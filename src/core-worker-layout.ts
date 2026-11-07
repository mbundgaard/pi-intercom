import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { coreCall, locateTerminalTab, terminalAddress, type CoreCall } from './herdr-core.js';

/** Source-pinned adapter, NOT a public app-layout schema or a UI readiness probe.
 * hc 0.1.18's public doc API treats values as opaque JSON. The layout below is
 * backed by herdr-app 0.1.13 src/{mirror,mirror_sync,model,window}.rs:
 * - Document::capture/replace uses machine-local IDs; View owns private focus.
 * - Tab::new uses a row whose ID is the tab ID and one terminal block.
 * - Model::fresh_id uses a prefix and 32 random hexadecimal digits.
 * - window::reconcile/start_adoption consumes placement labels. Therefore write
 *   and verify the document BEFORE labeling, never copy the caller's labels.
 * Unknown metadata is retained. Unsupported/ambiguous trees fail closed.
 */
const DOCUMENT = 'herdr-app';
const error = (message: string) => new Error(`PiIntercom HC worker layout: ${message}`);
const positiveInteger = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) > 0;

export interface CoreWorkerLayoutRequest {
  caller: string;
  cwd: string;
  /** Canonically equal to cwd; runtime remains responsible for realpath checks. */
  workspaceRoot: string;
  platform?: string;
  /** Optional already-known resumed worker name; reload uses renameCoreTab later. */
  name?: string;
}

export interface CoreWorkerLayoutPreflight {
  readonly caller: string;
  readonly callerCreatedMs: number;
  readonly coreId: string;
  readonly space: string;
  readonly tab: string;
  readonly pane: string;
  readonly version: number;
  readonly startedAtMs: number;
  readonly cwd: string;
  readonly platform: string;
  readonly name: string;
}

export interface CoreWorkerLayoutAttachment {
  terminal: string;
  terminalCreatedMs: number;
  coreId: string;
  space: string;
  tab: string;
  pane: string;
  version: number;
  layoutConfirmed: true;
  uiAcknowledged: false;
}

/** All attach failures are post-creation uncertainty, including validation and
 * CAS conflicts. No cleanup, retry, replacement, fallback, or terminal killing.
 * The launcher must propagate this to its existing uncertain-launch fence. */
export class CoreWorkerLayoutUncertainError extends Error {
  readonly outcomeUncertain = true;
  constructor() {
    super('PiIntercom HC worker layout attachment failed; outcome unknown, terminal/process and app tab may remain; no automatic cleanup/retry/replacement or fallback');
    this.name = 'CoreWorkerLayoutUncertainError';
  }
}

// A ticket is one attempt in this process, not persisted launch authorization.
const tickets = new WeakSet<CoreWorkerLayoutPreflight>();

function normalizeCwd(value: unknown, platform: string): string {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || !paths.isAbsolute(value)) throw error('absolute root cwd required');
  return platform === 'win32' ? paths.resolve(value).toLowerCase() : paths.resolve(value);
}

function live(record: any, address: string, createdMs?: number): void {
  if (record?.address !== address || record.state !== 'live' || !positiveInteger(record.created_ms) ||
    (createdMs !== undefined && record.created_ms !== createdMs)) throw error('terminal identity is not live or changed');
}

async function identity(call: CoreCall, expected?: string): Promise<string> {
  // CoreInfo.id is available in the verified hc 0.1.18 schema. Do not silently
  // degrade an unavailable identity check into address-only ownership.
  const status = await call('server.status', {});
  const id = status?.core?.id;
  if (typeof id !== 'string' || !id.trim() || (expected !== undefined && id !== expected)) throw error('current core identity unavailable or changed');
  return id;
}

function snapshot(value: any): { version: number; value: any } {
  if (!Number.isSafeInteger(value?.version) || value.version < 0 || !value.value || typeof value.value !== 'object') throw error('app document unavailable');
  if (Buffer.byteLength(JSON.stringify(value.value), 'utf8') > 1024 * 1024) throw error('app document exceeds core limit');
  return value;
}

/** locateTerminalTab supplies bounded tree/ID checks. Additionally reject
 * qualified IDs and inspect floating blocks so they cannot conceal a duplicate
 * terminal or collide with a generated ID. Stack layouts are not supported by
 * the shared locator and are deliberately rejected, not rewritten. */
function inspect(value: any, caller: string): { location: ReturnType<typeof locateTerminalTab>; ids: Set<string>; terminals: Set<string> } {
  const location = locateTerminalTab(value, caller);
  const ids = new Set<string>(), terminals = new Set<string>();
  const localId = (id: string) => {
    if (!id || id.length > 256 || /[\/\x00-\x20\x7f]/.test(id)) throw error('nonlocal app identity');
    ids.add(id);
  };
  const content = (v: any) => {
    if (v?.terminal !== undefined) {
      terminalAddress(v.terminal);
      if (terminals.has(v.terminal)) throw error('duplicate terminal placement');
      terminals.add(v.terminal);
    }
  };
  let floats = 0;
  const node = (v: any) => {
    localId(v.id);
    if (v.type === 'block') content(v.content);
    if (v.floating !== undefined) {
      if (!Array.isArray(v.floating)) throw error('invalid floating blocks');
      for (const f of v.floating) {
        if (++floats > 4096 || typeof f?.id !== 'string' || ids.has(f.id)) throw error('ambiguous floating identity');
        localId(f.id); content(f.content);
      }
    }
    if (v.type !== 'block') for (const c of v.children) node(c);
  };
  // Reserve all regular IDs before inspecting floats for cross-tree collisions.
  const reserve = (v: any) => { localId(v.id); if (v.type !== 'block') for (const c of v.children) reserve(c); };
  for (const s of value.spaces) { localId(s.id); for (const t of s.tabs) { localId(t.id); reserve(t.root); } }
  for (const s of value.spaces) for (const t of s.tabs) node(t.root);
  return { location, ids, terminals };
}

/** Call BEFORE hc run. Read-only: missing app document/mapping refuses launch.
 * Labels are not authority: the current document must contain the caller once.
 * This proves shared state, not that a remote window is connected/rendering. */
export async function preflightCoreWorkerLayout(request: CoreWorkerLayoutRequest, call: CoreCall = coreCall): Promise<CoreWorkerLayoutPreflight> {
  const startedAtMs = Date.now();
  terminalAddress(request.caller);
  const platform = request.platform ?? process.platform;
  if (platform !== 'linux' && platform !== 'win32') throw error('unsupported platform');
  const cwd = normalizeCwd(request.cwd, platform);
  if (normalizeCwd(request.workspaceRoot, platform) !== cwd) throw error('worker cwd must equal workspace root');
  const name = request.name ?? 'Intercom (anonymous)';
  if (typeof name !== 'string' || !name.trim() || name.length > 128 || /[\x00-\x1f\x7f]/.test(name)) throw error('invalid tab name');
  const coreId = await identity(call);
  const caller = await call('terminal.get', { terminal: request.caller });
  live(caller, request.caller);
  const doc = snapshot(await call('doc.get', { name: DOCUMENT }));
  const { location } = inspect(doc.value, request.caller);
  if (location.space.tabs.length >= 512) throw error('app tab limit reached');
  await identity(call, coreId);
  live(await call('terminal.get', { terminal: request.caller }), request.caller, caller.created_ms);
  const ticket = Object.freeze({ caller: request.caller, callerCreatedMs: caller.created_ms, coreId,
    space: location.space.id, tab: location.tab.id, pane: location.pane.id,
    version: doc.version, startedAtMs, cwd, platform, name });
  tickets.add(ticket);
  return ticket;
}

function worker(record: any, ticket: CoreWorkerLayoutPreflight, address: string, createdMs: number): void {
  live(record, address, createdMs);
  if (record.parent !== ticket.caller || record.first_message != null ||
    normalizeCwd(record.cwd, ticket.platform) !== ticket.cwd ||
    (record.foreground != null && normalizeCwd(record.foreground.cwd, ticket.platform) !== ticket.cwd)) throw error('worker root cwd/parent differs from launch');
}

/** Call once AFTER hc run, with its full parsed RunResult (created_ms required).
 * Appends exactly one dedicated tab in the caller's AUTHORITATIVE CURRENT space,
 * using the current doc version, not the preflight version. No focus mutations.
 * Returns shared-state confirmation only, never UI/Pi readiness. */
export async function attachCoreWorkerLayout(ticket: CoreWorkerLayoutPreflight, created: unknown, call: CoreCall = coreCall): Promise<CoreWorkerLayoutAttachment> {
  try {
    if (!tickets.delete(ticket)) throw error('preflight ticket absent or already consumed');
    const result = created as any;
    terminalAddress(result?.address);
    if (result.address === ticket.caller || !positiveInteger(result.created_ms) || result.created_ms < ticket.startedAtMs) throw error('worker is not a fresh launch identity');
    const address: string = result.address, createdMs: number = result.created_ms;
    worker(result, ticket, address, createdMs);
    await identity(call, ticket.coreId);
    live(await call('terminal.get', { terminal: ticket.caller }), ticket.caller, ticket.callerCreatedMs);
    const record = await call('terminal.get', { terminal: address });
    worker(record, ticket, address, createdMs);
    // A pre-labeled worker may already have triggered app adoption. Do not
    // race it, move it, borrow its tab, or attempt to undo that operation.
    const unplaced = (r: any) => {
      if (r.labels?.['herdr.space'] || r.labels?.['herdr.tab']) throw error('worker already has placement labels');
    };
    unplaced(record);
    const doc = snapshot(await call('doc.get', { name: DOCUMENT }));
    if (doc.version < ticket.version) throw error('app document version regressed since preflight');
    const value = structuredClone(doc.value);
    const { location, ids, terminals } = inspect(value, ticket.caller);
    if (terminals.has(address) || location.space.tabs.length >= 512) throw error('worker already placed or app tab limit reached');
    const tab = `tb${randomUUID().replaceAll('-', '')}`, pane = `p${randomUUID().replaceAll('-', '')}`;
    if (ids.has(tab) || ids.has(pane) || tab === pane) throw error('generated app identity collision');
    const added = { id: tab, name: ticket.name, root: { id: tab, type: 'row', children: [{ id: pane, type: 'block', content: { terminal: address } }] } };
    location.space.tabs.push(added);
    inspect(value, ticket.caller); // Also enforce post-append tree bounds.
    snapshot({ version: doc.version, value });
    await identity(call, ticket.coreId);
    live(await call('terminal.get', { terminal: ticket.caller }), ticket.caller, ticket.callerCreatedMs);
    const fresh = await call('terminal.get', { terminal: address });
    worker(fresh, ticket, address, createdMs); unplaced(fresh);
    const written = await call('doc.set', { name: DOCUMENT, version: doc.version, value });
    if (!Number.isSafeInteger(written?.version) || written.version !== doc.version + 1) throw error('unconfirmed document write');
    const confirm = async () => {
      const observed = snapshot(await call('doc.get', { name: DOCUMENT }));
      if (observed.version < written.version) throw error('stale document readback');
      const current = inspect(observed.value, ticket.caller).location;
      const target = locateTerminalTab(observed.value, address);
      if (current.space.id !== location.space.id || target.space.id !== current.space.id ||
        target.tab.id !== tab || target.pane.id !== pane || !isDeepStrictEqual(target.tab, added)) throw error('placement readback differs');
      // At the written version, every field must roundtrip, including metadata.
      if (observed.version === written.version && !isDeepStrictEqual(observed.value, value)) throw error('document write differs');
      return observed.version;
    };
    await confirm();
    await identity(call, ticket.coreId);
    live(await call('terminal.get', { terminal: ticket.caller }), ticket.caller, ticket.callerCreatedMs);
    const beforeLabel = await call('terminal.get', { terminal: address });
    worker(beforeLabel, ticket, address, createdMs); unplaced(beforeLabel);
    const labels = { 'herdr.space': location.space.id, 'herdr.tab': tab };
    const labeled = await call('terminal.label', { terminal: address, labels });
    const verifyLabels = (r: any) => {
      worker(r, ticket, address, createdMs);
      if (r.labels?.['herdr.space'] !== labels['herdr.space'] || r.labels?.['herdr.tab'] !== tab) throw error('placement labels not confirmed');
    };
    verifyLabels(labeled);
    verifyLabels(await call('terminal.get', { terminal: address }));
    const version = await confirm();
    await identity(call, ticket.coreId);
    live(await call('terminal.get', { terminal: ticket.caller }), ticket.caller, ticket.callerCreatedMs);
    return { terminal: address, terminalCreatedMs: createdMs, coreId: ticket.coreId, space: location.space.id, tab, pane, version, layoutConfirmed: true, uiAcknowledged: false };
  } catch {
    // Do not leak transport payloads. This deliberately includes failures before
    // our CAS: hc run has already happened and cannot safely be replayed.
    throw new CoreWorkerLayoutUncertainError();
  }
}
