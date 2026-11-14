import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigStore, monitorSettings, validateConfig } from '../dist/config.js';
import { Intercom } from '../dist/runtime.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'intercom-monitor-settings-'));
  await new ConfigStore(root).initialize('c', 12345);
  const calls = [], endpoints = new Map(); let port = 30000;
  const options = {
    launch: async () => assert.fail('worker launch not expected'),
    observe: () => ({ record() {}, close() {} }),
    listen: async (_preferred, accept) => { const value = port++; endpoints.set(value, accept); return { port: value, close: async () => { endpoints.delete(value); } }; },
    send: async (port, message) => endpoints.get(port)(message),
    monitor: {
      open: async request => { request.assertCurrent(); calls.push({ operation: 'open', ...request }); return { opened: true }; },
      close: async request => { request.assertCurrent(); calls.push({ operation: 'close', ...request }); return { closed: true }; },
    },
  };
  const host = id => ({ cwd: root, sessionId: () => id, busy: () => false, deliver() {}, setName: async () => {}, notify() {} });
  const c = new Intercom(host('c'), options), w = new Intercom(host('w'), options);
  t.after(async () => { await w.close(); await c.close(); await rm(root, { recursive: true, force: true }); });
  await c.start();
  return { root, c, w, options, calls };
}

test('missing settings retain backcompat defaults without rewriting config', async t => {
  const f = await fixture(t);
  const before = await readFile(f.c.store.file, 'utf8');
  assert.deepEqual(await f.c.getMonitorSettings(), { autoOpen: true, placement: 'coordinator-tab' });
  assert.equal((await f.c.store.read()).monitor, undefined);
  assert.equal(await readFile(f.c.store.file, 'utf8'), before);
  const settings = monitorSettings(await f.c.store.read()); settings.autoOpen = false;
  assert.equal((await f.c.getMonitorSettings()).autoOpen, true);
});

test('settings merge serially, preserve unrelated metadata, and never operate panes', async t => {
  const f = await fixture(t);
  await f.c.store.update('c', config => { config.unrecognized = { retained: true }; });
  const before = await f.c.store.read();
  const first = await f.c.tool('configure_monitor', { autoOpen: false });
  assert.deepEqual(first, { written: true, monitor: { autoOpen: false, placement: 'coordinator-tab' }, paneEffects: false });
  await f.c.tool('configure_monitor', { placement: 'new-tab' });
  await Promise.all([f.c.tool('configure_monitor', { autoOpen: true }), f.c.tool('configure_monitor', { placement: 'coordinator-tab' })]);
  assert.deepEqual(await f.c.getMonitorSettings(), { autoOpen: true, placement: 'coordinator-tab' });
  const after = await f.c.store.read(); delete after.monitor;
  assert.deepEqual(after, before); assert.deepEqual(f.calls, []);
});

test('malformed persisted/settings inputs fail closed without writes or pane callbacks', async t => {
  const f = await fixture(t), before = await readFile(f.c.store.file, 'utf8');
  for (const monitor of [null, [], {}, { autoOpen: true }, { autoOpen: 'yes', placement: 'new-tab' },
    { autoOpen: false, placement: 'other' }, { autoOpen: true, placement: 'new-tab', extra: true }]) {
    assert.throws(() => validateConfig({ ...(JSON.parse(before)), monitor }), /monitor settings/);
  }
  for (const args of [{}, { extra: true }, { autoStart: true }, { autoOpen: undefined }, { autoOpen: 1 }, { placement: null }, { placement: 'unknown' }]) {
    await assert.rejects(f.c.tool('configure_monitor', args), /monitor/);
  }
  for (const [operation, args] of [['open_monitor', {}], ['open_monitor', { placement: undefined }], ['open_monitor', { placement: 'unknown' }], ['open_monitor', { sessionId: 'other' }], ['close_monitor', { placement: 'new-tab' }]]) {
    await assert.rejects(f.c.tool(operation, args), /monitor/);
  }
  assert.equal(await readFile(f.c.store.file, 'utf8'), before); assert.deepEqual(f.calls, []);
});

test('explicit open requires placement despite saved settings, pins identity and permits empty roster without changing settings', async t => {
  const f = await fixture(t);
  await f.c.tool('configure_monitor', { autoOpen: false, placement: 'new-tab' });
  const before = await readFile(f.c.store.file, 'utf8');
  await assert.rejects(f.c.tool('open_monitor', {}), /explicit monitor placement is required/);
  await assert.rejects(f.c.tool('open_monitor', { placement: undefined }), /explicit monitor placement is required/);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(await f.c.tool('open_monitor', { placement: 'new-tab' }), { opened: true });
  assert.deepEqual(await f.c.tool('open_monitor', { placement: 'coordinator-tab' }), { opened: true });
  assert.deepEqual(await f.c.tool('close_monitor', {}), { closed: true });
  assert.deepEqual(f.calls.map(call => [call.operation, call.placement]), [['open', 'new-tab'], ['open', 'coordinator-tab'], ['close', undefined]]);
  for (const call of f.calls) { assert.equal(call.root, f.c.store.root); assert.equal(call.sessionId, 'c'); }
  assert.equal(await readFile(f.c.store.file, 'utf8'), before);
});

test('automatic admission rechecks settings and roster after preflight while explicit open remains available', async t => {
  for (const change of ['disable', 'remove']) {
    const f = await fixture(t);
    await f.c.store.configure('c', { sessionId: 'w', name: 'Worker', description: 'work', port: 12346, projectDirectory: '.' });
    assert.equal((await f.c.getMonitorSettings()).autoOpen, true);
    assert.equal((await f.c.state()).config.agents.length, 2);
    if (change === 'disable') await f.c.tool('configure_monitor', { autoOpen: false });
    else await f.c.store.update('c', config => { config.agents = config.agents.filter(agent => agent.coordinator); });
    assert.deepEqual(await f.c.autoOpenMonitor(), { outcome: 'automatic monitor skipped' });
    assert.deepEqual(f.calls, []);
    await f.c.tool('open_monitor', { placement: 'coordinator-tab' }); assert.equal(f.calls.length, 1);
  }
});

test('worker and anonymous operations are rejected before persistence or adapter calls', async t => {
  const f = await fixture(t); await f.w.start();
  for (const configured of [false, true]) {
    if (configured) await f.c.store.configure('c', { sessionId: 'w', name: 'Worker', description: 'work', port: f.w.endpoint.port, projectDirectory: '.' });
    const before = await readFile(f.c.store.file, 'utf8');
    for (const operation of ['configure_monitor', 'open_monitor', 'close_monitor']) {
      await assert.rejects(f.w.tool(operation, operation === 'configure_monitor' ? { autoOpen: false } : {}), /coordinator permission/);
    }
    await assert.rejects(f.w.getMonitorSettings(), /coordinator permission/);
    assert.equal(await readFile(f.c.store.file, 'utf8'), before);
  }
  assert.deepEqual(f.calls, []);
});

test('queued settings writes and late adapter actions are fenced by runtime closure', async t => {
  const f = await fixture(t), before = await f.c.store.read();
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const blocker = f.c.store.update('c', async () => { entered(); await gate; });
  await started;
  const pending = f.c.tool('configure_monitor', { autoOpen: false });
  const rejected = assert.rejects(pending, /inactive|replaced/);
  await f.c.close(); release(); await blocker; await rejected;
  assert.deepEqual(await f.c.store.read(), before);
  await f.c.start();
  let adapterEntered, adapterRelease;
  const adapterStarted = new Promise(resolve => { adapterEntered = resolve; });
  const adapterGate = new Promise(resolve => { adapterRelease = resolve; });
  f.options.monitor.open = async request => { adapterEntered(); await adapterGate; request.assertCurrent(); assert.fail('stale pane action'); };
  const opening = f.c.tool('open_monitor', { placement: 'coordinator-tab' }); const openingRejected = assert.rejects(opening, /inactive|replaced/);
  await adapterStarted; await f.c.close(); adapterRelease(); await openingRejected;
});

test('fresh role checks precede delegation and follow adapter result; no automatic retry on adapter error', async t => {
  const f = await fixture(t), state = f.c.state.bind(f.c);
  let reads = 0;
  f.c.state = async () => {
    const result = await state();
    if (++reads >= 2) result.config.agents[0].coordinator = false;
    return result;
  };
  await assert.rejects(f.c.tool('open_monitor', { placement: 'coordinator-tab' }), /coordinator permission/);
  assert.deepEqual(f.calls, []); f.c.state = state;
  let attempts = 0;
  f.options.monitor.close = async () => { attempts++; throw new Error('adapter outcome uncertain'); };
  await assert.rejects(f.c.tool('close_monitor', {}), /uncertain/); assert.equal(attempts, 1);
  f.options.monitor.open = async () => {
    f.c.state = async () => { const result = await state(); result.config.agents[0].coordinator = false; return result; };
    return { opened: true };
  };
  await assert.rejects(f.c.tool('open_monitor', { placement: 'coordinator-tab' }), /coordinator permission/);
});
