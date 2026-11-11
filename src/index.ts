import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Type, type TSchema } from 'typebox';
import { getAgentDir, SessionManager, SettingsManager, truncateHead, withFileMutationQueue, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { ConfigStore } from './config.js';
import { Intercom, UNSUPPORTED_CANCELLATION } from './runtime.js';
import { launchers } from './launcher.js';
import { ensureMonitorPane, closeMonitorPane } from './monitor-launcher.js';
import { createActivityTracker } from './activity.js';
import { createCloseProvider } from './pane-close.js';

const to = Type.Object({ to: Type.String({ minLength: 1, maxLength: 128 }) });
const modelSelection = Type.Union([Type.Null(), Type.Object({ provider: Type.String({ minLength: 1, maxLength: 256 }), model: Type.String({ minLength: 1, maxLength: 256 }) }, { additionalProperties: false })]);
const tools: [string, string, TSchema][] = [
  ['configure_models', 'Coordinator only. Save coordinator and/or worker provider/model defaults in project config. Null removes a default. Applies on startup or idle responsibility reload, not immediately. Manual model changes remain allowed; unavailable models produce an error without fallback.', Type.Object({ coordinator: Type.Optional(modelSelection), worker: Type.Optional(modelSelection) }, { minProperties: 1, additionalProperties: false })],
  ['create_worker', 'Coordinator only. Launch one anonymous worker at the coordinator root. projectDirectory defaults to root and must resolve to that same directory; subfolder launches cannot use a parent config and are refused. No assignment, configuration, or registration wait.', Type.Object({ projectDirectory: Type.Optional(Type.String()) })],
  ['configure_worker', 'Coordinator only. Write explicit reported connection details and responsibility to config. Does not notify, reload, or start work. Use reload_worker separately.', Type.Object({ sessionId: Type.String(), port: Type.Integer({ minimum: 1, maximum: 65535 }), projectDirectory: Type.String(), name: Type.String({ minLength: 1, maxLength: 128 }), description: Type.String({ minLength: 1, maxLength: 4096 }) })],
  ['reload_worker', 'Coordinator only. Ask worker to reread responsibility and synchronize names. NOT Pi extension reload, cancellation, restart, or work assignment.', to],
  ['send', 'Configured sessions only. Send an explicit work/progress/findings message by recipient name. Idle delivery starts a turn; busy delivery steers at supported boundaries. Receipt is not an agent reply. Progress questions do not cancel assignments.', Type.Object({ to: Type.String(), message: Type.String({ minLength: 1, maxLength: 48000 }) })],
  ['worker_status', 'Configured sessions only. Read paginated JSON worker observations and public reports from local files, optionally by worker name. Last-observed status is not live liveness or task completion; reports are self-reported, not approval. Local-only by default; probe:true performs bounded loopback identity checks for this page only, without worker prompts or Telegram dependency. Disconnected means endpoint unreachable, not process termination. Follow nextOffset for further pages; null report means no readable active report.', Type.Object({ name: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })), offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })), probe: Type.Optional(Type.Boolean()) })],
  ['list', 'Configured sessions only. Read current saved names, responsibilities, session IDs, roles and ports. No live probing. Output limited to 50 KiB/2000 lines; full data remains in config.json.', Type.Object({})],
  ['request_status', 'Coordinator only. Ask worker extension to send an independent sessionId/port/busy report without a model turn on worker. No synchronous status reply.', to],
  ['report_work', 'Configured, responsibility-loaded workers only. Store one public report (blocked, needs_decision, ready_for_review) and notify the coordinator; clear retires it. Summary required except clear (omit or empty). Never include private reasoning, credentials, raw tool payloads, or secrets. Receipt is not approval, verified completion, or permission for follow-up work.', Type.Object({ status: Type.String({ enum: ['blocked', 'needs_decision', 'ready_for_review', 'clear'] }), summary: Type.Optional(Type.String({ maxLength: 2000 })) })],
  ['stop_reminders', 'Coordinator only. Disable the five-minute orchestration reminders until the next worker-directed call. Use when there is genuinely nothing to follow up on. Stops only reminders, not workers, close jobs or model work. Reminder state is session-local and clears on shutdown/reload.', Type.Object({})],
  ['report_status', 'Worker only (including anonymous). Send runtime sessionId/port/busy report to coordinator. This is NOT registration and creates no config entry.', Type.Object({})],
  ['stop_worker', UNSUPPORTED_CANCELLATION, to],
  ['close_worker', 'Coordinator only. Begin a background save-handoff-and-close job for a configured worker in Linux Herdr. Requests a public summary, saves it in config, waits for successful tool persistence and final turn settlement, then attempts one verified pane close. Returns job acceptance, not completion. Registration/session history are retained. Check worker_status/list for closeJob; failure/timeout/uncertainty never authorizes retry. Not graceful abort or an all-descendants termination guarantee; Windows/non-Herdr unsupported.', to],
  ['report_handoff', 'Configured worker only, in response to its pending close request. Submit the matching jobId and concise public resume handoff (current work, completed work, unfinished items, blockers, next step). Never include secrets, private reasoning or raw tool payloads. Saved receipt is not closure: finish the response and wait; the extension requires final turn settlement before pane closure.', Type.Object({ jobId: Type.String({ minLength: 1, maxLength: 128 }), summary: Type.String({ minLength: 1, maxLength: 4000 }) })],
  ['resume_worker', 'Coordinator only. Resume saved session/name/responsibility after the user explicitly confirms the old session was closed: set confirmClosed:true only for that confirmation, never infer it from disconnected status. A matching live health endpoint blocks launch. In-flight/uncertain attempts are fenced until worker status arrives; otherwise inspect process and reload coordinator before considering retry. Saved subfolder launches are refused rather than relocated, because a worker cannot use a parent config. No cross-process uniqueness guarantee, automatic assignment, replacement or removal.', Type.Object({ to: Type.String({ minLength: 1, maxLength: 128 }), confirmClosed: Type.Boolean() })],
  ['remove_worker', 'Coordinator only. Remove config entry only; never stop process or delete session files. A running worker must be explicitly closed before removal. Retain registration to resume it later; remove only to forget it. Pending or uncertain close jobs block removal.', to],
  ['open_monitor', "Coordinator only. Open or reuse the owned status monitor, including with no workers. Explicit placement is required: ask the user if unknown; never guess or fall back to saved settings. Currently supported: 'coordinator-tab' (pane above the coordinator in its current tab), 'new-tab' (separate tab). Does not assign worker work or change saved settings.", Type.Object({ placement: Type.String({ minLength: 1 }) })],
  ['close_monitor', 'Coordinator only. Close only the verified owned status monitor pane, not a worker, coordinator or whole tab. Does not change saved auto-open settings.', Type.Object({})],
  ['configure_monitor', "Coordinator only. Persist autoOpen and/or placement for future monitor openings. At least one setting is required. Currently supported placement values: 'coordinator-tab' (pane above the coordinator in its current tab), 'new-tab' (separate tab). Does not open, close or move panes.", Type.Object({ autoOpen: Type.Optional(Type.Boolean()), placement: Type.Optional(Type.String({ minLength: 1 })) }, { minProperties: 1, additionalProperties: false })],
  ['set_multiplexer', 'Coordinator only. Set herdr (default, Windows/Linux) or none (separate visible Windows terminals; unsupported on Linux) for future launches. Never move/restart existing workers or fall back.', Type.Object({ multiplexer: Type.String({ enum: ['herdr', 'none'] }) })],
];

// Launchers pass no --session-dir. Match child Pi's env > per-cwd settings >
// default lookup, resolving relative paths against the child's cwd, not ours.
// SettingsManager's public getter applies Pi's own path/tilde normalization.
export function resumeSessionDirectory(cwd: string, envSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR, agentDir = getAgentDir()): string | undefined {
  const settings = envSessionDir
    ? SettingsManager.inMemory({ sessionDir: envSessionDir })
    : SettingsManager.create(cwd, path.resolve(cwd, agentDir));
  const sessionDir = settings.getSessionDir();
  return sessionDir ? path.resolve(cwd, sessionDir) : undefined;
}

// Participate in Pi's own per-file mutation queue as well as Intercom serialization.
class PiConfigStore extends ConfigStore {
  override update(id: string, mutate: Parameters<ConfigStore['update']>[1], assertValid?: () => void) {
    return withFileMutationQueue(this.file, () => super.update(id, mutate, assertValid));
  }
}
export default function intercomExtension(pi: ExtensionAPI): void {
  pi.registerFlag('intercom-root', {
    type: 'string',
    description: 'Explicit Intercom root must equal this session cwd; parent configuration is never allowed, even with this flag.',
  });
  let runtime: Intercom | undefined;
  let context: ExtensionContext | undefined;
  let generation = 0;
  let activityOutcome: 'started' | 'settled' | 'snapshot' = 'snapshot';
  const activity = createActivityTracker((phase, detail) => {
    runtime?.recordObservation('host.activity', { busy: phase !== 'idle', phase, detail, outcome: activityOutcome });
  });
  const launcher = launchers({
    extension: fileURLToPath(import.meta.url),
    sessionExists: async (cwd, id) => (await SessionManager.list(cwd, resumeSessionDirectory(cwd))).some(s => s.id === id),
  });
  let monitorAutoEpoch = 0;
  let monitorTask: { runtime: Intercom; generation: number; epoch: number; dirty: boolean; promise: Promise<void> } | undefined;
  async function ensureCoordinatorMonitor(current: Intercom, ctx: ExtensionContext, started: number): Promise<void> {
    const epoch = monitorAutoEpoch;
    const isCurrent = () => started === generation && runtime === current && epoch === monitorAutoEpoch;
    if (!isCurrent()) return;
    if (monitorTask?.runtime === current && monitorTask.generation === started && monitorTask.epoch === epoch) {
      monitorTask.dirty = true;
      return monitorTask.promise;
    }
    const check = async () => {
      try {
        const { config, me } = await current.state();
        if (!isCurrent() || !me?.coordinator || !config.agents.some(agent => !agent.coordinator)) return;
        const settings = await current.getMonitorSettings();
        if (!isCurrent() || !settings.autoOpen) return;
        const monitor = await current.autoOpenMonitor(() => {
          if (!isCurrent()) throw new Error('Automatic monitor request superseded');
        }) as Awaited<ReturnType<typeof ensureMonitorPane>>;
        if (isCurrent()) ctx.ui.notify(`Intercom status monitor: ${monitor.outcome}${monitor.pane ? ` (${monitor.pane})` : ''}`, 'info');
      } catch (error) {
        if (isCurrent()) ctx.ui.notify(String(error), 'warning');
      }
    };
    const task = { runtime: current, generation: started, epoch, dirty: false, promise: Promise.resolve() };
    monitorTask = task;
    task.promise = (async () => {
      do { task.dirty = false; await check(); } while (task.dirty && isCurrent());
    })();
    try { await task.promise; } finally { if (monitorTask === task) monitorTask = undefined; }
  }
  let starting = false;
  async function startSession(ctx: ExtensionContext, activate = false): Promise<void> {
    if (starting) throw new Error('PiIntercom activation already in progress');
    starting = true;
    try { await initializeSession(ctx, activate); } finally { starting = false; }
  }
  async function initializeSession(ctx: ExtensionContext, activate: boolean): Promise<void> {
    const started = ++generation;
    activity.reset();
    const oldRuntime = runtime;
    runtime = undefined;
    await oldRuntime?.close();
    if (started !== generation) return;
    context = ctx;
    if (!['win32', 'linux'].includes(process.platform) || ctx.mode !== 'tui') {
      if (!activate) return;
      throw new Error('PiIntercom requires Windows or Linux interactive Pi. No resources started.');
    }
    if (!ctx.isProjectTrusted()) {
      if (!activate) return;
      throw new Error('PiIntercom requires project trust before honoring shared project configuration.');
    }
    // Flags become available at session_start, not extension factory time. Never
    // infer workspace authority from ancestors or inherited environment values.
    const workspaceRoot = pi.getFlag('intercom-root');
    if (workspaceRoot !== undefined && typeof workspaceRoot !== 'string') throw new Error('PiIntercom: intercom-root must be an explicit absolute path.');
    let existing: ConfigStore | undefined;
    try {
      existing = workspaceRoot !== undefined
        ? await ConfigStore.workspace(ctx.cwd, workspaceRoot)
        : await ConfigStore.discover(ctx.cwd);
    } catch (error) {
      if (activate) throw error;
      ctx.ui.notify(String(error), 'error'); return;
    }
    if (started !== generation) return;
    if (!existing && !activate) return;
    runtime = new Intercom({
      cwd: ctx.cwd,
      sessionId: () => context!.sessionManager.getSessionId(),
      busy: () => !context!.isIdle(),
      // Always supply the supported busy mode: the arrival snapshot can become
      // stale before Pi checks it. Pi still starts a normal turn when idle.
      deliver: content => pi.sendUserMessage(content, { deliverAs: 'steer' }),
      setName: async name => { if (pi.getSessionName() !== name) pi.setSessionName(name); await launcher.syncName(name); },
      applyModel: async selection => {
        if (started !== generation || !ctx.isIdle()) throw new Error('Intercom model selection requires the current idle session');
        const model = ctx.modelRegistry.find(selection.provider, selection.model);
        if (!model) throw new Error(`Intercom configured model unavailable: ${selection.provider}/${selection.model}; no fallback applied`);
        if (!await pi.setModel(model)) throw new Error(`Intercom could not select configured model: ${selection.provider}/${selection.model}; check provider credentials; no fallback applied`);
      },
      notify: text => ctx.ui.notify(text, 'info'),
    }, {
      launch: launcher.launch, store: root => new PiConfigStore(root), workspaceRoot, requireExistingConfig: !activate,
      monitor: {
        open: request => ensureMonitorPane({ ...request,
          script: fileURLToPath(new URL('../dist/monitor.js', import.meta.url)),
          assertCurrent: () => {
            request.assertCurrent();
            if (started !== generation || runtime !== current) throw new Error('Coordinator session changed');
          },
        }),
        close: request => closeMonitorPane({ ...request,
          script: fileURLToPath(new URL('../dist/monitor.js', import.meta.url)),
          assertCurrent: () => {
            request.assertCurrent();
            if (started !== generation || runtime !== current) throw new Error('Coordinator session changed');
          },
        }),
      },
      closeProvider: createCloseProvider({
        sessionId: () => context!.sessionManager.getSessionId(),
        sessionFile: () => context!.sessionManager.getSessionFile(),
      }),
    });
    const current = runtime;
    try { await current.start(); }
    catch (e) { if (runtime === current) runtime = undefined; if (activate) throw e; ctx.ui.notify(String(e), 'error'); return; }
    if (started !== generation) { await current.close(); return; }
    try {
      if ((await current.state()).me?.coordinator) {
        try { await current.retireDashboardMetadata(); }
        catch (error) {
          if (started !== generation) return;
          ctx.ui.notify(`Legacy dashboard metadata cleanup failed; messaging remains available: ${String(error)}`, 'warning');
        }
        if (started !== generation) return;
        await ensureCoordinatorMonitor(current, ctx, started);
      }
    } catch (error) {
      if (started !== generation) return;
      ctx.ui.notify(String(error), 'warning');
    }
  }
  pi.on('session_start', async (_event, ctx) => { await startSession(ctx); });
  pi.registerTool({
    name: 'intercom_activate', label: 'Activate Intercom', exposure: 'direct',
    description: 'Explicitly enable Intercom in this project. If no config exists, create it and register this session as coordinator. Otherwise connect using the existing config; never replace its coordinator. Does not launch workers. Use only when the user asks to activate Intercom.',
    parameters: Type.Object({}),
    async execute(_id, _args, signal, _update, ctx) {
      signal?.throwIfAborted();
      if (!runtime) await startSession(ctx, true);
      signal?.throwIfAborted();
      if (!runtime) throw new Error('Intercom activation interrupted; inspect session state before retrying');
      const state = await runtime.state();
      return { content: [{ type: 'text', text: JSON.stringify({ active: true, configPath: runtime.store.file, role: state.me?.coordinator ? 'coordinator' : state.me ? 'worker' : 'anonymous' }) }], details: {} };
    },
  });
  pi.on('session_shutdown', async () => {
    generation++;
    activity.reset();
    const oldRuntime = runtime;
    runtime = undefined; context = undefined;
    await oldRuntime?.close();
  });
  pi.on('input', (_event, ctx) => {
    context = ctx;
    runtime?.workerStarted(); // New owner input invalidates a pending close-readiness epoch.
  });
  pi.on('agent_start', async (_event, ctx) => {
    context = ctx;
    runtime?.workerStarted();
    activityOutcome = 'started';
    try { activity.start(); } finally { activityOutcome = 'snapshot'; }
  });
  pi.on('agent_settled', async (_event, ctx) => {
    context = ctx;
    activityOutcome = 'settled';
    try { activity.settled(); } finally { activityOutcome = 'snapshot'; }
    // Settlement is notification-only and follows tool-result persistence. Inspect
    // only entry kinds and successful tool call IDs, never message/reasoning bodies.
    const successful = new Set<string>();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === 'message' && entry.message.role === 'toolResult' && !entry.message.isError) {
        successful.add(entry.message.toolCallId);
      }
    }
    runtime?.workerSettled(successful);
  });
  pi.on('message_update', (event, ctx) => {
    context = ctx;
    // Inspect the event discriminator only. Never access reasoning/text payloads.
    activity.message(event.assistantMessageEvent.type);
  });
  pi.on('tool_execution_start', (event, ctx) => {
    context = ctx;
    activity.toolStart(event.toolCallId, event.toolName);
  });
  pi.on('tool_execution_end', (event, ctx) => {
    context = ctx;
    activity.toolEnd(event.toolCallId);
  });
  pi.on('before_agent_start', async (event, ctx) => {
    context = ctx;
    if (!runtime) return;
    const { me } = await runtime.state();
    const loaded = runtime.responsibility;
    return { systemPrompt: event.systemPrompt + '\n\nPiIntercom: communicates; Pi decides orchestration. Responsibility is not a work assignment. Do not implement unrelated work from findings. After assigned work, report as instructed and wait; do not autonomously exit. Progress questions require reporting and continuing unless explicitly redirected. stop_worker remains disabled due to the host cancellation blocker. close_worker is a separate Linux Herdr background handoff-and-pane-close workflow: do not self-exit, remove registration, force kill or infer completion from job acceptance.\n' + (me && loaded ? `Identity: ${loaded.name} (${me.sessionId}). Responsibility: ${loaded.description}.` : 'Anonymous/unloaded worker: wait for coordinator configuration and separate reload; do not treat registration as authorization to work.') };
  });
  for (const [operation, description, parameters] of tools) {
    pi.registerTool({
      name: `intercom_${operation}`, label: `Intercom ${operation}`, description, parameters,
      // Handoff readiness requires this call's successful transcript tool result.
      // Pi1.x enforces model-only for nested calls;0.84 ignores this optional field
      // and has no nested-tool API. Never substitute a parent result as proof.
      exposure: operation === 'report_handoff' ? 'model-only' : 'direct',
      async execute(_id, args, signal, _update, ctx) {
        signal?.throwIfAborted(); context = ctx;
        if (!runtime) throw new Error('PiIntercom not initialized (inactive). Ask the user to activate this project with intercom_activate; inspect any startup error first.');
        const current = runtime, started = generation;
        if (operation === 'close_monitor') {
          const state = await current.state();
          if (started !== generation || runtime !== current) throw new Error('Coordinator session changed');
          if (!state.me?.coordinator) throw new Error('PiIntercom: coordinator permission required');
          monitorAutoEpoch++; // Fence prior automatic passes; lock refusal never schedules a retry.
        }
        const result = await current.tool(operation, args as Record<string, unknown>, _id, signal);
        if (operation === 'configure_worker') await ensureCoordinatorMonitor(current, ctx, started);
        const output = truncateHead(JSON.stringify(result, null, 2));
        return { content: [{ type: 'text', text: output.content + (output.truncated ? `\n[Truncated; full shared configuration: ${current.store.file}]` : '') }], details: {} };
      },
    });
  }
}
