import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fail } from './config.js';
import type { LaunchRequest } from './runtime.js';

export type Run = (file: string, args: string[]) => Promise<string>;
export const run: Run = async (file, args) => {
  const { stdout } = await promisify(execFile)(file, args, { windowsHide: true, timeout: 40000, maxBuffer: 1024 * 1024 });
  return stdout;
};
export const psQuote = (value: string) => `'${value.replaceAll("'", "''")}'`;
export const shQuote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;
export const encoded = (script: string) => Buffer.from(script, 'utf16le').toString('base64');
export interface LauncherOptions {
  extension: string;
  platform?: string;
  env?: NodeJS.ProcessEnv;
  run?: Run;
  sessionExists(cwd: string, id: string): Promise<boolean>;
}
export function launchers(options: LauncherOptions) {
  const exec = options.run ?? run, env = options.env ?? process.env;
  async function launch(request: LaunchRequest): Promise<unknown> {
    const platform = options.platform ?? process.platform;
    if (platform !== 'win32' && platform !== 'linux') fail('launchers support Windows and Linux only');
    const paths = platform === 'win32' ? path.win32 : path.posix;
    if (typeof request.workspaceRoot !== 'string' || !request.workspaceRoot.trim() || request.workspaceRoot.includes('\0') || !paths.isAbsolute(request.workspaceRoot)) fail('worker launch requires an explicit absolute workspace root');
    // Runtime performs authoritative realpath equality before reading config.
    // Defend direct launcher calls too, without filesystem access or cwd rewrites.
    const samePath = (value: string) => platform === 'win32' ? paths.resolve(value).toLowerCase() : paths.resolve(value);
    if (typeof request.cwd !== 'string' || !paths.isAbsolute(request.cwd) || samePath(request.workspaceRoot) !== samePath(request.cwd)) fail('worker workspace root must equal its working directory; parent workspace access is not allowed');
    if (platform === 'linux' && request.multiplexer === 'none') fail('Linux worker launching requires Herdr; none is Windows-only. No terminal fallback');
    if (request.sessionId && !await options.sessionExists(request.cwd, request.sessionId)) fail('saved Pi session not found in project directory; never-used sessions may not be persisted. Config unchanged; no replacement launched');
    // Explicit per-child CLI scope cannot widen cwd or leak from a parent shell environment.
    const args = ['-e', options.extension, '--intercom-root', request.workspaceRoot, ...(request.sessionId ? ['--session', request.sessionId] : [])];
    if (request.multiplexer === 'herdr') {
      if (env.HERDR_ENV !== '1' || !env.HERDR_WORKSPACE_ID) fail('Herdr launcher requires this Pi to run inside a Herdr-managed workspace; no fallback');
      let created: { result?: { root_pane?: { pane_id?: string }; tab?: { tab_id?: string } } };
      try { created = JSON.parse(await exec('herdr', ['tab', 'create', '--workspace', env.HERDR_WORKSPACE_ID, '--cwd', request.cwd, '--label', 'Intercom (anonymous)', '--no-focus'])); }
      catch (e) { fail(`Herdr tab launch failed: ${String(e)}; no fallback or cleanup`); }
      const pane = created.result?.root_pane?.pane_id, tab = created.result?.tab?.tab_id;
      if (!pane || !tab) fail('Herdr creation response missing returned pane/tab IDs; no guessed targeting or cleanup');
      // Herdr's Windows agent-start wrapper uses Start-Process on `pi`, which
      // can resolve to a PowerShell shim and fail with invalid Win32 application.
      // Run an explicit PowerShell command in the returned shell pane instead.
      // This acknowledges command submission only, not Pi readiness/registration.
      const script = `$ErrorActionPreference='Stop'; Set-Location -LiteralPath ${psQuote(request.cwd)}; & (Get-Command pi.ps1 -ErrorAction Stop).Source ${args.map(psQuote).join(' ')}; if ($LASTEXITCODE -ne 0) { Write-Error ('Pi exited with code ' + $LASTEXITCODE) }`;
      const command = platform === 'win32'
        ? `powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded(script)}`
        : `sh -c ${shQuote(`cd ${shQuote(request.cwd)} && exec pi ${args.map(shQuote).join(' ')}`)}`;
      try { await exec('herdr', ['pane', 'run', pane, command]); }
      catch (e) { fail(`Herdr Pi command submission failed in tab ${tab}, pane ${pane}: ${String(e)}. Tab/process may remain; no automatic cleanup/retry/replacement`); }
      return { commandSubmitted: true, tab, pane, piReadiness: 'not observed; inspect pane for startup failures', registrationAwaited: false };
    }
    if (request.multiplexer !== 'none') fail('unsupported multiplexer');
    // Use encoded PowerShell rather than constructing cmd.exe command strings.
    // The outer process reports only successful visible terminal creation, not Pi readiness.
    const child = `$ErrorActionPreference='Stop'; Get-ChildItem Env: | Where-Object { $_.Name -like 'HERDR_*' -or $_.Name -like 'PI_SESSION_*' } | ForEach-Object { Remove-Item ('Env:' + $_.Name) }; Set-Location -LiteralPath ${psQuote(request.cwd)}; & (Get-Command pi.cmd -ErrorAction Stop).Source ${args.map(psQuote).join(' ')}; if ($LASTEXITCODE -ne 0) { Write-Error ('Pi exited with code ' + $LASTEXITCODE) }`;
    const outer = `$ErrorActionPreference='Stop'; $null=Get-Command pi.cmd -ErrorAction Stop; $p=Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -WorkingDirectory ${psQuote(request.cwd)} -ArgumentList @('-NoProfile','-NoExit','-EncodedCommand',${psQuote(encoded(child))}) -WindowStyle Normal -PassThru; $p.Id`;
    const result = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded(outer)]);
    const pid = Number(result.trim());
    if (!Number.isInteger(pid) || pid <= 0) fail('visible terminal launch returned no process ID; outcome unknown');
    return { terminalLaunched: true, pid, piReadiness: 'not observed; inspect visible terminal for startup failures', registrationAwaited: false };
  }
  async function syncName(name: string): Promise<void> {
    if (env.HERDR_ENV !== '1') return;
    // Resolve inherited pane context, including panes moved since launch.
    if (!env.HERDR_PANE_ID) fail('Herdr tab name sync requires caller pane identity');
    const data = JSON.parse(await exec('herdr', ['pane', 'current', '--current']));
    const tab = data.result?.pane?.tab_id;
    if (typeof tab !== 'string') fail('Herdr current-pane response missing tab_id; tab name not synchronized');
    await exec('herdr', ['tab', 'rename', tab, name]);
  }
  return { launch, syncName };
}
