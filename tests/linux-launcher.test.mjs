import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchers } from '../dist/launcher.js';

const options = { platform: 'linux', extension: "/source/O'Brien $HOME;`echo bad`/index.ts",
  env: { HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'workspace', PI_INTERCOM_ROOT: '/unrelated/inherited-root' }, sessionExists: async () => true };
const created = JSON.stringify({ result: { tab: { tab_id: 'tab' }, root_pane: { pane_id: 'pane' } } });

test('Linux Herdr uses returned pane and quotes cwd, extension and resume ID literally', { skip: process.platform !== 'linux' }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'intercom-linux-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, "O'Brien $HOME;`echo bad`");
  await mkdir(cwd);
  // A fake pi executable verifies real shell parsing without launching an agent.
  await writeFile(path.join(root, 'pi'), '#!/bin/sh\nprintf "%s\\n" "$PWD" "$@"\n', { mode: 0o700 });
  const calls = [];
  const launcher = launchers({ ...options, run: async (file, args) => { calls.push({ file, args }); return created; } });
  const sessionId = "session'$HOME;`echo bad`";
  const workspaceRoot = cwd;
  const result = await launcher.launch({ multiplexer: 'herdr', cwd, workspaceRoot, sessionId });
  assert.deepEqual(calls[0], { file: 'herdr', args: ['tab', 'create', '--workspace', 'workspace', '--cwd', cwd, '--label', 'Intercom (anonymous)', '--no-focus'] });
  assert.deepEqual(calls[1].args.slice(0, 3), ['pane', 'run', 'pane']);
  assert.equal(calls.length, 2);
  assert.equal(result.commandSubmitted, true);
  assert.equal(result.registrationAwaited, false);
  const { stdout } = await promisify(execFile)('/bin/sh', ['-c', calls[1].args[3]], { env: { ...process.env, PATH: `${root}:${process.env.PATH}` } });
  assert.deepEqual(stdout.trimEnd().split('\n'), [cwd, '-e', options.extension, '--intercom-root', workspaceRoot, '--session', sessionId]);
});

test('Linux rejects unsupported launcher, missing workspace and missing resume before launch', async () => {
  const run = async () => assert.fail('must not launch');
  await assert.rejects(launchers({ ...options, run }).launch({ multiplexer: 'none', cwd: '/tmp', workspaceRoot: '/tmp' }), /No terminal fallback/);
  await assert.rejects(launchers({ ...options, env: {}, run }).launch({ multiplexer: 'herdr', cwd: '/tmp', workspaceRoot: '/tmp' }), /no fallback/);
  await assert.rejects(launchers({ ...options, sessionExists: async () => false, run }).launch({ multiplexer: 'herdr', cwd: '/tmp', workspaceRoot: '/tmp', sessionId: 'missing' }), /not found/);
  await assert.rejects(launchers({ ...options, platform: 'darwin', run }).launch({ multiplexer: 'herdr', cwd: '/tmp', workspaceRoot: '/tmp' }), /Windows and Linux/);
});

test('Linux launch ignores inherited root and requires an explicit absolute root', async () => {
  const launcher = launchers({ ...options, run: async () => assert.fail('no launch') });
  for (const workspaceRoot of [undefined, '', '.', 'D:/windows-path', '/tmp/bad\0root']) {
    await assert.rejects(launcher.launch({ multiplexer: 'herdr', cwd: '/tmp', workspaceRoot }), /explicit absolute workspace root/);
  }
});
test('Linux rejects parent or unrelated explicit roots before lookup or spawn', async () => {
  const launcher = launchers({ ...options, sessionExists: async () => assert.fail('no lookup'), run: async () => assert.fail('no launch') });
  for (const workspaceRoot of ['/tmp', '/', '/unrelated']) {
    await assert.rejects(launcher.launch({ multiplexer: 'herdr', cwd: '/tmp/child', workspaceRoot, sessionId: 'saved' }), /root must equal its working directory/);
  }
});
test('Linux partial command submission failure leaves tab and never retries', async () => {
  let count = 0;
  const launcher = launchers({ ...options, run: async () => { if (++count === 1) return created; throw new Error('submission failed'); } });
  await assert.rejects(launcher.launch({ multiplexer: 'herdr', cwd: '/tmp', workspaceRoot: '/tmp' }), /may remain; no automatic cleanup/);
  assert.equal(count, 2);
});
