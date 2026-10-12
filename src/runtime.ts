import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { LocalObserver, LOG_LIMITS, observationError, type Observer, type EventType, type EventMetadata } from './observability.js';
import { ConfigStore, coordinator, directory, fail, named, port, requireCoordinator, text, validateConfig, type Agent, type Config } from './config.js';
import { listen, send, reportPayload, type Endpoint, type Envelope, type Kind } from './transport.js';
import { saveWorkerReport } from './reports.js';
import { readObservationSnapshot } from './snapshot.js';
import { workerStatusPage } from './worker-status.js';
import { probeWorker, probeWorkers } from './connections.js';
import { HandoffWorkflow, HANDOFF_KINDS, fencedClose, type CloseProvider, type HandoffKind } from './handoff.js';
import { CoordinatorReminders, type ReminderClock } from './reminders.js';

export const UNSUPPORTED_CANCELLATION = 'Unsupported Pi host: stop_worker and legacy graceful-close control are disabled. Pi 0.84.4 extension abort does not cancel retry backoff/continuations; graceful shutdown cannot guarantee no queued work restarts. No cancellation or shutdown was performed. close_worker uses a separate supported-provider owned-pane closure contract, not graceful cancellation. See references/implementation-blocker.md. A verified supported host API is required for graceful cancellation (no version-only override).';
export interface Host {
  sessionId(): string;
  cwd: string;
  busy(): boolean;
  deliver(text: string, busy: boolean): void;
  setName(name: string): Promise<void>;
  notify(text: string): void;
}
export interface LaunchRequest { multiplexer: 'herdr' | 'none'; cwd: string; sessionId?: string }
export interface RuntimeOptions {
  launch(request: LaunchRequest): Promise<unknown>;
  listen?: typeof listen;
  send?: typeof send;
  probe?: typeof probeWorker;
  store?: (root: string) => ConfigStore;
  observe?: (root: string, sessionId: string) => Observer;
  closeProvider?: CloseProvider;
  /** Test seam; production defaults to 120 seconds, values above that are capped. */
  closeTimeoutMs?: number;
  reminderClock?: ReminderClock;
}
export class Intercom {
  store!: ConfigStore;
  endpoint?: Endpoint;
  private active = false;
  private generation = 0;
  private initialId = '';
  responsibility?: Agent;
  private observer?: Observer;
  private closing?: Promise<void>;
  private reportWrites: Promise<void> = Promise.resolve();
  private pendingReports = 0;
  private probeController = new AbortController();
  private resumeFences = new Map<string, { inFlight: boolean; submitted: boolean; announced: boolean }>();
  private handoff?: HandoffWorkflow;
  private reminders?: CoordinatorReminders;
  private reminderRevision = 0;
  private reminderInvocation = 0;
  workerStarted(): void { this.handoff?.workerStarted(); }
  workerSettled(successfulToolCallIds: ReadonlySet<string>): void { this.handoff?.workerSettled(successfulToolCallIds); }
  private captureObserver(): (event: EventType, metadata?: EventMetadata) => void {
    const observer = this.observer;
    return (event, metadata = {}) => {
      try { observer?.record(event, metadata); } catch { /* Logging cannot affect communication. */ }
    };
  }
  recordObservation(event: EventType, metadata: EventMetadata = {}): void { this.captureObserver()(event, metadata); }
  constructor(readonly host: Host, readonly options: RuntimeOptions) {}
  private id(): string {
    const id = this.host.sessionId();
    if (!this.active || id !== this.initialId) fail('session is inactive or replaced');
    return id;
  }
  private validity(): () => void {
    const generation = this.generation;
    this.id();
    return () => {
      this.id();
      if (generation !== this.generation) fail('runtime lifecycle replaced');
    };
  }
  async start(): Promise<void> {
    if (this.closing) await this.closing;
    if (this.active) fail('runtime already active');
    this.initialId = this.host.sessionId(); this.active = true;
    this.probeController = new AbortController();
    this.resumeFences.clear();
    const generation = ++this.generation, assertValid = this.validity();
    let record = this.captureObserver();
    try {
      const discovered = await ConfigStore.discover(this.host.cwd);
      assertValid();
      this.store = this.options.store?.(discovered?.root ?? this.host.cwd) ?? discovered ?? new ConfigStore(this.host.cwd);
      try { this.observer = this.options.observe ? this.options.observe(this.store.root, this.initialId) : new LocalObserver(this.store.root, this.initialId); } catch { /* Logging is optional on failure. */ }
      record = this.captureObserver();
      record('runtime.starting');
      const previous = discovered ? await this.store.read() : undefined;
      assertValid();
      const own = previous?.agents.find(a => a.sessionId === this.id());
      const endpoint = await (this.options.listen ?? listen)(own?.port, m => { assertValid(); return this.receive(m); }, () => {
        assertValid();
        return { version: 1, sessionId: this.initialId };
      });
      try { assertValid(); } catch (error) { await endpoint.close(); throw error; }
      this.endpoint = endpoint;
      if (!previous) {
        const initialized = await this.store.initialize(this.id(), this.endpoint.port, assertValid);
        if (initialized) record('config.changed', { operation: 'initialize', outcome: 'written' });
      }
      const config = await this.store.read();
      assertValid();
      const me = config.agents.find(a => a.sessionId === this.id());
      this.reminders = new CoordinatorReminders({
        isCoordinator: async () => { const fresh = await this.state(); assertValid(); return fresh.me?.coordinator === true; },
        busy: () => this.host.busy(),
        deliver: message => { assertValid(); this.host.deliver(message, false); },
      }, this.options.reminderClock);
      this.handoff = new HandoffWorkflow({
        state: () => this.state(), assertCurrent: assertValid,
        update: async (mutate, guard) => {
          await this.store.update(this.initialId, mutate, () => { assertValid(); guard?.(); });
        },
        send: async (sessionId, kind, payload) => {
          const state = await this.state(); assertValid();
          const target = state.config.agents.find(a => a.sessionId === sessionId);
          if (!target) fail('handoff recipient no longer configured');
          await (this.options.send ?? send)(target.port, { version: 1, kind, from: state.id, to: sessionId, payload, correlationId: randomUUID() });
          assertValid();
        },
        deliver: message => { assertValid(); this.host.deliver(message, this.host.busy()); },
        busy: () => this.host.busy(), provider: this.options.closeProvider, timeoutMs: this.options.closeTimeoutMs,
      });
      if (me?.coordinator) {
        await this.handoff.recover(); assertValid();
        try { this.observer?.maintain?.(); } catch { /* No cleanup failure affects readiness. */ }
        await this.store.update(this.id(), c => { requireCoordinator(c, this.id()).port = this.endpoint!.port; }, assertValid);
        assertValid();
        record('config.changed', { operation: 'port_update', outcome: 'written', port: this.endpoint.port });
        try { await this.reload(); } catch (e) { assertValid(); this.host.notify(`Name/responsibility synchronization failed: ${String(e)}`); }
        assertValid();
        this.host.notify(`Intercom Coordinator ready at 127.0.0.1:${this.endpoint.port}; waiting for user input.`);
      } else {
        if (me) { try { await this.reload(); } catch (e) { assertValid(); this.host.notify(`Name/responsibility synchronization failed: ${String(e)}`); } }
        assertValid();
        try {
          if (me) await this.report();
          else {
            const projectDirectory = await directory(this.store.root, this.host.cwd);
            assertValid();
            await this.transmit(coordinator(config).name, 'registration', { port: this.endpoint.port, projectDirectory });
          }
        } catch (e) { assertValid(); this.host.notify(`Coordinator unreachable/registration failed; worker remains reachable: ${String(e)}. No retry. Anonymous registration repeat is an unresolved contract; use explicit Pi /reload to restart this extension, not report_status.`); }
        assertValid();
        this.host.notify(`Intercom worker ready at 127.0.0.1:${this.endpoint.port}; waiting for explicit work.`);
      }
      record('runtime.ready', { port: this.endpoint.port, role: me?.coordinator ? 'coordinator' : me ? 'worker' : 'anonymous', busy: this.host.busy(), outcome: 'ready' });
    } catch (e) {
      if (generation === this.generation) {
        record('runtime.failed', { errorCode: observationError(e), outcome: 'failed' });
        await this.close();
      }
      throw e;
    }
  }
  async close(): Promise<void> {
    if (this.closing) return this.closing;
    this.recordObservation('runtime.closed');
    const observer = this.observer; this.observer = undefined;
    this.active = false; this.generation++;
    this.probeController.abort();
    this.handoff?.dispose(); this.handoff = undefined;
    this.reminderRevision = ++this.reminderInvocation;
    this.reminders?.dispose(); this.reminders = undefined;
    const endpoint = this.endpoint; this.endpoint = undefined;
    this.responsibility = undefined;
    const closing = (async () => {
      try { if (endpoint) await endpoint.close(); }
      finally {
        if (observer) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            // Only shutdown waits, and only for this bounded deadline. Already-issued I/O cannot be cancelled.
            await Promise.race([
              Promise.resolve().then(() => observer.close()).catch(() => {}),
              new Promise<void>(resolve => { timer = setTimeout(resolve, LOG_LIMITS.closeTimeoutMs); }),
            ]);
          } finally { if (timer) clearTimeout(timer); }
        }
      }
    })();
    this.closing = closing;
    try { await closing; } finally { if (this.closing === closing) this.closing = undefined; }
  }
  async state(): Promise<{ id: string; config: Config; me?: Agent }> {
    const assertValid = this.validity();
    const id = this.id(), config = await this.store.read();
    assertValid();
    return { id, config, me: config.agents.find(a => a.sessionId === id) };
  }
  /** Accept old configs, but retire the removed browser dashboard's discovery metadata. */
  async retireDashboardMetadata(): Promise<void> {
    const record = this.captureObserver(), assertValid = this.validity();
    const { id, config } = await this.state();
    assertValid();
    if (requireCoordinator(config, id).dashboardPort === undefined) return;
    await this.store.update(id, c => { delete requireCoordinator(c, id).dashboardPort; }, assertValid);
    record('config.changed', { outcome: 'written' });
  }
  async reload(): Promise<void> {
    const record = this.captureObserver();
    const assertValid = this.validity();
    const { me } = await this.state();
    assertValid();
    if (!me) fail('worker not configured; configure_worker must run before reload_worker');
    this.responsibility = { ...me };
    // Coordinator is a routing identity, not ownership of the user's Pi/tab title.
    if (!me.coordinator) await this.host.setName(me.name);
    assertValid();
    record('config.reloaded', { role: me.coordinator ? 'coordinator' : 'worker' });
    this.host.notify(`Intercom responsibility loaded for ${me.name}; no work turn started.`);
  }
  async transmit(to: string, kind: Kind, payload: Record<string, unknown> = {}): Promise<void> {
    const record = this.captureObserver();
    const assertValid = this.validity();
    const { id, config } = await this.state();
    assertValid();
    const target = named(config, to), correlationId = randomUUID();
    if (['message', 'reload'].includes(kind) && (this.handoff?.isClosing(target.sessionId) || fencedClose(target.closeJob))) fail('worker close is active or uncertain; new Intercom work is fenced');
    const metadata = { peerSessionId: target.sessionId, peerName: target.name, correlationId, kind };
    record('transport.send', { ...metadata, outcome: 'attempted' });
    try {
      await (this.options.send ?? send)(target.port, { version: 1, from: id, to: target.sessionId, kind, payload, correlationId });
      record('transport.receipt', { ...metadata, outcome: 'http_receipt' });
    } catch (error) {
      record('transport.failed', { ...metadata, outcome: 'failed', errorCode: observationError(error) });
      throw error;
    }
  }
  async report(): Promise<void> {
    const assertValid = this.validity();
    const { config, me } = await this.state();
    assertValid();
    if (me?.coordinator) fail('report_status is worker-only');
    if (!this.endpoint) fail('endpoint unavailable');
    await this.transmit(coordinator(config).name, 'status', { port: this.endpoint.port, busy: this.host.busy() });
  }
  async receive(message: Envelope): Promise<void> {
    const record = this.captureObserver();
    const metadata = { peerSessionId: message.from, correlationId: message.correlationId, kind: message.kind };
    record('transport.received', metadata);
    try { await this.handleReceive(message); }
    catch (error) {
      record('transport.rejected', { ...metadata, outcome: 'handler_failed', errorCode: observationError(error) });
      throw error;
    }
  }
  private async handleReceive(message: Envelope): Promise<void> {
    const record = this.captureObserver();
    const assertValid = this.validity();
    const receivedFence = message.kind === 'status' ? this.resumeFences.get(message.from) : undefined;
    const eligibleAnnouncement = receivedFence?.submitted ? receivedFence : undefined;
    const { id, config, me } = await this.state();
    assertValid();
    if (message.to !== id) fail('recipient session ID mismatch (stale endpoint)');
    const sender = config.agents.find(a => a.sessionId === message.from);
    const busy = this.host.busy();
    const metadata = { peerSessionId: message.from, peerName: sender?.name, correlationId: message.correlationId, kind: message.kind, busy };
    const notify = (purpose: string, content: string) => {
      assertValid();
      record('host.submission', { ...metadata, outcome: 'attempted' });
      try {
        this.host.deliver(`[Intercom ${purpose} from ${sender?.name ?? 'unconfigured worker'} (${message.from})]\n${content}`, busy);
        // A synchronous return is not Pi queue acceptance or model completion.
        record('host.submission', { ...metadata, outcome: 'returned' });
      } catch (error) {
        record('host.submission', { ...metadata, outcome: 'failed', errorCode: observationError(error) });
        throw error;
      }
    };
    if (HANDOFF_KINDS.includes(message.kind)) {
      if (!this.handoff || !me || (!me.coordinator && !this.responsibility)) fail('handoff requires a configured, responsibility-loaded worker');
      await this.handoff.receive(message.kind as HandoffKind, message.from, message.payload); return;
    }
    if (message.kind === 'registration' || message.kind === 'status') {
      requireCoordinator(config, id);
      if (sender?.coordinator) fail('coordinator cannot report as worker');
      if (message.kind === 'registration') {
        const projectDirectory = await directory(this.store.root, message.payload.projectDirectory as string);
        // No pending map, placeholder or configuration mutation.
        record('registration.received', { ...metadata, port: message.payload.port as number });
        notify('registration', JSON.stringify({ sessionId: message.from, port: message.payload.port, projectDirectory }) + '\nThis is connection information, not a work assignment. Configure explicitly, then reload separately.');
      } else {
        if (sender) await this.store.update(id, c => {
          const entry = c.agents.find(a => a.sessionId === message.from && !a.coordinator);
          if (entry) entry.port = message.payload.port as number;
        }, assertValid);
        assertValid();
        const fence = sender && this.resumeFences.get(sender.sessionId);
        if (fence && fence === eligibleAnnouncement) {
          fence.announced = true;
          if (!fence.inFlight) this.resumeFences.delete(sender!.sessionId);
        }
        record('status.received', { ...metadata, busy: message.payload.busy as boolean, port: message.payload.port as number });
        if (sender) record('config.changed', { operation: 'port_update', peerSessionId: message.from, port: message.payload.port as number, outcome: 'written' });
        notify('status', JSON.stringify({ sessionId: message.from, port: message.payload.port, busy: message.payload.busy, configured: !!sender }));
      }
      return;
    }
    if (message.kind === 'report') {
      requireCoordinator(config, id);
      if (!sender || sender.coordinator) fail('work reports require a configured worker sender');
      const payload = reportPayload(message.payload);
      if (this.pendingReports >= 64) fail('report queue full; no report stored');
      this.pendingReports++;
      const pending = this.reportWrites.then(async () => {
        assertValid();
        const fresh = await this.state();
        requireCoordinator(fresh.config, id);
        if (!fresh.config.agents.some(agent => agent.sessionId === message.from && !agent.coordinator)) fail('reporting worker is no longer configured');
        await saveWorkerReport(this.store.root, { version: 1, sessionId: message.from, ...payload, updatedAt: new Date().toISOString() }, assertValid);
        assertValid();
        try {
          notify('worker report', `Report: ${payload.status}\n${payload.summary}\nThis is a worker-authored public report, not approval or verified completion. Evaluate it before deciding any next step. Clearing retires the report only; it does not resume or complete work.`);
        } catch { fail('Report stored, but coordinator notification failed or became uncertain; do not blindly resend'); }
      });
      this.reportWrites = pending.catch(() => {}).finally(() => { this.pendingReports--; });
      await pending;
      return;
    }
    if (message.kind === 'message') {
      if (!sender || !me) fail('agent messaging requires configured sender and recipient; anonymous permissions TODO');
      if (!this.responsibility) fail('worker must load responsibility before receiving work');
      if (this.handoff?.workerClosing || fencedClose(me.closeJob)) fail('worker close is active or uncertain; new Intercom work is fenced');
      notify('agent message', message.payload.message as string); return;
    }
    if (!sender?.coordinator) fail('control requires current coordinator sender session ID');
    if (me?.coordinator) fail('worker control cannot target coordinator');
    if (message.kind === 'stop' || message.kind === 'close') fail(UNSUPPORTED_CANCELLATION);
    if (message.kind === 'reload') {
      if (this.handoff?.workerClosing || fencedClose(me?.closeJob)) fail('worker close is active or uncertain; reload is fenced');
      await this.reload(); return;
    }
    if (message.kind === 'request_status') {
      // Independent one-way report, never a synchronous status in the HTTP response.
      setImmediate(() => {
        try { assertValid(); } catch { return; } // Closed/replaced requests cannot report for a new lifecycle.
        void this.report().catch(e => {
          try { assertValid(); } catch { return; }
          this.host.notify(`Status report failed: ${String(e)}`);
        });
      });
      return;
    }
    fail('unsupported control');
  }
  async tool(operation: string, args: Record<string, unknown>, toolCallId?: string, reminderSignal?: AbortSignal): Promise<unknown> {
    // Reserve invocation order before state/directory awaits, but only VALID
    // reminder actions advance the accepted revision. Invalid/nonworker calls
    // must not supersede a pending stop or suppress an older valid preflight.
    const invocation = ++this.reminderInvocation;
    const armReminder = () => {
      if (invocation >= this.reminderRevision && !reminderSignal?.aborted) {
        this.reminderRevision = invocation;
        this.reminders?.arm(reminderSignal);
      }
    };
    const record = this.captureObserver();
    const assertValid = this.validity();
    const { id, config, me } = await this.state();
    assertValid();
    if (operation === 'worker_status') {
      if (!me) fail('worker_status requires a configured session');
      const snapshot = await readObservationSnapshot(this.store.root);
      assertValid();
      if (args.probe !== undefined && typeof args.probe !== 'boolean') fail('probe must be a boolean');
      const pageOptions = { name: args.name as string | undefined, offset: args.offset as number | undefined, limit: args.limit as number | undefined };
      const page = workerStatusPage(snapshot, pageOptions);
      if (!args.probe) return page;
      const ids = new Set(page.workers.map(worker => worker.sessionId));
      snapshot.connections = await probeWorkers(snapshot.config?.agents.filter(agent => !agent.coordinator && ids.has(agent.sessionId)) ?? [], { signal: this.probeController.signal });
      assertValid();
      return workerStatusPage(snapshot, pageOptions);
    }
    if (operation === 'list') {
      if (!me) fail('anonymous intercom_list permissions unresolved (TODO); no coordinator privileges');
      return { ...config, agents: config.agents.map(({ dashboardPort: _retired, ...agent }) => agent) };
    }
    if (operation === 'report_handoff') {
      if (!me || me.coordinator || !this.responsibility || !this.handoff) fail('report_handoff requires a configured, responsibility-loaded worker');
      return this.handoff.report(args.jobId, args.summary, toolCallId);
    }
    if (operation === 'report_status') { await this.report(); return { accepted: true }; }
    if (operation === 'report_work') {
      if (!me || me.coordinator || !this.responsibility) fail('report_work requires a configured, responsibility-loaded worker');
      const payload = reportPayload(args);
      await this.transmit(coordinator(config).name, 'report', payload);
      return { accepted: true, coordinatorEvaluation: 'not awaited' };
    }
    if (operation === 'send') {
      if (!me || !this.responsibility) fail('anonymous/unloaded worker cannot send agent messages (permissions TODO)');
      const recipient = named(config, args.to as string);
      text(args.message, 'message', 48000);
      if (this.handoff?.workerClosing || fencedClose(me.closeJob) || this.handoff?.isClosing(recipient.sessionId) || fencedClose(recipient.closeJob)) fail('worker close is active or uncertain; new Intercom work is fenced');
      if (me.coordinator && !recipient.coordinator) armReminder();
      await this.transmit(args.to as string, 'message', { message: args.message }); return { accepted: true, completion: 'not awaited' };
    }
    requireCoordinator(config, id);
    if (operation === 'stop_reminders') {
      const current = invocation >= this.reminderRevision;
      if (current) { this.reminderRevision = invocation; this.reminders?.stop(); }
      return { stopped: current };
    }
    if (operation === 'stop_worker') fail(UNSUPPORTED_CANCELLATION);
    if (operation === 'configure_worker') {
      const assertConfigurable = () => {
        assertValid();
        if (this.handoff?.isClosing(args.sessionId as string) || this.resumeFences.has(args.sessionId as string)) fail('worker lifecycle operation is in flight; configuration is fenced');
      };
      assertConfigurable();
      // Validate the candidate without writing, so invalid input never arms a
      // reminder; persistence failures after valid initiation still do.
      const relative = await directory(this.store.root, args.projectDirectory as string);
      assertConfigurable();
      const candidate: Agent = { sessionId: args.sessionId as string, name: args.name as string, description: args.description as string,
        port: args.port as number, projectDirectory: relative, coordinator: false };
      if (candidate.sessionId === id) fail('cannot configure coordinator as worker');
      const previous = config.agents.find(a => a.sessionId === candidate.sessionId);
      if (fencedClose(previous?.closeJob)) fail('worker close is active or uncertain; configuration is fenced');
      validateConfig({ ...config, agents: [...config.agents.filter(a => a.sessionId !== candidate.sessionId), candidate] });
      armReminder();
      await this.store.configure(id, args as unknown as Omit<Agent, 'coordinator'>, assertConfigurable);
      record('config.changed', { operation: 'configure_worker', peerSessionId: args.sessionId as string, peerName: args.name as string, outcome: 'written' });
      return { written: true, reloaded: false };
    }
    if (operation === 'set_multiplexer') {
      await this.store.update(id, c => { c.multiplexer = args.multiplexer as Config['multiplexer']; }, assertValid);
      record('config.changed', { operation: 'set_multiplexer', outcome: 'written' }); return { written: true };
    }
    if (operation === 'create_worker') {
      const relative = await directory(this.store.root, (args.projectDirectory as string | undefined) ?? '.');
      assertValid();
      armReminder();
      return this.launchObserved({ multiplexer: config.multiplexer, cwd: path.resolve(this.store.root, relative) });
    }
    const target = named(config, args.to as string);
    if (target.coordinator) fail('operation requires a worker target');
    if (operation === 'close_worker') {
      if (!this.options.closeProvider || !this.handoff || config.multiplexer !== 'herdr') fail('Owned-pane close requires supported Linux Herdr provider; no closure attempted');
      if (this.resumeFences.has(target.sessionId)) fail('resume is in flight; close is fenced');
      if (fencedClose(target.closeJob) && !this.handoff.isClosing(target.sessionId)) fail('worker close is active or uncertain; close is fenced');
      armReminder();
      return { job: await this.handoff.request(target), completion: 'not awaited', contract: 'best-effort owned-pane closure; not all-child-process termination' };
    }
    if (['reload_worker', 'resume_worker', 'remove_worker'].includes(operation) && (this.handoff?.isClosing(target.sessionId) || fencedClose(target.closeJob))) fail('worker close is active or uncertain; operation is fenced');
    if (operation === 'reload_worker' || operation === 'request_status') {
      armReminder();
      await this.transmit(target.name, operation === 'reload_worker' ? 'reload' : 'request_status');
      return { accepted: true, completion: 'not awaited' };
    }
    if (operation === 'resume_worker') {
      if (args.confirmClosed !== true) fail('Resume requires explicit user confirmation that the previous worker session is closed (confirmClosed:true). Disconnected alone is not proof of closure.');
      if (this.resumeFences.has(target.sessionId)) fail('Resume already in flight or awaiting worker status; outcome may be uncertain. Inspect the worker before any retry; no automatic relaunch.');
      const fence = { inFlight: true, submitted: false, announced: false };
      this.resumeFences.set(target.sessionId, fence);
      armReminder();
      let completed = false;
      try {
        const connection = await (this.options.probe ?? probeWorker)(target, { signal: this.probeController.signal });
        assertValid();
        if (connection.state === 'connected') fail('Worker endpoint is still connected; refusing to resume the same session twice.');
        const relative = await directory(this.store.root, target.projectDirectory);
        assertValid();
        const cwd = path.resolve(this.store.root, relative);
        const fresh = await this.state();
        assertValid();
        requireCoordinator(fresh.config, id);
        const current = fresh.config.agents.find(agent => agent.sessionId === target.sessionId && !agent.coordinator);
        if (!current || current.port !== target.port || current.projectDirectory !== target.projectDirectory) fail('Worker configuration changed during resume check; no launch submitted.');
        if (this.handoff?.isClosing(target.sessionId) || fencedClose(current.closeJob)) fail('worker close is active or uncertain; resume is fenced');
        fence.submitted = true;
        const result = await this.launchObserved({ multiplexer: fresh.config.multiplexer, cwd, sessionId: current.sessionId });
        completed = true;
        return result;
      } finally {
        fence.inFlight = false;
        if ((!fence.submitted || (completed && fence.announced)) && this.resumeFences.get(target.sessionId) === fence) this.resumeFences.delete(target.sessionId);
      }
    }
    if (operation === 'remove_worker') {
      // No live process claim: the caller must explicitly ensure closure first.
      await this.store.update(id, c => {
        const current = c.agents.find(a => a.sessionId === target.sessionId);
        if (this.handoff?.isClosing(target.sessionId) || this.resumeFences.has(target.sessionId) || fencedClose(current?.closeJob)) fail('worker lifecycle operation is active or uncertain; removal is fenced');
        c.agents = c.agents.filter(a => a.sessionId !== target.sessionId);
      }, assertValid);
      record('config.changed', { operation: 'remove_worker', peerSessionId: target.sessionId, peerName: target.name, outcome: 'removed' });
      return { removed: true, processStopped: false, sessionDeleted: false };
    }
    fail(`unknown operation ${operation}`);
  }
  private async launchObserved(request: LaunchRequest): Promise<unknown> {
    const record = this.captureObserver();
    const metadata: EventMetadata = { operation: request.sessionId ? 'resume_worker' : 'create_worker', peerSessionId: request.sessionId };
    record('launch.result', { ...metadata, outcome: 'attempted' });
    try {
      const result = await this.options.launch(request);
      record('launch.result', { ...metadata, outcome: 'returned' });
      return result;
    } catch (error) {
      record('launch.result', { ...metadata, outcome: 'failed', errorCode: observationError(error) });
      throw error;
    }
  }
}
