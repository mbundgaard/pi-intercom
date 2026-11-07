import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { run, shQuote, psQuote, encoded, type Run } from './launcher.js';
import { ensureCoreMonitorPane, closeCoreMonitorPane } from './core-monitor.js';
import { withCoreSession, type CoreCall } from './herdr-core.js';

interface Pane { pane_id: string; tab_id: string; workspace_id?: string; label?: string }
export type MonitorPlacement = 'coordinator-tab' | 'new-tab';
interface RecordState { version: 1; sessionId: string; workspace: string; caller: string; pane?: string; tab?: string; placement?: MonitorPlacement; stage: string }
export interface MonitorLaunchOptions {
  root: string; sessionId: string; script: string;
  node?: string; platform?: string; env?: NodeJS.ProcessEnv; run?: Run;
  placement?: MonitorPlacement;
  coreCall?: CoreCall;
  assertCurrent?(): void;
}
/** Pane ownership is separate from agent config. Pending records fence uncertain
 * mutations across reloads; neither errors nor absence of readiness cause retries. */
export async function ensureMonitorPane(options: MonitorLaunchOptions): Promise<{ outcome: string; pane?: string }> {
  if ((options.env ?? process.env).HC_TERMINAL_ID !== undefined) {
    const open = (call: CoreCall) => ensureCoreMonitorPane({ ...options, placement: options.placement ?? 'coordinator-tab', call });
    return options.coreCall ? open(options.coreCall) : withCoreSession(open);
  }
  return monitorPane(options, false);
}
export async function closeMonitorPane(options: MonitorLaunchOptions): Promise<{ outcome: string; pane?: string }> {
  if ((options.env ?? process.env).HC_TERMINAL_ID !== undefined) {
    const close = (call: CoreCall) => closeCoreMonitorPane({ ...options, call });
    return options.coreCall ? close(options.coreCall) : withCoreSession(close);
  }
  return monitorPane(options, true);
}
async function monitorPane(options: MonitorLaunchOptions, closing: boolean): Promise<{ outcome: string; pane?: string }> {
  const placement = options.placement ?? 'coordinator-tab';
  if (!['coordinator-tab', 'new-tab'].includes(placement)) throw new Error('Invalid monitor placement');
  const env = options.env ?? process.env;
  if (env.HERDR_ENV !== '1') return { outcome: 'unavailable: coordinator is not inside Herdr' };
  if (!env.HERDR_PANE_ID) throw new Error('Monitor requires caller pane identity; no focused-pane fallback');
  const platform = options.platform ?? process.platform;
  if (!['win32', 'linux'].includes(platform)) throw new Error('Monitor launcher supports Windows/Linux only');
  const exec = options.run ?? run;
  const check = () => options.assertCurrent?.();
  const call = async (args: string[]) => {
    check();
    const output = await exec('herdr', args);
    check();
    // pane run acknowledges command submission with an empty stdout on current Herdr.
    if (!output.trim() && ['run', 'close'].includes(args[1])) return {};
    return JSON.parse(output).result;
  };
  const caller = (await call(['pane', 'current', '--current']))?.pane as Pane;
  if (!caller?.pane_id || !caller.tab_id || !caller.workspace_id) throw new Error('Missing current Herdr caller pane identity');
  // Herdr documents inherited moved-pane aliases for --current. Preserve that
  // resolution for opening; destructive close conservatively requires exact ID.
  if (closing && caller.pane_id !== env.HERDR_PANE_ID) throw new Error('Mismatched current Herdr caller pane identity; refusing close');
  const label = 'Intercom monitor';
  const legacyMarker = `Intercom monitor [${options.sessionId}]`;
  const key = createHash('sha256').update(options.sessionId).digest('hex').slice(0, 24);
  const directory = path.join(options.root, '.pi-intercom');
  check();
  await mkdir(directory, { recursive: true });
  check();
  const file = path.join(directory, `monitor-${key}.json`), lock = `${file}.lock`;
  check();
  try { await writeFile(lock, '', { flag: 'wx', mode: 0o600 }); }
  catch { throw new Error(`Monitor launch locked; inspect ${lock} before recovery. No pane created.`); }
  let state: RecordState | undefined;
  const save = async () => {
    check();
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(state), { flag: 'wx', mode: 0o600 });
      check();
      await rename(temporary, file);
    } finally { await unlink(temporary).catch(() => {}); }
  };
  try {
    check();
    try {
      state = JSON.parse(await readFile(file, 'utf8'));
      check();
      if (state?.version !== 1 || state.sessionId !== options.sessionId || typeof state.stage !== 'string' ||
        typeof state.workspace !== 'string' || typeof state.caller !== 'string' ||
        (state.placement !== undefined && !['coordinator-tab', 'new-tab'].includes(state.placement)) ||
        (state.tab !== undefined && typeof state.tab !== 'string') ||
        (state.pane !== undefined && typeof state.pane !== 'string') ||
        (state.placement === 'new-tab' && ['submitted', 'observed'].includes(state.stage) && !state.tab)) throw new Error('Invalid monitor ownership record');
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    const panes = (await call(['pane', 'list', '--workspace', caller.workspace_id]))?.panes as Pane[];
    if (!Array.isArray(panes) || panes.some(p => !p?.pane_id || !p.tab_id || p.workspace_id && p.workspace_id !== caller.workspace_id) || new Set(panes.map(p => p.pane_id)).size !== panes.length || !panes.some(p => p.pane_id === caller.pane_id && p.tab_id === caller.tab_id)) throw new Error('Invalid Herdr pane inventory');
    const matches = panes.filter(p => p.label === legacyMarker ||
      (state && state.workspace === caller.workspace_id && state.pane === p.pane_id));
    if (matches.length > 1) throw new Error('Multiple monitor markers; inspect panes. No automatic changes.');
    if (matches.length === 1) {
      const pane = matches[0];
      if (panes.some(other => other.pane_id !== pane.pane_id && other.label === label)) throw new Error('Multiple monitor labels in workspace; inspect panes. No automatic changes.');
      const savedPlacement = state?.placement ?? 'coordinator-tab';
      if (pane.pane_id === caller.pane_id || pane.tab_id !== (state?.tab ?? caller.tab_id) ||
        (savedPlacement === 'coordinator-tab' ? pane.tab_id !== caller.tab_id : pane.tab_id === caller.tab_id)) throw new Error('Monitor marker is on caller or moved to another tab; no automatic changes');
      if (!closing && savedPlacement !== placement) throw new Error('Monitor already exists in a different placement; close it first before opening elsewhere');
      if (state && (state.workspace !== caller.workspace_id || state.caller !== caller.pane_id || (state.pane && state.pane !== pane.pane_id))) {
        throw new Error('Monitor ownership differs from current caller; no automatic changes');
      }
      if (state && !['submitted', 'observed'].includes(state.stage)) {
        throw new Error(`Monitor partial launch needs inspection (${state.stage}); no retry or duplicate`);
      }
      if (!state) {
        if (closing) throw new Error('Legacy monitor marker has no saved ownership; manual inspection required, no automatic close');
        state = { version: 1, sessionId: options.sessionId, workspace: caller.workspace_id, caller: caller.pane_id, pane: pane.pane_id, tab: pane.tab_id, placement: 'coordinator-tab', stage: 'observed' };
        await save();
      }
      if (closing) {
        if (state.stage !== 'submitted') throw new Error('Legacy observed monitor lacks launcher-created ownership proof; refusing close');
        if (pane.label !== label && pane.label !== legacyMarker) throw new Error('Owned monitor label changed; refusing to close a potentially reused pane');
        state.stage = 'close_pending'; await save();
        const finalCaller = (await call(['pane', 'current', '--current']))?.pane as Pane;
        const finalPanes = (await call(['pane', 'list', '--workspace', caller.workspace_id]))?.panes as Pane[];
        if (finalCaller?.pane_id !== caller.pane_id || finalCaller.tab_id !== caller.tab_id || finalCaller.workspace_id !== caller.workspace_id ||
          !Array.isArray(finalPanes) || finalPanes.some(p => !p?.pane_id || !p.tab_id || p.workspace_id && p.workspace_id !== caller.workspace_id) ||
          new Set(finalPanes.map(p => p.pane_id)).size !== finalPanes.length ||
          !finalPanes.some(p => p.pane_id === caller.pane_id && p.tab_id === caller.tab_id) ||
          finalPanes.filter(p => p.pane_id === pane.pane_id && p.tab_id === pane.tab_id && p.label === pane.label).length !== 1 ||
          finalPanes.some(p => p.pane_id !== pane.pane_id && [label, legacyMarker].includes(p.label ?? ''))) throw new Error('Monitor ownership changed before close; pending outcome fenced, inspect manually');
        // Herdr has no compare-and-close primitive: this minimizes but cannot
        // eliminate an external topology race between inventory and pane close.
        await call(['pane', 'close', pane.pane_id]);
        const remaining = (await call(['pane', 'list', '--workspace', caller.workspace_id]))?.panes as Pane[];
        if (!Array.isArray(remaining) || remaining.some(p => !p?.pane_id || !p.tab_id || p.workspace_id && p.workspace_id !== caller.workspace_id) || new Set(remaining.map(p => p.pane_id)).size !== remaining.length || remaining.some(p => p.pane_id === pane.pane_id) || !remaining.some(p => p.pane_id === caller.pane_id && p.tab_id === caller.tab_id)) throw new Error('Monitor pane absence not confirmed; close outcome uncertain, do not retry');
        state.stage = 'closed'; await save();
        return { outcome: 'monitor pane absence observed; no claim about child processes', pane: pane.pane_id };
      }
      if (pane.label !== label) await call(['pane', 'rename', pane.pane_id, label]);
      return { outcome: 'existing pane preserved; process readiness not checked', pane: pane.pane_id };
    }
    if (panes.some(p => p.label === label)) {
      throw new Error('Unowned monitor label in workspace; inspect before creating or closing a pane');
    }
    if (state && (!['submitted', 'observed', 'closed'].includes(state.stage) || state.workspace !== caller.workspace_id || state.caller !== caller.pane_id || panes.some(p => p.pane_id === state!.pane))) {
      throw new Error(`Monitor ownership/partial launch needs inspection (${state.stage}, pane ${state.pane ?? 'unknown'}); no retry or duplicate`);
    }
    if (closing) return { outcome: 'no owned monitor pane present; no close submitted' };
    await access(options.script); // Missing build must not leave a new empty pane.
    check();
    state = { version: 1, sessionId: options.sessionId, workspace: caller.workspace_id, caller: caller.pane_id, placement, tab: placement === 'coordinator-tab' ? caller.tab_id : undefined, stage: placement === 'new-tab' ? 'tab_pending' : 'split_pending' };
    await save();
    // Small top quarter after swapping pane identities. Verify actual geometry below.
    const created = placement === 'new-tab'
      ? await call(['tab', 'create', '--workspace', caller.workspace_id, '--cwd', options.root, '--label', label, '--no-focus'])
      : await call(['pane', 'split', '--pane', caller.pane_id, '--direction', 'down', '--ratio', '0.25', '--cwd', options.root, '--no-focus']);
    const pane = placement === 'new-tab' ? created?.root_pane?.pane_id : created?.pane?.pane_id;
    if (typeof pane !== 'string' || pane === caller.pane_id || panes.some(p => p.pane_id === pane)) throw new Error('Creation returned no distinct new pane ID');
    if (placement === 'new-tab') {
      const tab = created?.tab?.tab_id;
      if (typeof tab !== 'string' || tab === caller.tab_id || panes.some(p => p.tab_id === tab)) throw new Error('Creation returned no distinct new tab ID');
      state.tab = tab;
    }
    state.pane = pane; state.stage = 'rename_pending'; await save();
    await call(['pane', 'rename', pane, label]);
    if (placement === 'coordinator-tab') {
      state.stage = 'swap_pending'; await save();
      const swapped = await call(['pane', 'swap', '--source-pane', caller.pane_id, '--target-pane', pane]);
      if (swapped?.swap?.changed !== true) throw new Error('Herdr did not confirm pane swap');
      const layout = (await call(['pane', 'layout', '--pane', caller.pane_id]))?.layout;
      const top = layout?.panes?.find((p: { pane_id: string }) => p.pane_id === pane)?.rect;
      const bottom = layout?.panes?.find((p: { pane_id: string }) => p.pane_id === caller.pane_id)?.rect;
      if (!top || !bottom || top.y >= bottom.y || layout.focused_pane_id !== caller.pane_id) throw new Error('Monitor geometry/focus not confirmed; inspect panes before recovery');
    } else {
      const inventory = (await call(['pane', 'list', '--workspace', caller.workspace_id]))?.panes as Pane[];
      const current = (await call(['pane', 'current', '--current']))?.pane as Pane;
      if (!Array.isArray(inventory) || inventory.some(p => !p?.pane_id || !p.tab_id || p.workspace_id && p.workspace_id !== caller.workspace_id) || new Set(inventory.map(p => p.pane_id)).size !== inventory.length || inventory.filter(p => p?.pane_id === pane && p.tab_id === state!.tab).length !== 1 || !inventory.some(p => p.pane_id === caller.pane_id && p.tab_id === caller.tab_id) || current?.pane_id !== caller.pane_id || current.tab_id !== caller.tab_id || current.workspace_id !== caller.workspace_id) throw new Error('New monitor tab/caller identity not confirmed; inspect before recovery');
    }
    state.stage = 'run_pending'; await save();
    const args = [options.script, '--root', options.root];
    const command = platform === 'win32'
      ? `powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded(`& ${psQuote(options.node ?? process.execPath)} ${args.map(psQuote).join(' ')}`)}`
      : `sh -c ${shQuote(`exec ${shQuote(options.node ?? process.execPath)} ${args.map(shQuote).join(' ')}`)}`;
    await call(['pane', 'run', pane, command]);
    state.stage = 'submitted'; await save();
    return { outcome: 'command submitted; monitor readiness not awaited', pane };
  } catch (e) {
    throw new Error(`Intercom monitor: ${String(e)}. Pane ${state?.pane ?? 'unknown'} may remain; no automatic cleanup.`);
  } finally { await unlink(lock).catch(() => {}); }
}
