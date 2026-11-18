import test from 'node:test';
import { workspaceFields, fakeValidateWorkspace } from './workspace-fixture.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Intercom } from '../dist/runtime.js';
import { ConfigStore } from '../dist/config.js';
import { listen } from '../dist/transport.js';

async function waitFor(predicate, label) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(`Timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'intercom-quality-http-'));
  // Stop production upward discovery inside this fixture, never at a real ancestor project.
  // Coordinator startup replaces this test-only saved port with its actual bound endpoint.
  await new ConfigStore(root).initialize('coordinator', 12345);
  const runtimes = [], extraEndpoints = [];
  t.after(async () => {
    for (const runtime of runtimes) await runtime.close();
    for (const endpoint of extraEndpoints) await endpoint.close();
    await rm(root, { recursive: true, force: true });
  });
  async function start(id) {
    const messages = [], notices = [], names = [];
    const host = { cwd: root, sessionId: () => id, busy: () => false,
      deliver: (text, busy) => messages.push({ text, busy }),
      setName: async name => { names.push(name); }, notify: text => notices.push(text) };
    const runtime = new Intercom(host, { validateWorkspace: fakeValidateWorkspace, launch: async () => assert.fail('must not launch a process') });
    runtimes.push(runtime); await runtime.start();
    return { runtime, host, messages, notices, names };
  }
  async function configure(coordinator, worker, id, name) {
    await coordinator.runtime.tool('configure_worker', { ...workspaceFields, sessionId: id, name,
      port: worker.runtime.endpoint.port, projectDirectory: '.', description: `${name} assigned remit` });
    await coordinator.runtime.tool('reload_worker', { to: name });
  }
  return { start, configure, extraEndpoints };
}

test('real HTTP runtime registration, passive configure/reload, peer delivery and independent status', async t => {
  const f = await fixture(t), c = await f.start('coordinator'), a = await f.start('worker-a');
  assert.equal(c.messages.length, 1);
  assert.deepEqual(c.names, [], 'coordinator startup must not rename the Pi session or Herdr tab');
  let existingTitle = 'User project session';
  c.host.setName = async name => { existingTitle = name; };
  await c.runtime.reload();
  assert.equal(existingTitle, 'User project session');
  assert.equal(c.runtime.responsibility.name, 'Coordinator');
  assert.match(c.messages[0].text, /Intercom registration/);
  assert.match(c.messages[0].text, /"sessionId":"worker-a"/);
  assert.equal((await c.runtime.store.read()).agents.length, 1);
  assert.equal(a.runtime.responsibility, undefined);
  await c.runtime.tool('configure_worker', { ...workspaceFields, sessionId: 'worker-a', name: 'Alpha', port: a.runtime.endpoint.port,
    projectDirectory: '.', description: 'Alpha assigned remit' });
  assert.equal(a.runtime.responsibility, undefined);
  assert.equal(a.messages.length, 0);
  await assert.rejects(c.runtime.tool('send', { to: 'Alpha', message: 'Not loaded yet' }), /responsibility/);
  await c.runtime.tool('reload_worker', { to: 'aLPHA' });
  assert.equal(a.runtime.responsibility.description, 'Alpha assigned remit');
  assert.deepEqual(a.names, ['Alpha']);
  assert.equal(a.messages.length, 0);
  await a.runtime.tool('send', { to: 'Coordinator', message: 'Reserved coordinator routing still works' });
  assert.match(c.messages.at(-1).text, /Reserved coordinator routing still works/);
  assert.equal(existingTitle, 'User project session');
  await c.runtime.tool('send', { to: 'Alpha', message: 'Explicit assignment' });
  assert.match(a.messages.at(-1).text, /Explicit assignment/);
  assert.equal(a.messages.at(-1).busy, false);
  const b = await f.start('worker-b'); await f.configure(c, b, 'worker-b', 'Beta');
  a.host.busy = () => true;
  await b.runtime.tool('send', { to: 'Alpha', message: 'Peer findings' });
  assert.match(a.messages.at(-1).text, /from Beta \(worker-b\)/);
  assert.equal(a.messages.at(-1).busy, true);
  const beforeWorker = a.messages.length, beforeCoordinator = c.messages.length;
  const result = await c.runtime.tool('request_status', { to: 'Alpha' });
  assert.deepEqual(result, { accepted: true, completion: 'not awaited' });
  await waitFor(() => c.messages.length > beforeCoordinator, 'independent status report');
  assert.match(c.messages.at(-1).text, /Intercom status/);
  assert.match(c.messages.at(-1).text, /"busy":true/);
  assert.equal(a.messages.length, beforeWorker, 'status must not create a worker turn');
});

test('real HTTP runtime reuses saved port and reports occupied-port fallback without work', async t => {
  const f = await fixture(t), c = await f.start('coordinator'), a = await f.start('worker-a');
  await f.configure(c, a, 'worker-a', 'Alpha');
  const saved = a.runtime.endpoint.port;
  await a.runtime.close();
  const resumed = await f.start('worker-a');
  assert.equal(resumed.runtime.endpoint.port, saved);
  assert.equal(resumed.messages.length, 0);
  assert.deepEqual(resumed.names, ['Alpha']);
  await resumed.runtime.close();
  const occupied = await listen(saved, async () => assert.fail('must not deliver to occupied endpoint'));
  f.extraEndpoints.push(occupied);
  assert.equal(occupied.port, saved);
  const fallback = await f.start('worker-a');
  assert.notEqual(fallback.runtime.endpoint.port, saved);
  assert.equal((await c.runtime.store.read()).agents.find(a => a.sessionId === 'worker-a').port, fallback.runtime.endpoint.port);
  assert.equal(fallback.messages.length, 0);
  await c.runtime.tool('send', { to: 'Alpha', message: 'Use refreshed endpoint' });
  assert.match(fallback.messages.at(-1).text, /Use refreshed endpoint/);
});

test('explicit health checks preserve saved workers and do not deliver messages or write config', async t => {
  const f = await fixture(t), c = await f.start('coordinator'), a = await f.start('worker-a');
  await f.configure(c, a, 'worker-a', 'Alpha');
  const before = await c.runtime.store.read(), count = c.messages.length, workerCount = a.messages.length;
  const local = await c.runtime.tool('worker_status', { name: 'Alpha' });
  assert.equal(local.workers[0].connection.state, 'unknown');
  const live = await c.runtime.tool('worker_status', { name: 'Alpha', probe: true });
  assert.equal(live.workers[0].connection.state, 'connected');
  assert.equal(c.messages.length, count); assert.equal(a.messages.length, workerCount);
  assert.deepEqual(await c.runtime.store.read(), before);
  await assert.rejects(c.runtime.tool('resume_worker', { to: 'Alpha', confirmClosed: true }), /still connected/);
  await a.runtime.close();
  const disconnected = await c.runtime.tool('worker_status', { name: 'Alpha', probe: true });
  assert.equal(disconnected.workers[0].connection.state, 'disconnected');
  assert.deepEqual(await c.runtime.store.read(), before);
  const resumed = await f.start('worker-a');
  assert.equal(resumed.runtime.responsibility.name, 'Alpha');
  assert.equal(resumed.runtime.responsibility.description, 'Alpha assigned remit');
  assert.equal(resumed.messages.length, 0);
  const back = await c.runtime.tool('worker_status', { name: 'Alpha', probe: true });
  assert.equal(back.workers[0].connection.state, 'connected');
});

test('real HTTP coordinator loss leaves workers reachable for peer communication', async t => {
  const f = await fixture(t), c = await f.start('coordinator'), a = await f.start('worker-a'), b = await f.start('worker-b');
  await f.configure(c, a, 'worker-a', 'Alpha'); await f.configure(c, b, 'worker-b', 'Beta');
  await c.runtime.close();
  await assert.rejects(a.runtime.report(), /ECONNREFUSED/);
  await b.runtime.tool('send', { to: 'Alpha', message: 'Continue assigned peer work' });
  assert.match(a.messages.at(-1).text, /Continue assigned peer work/);
  assert.ok(a.runtime.endpoint);
});
