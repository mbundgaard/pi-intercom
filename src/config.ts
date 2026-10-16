import { mkdir, readFile, realpath, rename, unlink, open, link, stat, lstat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fencedClose, validateHandoff, validateCloseJob, type Handoff, type CloseJob } from './handoff.js';

export interface Agent {
  sessionId: string;
  name: string;
  coordinator: boolean;
  description: string;
  port: number;
  /** Legacy browser dashboard field, accepted for migration only; removed at coordinator startup. */
  dashboardPort?: number;
  projectDirectory: string;
  handoff?: Handoff;
  closeJob?: CloseJob;
}
export interface Config { version: 1; multiplexer: 'herdr' | 'none'; agents: Agent[] }
export const DEFAULT_DESCRIPTION = 'Coordinate workers, delegate work, and manage shared configuration.';
export const key = (name: string) => name.toLowerCase();
export function fail(message: string): never { throw new Error(`PiIntercom: ${message}`); }
export function text(value: unknown, field: string, max = 4096): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) fail(`invalid ${field}`);
}
export function port(value: unknown): asserts value is number {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 65535) fail('invalid port');
}
export function relativeDirectory(value: unknown): asserts value is string {
  text(value, 'projectDirectory');
  if (path.isAbsolute(value) || path.win32.isAbsolute(value) || value.split(/[\\/]/).includes('..')) fail('projectDirectory must be root-relative, without ..');
}
export function validateConfig(value: unknown): Config {
  const c = value as Config;
  if (!c || c.version !== 1 || !['herdr', 'none'].includes(c.multiplexer) || !Array.isArray(c.agents)) fail('invalid config schema/version');
  const names = new Set<string>(), ids = new Set<string>();
  for (const a of c.agents) {
    if (!a || typeof a.coordinator !== 'boolean') fail('invalid agent');
    text(a.sessionId, 'sessionId', 256); text(a.name, 'name', 128); text(a.description, 'description');
    if (a.name !== a.name.trim() || /[\r\n\x00-\x1f]/.test(a.name)) fail('invalid name');
    port(a.port); relativeDirectory(a.projectDirectory);
    if (a.handoff !== undefined) { if (a.coordinator) fail('handoff is worker-only'); validateHandoff(a.handoff); }
    if (a.closeJob !== undefined) { if (a.coordinator) fail('closeJob is worker-only'); validateCloseJob(a.closeJob); }
    if (a.dashboardPort !== undefined) {
      if (!a.coordinator) fail('dashboardPort is coordinator-only');
      port(a.dashboardPort);
    }
    if (names.has(key(a.name)) || ids.has(a.sessionId)) fail('duplicate name or session ID');
    names.add(key(a.name)); ids.add(a.sessionId);
    if (a.coordinator ? (a.name !== 'Coordinator' || a.projectDirectory !== '.') : key(a.name) === 'coordinator') fail('reserved Coordinator identity');
  }
  if (c.agents.filter(a => a.coordinator).length !== 1) fail('config requires exactly one coordinator');
  return c;
}
export const coordinator = (c: Config) => c.agents.find(a => a.coordinator)!;
export function named(c: Config, name: string): Agent {
  text(name, 'to', 128);
  return c.agents.find(a => key(a.name) === key(name)) ?? fail(`unknown recipient ${name}`);
}
export function requireCoordinator(c: Config, id: string): Agent {
  const a = c.agents.find(a => a.sessionId === id);
  return a?.coordinator ? a : fail('coordinator permission required');
}
export async function directory(root: string, requested: string): Promise<string> {
  text(requested, 'projectDirectory');
  const base = await realpath(root), target = await realpath(path.resolve(root, requested));
  const rel = path.relative(base, target);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) fail('project directory must be coordinator root or descendant (including symlinks)');
  if (!(await stat(target)).isDirectory()) fail('projectDirectory is not a directory');
  return rel.split(path.sep).join('/') || '.';
}
export interface ConfigStoreOptions {
  /** Publication seams for deterministic platform/race tests. */
  platform?: NodeJS.Platform;
  rename?: (from: string, to: string) => Promise<void>;
  delay?: (milliseconds: number) => Promise<void>;
  now?: () => number;
}
const RENAME_DELAYS = [10, 20, 40, 80] as const;
const RENAME_BUDGET_MS = 250;
export class ConfigStore {
  readonly file: string;
  private tail: Promise<unknown> = Promise.resolve();
  private canonicalRoot?: string;
  constructor(readonly root: string, private readonly options: ConfigStoreOptions = {}) { this.file = path.join(root, '.pi-intercom', 'config.json'); }
  private async assertLocalPaths(): Promise<void> {
    const root = await realpath(this.root);
    if (this.canonicalRoot === undefined) this.canonicalRoot = root;
    else if (root !== this.canonicalRoot) fail('config root canonical location changed');
    // Reject existing escaping links/junctions before following them for any
    // config access. These path checks are best effort, not TOCTOU protection.
    for (const [location, directory] of [[path.dirname(this.file), true], [this.file, false]] as const) {
      try { await lstat(location); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      let resolved: string;
      try { resolved = await realpath(location); }
      catch { fail('local config path cannot be resolved safely'); }
      const relative = path.relative(root, resolved);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail('local config path escapes session root');
      const metadata = await stat(resolved);
      if (directory ? !metadata.isDirectory() : !metadata.isFile()) fail('invalid local config path type');
    }
  }
  async validateRoot(expectedCanonicalRoot: string): Promise<void> {
    await this.assertLocalPaths();
    if (this.canonicalRoot !== expectedCanonicalRoot) fail('config root canonical location changed');
  }
  async read(): Promise<Config> {
    // Missing, malformed and unreadable local files propagate; no fallback.
    await this.assertLocalPaths();
    return validateConfig(JSON.parse(await readFile(this.file, 'utf8')));
  }
  static async discover(cwd: string): Promise<ConfigStore | undefined> {
    const store = new ConfigStore(await realpath(cwd));
    try { await store.read(); return store; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return undefined; }
  }
  static async workspace(cwd: string, workspaceRoot: string): Promise<ConfigStore> {
    text(workspaceRoot, 'workspaceRoot');
    if (!path.isAbsolute(workspaceRoot)) fail('workspaceRoot must be absolute');
    const root = await realpath(workspaceRoot);
    if (!(await stat(root)).isDirectory()) fail('workspaceRoot is not a directory');
    const current = await realpath(cwd);
    if (path.relative(root, current) !== '') fail('workspaceRoot must equal the session working directory; parent configs are forbidden');
    const store = new ConfigStore(root);
    await store.read(); // Explicit worker mode must never create a replacement coordinator.
    return store;
  }
  protected openTemporary(file: string) { return open(file, 'wx'); }
  private async cleanupTemporary(temp: string): Promise<void> {
    // A moved root may leave an unpublished temp behind. Never follow a
    // replacement parent outside the pinned root just to clean up. This guard
    // is independent of lifecycle/deadline expiry so ordinary failures clean up.
    await this.assertLocalPaths();
    const resolved = await realpath(temp);
    const relative = path.relative(this.canonicalRoot!, resolved);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail('temporary config path escapes session root');
    await unlink(temp);
  }
  private async temporary(config: Config): Promise<string> {
    validateConfig(config);
    await this.assertLocalPaths();
    await mkdir(path.dirname(this.file), { recursive: true });
    await this.assertLocalPaths();
    const temp = `${this.file}.${randomUUID()}.tmp`;
    const handle = await this.openTemporary(temp);
    try {
      await handle.writeFile(JSON.stringify(config, null, 2) + '\n');
      await handle.sync();
      await handle.close();
      return temp;
    } catch (error) {
      // Cleanup failures must not replace the original write/sync/close error.
      await handle.close().catch(() => {});
      await this.cleanupTemporary(temp).catch(() => {});
      throw error;
    }
  }
  async initialize(id: string, boundPort: number, assertValid: () => void = () => {}): Promise<boolean> {
    // Publish an already complete file using an atomic, no-replace hard link.
    // Losers only ever see complete JSON; unsupported filesystems fail explicitly.
    assertValid();
    const temp = await this.temporary({ version: 1, multiplexer: 'herdr', agents: [{ sessionId: id, name: 'Coordinator', coordinator: true, description: DEFAULT_DESCRIPTION, port: boundPort, projectDirectory: '.' }] });
    try {
      await this.assertLocalPaths(); assertValid();
      try { await link(temp, this.file); }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        await this.read(); await this.cleanupTemporary(temp); return false;
      }
      await this.cleanupTemporary(temp); return true;
    } catch (error) { await this.cleanupTemporary(temp).catch(() => {}); throw error; }
  }
  private async publish(temp: string, assertValid: () => void): Promise<void> {
    const replace = this.options.rename ?? rename;
    const now = this.options.now ?? (() => performance.now());
    const delay = this.options.delay ?? (milliseconds => new Promise<void>(resolve => setTimeout(resolve, milliseconds)));
    const started = now();
    let originalError: unknown;
    for (let attempt = 0; ; attempt++) {
      // Windows readers can briefly deny replace-rename. Retry only publication
      // of this already synced/closed temp, never the mutation or any OS action
      // outside config persistence. The elapsed budget bounds retry initiation,
      // not the duration of an already-submitted OS rename.
      await this.assertLocalPaths(); assertValid();
      if (attempt > 0 && now() - started >= RENAME_BUDGET_MS) throw originalError;
      try { await replace(temp, this.file); return; }
      catch (error) {
        if ((this.options.platform ?? process.platform) !== 'win32' || (error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
        originalError ??= error;
        const backoff = RENAME_DELAYS[attempt];
        if (backoff === undefined || now() - started + backoff >= RENAME_BUDGET_MS) throw originalError;
        await delay(backoff);
      }
    }
  }
  async update(id: string, mutate: (config: Config) => void | Promise<void>, assertValid: () => void = () => {}): Promise<Config> {
    const operation = this.tail.then(async () => {
      assertValid();
      const c = await this.read(); assertValid(); requireCoordinator(c, id);
      await mutate(c); assertValid(); validateConfig(c);
      const temp = await this.temporary(c);
      try {
        // Every publication attempt checks the lifecycle/deadline guard; an
        // already submitted OS rename still cannot be undone.
        await this.publish(temp, assertValid);
      } catch (error) { await this.cleanupTemporary(temp).catch(() => {}); throw error; }
      return c;
    });
    this.tail = operation.catch(() => {}); return operation;
  }
  async configure(id: string, values: Omit<Agent, 'coordinator'>, assertValid: () => void = () => {}): Promise<Config> {
    return this.update(id, async c => {
      if (values.sessionId === coordinator(c).sessionId) fail('cannot configure coordinator as worker');
      const projectDirectory = await directory(this.root, values.projectDirectory);
      const a: Agent = { sessionId: values.sessionId, name: values.name, description: values.description, port: values.port, projectDirectory, coordinator: false };
      const index = c.agents.findIndex(old => old.sessionId === a.sessionId);
      if (index < 0) c.agents.push(a);
      else {
        const old = c.agents[index];
        if (fencedClose(old.closeJob)) fail('worker close is active or uncertain; configuration is fenced');
        if (old.handoff) a.handoff = old.handoff;
        if (old.closeJob) a.closeJob = old.closeJob;
        c.agents[index] = a;
      }
    }, assertValid);
  }
}
