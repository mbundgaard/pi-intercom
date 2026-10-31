import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CoordinatorReminders, REMINDER_INTERVAL_MS, REMINDER_TEXT } from '../dist/reminders.js';
import { Intercom } from '../dist/runtime.js';
import { ConfigStore } from '../dist/config.js';

function fakeClock() {
  let now = 0, next = 0;
  const pending = new Map(), callbacks = [];
  return {
    pending, callbacks,
    // Remaining delay per armed timer: a reset pushes a new full-interval due time.
    remaining: () => [...pending.values()].map(entry => entry.due - now),
    schedule(callback, delay) {
      assert.equal(delay, 300000);
      const id = ++next; pending.set(id, { callback, due: now + delay }); callbacks.push(callback);
      return () => pending.delete(id);
    },
    advance(milliseconds) {
      now += milliseconds;
      for (const [id, entry] of [...pending]) if (entry.due <= now) { pending.delete(id); entry.callback(); }
    },
  };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
async function settled(reminders) {
  const deadline = Date.now() + 2000;
  while (reminders?.checking) {
    assert.ok(Date.now() < deadline, 'reminder role check did not finish');
    await settle();
  }
}
function helper() {
  const clock = fakeClock(), delivered = [];
  let role = true, busy = false;
  const host = { isCoordinator: async () => role, busy: () => busy, deliver: text => delivered.push(text) };
  const reminders = new CoordinatorReminders(host, clock);
  return { clock, host, reminders, delivered, setRole: value => { role = value; }, setBusy: value => { busy = value; } };
}

test('five-minute reset, recurring delivery without an automatic cap, stop and rearm', async () => {
  const h = helper(); assert.equal(REMINDER_INTERVAL_MS, 300000); assert.equal(h.clock.pending.size, 0);
  h.reminders.arm(); h.clock.advance(299999); await settle(); assert.equal(h.delivered.length, 0);
  h.reminders.arm(); h.clock.advance(1); await settle(); assert.equal(h.delivered.length, 0);
  h.clock.advance(299999); await settled(h.reminders); assert.deepEqual(h.delivered, [REMINDER_TEXT]);
  for (let i = 0; i < 5; i++) { h.clock.advance(300000); await settled(h.reminders); }
  assert.equal(h.delivered.length, 6); assert.equal(h.clock.pending.size, 1);
  h.reminders.stop(); h.clock.advance(300000); await settle(); assert.equal(h.delivered.length, 6);
  h.reminders.arm(); h.clock.advance(300000); await settled(h.reminders); assert.equal(h.delivered.length, 7);
  h.reminders.dispose(); assert.equal(h.clock.pending.size, 0);
});

test('busy ticks skip without backlog; failed delivery has no immediate replay', async () => {
  const h = helper(); h.reminders.arm(); h.setBusy(true);
  h.clock.advance(300000); await settled(h.reminders); assert.equal(h.delivered.length, 0);
  h.setBusy(false); await settle(); assert.equal(h.delivered.length, 0);
  h.clock.advance(300000); await settled(h.reminders); assert.equal(h.delivered.length, 1);
  let attempts = 0;
  h.host.deliver = () => { attempts++; throw new Error('uncertain submission'); };
  h.clock.advance(300000); await settled(h.reminders); await settle(); assert.equal(attempts, 1);
  h.clock.advance(299999); assert.equal(attempts, 1);
  h.clock.advance(1); await settled(h.reminders); assert.equal(attempts, 2);
  h.reminders.dispose();
});

test('stale callbacks and pending role reads are fenced by reset, stop, disposal and role loss', async () => {
  for (const action of ['arm', 'stop', 'dispose']) {
    const h = helper(); let release;
    h.host.isCoordinator = () => new Promise(resolve => { release = resolve; });
    h.reminders.arm(); const stale = h.clock.callbacks.at(-1);
    h.clock.advance(300000); h.reminders[action](); release(true);
    await settled(h.reminders); stale(); await settle(); assert.equal(h.delivered.length, 0);
    h.reminders.dispose();
  }
  const h = helper(); h.reminders.arm(); h.setRole(false);
  h.clock.advance(300000); await settled(h.reminders);
  assert.equal(h.delivered.length, 0); assert.equal(h.clock.pending.size, 0);
});

test('owning abort signals disarm only their generation and already-aborted signals never arm', async () => {
  const h = helper(), old = new AbortController(), current = new AbortController();
  h.reminders.arm(AbortSignal.abort()); assert.equal(h.clock.pending.size, 0);
  h.reminders.arm(old.signal); h.reminders.arm(current.signal);
  old.abort(); assert.equal(h.clock.pending.size, 1);
  current.abort(); assert.equal(h.clock.pending.size, 0);
  h.clock.advance(300000); await settle(); assert.equal(h.delivered.length, 0);
  h.reminders.dispose();
});

test('slow role reads do not overlap or deliver a stale missed interval', async () => {
  const h = helper(); let release, reads = 0;
  h.host.isCoordinator = () => { reads++; return new Promise(resolve => { release = resolve; }); };
  h.reminders.arm(); h.clock.advance(300000); h.clock.advance(300000);
  assert.equal(reads, 1); release(true); await settled(h.reminders); assert.equal(h.delivered.length, 0);
  h.reminders.dispose();
});

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'intercom-reminders-'));
  await new ConfigStore(root).initialize('c', 12345);
  const clock = fakeClock(), messages = [], sent = [], endpoints = new Map();
  let port = 30000, busy = false;
  const options = {
    reminderClock: clock,
    // Pin the operator environment: these default-interval regressions must not follow an inherited value.
    reminderMinutesEnv: () => undefined,
    listen: async (_preferred, accept) => { const p = port++; endpoints.set(p, accept); return { port: p, close: async () => { endpoints.delete(p); } }; },
    send: async (p, message) => { sent.push(message); const accept = endpoints.get(p); if (!accept) throw new Error('offline'); await accept(message); },
    launch: async () => { assert.equal(clock.pending.size, 1, 'arm before launch'); throw new Error('launch outcome uncertain'); },
    probe: async () => { assert.equal(clock.pending.size, 1, 'arm before probe'); throw new Error('probe failed'); },
  };
  const host = id => ({ cwd: root, sessionId: () => id, busy: () => busy,
    deliver: text => messages.push({ id, text }), setName: async () => {}, notify() {} });
  const c = new Intercom(host('c'), options), w = new Intercom(host('w'), options);
  t.after(async () => { await w.close(); await c.close(); await rm(root, { recursive: true, force: true }); });
  await c.start(); await w.start();
  await c.tool('configure_worker', { sessionId: 'w', port: w.endpoint.port, projectDirectory: '.', name: 'Worker', description: 'Assigned scope' });
  await c.tool('reload_worker', { to: 'Worker' }); await c.tool('stop_reminders', {});
  const tick = async () => { clock.advance(300000); await settled(c.reminders); };
  const reminderCount = () => messages.filter(message => message.id === 'c' && message.text === REMINDER_TEXT).length;
  return { root, c, w, clock, messages, sent, tick, reminderCount, options, setBusy: value => { busy = value; } };
}

test('valid coordinator worker calls arm before effects including failed/uncertain calls', async t => {
  const f = await fixture(t);
  const configure = { sessionId: 'w', port: f.w.endpoint.port, projectDirectory: '.', name: 'Worker', description: 'Assigned scope' };
  for (const [operation, args] of [
    ['send', { to: 'Worker', message: 'Scoped request' }], ['configure_worker', configure],
    ['reload_worker', { to: 'Worker' }], ['request_status', { to: 'Worker' }],
    ['create_worker', {}], ['resume_worker', { to: 'Worker', confirmClosed: true }],
  ]) {
    await f.c.tool('stop_reminders', {}); assert.equal(f.clock.pending.size, 0);
    await f.c.tool(operation, args).catch(error => {
      assert.ok(['create_worker', 'resume_worker'].includes(operation), error.message);
    });
    assert.equal(f.clock.pending.size, 1, operation);
    await f.tick();
  }
  assert.equal(f.reminderCount(), 6);
  await f.c.tool('stop_reminders', {});
  f.c.options.closeProvider = {};
  f.c.handoff.request = async () => { assert.equal(f.clock.pending.size, 1); throw new Error('close initiation uncertain'); };
  await assert.rejects(f.c.tool('close_worker', { to: 'Worker' }), /uncertain/);
  await f.tick(); assert.equal(f.reminderCount(), 7);
  await f.c.tool('stop_reminders', {}); await f.w.close();
  await assert.rejects(f.c.tool('send', { to: 'Worker', message: 'follow-up' }), /offline/);
  await f.tick(); assert.equal(f.reminderCount(), 8);
});

test('invalid args/roles and read-only/report/bookkeeping operations never arm', async t => {
  const f = await fixture(t);
  for (const [operation, args] of [
    ['send', { to: 'Worker', message: '' }], ['send', { to: 'missing', message: 'x' }],
    ['configure_worker', { sessionId: 'w', port: 0, projectDirectory: '.', name: 'Worker', description: 'x' }],
    ['configure_worker', { sessionId: 'w', port: 1234, projectDirectory: '.', name: 'Coordinator', description: 'x' }],
    ['create_worker', { projectDirectory: '..' }], ['resume_worker', { to: 'Worker' }],
    ['close_worker', { to: 'Worker' }], ['stop_worker', { to: 'Worker' }],
  ]) { await assert.rejects(f.c.tool(operation, args)); assert.equal(f.clock.pending.size, 0, operation); }
  await assert.rejects(f.w.tool('stop_reminders', {}), /coordinator permission/);
  await assert.rejects(f.w.tool('create_worker', {}), /coordinator permission/);
  await f.c.tool('list', {}); await f.c.tool('worker_status', {});
  await f.w.tool('send', { to: 'Coordinator', message: 'worker finding' });
  await f.w.tool('report_work', { status: 'blocked', summary: 'Need input' });
  await f.w.tool('report_status', {});
  assert.equal(f.clock.pending.size, 0);
  await f.c.tool('remove_worker', { to: 'Worker' }); assert.equal(f.clock.pending.size, 0);
});

test('stop or newer calls fence old preflights; owner abort during preflight cannot arm later', async t => {
  for (const mode of ['stop', 'newer', 'abort']) {
    const f = await fixture(t), owner = new AbortController();
    let release, entered, first = true;
    const gate = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    const state = f.c.state.bind(f.c);
    f.c.state = async () => {
      const result = await state();
      if (first) { first = false; entered(); await gate; }
      return result;
    };
    f.c.options.launch = async () => ({ submitted: true });
    const pending = f.c.tool('create_worker', {}, 'create-tool', owner.signal);
    await started;
    if (mode === 'stop') await f.c.tool('stop_reminders', {});
    if (mode === 'newer') await f.c.tool('send', { to: 'Worker', message: 'newer call' });
    if (mode === 'abort') owner.abort();
    const callbacks = f.clock.callbacks.length;
    release(); await pending;
    assert.equal(f.clock.callbacks.length, callbacks, 'late preflight must not install/reset a timer');
    assert.equal(f.clock.pending.size, mode === 'newer' ? 1 : 0);
  }
});

test('invalid/nonworker calls cannot supersede pending stop or older valid preflight', async t => {
  for (const pendingOperation of ['stop_reminders', 'create_worker']) {
    const f = await fixture(t);
    await f.c.tool('send', { to: 'Worker', message: 'existing timer' });
    let release, entered, first = true;
    const gate = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    const state = f.c.state.bind(f.c);
    f.c.state = async () => {
      const value = await state();
      if (first) { first = false; entered(); await gate; }
      return value;
    };
    f.c.options.launch = async () => ({ submitted: true });
    const callbacks = f.clock.callbacks.length;
    const pending = f.c.tool(pendingOperation, {});
    await started;
    await assert.rejects(f.c.tool('send', { to: 'Worker', message: '' }));
    await assert.rejects(f.c.tool('send', { to: 'missing', message: 'invalid target' }));
    await f.c.tool('send', { to: 'Coordinator', message: 'not a worker call' });
    release(); await pending;
    assert.equal(f.clock.pending.size, pendingOperation === 'stop_reminders' ? 0 : 1);
    assert.equal(f.clock.callbacks.length, callbacks + (pendingOperation === 'create_worker' ? 1 : 0));
  }
});

test('runtime call signal retained after tool return cancels its reminder but not a newer owner', async t => {
  const f = await fixture(t), old = new AbortController(), next = new AbortController();
  await f.c.tool('send', { to: 'Worker', message: 'first' }, 'first', old.signal);
  await f.c.tool('send', { to: 'Worker', message: 'second' }, 'second', next.signal);
  old.abort(); assert.equal(f.clock.pending.size, 1);
  next.abort(); assert.equal(f.clock.pending.size, 0);
  await f.tick(); assert.equal(f.reminderCount(), 0);
});

test('runtime reset, busy skip, lifecycle close/restart and changed role suppress stale reminders', async t => {
  const f = await fixture(t);
  await f.c.tool('send', { to: 'Worker', message: 'first' });
  const stale = f.clock.callbacks.at(-1);
  f.clock.advance(299999);
  await f.c.tool('request_status', { to: 'Worker' });
  f.clock.advance(1); await settled(f.c.reminders); assert.equal(f.reminderCount(), 0);
  f.setBusy(true); f.clock.advance(299999); await settled(f.c.reminders); assert.equal(f.reminderCount(), 0);
  f.setBusy(false); await f.tick(); assert.equal(f.reminderCount(), 1);
  await f.c.tool('stop_reminders', {}); stale(); await settle(); assert.equal(f.reminderCount(), 1);
  await f.c.tool('reload_worker', { to: 'Worker' });
  const old = f.clock.callbacks.at(-1);
  await f.c.close(); await f.c.start(); old(); await settle();
  assert.equal(f.clock.pending.size, 0); assert.equal(f.reminderCount(), 1);
  await f.c.tool('send', { to: 'Worker', message: 'new lifecycle' });
  const state = f.c.state.bind(f.c);
  f.c.state = async () => { const value = await state(); return { ...value, me: { ...value.me, coordinator: false } }; };
  await f.tick(); assert.equal(f.reminderCount(), 1); assert.equal(f.clock.pending.size, 0);
});

test('read-only, incoming and worker operations preserve an already-armed due time', async t => {
  const f = await fixture(t);
  await f.c.tool('send', { to: 'Worker', message: 'arm' });
  f.clock.advance(120000);
  const armed = f.clock.remaining();
  assert.deepEqual(armed, [180000], 'one armed timer remains at its original due time');
  await f.c.tool('list', {});
  await f.c.tool('worker_status', {});
  await f.w.tool('send', { to: 'Coordinator', message: 'worker finding' });
  await f.w.tool('report_work', { status: 'blocked', summary: 'Need input' });
  await f.w.tool('report_status', {});
  await assert.rejects(f.c.tool('send', { to: 'Worker', message: '' }));
  assert.deepEqual(f.clock.remaining(), armed, 'non-qualifying operations never re-arm or reset the timer');
  f.clock.advance(179999); await settle(); assert.equal(f.reminderCount(), 0);
  f.clock.advance(1); await settled(f.c.reminders); assert.equal(f.reminderCount(), 1, 'the original due time still delivers exactly once');
});

test('replaced session identity fences both an armed timer and an in-flight role read', async t => {
  const f = await fixture(t);
  await f.c.tool('send', { to: 'Worker', message: 'arm' });
  assert.equal(f.clock.pending.size, 1);
  let release, entered, first = true;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const state = f.c.state.bind(f.c);
  f.c.state = async () => { const value = await state(); if (first) { first = false; entered(); await gate; } return value; };
  f.clock.advance(300000);
  await started;
  f.c.host.sessionId = () => 'replaced-session'; // the Pi session is replaced while the role read is in flight
  release();
  await settled(f.c.reminders); await settle();
  assert.equal(f.reminderCount(), 0, 'an in-flight role read of a replaced session cannot deliver');
  f.clock.advance(300000); await settle();
  assert.equal(f.reminderCount(), 0, 'the armed timer of a replaced session cannot deliver either');
});
