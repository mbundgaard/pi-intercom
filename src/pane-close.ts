import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { constants } from 'node:fs';
import { open, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { Run } from './launcher.js';
import type { CloseProvider, WorkerPaneIdentity } from './handoff.js';
import { createCoreCloseProvider } from './core-pane-close.js';

interface ProcessIdentity { start: string; state: string }
export interface PaneCloseOptions {
  sessionId(): string;
  sessionFile(): string | undefined;
  env?: NodeJS.ProcessEnv;
  platform?: string;
  pid?: number;
  run?: Run;
  processIdentity?: (pid: number) => Promise<ProcessIdentity | undefined>;
  verifySession?: (file: string, id: string) => Promise<void>;
  verificationMs?: number;
}
const rejected = () => new Error('PiIntercom: worker pane identity could not be verified; no close submitted.');
const exec: Run = async (file, args) => (await promisify(execFile)(file, args, {
  windowsHide: true, timeout: 4000, maxBuffer: 1024 * 1024,
})).stdout;

/** Linux process start ticks distinguish a reused PID from the original worker. */
export async function linuxProcessIdentity(pid: number): Promise<ProcessIdentity | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw rejected();
  let stat: string;
  try { stat = await readFile(`/proc/${pid}/stat`, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw rejected(); }
  const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
  if (!/^[0-9]+$/.test(fields[19] ?? '') || !/^[A-Za-z]$/.test(fields[0] ?? '')) throw rejected();
  return { start: fields[19], state: fields[0] };
}
async function verifySessionHeader(file: string, id: string): Promise<void> {
  if (!path.isAbsolute(file) || file.length > 4096 || file.includes('\0')) throw rejected();
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!(await handle.stat()).isFile()) throw rejected();
    // Inspect only the first session-header line, never transcript messages.
    const buffer = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const end = buffer.subarray(0, bytesRead).indexOf(10);
    if (end < 0) throw rejected();
    const header = JSON.parse(buffer.subarray(0, end).toString('utf8'));
    if (header?.type !== 'session' || header.id !== id) throw rejected();
  } finally { await handle.close(); }
}
const alive = (identity: ProcessIdentity | undefined, start: string) =>
  !!identity && identity.start === start && !['Z', 'X', 'x'].includes(identity.state);

/** Linux Herdr only. Identity-checked best effort; Herdr has no atomic compare-and-close API. */
export function createCloseProvider(options: PaneCloseOptions): CloseProvider | undefined {
  const env = options.env ?? process.env;
  if (env.HC_TERMINAL_ID !== undefined) return createCoreCloseProvider(options);
  if ((options.platform ?? process.platform) !== 'linux' || env.HERDR_ENV !== '1' || !env.HERDR_PANE_ID) return;
  const run = options.run ?? exec;
  const processIdentity = options.processIdentity ?? linuxProcessIdentity;
  const verifySession = options.verifySession ?? verifySessionHeader;
  const ownPid = options.pid ?? process.pid;
  const verificationMs = Math.max(0, Math.min(2000, options.verificationMs ?? 1500));
  async function query(args: string[]): Promise<any> {
    const output = await run('herdr', args);
    if (Buffer.byteLength(output) > 1024 * 1024) throw rejected();
    return JSON.parse(output)?.result;
  }
  async function caller(): Promise<any> {
    const pane = (await query(['pane', 'current', '--current']))?.pane;
    if (!pane || typeof pane.pane_id !== 'string' || typeof pane.workspace_id !== 'string' || typeof pane.terminal_id !== 'string') throw rejected();
    return pane;
  }
  async function verifyPane(pane: any, identity: WorkerPaneIdentity): Promise<void> {
    if (!pane || pane.pane_id !== identity.paneId || pane.workspace_id !== identity.workspaceId ||
      pane.terminal_id !== identity.terminalId || pane.agent !== 'pi' ||
      pane.agent_session?.source !== 'herdr:pi' || pane.agent_session?.kind !== 'path' ||
      typeof pane.agent_session.value !== 'string' || !path.isAbsolute(identity.sessionFile) ||
      !Number.isSafeInteger(identity.pid) || identity.pid <= 0 || !/^[0-9]+$/.test(identity.processStart)) throw rejected();
    if (await realpath(pane.agent_session.value) !== await realpath(identity.sessionFile)) throw rejected();
    await verifySession(identity.sessionFile, identity.sessionId);
    const info = (await query(['pane', 'process-info', '--pane', identity.paneId]))?.process_info;
    if (info?.pane_id !== identity.paneId || !Array.isArray(info.foreground_processes) ||
      !info.foreground_processes.some((p: { pid?: number }) => p.pid === identity.pid) ||
      !alive(await processIdentity(identity.pid), identity.processStart)) throw rejected();
  }
  async function inspect(identity: WorkerPaneIdentity, expectedSessionId: string, assertCurrent: () => void): Promise<void> {
    assertCurrent();
    if (identity.sessionId !== expectedSessionId || expectedSessionId === options.sessionId() || identity.pid === ownPid) throw rejected();
    const own = await caller();
    assertCurrent();
    if (own.pane_id === identity.paneId || own.workspace_id !== identity.workspaceId) throw rejected();
    await verifyPane((await query(['pane', 'get', identity.paneId]))?.pane, identity);
    assertCurrent();
  }
  return {
    async getIdentity() {
      try {
        const sessionId = options.sessionId(), sessionFile = options.sessionFile();
        if (!sessionFile) throw rejected();
        const pane = await caller();
        const process = await processIdentity(ownPid);
        if (!process || !alive(process, process.start)) throw rejected();
        const identity: WorkerPaneIdentity = { workspaceId: pane.workspace_id, paneId: pane.pane_id,
          terminalId: pane.terminal_id, sessionId, sessionFile, pid: ownPid, processStart: process.start };
        await verifyPane(pane, identity);
        if (options.sessionId() !== sessionId || options.sessionFile() !== sessionFile) throw rejected();
        return identity;
      } catch { throw rejected(); }
    },
    async inspect(identity, expectedSessionId, assertCurrent) {
      try { await inspect(identity, expectedSessionId, assertCurrent); } catch { throw rejected(); }
    },
    async close(identity, expectedSessionId, assertCurrent, beforeSubmit) {
      try { await inspect(identity, expectedSessionId, assertCurrent); } catch { throw rejected(); }
      assertCurrent();
      // Revalidate worker settlement only AFTER potentially slow ownership reads.
      // Herdr still has no atomic cross-process identity/idle compare-and-close.
      await beforeSubmit();
      assertCurrent();
      // Exactly one explicit pane target. No tab/workspace close, retry, or force kill.
      // A CLI timeout can mean the mutation happened: caller must persist uncertainty.
      try { await run('herdr', ['pane', 'close', identity.paneId]); }
      catch { throw new Error('PiIntercom: pane close outcome uncertain; inspect before any retry.'); }
      let paneClosed = false, workerExited = false;
      try {
        const panes = (await query(['pane', 'list', '--workspace', identity.workspaceId]))?.panes;
        paneClosed = Array.isArray(panes) && panes.every(p => typeof p?.pane_id === 'string') &&
          !panes.some(p => p.pane_id === identity.paneId);
        const deadline = Date.now() + verificationMs;
        do {
          workerExited = !alive(await processIdentity(identity.pid), identity.processStart);
          if (workerExited || Date.now() >= deadline) break;
          await new Promise(resolve => setTimeout(resolve, 50));
        } while (true);
      } catch { /* Verification failure is uncertainty, never an automatic retry. */ }
      return { paneClosed, workerExited };
    },
  };
}
