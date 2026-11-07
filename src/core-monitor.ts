import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { coreCall, withCoreSession, locateTerminalTab, terminalAddress, type CoreCall } from './herdr-core.js';

export type CoreMonitorPlacement = 'coordinator-tab' | 'new-tab';
export interface CoreMonitorOptions {
  root: string; sessionId: string; script: string;
  node?: string; env?: NodeJS.ProcessEnv; platform?: string;
  placement?: CoreMonitorPlacement; call?: CoreCall; assertCurrent?(): void;
}
export interface CoreMonitorResult { outcome: string; pane?: string; terminal?: string }
interface Owner {
  version: 2; backend: 'herdr-core'; root: string; sessionId: string; core: string;
  caller: string; callerCreated: number; space: string; callerTab: string; callerPane: string;
  placement: CoreMonitorPlacement; scope: string; token: string; argv: string[];
  pane: string; tab: string; lower: string;
  stage: 'run_pending' | 'attach_pending' | 'submitted' | 'close_pending' | 'closed';
  terminal?: string; created?: number;
}
const title = 'Intercom monitor';
const scopeLabel = 'pi-intercom.monitor.scope';
const tokenLabel = 'pi-intercom.monitor.token';
const fail = (why: string) => new Error(`Intercom core monitor: ${why}`);
const object = (v: any) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v: any): v is string => typeof v === 'string' && v.length > 0 && v.length <= 4096 && !/[\x00-\x1f\x7f]/.test(v);
const positive = (v: any) => Number.isSafeInteger(v) && v > 0;
const uuid = () => randomUUID().replaceAll('-', '');
const hash = (v: string) => createHash('sha256').update(v).digest('hex');

/** Deliberately narrower than the app's general layout language. In particular,
 * stacks, floats and dynamic tab/agent blocks cannot prove unique pane ownership.
 * Unknown metadata is retained, but unknown topology fails before terminal.run.
 * Source contract: herdr-app v0.1.13 mirror.rs/model.rs/layout.rs/window.rs. */
function layout(snapshot: any): any {
  if (!Number.isSafeInteger(snapshot?.version) || snapshot.version < 0 || !object(snapshot.value) ||
      !Array.isArray(snapshot.value.spaces) || snapshot.value.spaces.length > 256) throw fail('unsupported layout document');
  const value = structuredClone(snapshot.value);
  const terminals = new Set<string>();
  let count = 0;
  for (const space of value.spaces) {
    if (!object(space) || !text(space.id) || space.id.includes('/') || !Array.isArray(space.tabs) || space.tabs.length > 512 ||
        (space.name !== undefined && typeof space.name !== 'string') ||
        (space.folder !== undefined && typeof space.folder !== 'string') || space.machine != null) throw fail('unsupported machine-owned space');
    for (const tab of space.tabs) {
      if (!object(tab) || !text(tab.id) || tab.id.includes('/') || tab.root?.id !== tab.id || !['row', 'column'].includes(tab.root?.type)) throw fail('unsupported tab root');
      const visit = (node: any, depth: number) => {
        if (++count > 4096 || depth > 64 || !object(node) || !text(node.id) || node.id.includes('/') ||
            (node.floating !== undefined && (!Array.isArray(node.floating) || node.floating.length !== 0))) throw fail('unsupported or excessive layout topology');
        if ((node.hidden !== undefined && typeof node.hidden !== 'boolean') ||
            ['min', 'max'].some(k => node[k] != null && (!Number.isFinite(node[k]) || node[k] < 0)) ||
            (node.size != null && (!object(node.size) || Object.keys(node.size).length !== 1 ||
              !Object.entries(node.size).every(([k, v]) => ['px', 'weight'].includes(k) && typeof v === 'number' && Number.isFinite(v) && v > 0)))) throw fail('unsupported layout sizing');
        if (node.type === 'block') {
          if (node.children !== undefined || !object(node.content)) throw fail('unsupported block schema');
          const content = node.content;
          if (typeof content.terminal === 'string' && Object.keys(content).length === 1) {
            terminalAddress(content.terminal);
            if (terminals.has(content.terminal)) throw fail('ambiguous terminal panes');
            terminals.add(content.terminal);
          } else if (!(text(content.mod) && Object.keys(content).every(k => ['mod', 'props'].includes(k)))) throw fail('unsupported block content');
        } else if (['row', 'column'].includes(node.type) && Array.isArray(node.children) && node.content === undefined) {
          for (const child of node.children) visit(child, depth + 1);
        } else throw fail('unsupported layout node schema');
      };
      visit(tab.root, 0);
    }
  }
  // The subsequent locateTerminalTab invocation also validates globally unique
  // space/tab/node IDs (root repeats tab ID) and exactly one caller mapping.
  return value;
}
function live(record: any, address: string): void {
  if (record?.address !== address || record.state !== 'live' || !positive(record.created_ms)) throw fail('terminal identity is not live');
}
function callerAt(record: any, value: any, address: string) {
  live(record, address);
  const at = locateTerminalTab(value, address);
  if (record.labels?.['herdr.space'] !== at.space.id || record.labels?.['herdr.tab'] !== at.tab.id) throw fail('caller labels disagree with layout');
  return at;
}
function sameCaller(owner: Owner, record: any, value: any) {
  const at = callerAt(record, value, owner.caller);
  if (record.created_ms !== owner.callerCreated || at.space.id !== owner.space || at.tab.id !== owner.callerTab || at.pane.id !== owner.callerPane) throw fail('caller moved or identity changed');
  return at;
}
function monitorIdentity(record: any, owner: Owner): void {
  if (!owner.terminal || !positive(owner.created)) throw fail('missing created terminal proof');
  live(record, owner.terminal);
  if (record.created_ms !== owner.created || !isDeepStrictEqual(record.argv, owner.argv) || record.cwd !== owner.root ||
      record.labels?.[scopeLabel] !== owner.scope || record.labels?.[tokenLabel] !== owner.token ||
      record.keep !== false || record.notify !== false || record.die_with_parent !== false || record.template != null ||
      record.parent !== owner.caller || record.labels?.['herdr.space'] || record.labels?.['herdr.tab']) throw fail('monitor terminal ownership changed');
}
function validateOwner(state: any, root: string, session: string, core: string, scope: string): asserts state is Owner {
  if (!object(state) || state.version !== 2 || state.backend !== 'herdr-core') throw fail('legacy/unknown ownership record cannot grant core ownership');
  if (state.root !== root || state.sessionId !== session || state.core !== core || state.scope !== scope) throw fail('ownership scope or core identity differs; no automatic changes');
  if (!['run_pending', 'attach_pending', 'submitted', 'close_pending', 'closed'].includes(state.stage) || !['coordinator-tab', 'new-tab'].includes(state.placement) ||
      !['caller', 'space', 'callerTab', 'callerPane', 'token', 'pane', 'tab', 'lower'].every(k => text(state[k])) ||
      !/^[0-9a-f]{32}$/.test(state.token) || !positive(state.callerCreated) ||
      !Array.isArray(state.argv) || state.argv.length !== 4 || !state.argv.every(text) || state.argv[2] !== '--root' || state.argv[3] !== root ||
      (state.stage !== 'run_pending' && (!text(state.terminal) || !positive(state.created)))) throw fail('invalid monitor ownership record');
  terminalAddress(state.caller);
  if (state.terminal !== undefined) terminalAddress(state.terminal);
}
function ownedPane(value: any, owner: Owner) {
  const at = locateTerminalTab(value, owner.terminal!);
  if (at.space.id !== owner.space || at.tab.id !== owner.tab || at.pane.id !== owner.pane || at.pane.title !== title || owner.terminal === owner.caller) throw fail('owned monitor pane moved or changed');
  if (owner.placement === 'coordinator-tab') {
    const root = at.tab.root;
    if (owner.tab !== owner.callerTab || root.type !== 'column' || root.children.length !== 2 ||
        root.children[0] !== at.pane || at.pane.size?.weight !== 1 || root.children[1].id !== owner.lower || root.children[1].size?.weight !== 3) throw fail('monitor placement changed; no automatic rearrangement');
  } else if (owner.tab === owner.callerTab) throw fail('monitor is no longer in a separate tab');
  return at;
}
function attach(value: any, owner: Owner, terminal: string) {
  const at = locateTerminalTab(value, owner.caller);
  const block = { id: owner.pane, type: 'block', title, content: { terminal }, size: { weight: 1 } };
  if (owner.placement === 'new-tab') {
    at.space.tabs.push({ id: owner.tab, name: title, root: { id: owner.tab, type: 'row', children: [block] } });
  } else {
    // Preserve every old subtree/field, except the old root's identity and its
    // newly assigned share. Pane IDs (and therefore private focus) remain valid.
    const lower = { ...at.tab.root, id: owner.lower, size: { weight: 3 } };
    at.tab.root = { id: at.tab.id, type: 'column', children: [block, lower] };
  }
  const validated = layout({ version: 0, value });
  locateTerminalTab(validated, owner.caller);
  locateTerminalTab(validated, terminal); // Also catches generated-ID collisions.
  if (Buffer.byteLength(JSON.stringify(value)) > 1000000) throw fail('layout too large for a bounded core document request');
  return value;
}

/** Explicit open only. This edits the local core's machine-owned document; a
 * remote Windows app qualifies its IDs when projecting it. No app commands,
 * window launch, focus changes, terminal labels for auto-adoption, or retries.
 * Success proves shared data, NOT attached-window rendering or process readiness. */
export async function ensureCoreMonitorPane(options: CoreMonitorOptions): Promise<CoreMonitorResult> {
  if (!['coordinator-tab', 'new-tab'].includes(options.placement ?? '')) throw fail('explicit monitor placement required');
  if (!['linux', 'win32'].includes(options.platform ?? process.platform)) throw fail('only Linux/Windows supported');
  const env = options.env ?? process.env;
  const caller = env.HC_TERMINAL_ID;
  terminalAddress(caller);
  const node = options.node ?? process.execPath;
  if (!text(options.sessionId) || ![options.root, options.script, node].every(v => text(v) && path.isAbsolute(v)) ||
      !/^node(?:\.exe)?$/i.test(path.basename(node))) throw fail('explicit absolute root/script/plain-node executable and session required');
  const check = () => options.assertCurrent?.();
  check();
  // All identity reads and mutations share one verified connection. Repeated
  // coreCall invocations reconnect and cannot bind this multi-step operation.
  if (!options.call || options.call === coreCall) {
    return withCoreSession(call => ensureCoreMonitorPane({ ...options, call }), { endpoint: env.HC_SOCKET });
  }
  const root = await realpath(options.root);
  const invoke = options.call;
  const call: CoreCall = async (method, params) => { check(); const result = await invoke(method, params); check(); return result; };
  const identify = async () => {
    const status = await call('server.status', {});
    const version = typeof status?.version === 'string' ? /^(\d+)\.(\d+)\.(\d+)$/.exec(status.version) : null;
    if (!text(status?.core?.id) || !version || (Number(version[1]) === 0 && (Number(version[2]) < 1 || (Number(version[2]) === 1 && Number(version[3]) < 18)))) throw fail('core 0.1.18+ with permanent server identity required');
    return status.core.id as string;
  };
  const core = await identify();
  const sameCore = async () => { if (await identify() !== core) throw fail('core identity changed; no retry'); };
  const key = hash(options.sessionId).slice(0, 24);
  const scope = hash(JSON.stringify([root, options.sessionId, core]));
  const directory = path.join(root, '.pi-intercom');
  check(); await mkdir(directory, { recursive: true }); check();
  // Share the legacy lock. Completed legacy records can be retired on backend
  // transition, never adopted as core ownership. Uncertain intents stay fenced.
  const file = path.join(directory, `monitor-${key}.json`), lock = `${file}.lock`;
  let handle;
  try { handle = await open(lock, 'wx', 0o600); await handle.close(); }
  catch { throw fail(`monitor locked; inspect ${lock}; no automatic recovery`); }
  let state: Owner | undefined;
  let retire = false, creationAttempted = false;
  const save = async () => {
    check();
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      const output = await open(temporary, 'wx', 0o600);
      try { await output.writeFile(JSON.stringify(state)); await output.sync(); } finally { await output.close(); }
      check(); await rename(temporary, file);
      // fsync the rename on Unix. Windows cannot open directories for fsync;
      // it still gets the flushed file + same-directory atomic rename ledger.
      if (process.platform !== 'win32') {
        const dir = await open(directory, 'r');
        try { await dir.sync(); } finally { await dir.close(); }
      }
      check();
    } finally { await unlink(temporary).catch(() => {}); }
  };
  try {
    try { state = JSON.parse(await readFile(file, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (state !== undefined) {
      const legacy = state as any;
      if (object(legacy) && legacy.version === 1 && legacy.sessionId === options.sessionId &&
          ['submitted', 'observed', 'closed'].includes(legacy.stage) &&
          text(legacy.workspace) && text(legacy.caller) && text(legacy.pane) &&
          (legacy.placement === undefined || ['coordinator-tab', 'new-tab'].includes(legacy.placement))) {
        // Backend-specific IDs cannot identify anything on this core. Preserve
        // the old record as history, not as an active creation/ownership fence.
        retire = true; state = undefined;
      }
    }
    if (state !== undefined) {
      validateOwner(state, root, options.sessionId, core, scope);
      if (state.caller !== caller) throw fail('ownership differs from current caller');
      if (state.stage === 'closed') state = undefined;
      else {
        if (state.placement !== options.placement) throw fail('monitor already exists in a different placement; close it first');
        if (state.stage !== 'submitted') throw fail(`partial launch (${state.stage}); inspect manually, no retry or duplicate`);
      }
    }
    const record = await call('terminal.get', { terminal: caller });
    const snapshot = await call('doc.get', { name: 'herdr-app' });
    const value = layout(snapshot);
    const at = callerAt(record, value, caller);
    const inventory = await call('terminal.list', { all: false, labels: { [scopeLabel]: scope } });
    if (!Array.isArray(inventory?.terminals) || inventory.terminals.some((t: any) => !text(t?.address) || t.labels?.[scopeLabel] !== scope) ||
        new Set(inventory.terminals.map((t: any) => t.address)).size !== inventory.terminals.length) throw fail('ambiguous monitor inventory');
    if (state && inventory.terminals.length === 0) {
      sameCaller(state, record, value);
      const references = (node: any): boolean => node.id === state!.pane || node.content?.terminal === state!.terminal || (node.children ?? []).some(references);
      const referenced = value.spaces.some((s: any) => s.tabs.some((t: any) => references(t.root)));
      if (!referenced) {
        // A complete successful inventory is absence evidence. RPC failures are
        // not. Include finished records so a hidden live process is not lost.
        const all = await call('terminal.list', { all: true });
        if (!Array.isArray(all?.terminals) || all.hidden_finished !== 0 || all.terminals.length > 4096 ||
            all.terminals.some((t: any) => !text(t?.address) || !['live', 'finished'].includes(t.state)) ||
            new Set(all.terminals.map((t: any) => t.address)).size !== all.terminals.length) throw fail('ambiguous complete monitor inventory');
        const old = all.terminals.find((t: any) => t.address === state!.terminal);
        if (old && (old.state !== 'finished' || old.created_ms !== state.created)) throw fail('monitor still exists or identity changed');
        if (all.terminals.some((t: any) => t.state === 'live' && t.labels?.[scopeLabel] === scope)) throw fail('monitor inventory changed');
        await sameCore();
        retire = true; state = undefined;
      }
    }
    if (state) {
      if (inventory.terminals.length !== 1 || inventory.terminals[0].address !== state.terminal) throw fail('owned monitor inventory missing or ambiguous; no duplicate');
      sameCaller(state, record, value);
      monitorIdentity(await call('terminal.get', { terminal: state.terminal }), state);
      ownedPane(value, state);
      await sameCore();
      return { outcome: 'existing owned monitor preserved; readiness and remote rendering not checked', pane: state.pane, terminal: state.terminal };
    }
    if (inventory.terminals.length) throw fail('unowned monitor terminal exists; no adoption or duplicate');
    const hasMarker = (node: any): boolean => [title, `${title} [${options.sessionId}]`].includes(node.title) || (node.children ?? []).some(hasMarker);
    if (at.space.tabs.some((t: any) => t.name === title || hasMarker(t.root))) throw fail('unowned monitor layout marker exists in caller space');
    if (options.placement === 'coordinator-tab' && (at.tab.root.hidden === true || at.tab.root.min != null || at.tab.root.max != null || at.tab.root.size != null)) throw fail('constrained caller root cannot guarantee quarter-height placement');
    await access(options.script); await access(node); check();
    if (retire) {
      await sameCore(); check();
      await rename(file, `${file}.retired-${randomUUID()}`);
      check();
    }
    state = {
      version: 2, backend: 'herdr-core', root, sessionId: options.sessionId, core, caller, callerCreated: record.created_ms,
      space: at.space.id, callerTab: at.tab.id, callerPane: at.pane.id, placement: options.placement!, scope, token: uuid(),
      argv: [node, options.script, '--root', root],
      pane: `p${uuid()}`, tab: options.placement === 'new-tab' ? `tb${uuid()}` : at.tab.id, lower: `s${uuid()}`, stage: 'run_pending',
    };
    // Validate structure/size/collisions before any external effect. t + 255
    // characters reserves more space than a normal core-issued address needs.
    attach(structuredClone(value), state, `t${'z'.repeat(255)}`);
    await save(); // Durable intent MUST precede terminal.run, including timeouts.
    await sameCore();
    const before = await call('doc.get', { name: 'herdr-app' });
    sameCaller(state, await call('terminal.get', { terminal: caller }), layout(before));
    if (!isDeepStrictEqual(before, snapshot)) throw fail('layout changed before launch; no automatic retry');
    creationAttempted = true;
    const created = await call('terminal.run', {
      argv: state.argv, cwd: root, caller, parent: caller, outlive_parent: true,
      no_notify: true, keep: false, rm: false, wait: false,
      // DO NOT set herdr.space/tab: app auto-adoption races our CAS and turns
      // keep on. The shared document itself makes this terminal visible.
      labels: { [scopeLabel]: scope, [tokenLabel]: state.token },
    });
    terminalAddress(created?.address);
    if (created.address.length > 256 || created.address === caller) throw fail('run returned invalid/new terminal identity');
    state.terminal = created.address; state.created = created.created_ms;
    monitorIdentity(created, state);
    state.stage = 'attach_pending'; await save();
    await sameCore();
    monitorIdentity(await call('terminal.get', { terminal: state.terminal }), state);
    const fresh = await call('doc.get', { name: 'herdr-app' });
    const freshValue = layout(fresh);
    sameCaller(state, await call('terminal.get', { terminal: caller }), freshValue);
    if (!isDeepStrictEqual(locateTerminalTab(freshValue, caller).tab.root, at.tab.root)) throw fail('caller layout changed during launch');
    const updated = attach(freshValue, state, state.terminal!);
    await sameCore();
    const written = await call('doc.set', { name: 'herdr-app', version: fresh.version, value: updated });
    if (!Number.isSafeInteger(written?.version) || written.version !== fresh.version + 1) throw fail('layout acknowledgment uncertain; do not replay');
    await sameCore();
    const observed = await call('doc.get', { name: 'herdr-app' });
    const observedValue = layout(observed);
    if (observed.version < written.version) throw fail('layout version regressed');
    sameCaller(state, await call('terminal.get', { terminal: caller }), observedValue);
    monitorIdentity(await call('terminal.get', { terminal: state.terminal }), state);
    ownedPane(observedValue, state);
    state.stage = 'submitted'; await save();
    return { outcome: 'monitor attached in shared layout; readiness and remote Windows rendering not verified', pane: state.pane, terminal: state.terminal };
  } catch (error) {
    const reason = error instanceof Error ? error.message.replace(/^Intercom core monitor: /, '') : String(error);
    throw fail(creationAttempted ? `${reason}. Terminal ${state?.terminal ?? 'unknown'} may remain; no automatic cleanup or retry.` : reason);
  } finally { await unlink(lock).catch(() => {}); }
}

/** Best-effort owned-monitor close: reject existing live descendants, persist a
 * fence, recheck identity and inventory, stop once, then remove only its pane.
 * Core completion may cascade to die_with_parent children; other clients must
 * not concurrently attach children to this owned monitor. This is not an atomic
 * child-registration barrier or an all-descendants guarantee. Uncertainty stays
 * fenced and never authorizes replay. No whole-tab close command is issued. */
export async function closeCoreMonitorPane(options: CoreMonitorOptions): Promise<CoreMonitorResult> {
  if (!['linux', 'win32'].includes(options.platform ?? process.platform)) throw fail('close unsupported on this platform; no terminal or layout changes performed');
  const env = options.env ?? process.env;
  const caller = env.HC_TERMINAL_ID;
  terminalAddress(caller);
  if (!text(options.sessionId) || !text(options.root) || !path.isAbsolute(options.root)) throw fail('explicit absolute root and session required');
  const check = () => options.assertCurrent?.();
  check();
  if (!options.call || options.call === coreCall) {
    return withCoreSession(call => closeCoreMonitorPane({ ...options, call }), { endpoint: env.HC_SOCKET });
  }
  const invoke = options.call;
  const call: CoreCall = async (method, params) => { check(); const result = await invoke(method, params); check(); return result; };
  const root = await realpath(options.root);
  const key = hash(options.sessionId).slice(0, 24);
  const file = path.join(root, '.pi-intercom', `monitor-${key}.json`), lock = `${file}.lock`;
  // Use the same exclusive lock as open, without creating a missing owner dir.
  let handle;
  try { check(); handle = await open(lock, 'wx', 0o600); await handle.close(); }
  catch { throw fail('close ownership unavailable or monitor locked; no automatic recovery'); }
  try {
    const state = JSON.parse(await readFile(file, 'utf8'));
    const status = await call('server.status', {});
    if (status?.version !== '0.1.18' || !text(status?.core?.id)) throw fail('close preflight requires reviewed core 0.1.18 identity');
    const core = status.core.id;
    validateOwner(state, root, options.sessionId, core, hash(JSON.stringify([root, options.sessionId, core])));
    if (state.caller !== caller) throw fail('ownership differs from current caller');
    if (state.stage !== 'submitted') throw fail(`partial launch (${state.stage}); inspect manually, no close or retry`);
    const snapshot = await call('doc.get', { name: 'herdr-app' });
    const value = layout(snapshot);
    sameCaller(state, await call('terminal.get', { terminal: caller }), value);
    monitorIdentity(await call('terminal.get', { terminal: state.terminal }), state);
    ownedPane(value, state);
    // NEVER filter by monitor labels: child workers do not inherit our labels.
    // Include finished records to find live grandchildren behind finished parents.
    const inventory = await call('terminal.list', { all: true });
    if (!Array.isArray(inventory?.terminals) || inventory.terminals.length > 4096) throw fail('ambiguous descendant inventory');
    const records = new Map<string, any>(), children = new Map<string, string[]>();
    for (const record of inventory.terminals) {
      if (!text(record?.address) || !['live', 'finished'].includes(record.state) ||
          (record.parent != null && !text(record.parent)) || records.has(record.address)) throw fail('ambiguous descendant inventory');
      records.set(record.address, record);
      if (record.parent != null) children.set(record.parent, [...(children.get(record.parent) ?? []), record.address]);
    }
    monitorIdentity(records.get(state.terminal!), state);
    const seen = new Set<string>([state.terminal!]), pending = [state.terminal!];
    while (pending.length) {
      for (const child of children.get(pending.pop()!) ?? []) {
        if (seen.has(child)) throw fail('cyclic descendant inventory');
        seen.add(child);
        if (records.get(child).state === 'live') throw fail('close refused: live monitor descendant exists; no terminal or layout changes performed');
        pending.push(child);
      }
    }
    const finalStatus = await call('server.status', {});
    if (finalStatus?.core?.id !== core || finalStatus.version !== status.version) throw fail('core identity changed; no retry');
    // Best-effort identity/descendant preflight, not an atomic child-registration
    // barrier. Do not run another task between the final checks and submission.
    const save = async () => {
      check();
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        const output = await open(temporary, 'wx', 0o600);
        try { await output.writeFile(JSON.stringify(state)); await output.sync(); } finally { await output.close(); }
        check(); await rename(temporary, file); check();
      } finally { await unlink(temporary).catch(() => {}); }
    };
    state.stage = 'close_pending'; await save();
    const finalSnapshot = await call('doc.get', { name: 'herdr-app' });
    const finalValue = layout(finalSnapshot);
    sameCaller(state, await call('terminal.get', { terminal: caller }), finalValue);
    monitorIdentity(await call('terminal.get', { terminal: state.terminal }), state);
    ownedPane(finalValue, state);
    // A new terminal since the checked inventory requires inspection, not a kill.
    const finalInventory = await call('terminal.list', { all: true });
    const inventoryIdentity = (value: any) => {
      if (!Array.isArray(value?.terminals) || value.terminals.length > 4096) throw fail('ambiguous final descendant inventory');
      return value.terminals.map((r: any) => [r.address, r.parent ?? null, r.state, r.created_ms ?? null])
        .sort((a: any[], b: any[]) => String(a[0]).localeCompare(String(b[0])));
    };
    if (!isDeepStrictEqual(inventoryIdentity(finalInventory), inventoryIdentity(inventory))) throw fail('terminal inventory changed before close; pending fence retained');
    await call('terminal.kill', { terminal: state.terminal });
    let ended;
    for (let attempt = 0; attempt < 10; attempt++) {
      ended = await call('terminal.get', { terminal: state.terminal });
      if (ended?.address !== state.terminal || ended.created_ms !== state.created) throw fail('terminal identity changed after stop; pending fence retained');
      if (ended.state === 'finished') break;
      if (ended.state !== 'live') throw fail('terminal stop state ambiguous; pending fence retained');
      if (attempt < 9) await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (ended.state !== 'finished') throw fail('terminal stop not confirmed; pending fence retained');
    const after = await call('doc.get', { name: 'herdr-app' });
    const remaining = layout(after);
    sameCaller(state, await call('terminal.get', { terminal: caller }), remaining);
    const nodes: any[] = [];
    const visit = (node: any) => { nodes.push(node); for (const child of node.children ?? []) visit(child); };
    for (const space of remaining.spaces) for (const tab of space.tabs) visit(tab.root);
    const target = nodes.filter(n => n.content?.terminal === state.terminal || n.id === state.pane);
    if (target.length) {
      ownedPane(remaining, state);
      const space = remaining.spaces.find((s: any) => s.id === state.space);
      const tab = space.tabs.find((t: any) => t.id === state.tab);
      if (state.placement === 'coordinator-tab') {
        const lower = tab.root.children[1];
        tab.root = { ...lower, id: state.tab }; delete tab.root.size;
      } else {
        const remove = (node: any): boolean => {
          if (!Array.isArray(node.children)) return false;
          const index = node.children.findIndex((n: any) => n.id === state.pane);
          if (index >= 0) { node.children.splice(index, 1); return true; }
          return node.children.some(remove);
        };
        if (!remove(tab.root)) throw fail('owned pane removal cannot be proved');
        if (tab.root.children.length === 0 && !(tab.root.floating?.length)) space.tabs.splice(space.tabs.indexOf(tab), 1);
      }
      layout({ version: after.version, value: remaining });
      locateTerminalTab(remaining, caller);
      const write = await call('doc.set', { name: 'herdr-app', version: after.version, value: remaining });
      if (write?.version !== after.version + 1) throw fail('pane removal acknowledgment uncertain');
    }
    const confirmed = await call('doc.get', { name: 'herdr-app' });
    const confirmedValue = layout(confirmed);
    sameCaller(state, await call('terminal.get', { terminal: caller }), confirmedValue);
    const contains = (node: any): boolean => node.id === state.pane || node.content?.terminal === state.terminal || (node.children ?? []).some(contains);
    if (confirmedValue.spaces.some((s: any) => s.tabs.some((t: any) => contains(t.root)))) throw fail('monitor pane absence not confirmed');
    state.stage = 'closed'; await save();
    return { outcome: 'owned monitor terminal finished and pane absence confirmed; no all-descendants guarantee', pane: state.pane, terminal: state.terminal };
  } finally { await unlink(lock).catch(() => {}); }
}
