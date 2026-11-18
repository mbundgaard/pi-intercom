import test from 'node:test';
import { workspaceFields, fakeValidateWorkspace } from './workspace-fixture.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, stat, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Intercom } from '../dist/runtime.js';
import { ConfigStore } from '../dist/config.js';
import { LocalObserver, LOG_DIRECTORY, LOG_FILE_PATTERN, LOG_LIMITS } from '../dist/observability.js';
import { readObservationSnapshot } from '../dist/snapshot.js';

const BODY = 'PRIVATE_TASK_BODY_MUST_NOT_BE_LOGGED';
const CREDENTIAL = 'PRIVATE_ERROR_CREDENTIAL_MUST_NOT_BE_LOGGED';
async function fixture(t, createObserver = (root, id) => new LocalObserver(root, id)) {
  const root = await mkdtemp(path.join(tmpdir(), 'intercom-quality-observation-'));
  // Isolate discovery from real ancestor projects; startup replaces this saved test port.
  await new ConfigStore(root).initialize('coordinator', 12345);
  const runtimes = [], observers = [];
  t.after(async () => {
    for (const runtime of runtimes) await runtime.close();
    for (const observer of observers) await observer.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  async function start(id) {
    const messages = [];
    const host = { cwd: root, sessionId: () => id, busy: () => false, setName: async () => {}, notify: () => {},
      deliver: (text, busy) => messages.push({ text, busy }) };
    const runtime = new Intercom(host, { validateWorkspace: fakeValidateWorkspace, launch: async () => assert.fail('must not launch real workers'),
      observe: (directory, sessionId) => { const observer = createObserver(directory, sessionId); observers.push(observer); return observer; } });
    runtimes.push(runtime); await runtime.start(); return { runtime, host, messages };
  }
  async function configure(c, w) {
    await c.runtime.tool('configure_worker', { ...workspaceFields, sessionId: 'worker', name: 'Worker', description: 'Assigned remit',
      port: w.runtime.endpoint.port, projectDirectory: '.' });
    await c.runtime.tool('reload_worker', { to: 'Worker' });
  }
  async function finish() {
    for (const runtime of runtimes) await runtime.close();
    for (const observer of observers) await observer.close();
  }
  return { root, start, configure, finish, observers };
}
async function records(root) {
  const directory = path.join(root, LOG_DIRECTORY);
  const files = (await readdir(directory)).filter(name => LOG_FILE_PATTERN.test(name));
  const text = (await Promise.all(files.map(name => readFile(path.join(directory, name), 'utf8')))).join('');
  return { files, text, events: text.split('\n').filter(Boolean).map(line => JSON.parse(line)) };
}

test('real runtime telemetry correlates HTTP receipt/submission without persisting task bodies, errors or completion', async t => {
  const f = await fixture(t), c = await f.start('coordinator'), w = await f.start('worker');
  await f.configure(c, w);
  await c.runtime.tool('send', { to: 'Worker', message: BODY });
  assert.match(w.messages.at(-1).text, new RegExp(BODY));
  w.runtime.recordObservation('host.activity', { outcome: 'started', busy: true, body: BODY, token: CREDENTIAL });
  w.runtime.recordObservation('host.activity', { outcome: 'settled', busy: false });
  w.host.deliver = () => { throw new Error(CREDENTIAL); };
  await assert.rejects(c.runtime.tool('send', { to: 'Worker', message: BODY }), new RegExp(CREDENTIAL));
  // Unknown status is evidence only, never a registration/config entry.
  await c.runtime.receive({ version: 1, kind: 'status', from: 'removed-worker', to: 'coordinator', payload: { port: 49990, busy: true } });
  assert.equal((await c.runtime.store.read()).agents.length, 2);
  await f.finish();
  const log = await records(f.root);
  assert.doesNotMatch(log.text, new RegExp(`${BODY}|${CREDENTIAL}`));
  assert.ok(log.events.every(event => !('payload' in event) && !('message' in event) && !('stack' in event) && !('token' in event)));
  const receipt = log.events.find(event => event.sessionId === 'coordinator' && event.event === 'transport.receipt' && event.kind === 'message');
  assert.ok(receipt?.correlationId); assert.equal(receipt.outcome, 'http_receipt');
  const correlated = log.events.filter(event => event.correlationId === receipt.correlationId);
  assert.ok(correlated.some(event => event.event === 'transport.send'));
  assert.ok(correlated.some(event => event.event === 'transport.received' && event.sessionId === 'worker'));
  assert.ok(correlated.some(event => event.event === 'host.submission' && event.outcome === 'returned'));
  assert.ok(log.events.some(event => event.event === 'host.submission' && event.outcome === 'failed' && event.errorCode === 'operation_failed'));
  assert.ok(log.events.some(event => event.event === 'status.received' && event.peerSessionId === 'removed-worker'));
  assert.doesNotMatch(log.text, /task\.completed|model\.completed|queue\.accepted/);
  const snapshot = await readObservationSnapshot(f.root);
  assert.ok(snapshot.events.some(event => event.correlationId === receipt.correlationId));
  assert.equal(snapshot.config.agents.some(agent => agent.sessionId === 'removed-worker'), false);
});

test('logger failures cannot break registration, explicit work, or runtime teardown', async t => {
  class BrokenObserver extends LocalObserver {
    async append() { throw Object.assign(new Error(CREDENTIAL), { code: 'ENOSPC' }); }
  }
  const f = await fixture(t, (root, id) => new BrokenObserver(root, id));
  const c = await f.start('coordinator'), w = await f.start('worker'); await f.configure(c, w);
  await c.runtime.tool('send', { to: 'Worker', message: BODY });
  assert.match(w.messages.at(-1).text, new RegExp(BODY));
  await f.finish();
  assert.equal(c.runtime.endpoint, undefined); assert.equal(w.runtime.endpoint, undefined);
});

test('blocked observer has bounded queue and cannot delay communication or exceed shutdown drain budget', async t => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  class SlowObserver extends LocalObserver { async append(file, line) { await blocked; await super.append(file, line); } }
  const f = await fixture(t, (root, id) => new SlowObserver(root, id, { queueEntries: 4 }));
  // Always unblock disk draining before fixture teardown, including startup failures.
  try {
    const c = await f.start('coordinator'), w = await f.start('worker');
    await f.configure(c, w);
    for (let i = 0; i < 50; i++) w.runtime.recordObservation('host.activity', { outcome: 'snapshot', busy: true });
    await c.runtime.tool('send', { to: 'Worker', message: BODY });
    assert.match(w.messages.at(-1).text, new RegExp(BODY));
    assert.ok(f.observers.some(observer => observer.dropped > 0));
    let timer;
    try {
      await Promise.race([Promise.all([c.runtime.close(), w.runtime.close()]), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('runtime close exceeded bounded logger drain plus scheduling tolerance')), LOG_LIMITS.closeTimeoutMs + 750);
      })]);
    } finally { clearTimeout(timer); }
  } finally { release(); }
  await f.finish();
  const log = await records(f.root);
  assert.ok(log.events.length <= 10, 'two writers each retain at most in-flight plus four queued records');
});

test('rotated logs stay bounded, remain metadata-only, and snapshot reads preserve the newest evidence', async t => {
  const f = await fixture(t);
  const observer = new LocalObserver(f.root, 'rotation-writer', { fileBytes: LOG_LIMITS.entryBytes });
  f.observers.push(observer);
  for (let i = 0; i < 200; i++) observer.record('host.activity', { outcome: 'snapshot', busy: i % 2 === 0, correlationId: `sample-${i}`, payload: BODY, credentials: CREDENTIAL });
  await observer.close();
  const log = await records(f.root);
  assert.ok(log.files.length <= 3); assert.ok(log.files.length >= 2, 'fixture actually rotates');
  for (const file of log.files) assert.ok((await stat(path.join(f.root, LOG_DIRECTORY, file))).size <= LOG_LIMITS.entryBytes);
  assert.doesNotMatch(log.text, new RegExp(`${BODY}|${CREDENTIAL}`));
  const before = log.text, snapshot = await readObservationSnapshot(f.root);
  assert.ok(snapshot.events.some(event => event.correlationId === 'sample-199'));
  assert.equal((await records(f.root)).text, before, 'snapshot reads cannot prune/rotate logs');
});
