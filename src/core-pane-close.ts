import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { CloseProvider, WorkerPaneIdentity } from './handoff.js';
import { linuxProcessIdentity } from './pane-close.js';
import { coreCall, defaultCoreEndpoint, locateTerminalTab, terminalAddress, withCoreSession, type CoreCall } from './herdr-core.js';

interface ProcessIdentity { start: string; state: string }
export interface CorePaneCloseOptions {
  sessionId(): string;
  sessionFile(): string | undefined;
  env?: NodeJS.ProcessEnv;
  platform?: string;
  pid?: number;
  processIdentity?: (pid: number) => Promise<ProcessIdentity | undefined>;
  verifySession?: (file: string, id: string) => Promise<void>;
  /** Trusted test seam, or a call already inside ONE withCoreSession operation.
   * Never inject a reconnecting per-request transport. */
  call?: CoreCall;
  verificationMs?: number;
}

const DOCUMENT = 'herdr-app';
const blocked = () => new Error('PiIntercom HC pane close blocked: ownership, process, descendants or supported layout could not be verified; no close submitted.');
export class CorePaneCloseUncertainError extends Error {
  readonly uncertain = true;
  readonly outcomeUncertain = true;
  constructor() {
    super('PiIntercom HC pane close outcome uncertain; terminal/process or pane may remain; inspect before any retry; no automatic replay.');
    this.name = 'CorePaneCloseUncertainError';
  }
}
function requireProof(ok: unknown): asserts ok { if (!ok) throw blocked(); }
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const alive = (p: ProcessIdentity | undefined, start: string) => !!p && p.start === start && !['Z', 'X', 'x'].includes(p.state);
const localId = (v: unknown): v is string => typeof v === 'string' && !!v && v.length <= 256 && !/[\/\x00-\x20\x7f]/.test(v);
const uuid = (v: unknown) => typeof v === 'string' && /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(v) && v.trim() === v;

async function verifySessionHeader(file: string, id: string): Promise<void> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    requireProof((await handle.stat()).isFile());
    const buffer = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const end = buffer.subarray(0, bytesRead).indexOf(10);
    requireProof(end >= 0);
    const header = JSON.parse(buffer.subarray(0, end).toString('utf8'));
    requireProof(header?.type === 'session' && header.id === id);
  } finally { await handle.close(); }
}

interface Placement { space: string; tab: string; pane: string; content: unknown }
interface View {
  version: number; value: any;
  caller: ReturnType<typeof locateTerminalTab>;
  terminals: Map<string, Placement>;
  blocks: Map<string, Placement>;
  ids: Set<string>;
}
function view(snapshot: any, caller: string): View {
  requireProof(Number.isSafeInteger(snapshot?.version) && snapshot.version >= 0 && snapshot.value &&
    Buffer.byteLength(JSON.stringify(snapshot.value)) <= 1024 * 1024);
  // Shared locator checks bounded trees, global IDs, unambiguous content and floats.
  const location = locateTerminalTab(snapshot.value, caller);
  const terminals = new Map<string, Placement>(), blocks = new Map<string, Placement>(), ids = new Set<string>();
  const id = (v: string) => { requireProof(localId(v)); ids.add(v); };
  for (const space of snapshot.value.spaces) {
    id(space.id);
    for (const tab of space.tabs) {
      id(tab.id);
      const visit = (node: any) => {
        id(node.id);
        for (const floating of node.floating ?? []) {
          id(floating.id);
          blocks.set(floating.id, { space: space.id, tab: tab.id, pane: floating.id, content: floating.content });
        }
        if (node.type === 'block') {
          const placement = { space: space.id, tab: tab.id, pane: node.id, content: node.content };
          blocks.set(node.id, placement);
          if (node.content.terminal !== undefined) {
            terminalAddress(node.content.terminal);
            requireProof(!terminals.has(node.content.terminal));
            terminals.set(node.content.terminal, placement);
          }
        } else for (const child of node.children) visit(child);
      };
      visit(tab.root);
    }
  }
  return { version: snapshot.version, value: snapshot.value, caller: location, terminals, blocks, ids };
}
function samePlace(a: Placement | undefined, b: Placement | undefined): boolean {
  return !!a && !!b && a.space === b.space && a.tab === b.tab && a.pane === b.pane && isDeepStrictEqual(a.content, b.content);
}
function preserveBlocks(before: View, after: View, removed: string): void {
  for (const [id, placement] of before.blocks) if (id !== removed) requireProof(samePlace(placement, after.blocks.get(id)));
}

/** Intentionally narrow mutation subset: the standard worker tab, or flat
 * row/column splits. Never delete a tab containing any sibling block/mod/float.
 * Keep sibling nodes and their sizes/metadata verbatim; singleton roots are valid
 * in app 0.1.13. Nested target trees/root blocks are blocked BEFORE the kill.
 * Source: app 0.1.13 mirror.rs Document/SharedTab, layout.rs Node, model.rs
 * remove_pane, window.rs terminal_ended/reconcile. The app may do its own removal.
 * This is private, source-pinned layout support, NOT an app-version/UI handshake. */
function removal(current: View, identity: WorkerPaneIdentity): any {
  const value = structuredClone(current.value);
  const { space, tab, pane } = locateTerminalTab(value, identity.terminalId);
  const root = tab.root;
  requireProof(pane.id === identity.paneId && ['row', 'column'].includes(root.type) &&
    root.children.every((n: any) => n.type === 'block') && root.children.includes(pane) &&
    pane.closable !== false && root.closable !== false && !(pane.floating?.length));
  if (root.children.length === 1) {
    requireProof(!(root.floating?.length));
    space.tabs.splice(space.tabs.indexOf(tab), 1);
    // Do not remove the space, even if now empty: it is not our owned object.
  } else root.children.splice(root.children.indexOf(pane), 1);
  return value;
}

function live(record: any, identity: WorkerPaneIdentity, created?: number): number {
  requireProof(record?.address === identity.terminalId && record.state === 'live' && positive(record.created_ms) &&
    (created === undefined || record.created_ms === created) && record.foreground?.pid === identity.pid && record.rm !== true);
  return record.created_ms;
}
function terminalResult(record: any, terminal: string, created: number): boolean {
  requireProof(record?.address === terminal && record.created_ms === created && ['live', 'finished'].includes(record.state));
  if (record.state !== 'finished') return false;
  requireProof(record.foreground == null && positive(record.finished_ms) && record.finished_ms >= created);
  return true;
}

/** Include finished ancestors too. Missing ancestry, cycles, duplicate addresses,
 * foreign machines (including disconnected ones) and unknown states fail closed.
 * Core children normally end with their parent; outlive-parent is NOT permission
 * to kill somebody else's worker. This snapshot is not an atomic spawn barrier. */
function noDescendants(list: any, target: WorkerPaneIdentity, own: WorkerPaneIdentity, targetCreated: number, ownCreated: number): void {
  requireProof(Array.isArray(list?.terminals) && list.terminals.length <= 4096 &&
    list.hidden_finished === 0 && Array.isArray(list.machines) && list.machines.length === 0);
  const records = new Map<string, any>();
  for (const r of list.terminals) {
    terminalAddress(r?.address);
    requireProof(!records.has(r.address) && ['live', 'finished'].includes(r.state));
    if (r.parent != null) terminalAddress(r.parent);
    records.set(r.address, r);
  }
  live(records.get(target.terminalId), target, targetCreated);
  live(records.get(own.terminalId), own, ownCreated);
  for (const r of records.values()) {
    const seen = new Set<string>([r.address]);
    let parent = r.parent;
    while (parent != null) {
      requireProof(!seen.has(parent) && records.has(parent));
      requireProof(r.state !== 'live' || parent !== target.terminalId);
      seen.add(parent); parent = records.get(parent).parent;
    }
  }
}

/** Linux-only owned-worker closure. HandoffWorkflow still owns saved handoff,
 * successful tool persistence, final settlement and same-epoch close_commit.
 * beforeSubmit MUST perform that commit; it runs after all slow ownership reads,
 * immediately before ONE terminal.kill. There is no graceful-cancel enablement,
 * all-descendants guarantee, atomic identity/kill API, automatic retry or rm.
 * Default operations each use a fresh bound CoreSession, never reconnect mid-job.
 * Current shared transport deliberately pins core 0.1.18; later versions require
 * review. No API can establish remote app 0.1.13/rendering from core alone. */
export function createCoreCloseProvider(options: CorePaneCloseOptions): CloseProvider | undefined {
  const env = options.env ?? process.env;
  if ((options.platform ?? process.platform) !== 'linux' || !env.HC_TERMINAL_ID) return;
  const caller = env.HC_TERMINAL_ID;
  const ownPid = options.pid ?? process.pid;
  const processIdentity = options.processIdentity ?? linuxProcessIdentity;
  const verifySession = options.verifySession ?? verifySessionHeader;
  const requestedMs = options.verificationMs ?? 1500;
  const verificationMs = Number.isFinite(requestedMs) ? Math.max(0, Math.min(2000, requestedMs)) : 1500;
  const attempted = new Set<string>(), active = new Set<string>();
  const operation = <T>(work: (call: CoreCall) => Promise<T>): Promise<T> =>
    options.call && options.call !== coreCall ? work(options.call) :
      defaultCoreEndpoint(env).then(endpoint => withCoreSession(work, { endpoint }));

  async function context(call: CoreCall, assertCurrent: () => void) {
    terminalAddress(caller);
    const sessionId = options.sessionId(), sourceFile = options.sessionFile();
    requireProof(positive(ownPid) && typeof sessionId === 'string' && !!sessionId && sourceFile);
    const guard = () => {
      assertCurrent();
      requireProof(env.HC_TERMINAL_ID === caller && options.sessionId() === sessionId && options.sessionFile() === sourceFile);
    };
    const query: CoreCall = async (method, params) => { guard(); const result = await call(method, params); guard(); return result; };
    const status = await query('server.status', {});
    requireProof(status?.version === '0.1.18' && uuid(status.core?.id) && typeof status.core.name === 'string' && positive(status.pid));
    const core = async () => {
      const fresh = await query('server.status', {});
      requireProof(fresh?.version === status.version && fresh.core?.id === status.core.id &&
        fresh.core?.name === status.core.name && fresh.pid === status.pid);
    };
    const canonical = async (file: string) => {
      requireProof(typeof file === 'string' && path.isAbsolute(file) && file.length <= 4096 && !file.includes('\0'));
      const resolved = await realpath(file); guard(); return resolved;
    };
    const sessionFile = await canonical(sourceFile);
    const process = await processIdentity(ownPid); guard();
    requireProof(process && /^[0-9]+$/.test(process.start) && alive(process, process.start));
    const own: WorkerPaneIdentity = { workspaceId: status.core.id, terminalId: caller, paneId: '',
      sessionId, sessionFile, pid: ownPid, processStart: process.start };
    const checkProcess = async (identity: WorkerPaneIdentity) => {
      requireProof(positive(identity.pid) && /^[0-9]+$/.test(identity.processStart) &&
        identity.workspaceId === status.core.id && typeof identity.sessionId === 'string' && !!identity.sessionId);
      requireProof(await canonical(identity.sessionFile) === identity.sessionFile);
      await verifySession(identity.sessionFile, identity.sessionId); guard();
      requireProof(await canonical(identity.sessionFile) === identity.sessionFile);
      requireProof(alive(await processIdentity(identity.pid), identity.processStart)); guard();
    };
    const readView = async () => view(await query('doc.get', { name: DOCUMENT }), caller);
    const initial = await readView();
    own.paneId = initial.caller.pane.id;
    const ownPlace = initial.terminals.get(caller)!;
    const ownCreated = live(await query('terminal.get', { terminal: caller }), own);
    const checkOwn = async (current: View) => {
      requireProof(samePlace(ownPlace, current.terminals.get(caller)) && await canonical(sourceFile) === sessionFile);
      await checkProcess(own);
      live(await query('terminal.get', { terminal: caller }), own, ownCreated);
    };
    await checkOwn(initial);
    return { guard, query, core, own, ownCreated, checkProcess, readView, checkOwn };
  }
  type Context = Awaited<ReturnType<typeof context>>;
  async function inspectTarget(ctx: Context, identity: WorkerPaneIdentity, expected: string, prior?: { current: View; created: number }) {
    terminalAddress(identity.terminalId);
    requireProof(identity.sessionId === expected && expected !== ctx.own.sessionId && identity.pid !== ownPid &&
      identity.terminalId !== caller && identity.paneId !== ctx.own.paneId && identity.workspaceId === ctx.own.workspaceId);
    await ctx.core();
    await ctx.checkProcess(identity);
    const current = await ctx.readView();
    const placement = current.terminals.get(identity.terminalId);
    requireProof(placement?.pane === identity.paneId && (!prior || (current.version >= prior.current.version &&
      samePlace(placement, prior.current.terminals.get(identity.terminalId)))));
    removal(current, identity); // Prove our mutation subset BEFORE any effect.
    await ctx.checkOwn(current);
    const created = live(await ctx.query('terminal.get', { terminal: identity.terminalId }), identity, prior?.created);
    ctx.guard();
    return { current, created };
  }
  return {
    async getIdentity() {
      try {
        return await operation(async call => {
          const ctx = await context(call, () => {});
          await ctx.core();
          await ctx.checkOwn(await ctx.readView());
          ctx.guard(); return ctx.own;
        });
      } catch { throw blocked(); }
    },
    async inspect(identity, expectedSessionId, assertCurrent) {
      try { await operation(async call => { await inspectTarget(await context(call, assertCurrent), { ...identity }, expectedSessionId); }); }
      catch { throw blocked(); }
    },
    async close(identity, expectedSessionId, assertCurrent, beforeSubmit) {
      const target = { ...identity };
      const key = JSON.stringify([target.workspaceId, target.terminalId, target.sessionId, target.pid, target.processStart]);
      requireProof(!active.has(key) && !attempted.has(key));
      active.add(key);
      let submitted = false;
      try {
        return await operation(async call => {
          const ctx = await context(call, assertCurrent);
          const first = await inspectTarget(ctx, target, expectedSessionId);
          // Revalidate on the SAME connection after slow header/process/layout reads.
          const proof = await inspectTarget(ctx, target, expectedSessionId, first);
          noDescendants(await ctx.query('terminal.list', { all: true }), target, ctx.own, proof.created, ctx.ownCreated);
          await ctx.checkProcess(target);
          await ctx.core();
          live(await ctx.query('terminal.get', { terminal: target.terminalId }), target, proof.created);
          ctx.guard();
          await beforeSubmit(); // Handoff's same-epoch commit; no intervening slow read.
          ctx.guard();
          attempted.add(key); submitted = true;
          const killed = await ctx.query('terminal.kill', { terminal: target.terminalId });
          let finished = terminalResult(killed, target.terminalId, proof.created), workerExited = false;
          const deadline = Date.now() + verificationMs;
          // Bounded observation only, never resubmit kill. Stay below CoreSession's
          // request budget even when the terminal does not finish promptly.
          for (let i = 0; i < 10; i++) {
            finished = terminalResult(await ctx.query('terminal.get', { terminal: target.terminalId }), target.terminalId, proof.created);
            workerExited = !alive(await processIdentity(target.pid), target.processStart); ctx.guard();
            if ((finished && workerExited) || Date.now() >= deadline) break;
            await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(0, deadline - Date.now()))));
            ctx.guard();
          }
          if (!finished || !workerExited) return { paneClosed: false, workerExited };
          await ctx.core();
          const current = await ctx.readView();
          requireProof(current.version >= proof.current.version);
          await ctx.checkOwn(current);
          preserveBlocks(proof.current, current, target.paneId);
          const present = current.terminals.get(target.terminalId);
          if (present) {
            requireProof(samePlace(present, proof.current.terminals.get(target.terminalId)));
            const value = removal(current, target);
            const planned = view({ version: current.version, value }, caller);
            requireProof(!planned.terminals.has(target.terminalId) && !planned.ids.has(target.paneId));
            preserveBlocks(current, planned, target.paneId);
            ctx.guard();
            const written = await ctx.query('doc.set', { name: DOCUMENT, version: current.version, value });
            requireProof(Number.isSafeInteger(written?.version) && written.version === current.version + 1);
            const observed = await ctx.readView();
            requireProof(observed.version >= written.version && !observed.terminals.has(target.terminalId) && !observed.ids.has(target.paneId));
            if (observed.version === written.version) requireProof(isDeepStrictEqual(observed.value, value));
            preserveBlocks(planned, observed, target.paneId);
            await ctx.checkOwn(observed);
          } else {
            // The app can reconcile first. Absence alone is NOT ownership proof.
            requireProof(!current.ids.has(target.paneId));
          }
          await ctx.core(); ctx.guard();
          return { paneClosed: true, workerExited: true };
        });
      } catch (error) {
        if (submitted) throw new CorePaneCloseUncertainError();
        // Preserve commit/guard rejection details for HandoffWorkflow callers.
        throw error;
      } finally { active.delete(key); }
    },
  };
}
