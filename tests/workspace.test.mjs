import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ConfigStore, requireWorkspace, validateConfig } from '../dist/config.js';
import { validateWorkerWorkspace } from '../dist/workspace.js';
import { Intercom } from '../dist/runtime.js';
import { renderMonitor } from '../dist/monitor-view.js';
import { createGitWorkspace, workspaceFields, git } from './workspace-fixture.mjs';

async function repository(t) {
  const base = await mkdtemp(path.join(tmpdir(), 'intercom-workspace-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'project with spaces');
  await mkdir(root); await createGitWorkspace(root);
  return { root, base, worktree: path.join(root, workspaceFields.worktree) };
}
async function runtimes(t, options = {}) {
  const all = [], checks = [], messages = [], launches = [];
  t.after(async () => { for (const runtime of all) await runtime.close(); });
  const f = await repository(t);
  await new ConfigStore(f.root).initialize('c', 12345);
  const shared = { launch: async request => { launches.push(request); return { launched: true }; },
    validateWorkspace: async (root, worker) => { checks.push(worker.sessionId); return validateWorkerWorkspace(root, worker); }, ...options };
  async function start(id) {
    const host = { cwd: f.root, sessionId: () => id, busy: () => false, setName: async () => {}, notify() {}, deliver: text => messages.push({ id, text }) };
    const runtime = new Intercom(host, shared); all.push(runtime); await runtime.start(); return runtime;
  }
  const c = await start('c'), w = await start('w');
  const values = { sessionId: 'w', name: 'Builder', description: 'Assigned work', projectDirectory: '.', port: w.endpoint.port, ...workspaceFields };
  const configure = async () => { await c.tool('configure_worker', values); await c.tool('reload_worker', { to: 'Builder' }); };
  return { ...f, c, w, checks, messages, launches, start, values, configure };
}

test('required workspace fields reject absent, blank, none, control characters and main; legacy schema stays readable', async t => {
  const { root } = await repository(t), store = new ConfigStore(root);
  await store.initialize('c', 12345);
  const worker = { sessionId: 'w', name: 'Worker', description: 'Review', port: 12346, projectDirectory: '.' };
  await assert.rejects(store.configure('c', worker), /requires worktree and branch/);
  for (const field of ['worktree', 'branch']) {
    for (const value of ['', ' ', 'none', 'NONE', ' none ', 'bad\nvalue', '\0']) {
      const candidate = { ...worker, ...workspaceFields, [field]: value };
      assert.throws(() => requireWorkspace(candidate), /invalid/);
      await assert.rejects(store.configure('c', candidate), /invalid/);
    }
  }
  for (const field of ['sessionId', 'name', 'description', 'projectDirectory']) {
    await assert.rejects(store.configure('c', { ...worker, ...workspaceFields, [field]: 'none' }), /invalid/);
  }
  assert.throws(() => requireWorkspace({ ...workspaceFields, branch: 'main' }), /main branch/);
  const config = await store.read(); config.agents.push({ ...worker, coordinator: false });
  const contents = JSON.stringify(config); await writeFile(store.file, contents);
  assert.equal(validateConfig(config).agents[1].worktree, undefined);
  assert.equal((await store.read()).agents[1].branch, undefined);
  assert.equal(await readFile(store.file, 'utf8'), contents);
  await store.configure('c', { ...worker, ...workspaceFields });
  assert.equal((await store.read()).agents[1].worktree, workspaceFields.worktree);
  const invalidCoordinator = await store.read(); invalidCoordinator.agents[0].branch = 'main';
  assert.throws(() => validateConfig(invalidCoordinator), /worker-only/);
});

test('real read-only checks resolve absolute and sibling paths without changing checkout or files', async t => {
  const f = await repository(t);
  const sibling = path.join(f.base, 'sibling worker');
  await git(f.root, 'worktree', 'add', '-b', 'work/sibling', sibling);
  const before = await git(f.root, 'worktree', 'list', '--porcelain');
  for (const worktree of [sibling, '../sibling worker']) {
    assert.deepEqual(await validateWorkerWorkspace(f.root, { worktree, branch: 'work/sibling' }), { worktree: await realpath(sibling), branch: 'work/sibling' });
  }
  assert.equal(await git(f.root, 'worktree', 'list', '--porcelain'), before);
  assert.equal(await git(sibling, 'status', '--porcelain'), '');
  assert.equal(await git(f.root, 'branch', '--show-current'), 'main');
});

test('real checks reject wrong repository, wrong branch, detached HEAD, subdirectory, project root and missing folder', async t => {
  const f = await repository(t);
  const other = path.join(f.base, 'other'); await mkdir(other); await createGitWorkspace(other);
  await assert.rejects(validateWorkerWorkspace(f.root, { worktree: path.join(other, '.worker'), branch: workspaceFields.branch }), /different repository/);
  await assert.rejects(validateWorkerWorkspace(f.root, { ...workspaceFields, branch: 'work/wrong' }), /configured branch/);
  await mkdir(path.join(f.worktree, 'nested'));
  await assert.rejects(validateWorkerWorkspace(f.root, { worktree: '.worker/nested', branch: workspaceFields.branch }), /not a subdirectory/);
  await assert.rejects(validateWorkerWorkspace(f.root, { worktree: '.', branch: 'work/root' }), /separate from the project root/);
  await assert.rejects(validateWorkerWorkspace(f.root, { worktree: '../missing', branch: 'work/missing' }), /missing or inaccessible/);
  await git(f.worktree, 'checkout', '--detach');
  await assert.rejects(validateWorkerWorkspace(f.root, workspaceFields), /Git check failed/);
});

test('Git environment overrides cannot redirect validation into another checkout', async t => {
  const f = await repository(t);
  const original = process.env.GIT_DIR;
  process.env.GIT_DIR = path.join(f.base, 'does-not-exist');
  try { assert.equal((await validateWorkerWorkspace(f.root, workspaceFields)).worktree, await realpath(f.worktree)); }
  finally { if (original === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = original; }
});

test('worker loads its own entry, validates before each run but not each tool, and resumes without starting work', async t => {
  const f = await runtimes(t); await f.configure();
  assert.equal(f.w.responsibility.branch, workspaceFields.branch);
  assert.deepEqual(f.checks, ['w']);
  const messageCount = f.messages.length;
  for (let i = 0; i < 2; i++) {
    const prompt = await f.w.beforeRunInstructions();
    assert.ok(prompt.includes(`Worktree: ${await realpath(f.worktree)}`));
    assert.match(prompt, /Branch: work\/test/);
    assert.match(prompt, /tools still start in the project root/);
  }
  assert.deepEqual(f.checks, ['w', 'w', 'w']);
  await f.w.tool('list', {}); await f.w.tool('list', {});
  assert.equal(f.checks.length, 3); assert.equal(f.messages.length, messageCount);
  const status = await f.c.tool('worker_status', { name: 'Builder' });
  assert.equal(status.workers[0].worktree, workspaceFields.worktree);
  assert.equal(status.workers[0].branch, workspaceFields.branch);
  assert.equal(status.workers[0].description, 'Assigned work');
  const roster = await f.c.tool('list', {});
  assert.equal(roster.agents.find(a => a.sessionId === 'w').branch, workspaceFields.branch);
  await f.w.close(); const restarted = await f.start('w');
  assert.equal(restarted.responsibility.worktree, workspaceFields.worktree);
  assert.equal(f.messages.filter(message => message.id === 'w').length, 0);
  await restarted.report();
  assert.match(f.messages.at(-1).text, /"workspaceState":"loaded"/);
  assert.match(f.messages.at(-1).text, /"branch":"work\/test"/);
});

test('legacy workers remain readable, get migration instructions, and cannot reload/resume until explicitly reconfigured', async t => {
  const f = await runtimes(t);
  await f.c.store.update('c', config => {
    const { worktree, branch, ...legacy } = f.values;
    config.agents.push({ ...legacy, coordinator: false });
  });
  const original = await readFile(f.c.store.file, 'utf8');
  for (let i = 0; i < 2; i++) {
    const prompt = await f.c.beforeRunInstructions();
    assert.match(prompt, /Workers with incomplete configuration: \["Builder"\]/);
    assert.match(prompt, /Do not guess missing values; ask the user/);
  }
  assert.equal(await readFile(f.c.store.file, 'utf8'), original);
  await assert.rejects(f.c.tool('reload_worker', { to: 'Builder' }), /requires worktree and branch/);
  await assert.rejects(f.c.tool('resume_worker', { to: 'Builder', confirmClosed: true }), /requires worktree and branch/);
  assert.match(await f.w.beforeRunInstructions(), /NOT READY/);
  await f.w.tool('report_work', { status: 'blocked', summary: 'My workspace configuration is incomplete.' });
  await assert.rejects(f.c.tool('send', { to: 'Builder', message: 'Premature assignment' }), /load responsibility/);
  assert.equal(f.launches.length, 0);
  await f.configure();
  assert.doesNotMatch(await f.c.beforeRunInstructions(), /Workers with incomplete configuration/);
  assert.match(await f.w.beforeRunInstructions(), /Identity: Builder/);
  await f.c.tool('send', { to: 'Builder', message: 'Explicit assignment' });
  assert.match(f.messages.at(-1).text, /Explicit assignment/);
});

test('a failed per-run check discards readiness, permits reporting, and requires reload after repair', async t => {
  const f = await runtimes(t); await f.configure();
  await git(f.worktree, 'checkout', '-b', 'work/unexpected');
  assert.match(await f.w.beforeRunInstructions(), /NOT READY.*configured branch/);
  assert.equal(f.w.responsibility, undefined);
  await f.w.tool('send', { to: 'Coordinator', message: 'Workspace branch mismatch; waiting.' });
  await assert.rejects(f.w.tool('report_work', { status: 'ready_for_review', summary: 'Not allowed' }), /configured/);
  await git(f.worktree, 'checkout', workspaceFields.branch);
  assert.match(await f.w.beforeRunInstructions(), /NOT READY/);
  await f.c.tool('reload_worker', { to: 'Builder' });
  assert.match(await f.w.beforeRunInstructions(), /Identity: Builder/);
  await rename(f.worktree, `${f.worktree}-moved`);
  assert.match(await f.w.beforeRunInstructions(), /NOT READY.*missing or inaccessible/);
  await rename(`${f.worktree}-moved`, f.worktree);
  await f.w.reload();
  assert.match(await f.w.beforeRunInstructions(), /Identity: Builder/);
});

test('failed reload cannot leave old responsibility active; startup failures keep an endpoint but not readiness', async t => {
  const f = await runtimes(t); await f.configure();
  await f.c.store.update('c', config => { config.agents.find(a => a.sessionId === 'w').branch = 'work/absent'; });
  await assert.rejects(f.w.reload(), /configured branch/);
  assert.equal(f.w.responsibility, undefined);
  await f.w.close(); const restarted = await f.start('w');
  assert.ok(restarted.endpoint); assert.equal(restarted.responsibility, undefined);
  assert.match(await restarted.beforeRunInstructions(), /NOT READY/);
});

test('live busy check refuses workspace changes and reload; unknown endpoints cannot authorize reassignment', async t => {
  const f = await runtimes(t); await f.configure();
  const before = await readFile(f.c.store.file, 'utf8');
  f.w.host.busy = () => true;
  await assert.rejects(f.c.tool('configure_worker', { ...f.values, branch: 'work/next' }), /verified idle/);
  assert.equal(await readFile(f.c.store.file, 'utf8'), before);
  await assert.rejects(f.c.tool('reload_worker', { to: 'Builder' }), /idle worker/);
  f.w.host.busy = () => false;
  await f.w.reload();
  await f.c.tool('configure_worker', { ...f.values, branch: 'work/next' });
  assert.match(await f.w.beforeRunInstructions(), /NOT READY.*configuration changed/);
  await f.w.close();
  await assert.rejects(f.c.tool('configure_worker', { ...f.values, branch: 'work/another' }), /verified idle/);
});

test('configuration changes during validation do not apply a mixed snapshot', async t => {
  const f = await runtimes(t); await f.configure();
  f.w.options.validateWorkspace = async (root, agent) => {
    const result = await validateWorkerWorkspace(root, agent);
    await f.c.store.update('c', config => { config.agents.find(a => a.sessionId === 'w').description = 'Changed while checking'; });
    return result;
  };
  assert.match(await f.w.beforeRunInstructions(), /NOT READY.*configuration changed during validation/);
  assert.equal(f.w.responsibility, undefined);
});

test('monitor details show both workspace fields, including clear legacy migration markers', () => {
  const worker = { sessionId: 'w', name: 'Builder', description: 'Review', coordinator: false, ...workspaceFields };
  const snapshot = { version: 1, generatedAt: new Date().toISOString(), staleAfterMs: 60000, config: { multiplexer: 'herdr', agents: [worker] }, events: [], errors: [], truncated: false };
  let output = renderMonitor(snapshot, 120, 24, Date.now(), false, { selectedIndex: 0, details: true }).join('\n');
  assert.match(output, /Worktree: \.worker/); assert.match(output, /Branch: work\/test/);
  delete worker.worktree; delete worker.branch;
  output = renderMonitor(snapshot, 120, 24, Date.now(), false, { selectedIndex: 0, details: true }).join('\n');
  assert.match(output, /Worktree: Missing — reconfigure worker/);
  assert.match(output, /Branch: Missing — reconfigure worker/);
});
