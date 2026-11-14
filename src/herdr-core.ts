import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import { isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import { lstat } from 'node:fs/promises';
import type { Readable, Writable } from 'node:stream';

export type CoreCall = (method: string, params: Record<string, unknown>) => Promise<any>;
const failure = (message: string) => new Error(`PiIntercom Herdr core: ${message}`);
const MAX_BYTES = 1024 * 1024;

// Product releases are not protocol versions. Gate on negotiated protocol and capabilities.
const versionLabel = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\x00-\x1f\x7f]/.test(value);
const object = (value: any): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value);
const identity = (value: any): boolean => object(value) && typeof value.id === 'string' && value.id.length > 0 &&
  value.id.length <= 256 && typeof value.name === 'string';
const statusValid = (value: any): boolean => object(value) && versionLabel(value.version) && identity(value.core) &&
  Number.isSafeInteger(value.pid) && value.pid > 0;
const sameCore = (a: any, b: any): boolean => a.id === b.id && a.name === b.name;
const READ_METHODS = new Set(['hello', 'server.status', 'terminal.get', 'terminal.list', 'doc.get']);

export interface CoreSessionOptions {
  /** Explicit documented HC_SOCKET endpoint; no endpoint discovery or path guessing. */
  endpoint?: string;
  /** Validate operation capabilities before permitting any mutation. */
  requiredMethods?: readonly string[];
  /** Test-only trusted seams. Supplying startClient requires readStatus. */
  startClient?: () => ChildProcessWithoutNullStreams;
  readStatus?: () => Promise<unknown>;
  /** Tests may shorten, never extend, the ten-second whole-operation deadline. */
  timeoutMs?: number;
}

/** Resolve only documented Unix defaults. An existing config may override the
 * socket, so require explicit HC_SOCKET rather than silently ignoring that file. */
export async function defaultCoreEndpoint(env: NodeJS.ProcessEnv = process.env, home = homedir(), uid = process.getuid?.()): Promise<string> {
  if (env.HC_SOCKET !== undefined) {
    if (!env.HC_SOCKET || !isAbsolute(env.HC_SOCKET) || env.HC_SOCKET.includes('\0')) throw failure('invalid explicit HC_SOCKET');
    return env.HC_SOCKET;
  }
  const session = env.HC_SESSION ?? 'default';
  if (!/^[a-zA-Z0-9_-]+$/.test(session) || session.trim() !== session || session.length > 64) throw failure('unsupported HC_SESSION; set explicit HC_SOCKET');
  const config = join(env.XDG_CONFIG_HOME || join(home, '.config'), 'herdr-core', 'config.toml');
  try { await lstat(config); throw failure('core config may override socket; set explicit HC_SOCKET'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  let runtime = env.XDG_RUNTIME_DIR;
  if (!runtime && uid !== undefined) {
    const candidate = `/run/user/${uid}`;
    try { if ((await lstat(candidate)).isDirectory()) runtime = candidate; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const base = runtime ? join(runtime, 'herdr-core') : join(env.XDG_STATE_HOME || join(home, '.local', 'state'), 'herdr-core', session);
  if (!isAbsolute(base)) throw failure('core endpoint root must be absolute');
  return join(base, `${session}.sock`);
}

function cliStatus(): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile('hc', ['server', 'status', '--json'], { windowsHide: true, timeout: 3000, maxBuffer: MAX_BYTES, encoding: 'utf8' }, (error, stdout) => {
      if (error) return reject(failure('existing core status preflight failed'));
      try { resolve(JSON.parse(stdout)); } catch { reject(failure('invalid core status preflight')); }
    });
  });
}

/** One bounded, sequential operation on ONE verified connection; never reconnects.
 * Core v0.1.18 schema hello + server.status bind protocol, version, permanent core
 * identity and (with CLI preflight) pid before the callback can send requests.
 * This is not cryptographic authentication or a boot nonce; local endpoint access
 * is the upstream trust boundary. The call handle expires with the callback.
 *
 * IMPORTANT: v0.1.18 cli.rs/server + platform/unix.rs status_may_start_core() show
 * `hc server status` ITSELF autostarts on Unix. Unix therefore connects directly
 * via HC_SOCKET or documented defaults (only when no config override can exist),
 * without starting a process.
 * Public contract: herdr-core v0.1.18 schema/README.md "Connecting" and
 * docs/security.md "State and endpoints". No undocumented endpoint discovery.
 * On Windows only, status is require_existing; preflight precedes hc connect.
 * That check is NOT atomic start avoidance: core could disappear before connect.
 * Use an explicit endpoint even on Windows when strict no-autostart is required.
 */
export async function withCoreSession<T>(operation: (call: CoreCall) => Promise<T>, options: CoreSessionOptions = {}): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 10000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 10000) throw failure('invalid session deadline');
  let input: Writable | undefined, output: Readable | undefined, cleanup: (() => void) | undefined;
  let closed = false, fatal: Error | undefined, mutationAttempted = false;
  let pending: { id: string; method: string; resolve: (value: any) => void; reject: (error: Error) => void } | undefined;
  let rejectSession!: (error: Error) => void;
  const failed = new Promise<never>((_, reject) => { rejectSession = reject; });
  const close = () => {
    if (closed) return;
    closed = true;
    try { cleanup?.(); } catch { /* Closing our transport must not mask the result. */ }
  };
  const fail = (reason: string) => {
    if (closed || fatal) return;
    fatal = Object.assign(failure(`${reason}; session unusable; ${mutationAttempted ? 'outcome uncertain; ' : ''}do not replay`), { uncertain: mutationAttempted });
    pending?.reject(fatal); pending = undefined;
    rejectSession(fatal);
    close();
  };
  const timer = setTimeout(() => fail('operation timed out'), timeoutMs);
  let methods: Set<string> | undefined, requests = 0, bytes = 0, buffer = '';
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const call: CoreCall = (method, params) => {
    if (closed || fatal) return Promise.reject(fatal ?? failure('session is closed; do not replay'));
    if (pending || ++requests > 64 || (methods && !methods.has(method))) {
      fail(methods && !methods.has(method) ? `unsupported API method ${method}` : 'concurrent or excessive API request');
      return Promise.reject(fatal);
    }
    const id = randomUUID();
    let request: string;
    try { request = `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`; }
    catch { fail('invalid API request'); return Promise.reject(fatal); }
    if (Buffer.byteLength(request) > MAX_BYTES) { fail('API request exceeded limit'); return Promise.reject(fatal); }
    return new Promise((resolve, reject) => {
      pending = { id, method, resolve, reject };
      if (!READ_METHODS.has(method)) mutationAttempted = true;
      try { input!.write(request, error => { if (error) fail('API request transport failed'); }); }
      catch { fail('API request transport failed'); }
    });
  };
  const run = async () => {
    let before: any;
    const endpoint = options.endpoint ?? process.env.HC_SOCKET ?? (!options.startClient && process.platform !== 'win32' ? await defaultCoreEndpoint() : undefined);
    if (options.startClient || !endpoint) {
      if (options.startClient && !options.readStatus) throw failure('test client requires status preflight');
      if (!options.startClient && process.platform !== 'win32') throw failure('explicit HC_SOCKET required: Unix hc server status/connect may autostart; no client started');
      before = await (options.readStatus ?? cliStatus)();
      if (closed) throw fatal;
      if (!statusValid(before)) throw failure('invalid core status identity; no client started');
      const child = options.startClient ? options.startClient() : spawn('hc', ['connect'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      input = child.stdin; output = child.stdout;
      cleanup = () => { child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.kill(); };
      child.on('error', () => fail('could not start hc API client'));
      child.on('close', () => fail('API client ended without operation completion'));
      child.stderr.on('error', () => fail('API diagnostic transport failed'));
      child.stderr.on('data', () => {}); // Never expose process diagnostics or credentials.
    } else {
      if (!isAbsolute(endpoint) || endpoint.includes('\0')) throw failure('explicit absolute local core endpoint required');
      const socket = createConnection(endpoint);
      input = output = socket;
      cleanup = () => { socket.destroy(); };
      socket.on('close', () => fail('API connection closed'));
    }
    input.on('error', () => fail('API request transport failed'));
    output.on('error', () => fail('API response transport failed'));
    output.on('end', () => fail('API response EOF; operation not completed'));
    output.on('data', (chunk: Buffer) => {
      if (closed) return;
      if (!pending) return fail('unsolicited API response data');
      bytes += chunk.length;
      if (bytes > MAX_BYTES) return fail('API response exceeded operation limit');
      try { buffer += decoder.decode(chunk, { stream: true }); }
      catch { return fail('invalid API response UTF-8'); }
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      try { decoder.decode(); } catch { return fail('invalid trailing API response UTF-8'); }
      const line = buffer.slice(0, end);
      // Sequential request/reply only: reject unsolicited/trailing data, including
      // a partial next response, BEFORE allowing the callback's next mutation.
      if (buffer.slice(end + 1).trim()) return fail('trailing API response data');
      buffer = '';
      let message: any;
      try { message = JSON.parse(line); } catch { return fail('invalid API response'); }
      if (!object(message) || !pending || message.id !== pending.id) return fail('uncorrelated API response');
      if (message.jsonrpc !== '2.0' || Object.hasOwn(message, 'error') || !Object.hasOwn(message, 'result')) {
        const code = Number.isSafeInteger(message.error?.code) ? `; RPC code ${message.error.code}` : '';
        // Server messages/data may echo credentials or request payloads. Keep only
        // our method name and the numeric error code in public diagnostics.
        return fail(`API rejected request ${pending.method}${code}`);
      }
      const current = pending; pending = undefined;
      current.resolve(message.result);
    });
    const hello = await call('hello', { generation: 1, framed: false });
    if (!object(hello) || hello.generation !== 1 || !versionLabel(hello.version) || hello.framed !== false ||
      !identity(hello.core) || !Array.isArray(hello.methods) || !hello.methods.every((v: unknown) => typeof v === 'string') ||
      !Array.isArray(hello.features) || !hello.features.every((v: unknown) => typeof v === 'string') ||
      (before && !sameCore(hello.core, before.core))) throw failure('unsupported or changed core handshake');
    methods = new Set(hello.methods);
    for (const method of ['server.status', ...(options.requiredMethods ?? [])]) {
      if (!methods.has(method)) throw failure(`required API method unavailable: ${method}; no operation attempted`);
    }
    const status = await call('server.status', {});
    if (!statusValid(status) || !sameCore(status.core, hello.core) || (before && status.pid !== before.pid)) throw failure('core instance changed before operation');
    const result = await operation(call);
    if (fatal) throw fatal; // Catching a request failure never rehabilitates a session.
    if (pending) { fail('callback left an unfinished API request'); throw fatal; }
    return result;
  };
  try { return await Promise.race([run(), failed]); }
  catch (error) {
    if (mutationAttempted && !(error instanceof Error && 'uncertain' in error)) {
      throw Object.assign(failure('operation failed after mutation; outcome uncertain; do not replay'), { uncertain: true, cause: error });
    }
    throw error;
  }
  finally { clearTimeout(timer); close(); }
}

/** Standalone compatibility API: one call per bounded session. Multi-call operations
 * MUST use withCoreSession, not repeated coreCall invocations. */
export const coreCall: CoreCall = (method, params) => withCoreSession(call => call(method, params));

export function terminalAddress(value: unknown): asserts value is string {
  if (typeof value !== 'string' || (!/^t[0-9a-z]+$/.test(value) || value.trim() !== value)) throw failure('explicit local HC_TERMINAL_ID required');
}

/** SOURCE-BACKED PRIVATE FORMAT, not a stable app API or production-readiness claim.
 * herdr-app v0.1.13 src/mirror.rs Document/SharedSpace/SharedTab and src/layout.rs
 * Node/Kind/Content define this opaque core doc. There is NO app-version handshake:
 * core 0.1.18 alone cannot establish app compatibility. An upstream versioned
 * layout contract is still needed. Tested subset: rows/columns, terminal/mod blocks,
 * and mod-only floats (src/layout.rs Float), whose IDs are checked too. Reject
 * stacks, terminal floats and dynamic context/agent content anywhere, including
 * unrelated tabs, rather than silently miss aliases.
 * Unknown metadata is preserved verbatim, not interpreted as a layout extension.
 * Private focus state is separate and is never inferred or changed here. */
export function locateTerminalTab(document: any, terminal: string): { space: any; tab: any; pane: any } {
  terminalAddress(terminal);
  if (!object(document) || !Array.isArray(document.spaces) || document.spaces.length > 256) throw failure('unsupported app layout document');
  const matches: { space: any; tab: any; pane: any }[] = [];
  const ids = new Set<string>(); let count = 0;
  const unique = (id: unknown) => {
    if (typeof id !== 'string' || !id || id.length > 256 || ids.has(id)) throw failure('ambiguous layout identity');
    ids.add(id);
  };
  for (const space of document.spaces) {
    if (!object(space)) throw failure('unsupported layout space');
    unique(space.id);
    if (!Array.isArray(space.tabs) || space.tabs.length > 512) throw failure('invalid layout tabs');
    for (const tab of space.tabs) {
      if (!object(tab)) throw failure('unsupported layout tab');
      unique(tab.id);
      if (typeof tab.name !== 'string') throw failure('invalid tab name');
      const visit = (node: any, depth: number) => {
        if (++count > 4096 || depth > 64 || !object(node) || typeof node.id !== 'string') throw failure('layout bounds exceeded');
        // The app uses the tab ID again for its root container.
        if (node !== tab.root || node.id !== tab.id) unique(node.id);
        if (Object.hasOwn(node, 'floating')) {
          if (!Array.isArray(node.floating)) throw failure('unsupported floating layout; no layout changes');
          for (const floating of node.floating) {
            if (++count > 4096 || !object(floating) || !object(floating.content) ||
              typeof floating.content.mod !== 'string' || ['terminal', 'tab', 'context', 'agent'].some(key => Object.hasOwn(floating.content, key)) ||
              ['children', 'floating', 'type'].some(key => Object.hasOwn(floating, key)) ||
              (Object.hasOwn(floating, 'edge') && !['top', 'right', 'bottom', 'left'].includes(floating.edge)) ||
              (Object.hasOwn(floating, 'align') && !['start', 'center', 'end'].includes(floating.align))) {
              throw failure('unsupported floating layout (only mod floats supported); no layout changes');
            }
            unique(floating.id);
          }
        }
        if (node.type === 'block') {
          if (Object.hasOwn(node, 'children') || !object(node.content)) throw failure('unsupported block shape');
          const tags = ['terminal', 'mod', 'tab', 'context', 'agent'].filter(key => Object.hasOwn(node.content, key));
          if (tags.length !== 1 || !['terminal', 'mod'].includes(tags[0]) || typeof node.content[tags[0]] !== 'string') throw failure('unsupported block content');
          if (tags[0] === 'terminal') terminalAddress(node.content.terminal);
          if (node.content.terminal === terminal) matches.push({ space, tab, pane: node });
        } else if (['row', 'column'].includes(node.type) && Array.isArray(node.children) && !Object.hasOwn(node, 'content')) {
          for (const child of node.children) visit(child, depth + 1);
        } else throw failure('unsupported layout node (only row/column/block supported)');
      };
      visit(tab.root, 0);
    }
  }
  if (matches.length !== 1) throw failure('terminal does not map to exactly one app pane; no layout changes');
  return matches[0];
}

/** Change only the owning tab name using the app's optimistic document protocol.
 * Success proves shared state, not that an attached Windows window has rendered it. */
export async function renameCoreTab(terminal: string, name: string, call?: CoreCall): Promise<void> {
  terminalAddress(terminal);
  if (typeof name !== 'string' || !name.trim() || name.length > 128 || /[\x00-\x1f\x7f]/.test(name)) throw failure('invalid worker tab name');
  // Default production rename is one operation, never a chain of reconnecting calls.
  // An injected call remains supported for tests or an enclosing withCoreSession.
  if (!call || call === coreCall) return withCoreSession(session => renameCoreTab(terminal, name, session));
  const record = await call('terminal.get', { terminal });
  if (record?.address !== terminal || record.state !== 'live' || !Number.isSafeInteger(record.created_ms) || record.created_ms <= 0) throw failure('worker terminal identity is not live');
  const snapshot = await call('doc.get', { name: 'herdr-app' });
  if (!Number.isSafeInteger(snapshot?.version) || snapshot.version < 0 || !snapshot.value) throw failure('app layout unavailable');
  const value = structuredClone(snapshot.value);
  const { space, tab, pane } = locateTerminalTab(value, terminal);
  if (record.labels?.['herdr.space'] !== space.id || record.labels?.['herdr.tab'] !== tab.id) throw failure('terminal labels disagree with actual app layout');
  if (tab.name === name) return;
  tab.name = name;
  const fresh = await call('terminal.get', { terminal });
  if (fresh?.address !== terminal || fresh.state !== 'live' || fresh.created_ms !== record.created_ms ||
    fresh.labels?.['herdr.space'] !== space.id || fresh.labels?.['herdr.tab'] !== tab.id) throw failure('terminal identity changed before rename');
  const written = await call('doc.set', { name: 'herdr-app', version: snapshot.version, value });
  if (!Number.isSafeInteger(written?.version) || written.version !== snapshot.version + 1) throw failure('layout write acknowledgment uncertain; do not replay');
  const observed = await call('doc.get', { name: 'herdr-app' });
  if (!Number.isSafeInteger(observed?.version) || observed.version < written.version) throw failure('layout readback version not confirmed; do not replay');
  const target = locateTerminalTab(observed?.value, terminal);
  if (target.space.id !== space.id || target.tab.id !== tab.id || target.pane.id !== pane.id || target.tab.name !== name) throw failure('tab rename not confirmed; do not replay');
}
