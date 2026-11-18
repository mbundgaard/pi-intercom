import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../', import.meta.url));

// npm.cmd cannot be executed directly by spawnSync on Windows. npm scripts
// provide npm_execpath; also support direct node --test with standard installs.
function npmCommand() {
  const cli = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'),
  ].find(candidate => candidate && existsSync(candidate));
  if (cli) return [process.execPath, cli];
  assert.notEqual(process.platform, 'win32', 'Run through npm or set npm_execpath to npm-cli.js on Windows');
  return ['npm'];
}

function run(command, args, cwd, timeout, expectedStatus = 0) {
  const env = { ...process.env };
  // Do not let host-provided module paths/loaders satisfy missing dependencies.
  delete env.NODE_PATH;
  delete env.NODE_OPTIONS;
  const result = spawnSync(command, args, {
    cwd, env, encoding: 'utf8', timeout, maxBuffer: 2 * 1024 * 1024,
    windowsHide: true,
  });
  const diagnostic = [result.error?.message, result.stdout, result.stderr]
    .filter(Boolean).join('\n').slice(-12000);
  assert.equal(result.error, undefined, `Subprocess failed: ${diagnostic}`);
  assert.equal(result.status, expectedStatus, `Subprocess exited ${result.status} (${result.signal ?? 'no signal'}): ${diagnostic}`);
  return result;
}

test('packed standalone monitor imports without Pi host peers', { timeout: 300000 }, () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'pi-intercom-package-'));
  try {
    const [npm, ...npmArgs] = npmCommand();
    const packed = JSON.parse(run(npm, [...npmArgs, 'pack', '--ignore-scripts', '--json',
      '--pack-destination', temporary], repository, 60000).stdout);
    assert.equal(packed.length, 1);
    const paths = packed[0].files.map(file => file.path.replaceAll('\\', '/'));
    for (const required of ['dist/monitor.js', 'dist/monitor-view.js', 'rules.md', 'src/workspace.ts', 'dist/workspace.js']) {
      assert.ok(paths.includes(required), `Tarball missing ${required}; build before running this test`);
    }
    for (const entry of paths) {
      assert.doesNotMatch(entry, /(^|\/)(?:\.pi(?:-intercom)?|\.git|node_modules)(?:\/|$)/,
        `Tarball contains project state: ${entry}`);
      assert.doesNotMatch(entry, /(^|\/)(?:dashboard(?:[./-]|$)|web(?:\/|$))/i,
        `Tarball contains retired dashboard assets: ${entry}`);
    }

    const tarball = path.join(temporary, packed[0].filename);
    run(npm, [...npmArgs, 'install', '--prefix', temporary, '--omit=dev', '--legacy-peer-deps',
      '--ignore-scripts', '--no-audit', '--no-fund', tarball], temporary, 180000);

    // Resolve from the installed package, not this repository or its dev deps.
    // A fresh process also catches accidental terminal startup during import.
    run(process.execPath, ['--input-type=module', '--eval', `
      import assert from 'node:assert/strict';
      import { existsSync, readFileSync } from 'node:fs';
      import { createRequire } from 'node:module';
      import path from 'node:path';
      import { pathToFileURL } from 'node:url';
      const installed = path.join(process.cwd(), 'node_modules/@comput/pi-intercom');
      const require = createRequire(path.join(installed, 'package.json'));
      for (const peer of ['@earendil-works/pi-coding-agent', 'typebox', '@earendil-works/pi-tui']) {
        assert.equal(existsSync(path.join(process.cwd(), 'node_modules', peer)), false, peer + ' was installed');
        assert.throws(() => require.resolve(peer), { code: 'MODULE_NOT_FOUND' }, peer + ' unexpectedly resolves');
      }
      assert.ok(require.resolve('pi-intercom-tui'));
      assert.match(readFileSync(path.join(installed, 'rules.md'), 'utf8'), /Change files only in your configured worktree/);
      const monitor = await import(pathToFileURL(path.join(installed, 'dist/monitor.js')).href);
      const view = await import(pathToFileURL(path.join(installed, 'dist/monitor-view.js')).href);
      assert.equal(typeof monitor.createMonitor, 'function');
      assert.equal(typeof monitor.parseMonitorRoot, 'function');
      assert.equal(typeof view.renderMonitor, 'function');
      assert.ok(view.renderMonitor(undefined, 100, 5).at(-1).includes('Intercom v' + require('./package.json').version));
      assert.equal(monitor.parseMonitorRoot(['--root', process.cwd()]), process.cwd());
    `], temporary, 30000);

    const cli = run(process.execPath, [path.join(temporary,
      'node_modules/@comput/pi-intercom/dist/monitor.js'), '--root', temporary], temporary, 30000, 1);
    assert.equal(cli.stdout, '');
    assert.equal(cli.stderr.trim(), 'Intercom monitor requires an interactive terminal.');
  } finally {
    rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
