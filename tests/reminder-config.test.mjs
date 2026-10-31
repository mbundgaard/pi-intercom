import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import extension from '../dist/index.js';
import { CoordinatorReminders, REMINDER_INTERVAL_MS, REMINDER_INVALID_INPUT_WARNING, REMINDER_TEXT, parseReminderInterval, readReminderMinutesEnv } from '../dist/reminders.js';
import { Intercom } from '../dist/runtime.js';
import { ConfigStore } from '../dist/config.js';

const MINUTE = 60 * 1000;
const MAX_DELAY_MS = 2147460000;
const settle = () => new Promise(resolve => setImmediate(resolve));
async function settled(reminders) {
  const deadline = Date.now() + 2000;
  while (reminders?.checking) {
    assert.ok(Date.now() < deadline, 'reminder role check did not finish');
    await settle();
  }
}

// Actual delays are recorded and cancelled callbacks are retained, so one scenario can assert the
// exact scheduled delay, recurrence, reset and stale callbacks without a tool-by-interval matrix.
function fakeClock() {
  let now = 0, next = 0;
  const pending = new Map(), scheduled = [];
  return {
    pending,
    delays: () => scheduled.map(entry => entry.delay),
    entries: () => scheduled,
    remaining: () => [...pending.values()].map(entry => entry.due - now),
    schedule(callback, delay) {
      const id = ++next;
      pending.set(id, { callback, due: now + delay });
      scheduled.push({ callback, delay, id });
      return () => pending.delete(id);
    },
    advance(milliseconds) {
      now += milliseconds;
      for (const [id, entry] of [...pending]) if (entry.due <= now) { pending.delete(id); entry.callback(); }
    },
  };
}

// One operator-environment read per runtime start, with its own counter and no retained raw value.
function operator(value) {
  let reads = 0, current = value;
  return { read: () => { reads++; return current; }, set: next => { current = next; }, count: () => reads };
}

async function fixture(t, { env, productionEnv = false, failWarningNotify = false, autoStart = true } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'intercom-reminder-config-'));
  await new ConfigStore(root).initialize('c', 12345);
  const clock = fakeClock(), messages = [], notices = [], sent = [], observations = [], endpoints = new Map();
  let port = 30000, busy = false;
  const base = {
    reminderClock: clock,
    listen: async (_preferred, accept, health) => { const p = port++; endpoints.set(p, accept); return { port: p, close: async () => { endpoints.delete(p); }, health }; },
    send: async (p, message) => { sent.push(message); const accept = endpoints.get(p); if (!accept) throw new Error('offline'); await accept(message); },
    launch: async () => ({ submitted: true }),
    probe: async () => ({ state: 'disconnected' }),
    observe: (_root, sessionId) => { const events = []; observations.push({ sessionId, events }); return { record: (event, metadata) => events.push({ event, metadata }), close: async () => {} }; },
  };
  const host = id => ({ cwd: root, sessionId: () => id, busy: () => busy,
    deliver: text => messages.push({ id, text }), setName: async () => {},
    notify: text => {
      if (failWarningNotify && text === REMINDER_INVALID_INPUT_WARNING) { notices.push({ id, text, failed: true }); throw new Error('injected notification failure'); }
      notices.push({ id, text });
    } });
  const operatorFor = value => { const op = operator(value); return { op, options: { ...base, reminderMinutesEnv: op.read } }; };
  const coordinator = productionEnv ? { op: null, options: { ...base } } : operatorFor(env);
  const c = new Intercom(host('c'), coordinator.options);
  const worker = operatorFor(env);
  const w = new Intercom(host('w'), worker.options);
  const anonymous = operatorFor(env);
  const a = new Intercom(host('anonymous'), anonymous.options);
  t.after(async () => {
    try { await a.close(); } finally {
      try { await w.close(); } finally { await c.close(); await rm(root, { recursive: true, force: true }); }
    }
  });
  const start = async () => {
    await c.start();
    await w.start();
    await c.tool('configure_worker', { sessionId: 'w', port: w.endpoint.port, projectDirectory: '.', name: 'Worker', description: 'Assigned scope' });
    await c.tool('reload_worker', { to: 'Worker' });
    await c.tool('stop_reminders', {});
  };
  if (autoStart) await start();
  return {
    root, c, w, a, clock, messages, notices, sent, options: coordinator.options,
    envReads: () => coordinator.op?.count() ?? 0, setEnv: value => coordinator.op?.set(value),
    workerReads: () => worker.op.count(), setWorkerEnv: value => worker.op.set(value),
    anonymousReads: () => anonymous.op.count(), setAnonymousEnv: value => anonymous.op.set(value),
    setBusy: value => { busy = value; },
    start,
    warnings: () => notices.filter(entry => entry.text === REMINDER_INVALID_INPUT_WARNING),
    reminderCount: () => messages.filter(message => message.id === 'c' && message.text === REMINDER_TEXT).length,
    captured: () => JSON.stringify({ messages, notices, sent, observations }),
  };
}

test('parser accepts whole minutes and marks only explicit nonblank unusable input', () => {
  assert.equal(REMINDER_INTERVAL_MS, 300000);
  for (const [raw, minutes] of [['1', 1], ['5', 5], ['35791', 35791], ['  \t7 \n', 7], ['0005', 5]]) {
    assert.deepEqual(parseReminderInterval(raw), { intervalMs: minutes * MINUTE, invalidInput: false }, raw);
  }
  for (const raw of [undefined, '', '   ', '\t\n']) {
    assert.deepEqual(parseReminderInterval(raw), { intervalMs: 300000, invalidInput: false }, JSON.stringify(raw));
  }
  for (const raw of ['0', '00', '-1', '+1', '1.5', '1e2', '0x10', '10m', '٣', '1 000', '99999999999999999999', '35792', 'NaN', 'Infinity']) {
    assert.deepEqual(parseReminderInterval(raw), { intervalMs: 300000, invalidInput: true }, raw);
  }
  // Ceiling arithmetic beside the bound: 35791 is the last whole minute inside the signed 32-bit timeout maximum.
  assert.equal(Math.floor(2147483647 / MINUTE), 35791);
  assert.equal(35791 * MINUTE, MAX_DELAY_MS);
  assert.ok(35792 * MINUTE > 2147483647, 'one minute more would overflow the timeout ceiling');
  assert.deepEqual(parseReminderInterval('35791'), { intervalMs: MAX_DELAY_MS, invalidInput: false });
});

test('scheduler uses the validated delay at default, override and ceiling with two-argument compatibility', async () => {
  for (const [argument, expected] of [[undefined, 300000], ['2', 120000], ['35791', MAX_DELAY_MS]]) {
    const clock = fakeClock(), delivered = [];
    const host = { isCoordinator: async () => true, busy: () => false, deliver: text => delivered.push(text) };
    const parsed = argument === undefined ? undefined : parseReminderInterval(argument);
    if (parsed) assert.equal(parsed.invalidInput, false, argument);
    const reminders = parsed === undefined ? new CoordinatorReminders(host, clock) : new CoordinatorReminders(host, clock, parsed.intervalMs);
    reminders.arm();
    assert.deepEqual(clock.delays(), [expected], String(argument));
    clock.advance(expected - 1); await settle(); assert.equal(delivered.length, 0, 'nothing fires before the configured delay');
    clock.advance(1); await settled(reminders); assert.deepEqual(delivered, [REMINDER_TEXT]);
    clock.advance(expected); await settled(reminders);
    assert.equal(delivered.length, 2, 'recurrence continues at the same delay');
    assert.deepEqual(clock.delays(), [expected, expected, expected], 'arm plus two recurrences');
    reminders.dispose();
    assert.equal(clock.pending.size, 0);
  }
});

test('runtime snapshots the interval once per start, stays disarmed, and rereads only on a fresh runtime', async t => {
  const f = await fixture(t, { env: '2' });
  assert.equal(f.envReads(), 1, 'construction never reads and exactly one read happens per start');
  assert.equal(f.clock.pending.size, 0, 'startup stays disarmed');
  await f.c.tool('send', { to: 'Worker', message: 'arm' });
  assert.equal(f.envReads(), 1, 'qualifying calls never reread');
  assert.deepEqual(f.clock.remaining(), [120000]);
  await f.c.tool('send', { to: 'Worker', message: 'reset' });
  assert.deepEqual(f.clock.remaining(), [120000], 'a qualifying call restarts the same interval');
  f.clock.advance(119999); await settle(); assert.equal(f.reminderCount(), 0);
  await f.c.tool('stop_reminders', {});
  assert.deepEqual(f.clock.remaining(), [], 'explicit stop cancels the timer');
  await f.c.tool('send', { to: 'Worker', message: 'rearm' });
  assert.deepEqual(f.clock.remaining(), [120000], 'rearm uses the same start-local snapshot');
  f.setEnv('30');
  await f.c.reload();
  await f.c.tool('reload_worker', { to: 'Worker' });
  assert.equal(f.envReads(), 1, 'config reload never rereads the operator environment');
  assert.deepEqual(f.clock.remaining(), [120000], 'config reload keeps the snapshotted interval');
  f.clock.advance(119999); await settle(); assert.equal(f.reminderCount(), 0);
  f.clock.advance(1); await settled(f.c.reminders); assert.equal(f.reminderCount(), 1, 'delivery happens at the delay, not before');
  await f.c.close(); await f.c.start();
  assert.equal(f.envReads(), 2, 'a fresh runtime reads again');
  assert.equal(f.clock.pending.size, 0, 'a restarted runtime still starts disarmed');
  await f.c.tool('send', { to: 'Worker', message: 'after restart' });
  assert.deepEqual(f.clock.remaining(), [1800000], 'the new runtime uses the new value');
});

test('one override smoke: busy skip, stop/rearm and retained stale callbacks at a non-default interval', async t => {
  const f = await fixture(t, { env: '2' });
  await f.c.tool('send', { to: 'Worker', message: 'arm' });
  const stale = f.clock.entries()[0].callback; // retained after stop/rearm cancels it
  f.setBusy(true);
  f.clock.advance(120000); await settled(f.c.reminders);
  assert.equal(f.reminderCount(), 0, 'a busy tick is skipped, not queued');
  f.setBusy(false); await settle(); assert.equal(f.reminderCount(), 0, 'the skipped tick never becomes a backlog');
  await f.c.tool('stop_reminders', {});
  assert.deepEqual(f.clock.remaining(), []);
  const scheduledBefore = f.clock.delays().length;
  await f.c.tool('send', { to: 'Worker', message: 'rearm' });
  assert.equal(f.clock.pending.size, 1, 'rearm replaces rather than stacks the timer');
  f.clock.advance(120000); await settled(f.c.reminders);
  assert.equal(f.reminderCount(), 1);
  assert.ok(f.clock.delays().length > scheduledBefore, 'scheduled, replaced and cancelled callbacks are all retained for inspection');
  assert.deepEqual([...new Set(f.clock.delays())], [120000], 'nothing ever scheduled the default delay');
  stale(); await settle(); assert.equal(f.reminderCount(), 1, 'the cancelled generation stays suppressed');
});

// Isolated and deliberately non-concurrent: this is the production process.env path, so no seam pins it.
test('production reader uses the process environment at start and falls back after removal', { concurrency: false }, async t => {
  const name = 'PI_INTERCOM_REMINDER_MINUTES';
  const saved = Object.prototype.hasOwnProperty.call(process.env, name) ? process.env[name] : undefined;
  try {
    process.env[name] = '4';
    assert.equal(readReminderMinutesEnv(), '4');
    const f = await fixture(t, { productionEnv: true });
    assert.equal(f.clock.pending.size, 0);
    await f.c.tool('send', { to: 'Worker', message: 'arm' });
    assert.deepEqual(f.clock.remaining(), [240000], 'production start used the inherited operator value');
    delete process.env[name];
    await f.c.close(); await f.c.start();
    await f.c.tool('send', { to: 'Worker', message: 'after restart' });
    assert.deepEqual(f.clock.remaining(), [300000], 'a removed value falls back to the five-minute default');
  } finally {
    if (saved === undefined) delete process.env[name]; else process.env[name] = saved;
  }
});

test('explicit nonblank invalid input warns once at coordinator startup with fixed value-free text', async t => {
  const f = await fixture(t, { env: '10m#SENTINEL' });
  assert.deepEqual(f.warnings().map(entry => entry.text), [REMINDER_INVALID_INPUT_WARNING], 'exactly one warning per coordinator start');
  assert.equal(REMINDER_INVALID_INPUT_WARNING, 'PI_INTERCOM_REMINDER_MINUTES is invalid; using the 5-minute default');
  assert.equal(f.clock.pending.size, 0, 'the warning path never arms a timer');
  await f.c.tool('send', { to: 'Worker', message: 'arm' });
  assert.deepEqual(f.clock.remaining(), [300000], 'unusable input schedules the five-minute default');
  await f.c.tool('send', { to: 'Worker', message: 'reset' });
  await f.c.tool('stop_reminders', {});
  await f.c.tool('send', { to: 'Worker', message: 'rearm' });
  await f.c.reload();
  assert.equal(f.warnings().length, 1, 'reset, stop/rearm and config reload never repeat the warning');
  assert.equal(f.envReads(), 1, 'and never reread the operator environment');
  await f.c.close(); await f.c.start();
  assert.equal(f.warnings().length, 2, 'a fresh invalid coordinator start may warn once again');
  assert.equal(f.envReads(), 2);
  assert.doesNotMatch(f.captured(), /SENTINEL/, 'the supplied value never reaches a notification, delivery, transport payload or observation');
  assert.ok(f.messages.every(message => message.text !== REMINDER_INVALID_INPUT_WARNING), 'the diagnostic is never delivered as a reminder');
});

test('valid, unset and blank input plus workers never emit the startup diagnostic', async t => {
  for (const env of ['5', undefined, '', '   ']) {
    const f = await fixture(t, { env });
    assert.deepEqual(f.warnings(), [], JSON.stringify(env));
    assert.equal(f.envReads(), 1, 'the environment is still read once per start');
    await f.c.tool('send', { to: 'Worker', message: 'arm' });
    assert.deepEqual(f.clock.remaining(), [300000], JSON.stringify(env));
  }
  const f = await fixture(t, { env: '7' });
  f.setWorkerEnv('nonsense#SENTINEL');
  await f.w.close();
  await f.w.start();
  assert.deepEqual(f.warnings().filter(entry => entry.id === 'w'), [], 'a configured worker never warns');
  assert.equal(f.workerReads(), 2, 'a shared snapshot for a worker is harmless and never warns');
  f.setAnonymousEnv('nonsense#SENTINEL');
  await f.a.start();
  assert.deepEqual(f.warnings().filter(entry => entry.id === 'anonymous'), [], 'an anonymous worker never warns');
  assert.doesNotMatch(f.captured(), /SENTINEL/);
});

test('a failing startup diagnostic is best-effort: startup, scheduling and worker operations still succeed', async t => {
  const f = await fixture(t, { env: '0', failWarningNotify: true });
  assert.equal(f.warnings().length, 1, 'the failed warning is attempted once and never retried');
  assert.ok(f.notices.some(entry => entry.id === 'c' && !entry.failed && /Coordinator ready/.test(entry.text)), 'startup still completes');
  assert.equal(f.clock.pending.size, 0);
  await f.c.tool('send', { to: 'Worker', message: 'arm' });
  assert.deepEqual(f.clock.remaining(), [300000], 'a subsequent qualifying worker operation schedules the default');
  f.clock.advance(300000); await settled(f.c.reminders);
  assert.equal(f.reminderCount(), 1, 'and the reminder still fires');
  assert.equal(f.warnings().length, 1, 'no retry and no repeated diagnostic');
  assert.doesNotMatch(f.captured(), /injected notification failure/, 'the notification failure itself is neither echoed nor logged');
});

test('a start whose session is replaced during startup emits no diagnostic and arms nothing', async t => {
  const f = await fixture(t, { env: 'bogus', autoStart: false });
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const listen = f.options.listen;
  f.options.listen = async (preferred, accept, health) => { entered(); await gate; return listen(preferred, accept, health); };
  const pending = f.c.start();
  await started;
  f.c.host.sessionId = () => 'replaced-session'; // the Pi session is replaced while this startup is in flight
  release();
  await assert.rejects(pending);
  assert.deepEqual(f.warnings(), [], 'a stale start never warns');
  assert.equal(f.clock.pending.size, 0, 'and never arms a timer');
});

test('the startup diagnostic suppresses its notification on a failed lifecycle check or host failure', async t => {
  const f = await fixture(t, { env: '5' });
  const attempted = [];
  f.c.host.notify = text => { attempted.push(text); if (attempted.length === 1) throw new Error('injected host failure'); };
  f.c.warnInvalidReminderInterval(() => { throw new Error('runtime lifecycle replaced'); });
  assert.deepEqual(attempted, [], 'a failed session/root/generation check never notifies');
  f.c.warnInvalidReminderInterval(() => {});
  assert.deepEqual(attempted, [REMINDER_INVALID_INPUT_WARNING], 'a throwing host notification is swallowed without retry');
});

test('fixed reminder and tool text stay interval-neutral without changing authority wording', () => {
  const fiveMinuteText = 'Intercom reminder: Review outstanding delegated work and worker reports. If follow-up is needed, take the next appropriate action. Do not assume workers have finished or stopped.\n\nIf there is genuinely nothing to follow up on, call intercom_stop_reminders. Otherwise, reminders continue every five minutes; a new worker call resets the timer.\n\nThis reminder does not authorize new work, retries, worker closure, or publication.';
  const neutral = 'Otherwise, reminders continue at the configured interval; a new worker call resets the timer.';
  assert.ok(REMINDER_TEXT.includes(neutral), 'the interval sentence is interval-neutral');
  assert.equal(REMINDER_TEXT.replace(neutral, 'Otherwise, reminders continue every five minutes; a new worker call resets the timer.'), fiveMinuteText, 'only the interval phrase changed');
  assert.match(REMINDER_TEXT, /This reminder does not authorize new work, retries, worker closure, or publication\.$/);
  assert.doesNotMatch(REMINDER_TEXT, /\d/, 'no operator value or numeric promise appears in the reminder');
  const tools = new Map();
  // Same adapter surface as upstream's extension mock; flags resolve only during session_start and no Pi host is constructed.
  extension({ registerTool: tool => tools.set(tool.name, tool), on: () => {}, registerFlag: () => {}, getFlag: () => undefined,
    getSessionName: () => '', setSessionName: async () => {}, sendUserMessage: () => {} });
  const description = tools.get('intercom_stop_reminders').description;
  assert.match(description, /at their configured interval/);
  assert.doesNotMatch(description, /five minutes?/i, 'the stop tool no longer promises five minutes');
  assert.match(description, /Stops only reminders, not workers, close jobs or model work\./);
});
