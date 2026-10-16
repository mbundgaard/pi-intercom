import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { CONFIG_DIR_NAME, SessionManager } from '@earendil-works/pi-coding-agent';
import { resumeSessionDirectory } from '../dist/index.js';
import { launchers } from '../dist/launcher.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'intercom-resume-'));
  const cwd = path.join(root, 'worker'), agentDir = path.join(root, 'agent');
  await mkdir(path.join(cwd, CONFIG_DIR_NAME), { recursive: true });
  await mkdir(agentDir);
  t.after(() => rm(root, { recursive: true, force: true }));
  const global = value => writeFile(path.join(agentDir, 'settings.json'), JSON.stringify(value));
  const project = value => writeFile(path.join(cwd, CONFIG_DIR_NAME, 'settings.json'), JSON.stringify(value));
  return { root, cwd, agentDir, global, project };
}

test('resume storage matches child-cwd settings and env precedence without changing process cwd', async t => {
  const f = await fixture(t), originalCwd = process.cwd();
  assert.equal(resumeSessionDirectory(f.cwd, '', f.agentDir), undefined);
  await f.global({ sessionDir: 'global-sessions' });
  assert.equal(resumeSessionDirectory(f.cwd, '', f.agentDir), path.join(f.cwd, 'global-sessions'));
  await f.project({ sessionDir: '.pi/sessions' });
  assert.equal(resumeSessionDirectory(f.cwd, '', f.agentDir), path.join(f.cwd, '.pi', 'sessions'));
  assert.equal(resumeSessionDirectory(f.cwd, 'env-sessions', f.agentDir), path.join(f.cwd, 'env-sessions'));
  const absolute = path.join(f.root, 'absolute');
  assert.equal(resumeSessionDirectory(f.cwd, absolute, f.agentDir), absolute);
  assert.equal(process.cwd(), originalCwd);
});

test('resume storage uses public Pi normalization for tilde settings and env paths', async t => {
  const f = await fixture(t);
  await f.project({ sessionDir: '~/intercom-test-sessions' });
  assert.equal(resumeSessionDirectory(f.cwd, '', f.agentDir), path.join(homedir(), 'intercom-test-sessions'));
  assert.equal(resumeSessionDirectory(f.cwd, '~/intercom-env-sessions', f.agentDir), path.join(homedir(), 'intercom-env-sessions'));
  // Resolution only: never create files under the real home/session directories.
});

test('settings-based saved session passes resume preflight; missing ID never launches a replacement', async t => {
  const f = await fixture(t);
  await f.project({ sessionDir: 'saved-sessions' });
  const sessionDir = resumeSessionDirectory(f.cwd, '', f.agentDir);
  await mkdir(sessionDir);
  const id = '01900000-0000-7000-8000-000000000001';
  const timestamp = '2026-01-01T00:00:00.000Z';
  // Static fixture only, not a live Pi session or model turn.
  const header = { type: 'session', version: 3, id, timestamp, cwd: f.cwd };
  await writeFile(path.join(sessionDir, `fixture_${id}.jsonl`), JSON.stringify(header) + '\n');
  const sessionExists = async (cwd, candidate) => (await SessionManager.list(cwd, resumeSessionDirectory(cwd, '', f.agentDir))).some(s => s.id === candidate);
  assert.equal(await sessionExists(f.cwd, id), true);
  let launches = 0;
  const launcher = launchers({ extension: '/test/index.ts', platform: 'win32', env: {}, sessionExists,
    run: async () => { launches++; return '12345'; } });
  const result = await launcher.launch({ multiplexer: 'none', cwd: f.cwd, workspaceRoot: f.cwd, sessionId: id });
  assert.equal(result.terminalLaunched, true);
  assert.equal(launches, 1);
  await assert.rejects(launcher.launch({ multiplexer: 'none', cwd: f.cwd, workspaceRoot: f.cwd, sessionId: 'missing' }), /saved Pi session not found/);
  assert.equal(launches, 1);
});
