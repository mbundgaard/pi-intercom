import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, rename, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Intercom } from '../dist/runtime.js';
import { ConfigStore, validateConfig } from '../dist/config.js';
import { readWorkerReports } from '../dist/reports.js';
import { readObservationSnapshot } from '../dist/snapshot.js';
import { envelope } from '../dist/transport.js';

async function setup(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'intercom-integration-'));
  // Keep runtime discovery in this fixture instead of adopting a real ancestor config.
  // The fake listener's actual port replaces this test-only saved endpoint at startup.
  await new ConfigStore(root).initialize('c', 12345);
  let nextPort = 30000;
  const endpoints = new Map(), all = [], wire = [], launches = [];
  const options = {
    listen: async (_port, accept) => {
      const port = nextPort++; endpoints.set(port, accept);
      return { port, close: async () => { endpoints.delete(port); } };
    },
    send: async (port, message) => {
      wire.push({ port, message });
      const accept = endpoints.get(port); if (!accept) throw new Error('unreachable');
      await accept(message);
    },
    launch: async r => { launches.push(r); return { launched: true }; },
    probe: async agent => ({ sessionId: agent.sessionId, state: 'disconnected', checkedAt: new Date().toISOString(), reason: 'refused' }),
  };
  async function start(id) {
    const messages = [], notices = [], names = [];
    const host = { cwd: root, sessionId: () => id, busy: () => false,
      deliver: (text, busy) => messages.push({ text, busy }), setName: async name => { names.push(name); }, notify: text => notices.push(text),
      abort: () => assert.fail('must not abort'), shutdown: () => assert.fail('must not shutdown') };
    const runtime = new Intercom(host, options); all.push(runtime); await runtime.start();
    return { runtime, host, messages, notices, names };
  }
  t.after(async () => { for (const r of all) await r.close(); await rm(root, { recursive: true, force: true }); });
  return { start, endpoints, wire, launches, root };
}
async function publicationFixture(t, options) {
  const root = await mkdtemp(path.join(tmpdir(), 'intercom-publication-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const counts = { writes: 0, syncs: 0, closes: 0, mutations: 0 };
  class CountingStore extends ConfigStore {
    async openTemporary(file) {
      const handle = await super.openTemporary(file);
      return {
        writeFile: async (...args) => { counts.writes++; return handle.writeFile(...args); },
        sync: async () => { counts.syncs++; return handle.sync(); },
        close: async () => { counts.closes++; return handle.close(); },
      };
    }
  }
  const store = new CountingStore(root, options);
  await store.initialize('c', 12345);
  counts.writes = counts.syncs = counts.closes = 0;
  const original = await readFile(store.file, 'utf8');
  const mutate = config => { counts.mutations++; config.agents[0].description = 'updated'; };
  const assertOriginalAndClean = async () => {
    assert.equal(await readFile(store.file, 'utf8'), original);
    assert.deepEqual(await readdir(path.dirname(store.file)), ['config.json']);
  };
  return { store, counts, mutate, assertOriginalAndClean };
}
async function configured(t) {
  const f = await setup(t), c = await f.start('c'), w = await f.start('w');
  await c.runtime.tool('configure_worker', { sessionId: 'w', port: w.runtime.endpoint.port, projectDirectory: '.', name: 'Builder', description: 'Build assigned tasks' });
  await c.runtime.tool('reload_worker', { to: 'Builder' });
  return { ...f, c, w };
}
test('Windows EPERM publication retries only the same closed temp with fresh guards', async t => {
  let clock = 0;
  const calls = [], delays = [], events = [];
  const permission = Object.assign(new Error('sharing conflict'), { code: 'EPERM' });
  const f = await publicationFixture(t, { platform: 'win32', now: () => clock,
    delay: async ms => { events.push('delay'); delays.push(ms); clock += ms; },
    rename: async (from, to) => {
      assert.equal(events.at(-1), 'guard');
      assert.deepEqual(f.counts, { writes: 1, syncs: 1, closes: 1, mutations: 1 });
      calls.push([from, to]);
      if (calls.length < 3) throw permission;
      await rename(from, to);
    },
  });
  await f.store.update('c', f.mutate, () => events.push('guard'));
  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => call[0] === calls[0][0] && call[1] === f.store.file));
  assert.deepEqual(delays, [10, 20]);
  assert.equal((await f.store.read()).agents[0].description, 'updated');
  assert.deepEqual(await readdir(path.dirname(f.store.file)), ['config.json']);
});

test('Windows permanent EPERM exhausts five attempts and preserves original config/error with temp cleanup', async t => {
  let clock = 0, attempts = 0;
  const delays = [];
  const original = Object.assign(new Error('first sharing conflict'), { code: 'EPERM' });
  const f = await publicationFixture(t, { platform: 'win32', now: () => clock,
    delay: async ms => { delays.push(ms); clock += ms; },
    rename: async () => { attempts++; throw attempts === 1 ? original : Object.assign(new Error('later conflict'), { code: 'EPERM' }); },
  });
  await assert.rejects(f.store.update('c', f.mutate), error => error === original);
  assert.equal(attempts, 5); assert.deepEqual(delays, [10, 20, 40, 80]);
  assert.deepEqual(f.counts, { writes: 1, syncs: 1, closes: 1, mutations: 1 });
  await f.assertOriginalAndClean();
});

test('publication never retries non-EPERM errors or non-Windows EPERM', async t => {
  for (const [platform, code] of [['win32', 'EACCES'], ['win32', 'EIO'], ['linux', 'EPERM']]) {
    let attempts = 0;
    const failure = Object.assign(new Error('non-retryable'), { code });
    const f = await publicationFixture(t, { platform,
      rename: async () => { attempts++; throw failure; }, delay: async () => assert.fail('must not back off'),
    });
    await assert.rejects(f.store.update('c', f.mutate), error => error === failure);
    assert.equal(attempts, 1); await f.assertOriginalAndClean();
  }
});

test('lifecycle guard invalidated during publication backoff prevents the next attempt', async t => {
  let active = true, attempts = 0, clock = 0;
  const lifecycle = Object.assign(new Error('lifecycle replaced'), { code: 'EPERM' });
  const f = await publicationFixture(t, { platform: 'win32', now: () => clock,
    rename: async () => { attempts++; throw Object.assign(new Error('sharing conflict'), { code: 'EPERM' }); },
    delay: async ms => { clock += ms; active = false; },
  });
  await assert.rejects(f.store.update('c', f.mutate, () => { if (!active) throw lifecycle; }), error => error === lifecycle);
  assert.equal(attempts, 1); await f.assertOriginalAndClean();
});

test('publication retry elapsed budget prevents another rename after an overslept backoff', async t => {
  let attempts = 0, clock = 0, delays = 0;
  const failure = Object.assign(new Error('sharing conflict'), { code: 'EPERM' });
  const f = await publicationFixture(t, { platform: 'win32', now: () => clock,
    rename: async () => { attempts++; throw failure; },
    delay: async () => { delays++; clock += 300; },
  });
  await assert.rejects(f.store.update('c', f.mutate), error => error === failure);
  assert.equal(attempts, 1); assert.equal(delays, 1); await f.assertOriginalAndClean();
});

test('real concurrent config readers see complete files; publication succeeds or fails conservatively on Windows contention', { timeout: 10000 }, async t => {
  const f = await publicationFixture(t, {}); // Real filesystem rename and platform, no retry injection.
  const original = await f.store.read();
  const updated = structuredClone(original); updated.agents[0].description = 'updated';
  const abort = new AbortController();
  let stopped = false, reads = 0, readerError, updateError, firstRead;
  const started = new Promise(resolve => { firstRead = resolve; });
  const readerDeadline = performance.now() + 5000;
  const reader = (async () => {
    try {
      while (!stopped && reads < 2000 && performance.now() < readerDeadline) {
        let contents;
        try { contents = await readFile(f.store.file, { encoding: 'utf8', signal: abort.signal }); }
        catch (error) { if (stopped && error.code === 'ABORT_ERR') return; throw error; }
        const config = validateConfig(JSON.parse(contents));
        assert.deepEqual(config, config.agents[0].description === 'updated' ? updated : original);
        reads++; firstRead();
      }
    } catch (error) { readerError = error; firstRead(); }
  })();
  const readerTimer = setTimeout(() => { stopped = true; abort.abort(); firstRead(); }, 5000);
  try {
    await started;
    assert.equal(readerError, undefined);
    try { await f.store.update('c', f.mutate); } catch (error) { updateError = error; }
  } finally {
    clearTimeout(readerTimer); stopped = true; abort.abort(); await reader;
  }
  assert.equal(readerError, undefined); assert.ok(reads > 0);
  if (updateError) {
    assert.equal(process.platform, 'win32', 'other platforms must not gain a tolerated failure');
    assert.equal(updateError.code, 'EPERM'); assert.equal(updateError.syscall, 'rename');
    await f.assertOriginalAndClean();
  } else {
    assert.deepEqual(await f.store.read(), updated);
    assert.deepEqual(await readdir(path.dirname(f.store.file)), ['config.json']);
  }
  // Exact attempt/budget bounds are asserted in the deterministic tests above;
  // this test makes no availability promise under real continuous contention.
});

test('a distinct non-EPERM during retry immediately propagates without further attempts', async t => {
  let attempts = 0, clock = 0;
  const finalError = Object.assign(new Error('disk failure'), { code: 'EIO' });
  const f = await publicationFixture(t, { platform: 'win32', now: () => clock,
    rename: async () => { attempts++; throw attempts === 1 ? Object.assign(new Error('sharing conflict'), { code: 'EPERM' }) : finalError; },
    delay: async ms => { clock += ms; },
  });
  await assert.rejects(f.store.update('c', f.mutate), error => error === finalError);
  assert.equal(attempts, 2); await f.assertOriginalAndClean();
});

test('anonymous registration explicitly hands ID/port/directory to agent, configure writes only, reload passive', async t => {
  const f = await setup(t), c = await f.start('c');
  assert.equal(c.messages.length, 0); assert.deepEqual(c.names, []);
  assert.equal(c.runtime.responsibility.name, 'Coordinator');
  c.host.setName = async () => assert.fail('coordinator reload must preserve the existing host title');
  await c.runtime.reload();
  assert.equal(c.runtime.responsibility.name, 'Coordinator');
  assert.deepEqual(c.names, []);
  c.host.busy = () => true;
  const w = await f.start('w');
  assert.equal(c.messages.length, 1); assert.equal(c.messages[0].busy, true);
  assert.match(c.messages[0].text, /registration/); assert.match(c.messages[0].text, /"sessionId":"w"/);
  assert.match(c.messages[0].text, /"projectDirectory":"\."/);
  assert.equal((await c.runtime.store.read()).agents.length, 1);
  await assert.rejects(w.runtime.tool('create_worker', {}), /permission/);
  await assert.rejects(w.runtime.tool('send', { to: 'Coordinator', message: 'x' }), /anonymous/);
  await c.runtime.tool('configure_worker', { sessionId: 'w', port: w.runtime.endpoint.port, projectDirectory: '.', name: 'Builder', description: 'Remit' });
  assert.equal(w.runtime.responsibility, undefined); assert.equal(w.messages.length, 0);
  await c.runtime.tool('reload_worker', { to: 'bUILDER' });
  assert.equal(w.runtime.responsibility.description, 'Remit'); assert.deepEqual(w.names, ['Builder']); assert.equal(w.messages.length, 0);
});
test('worker status reads local JSON without sending messages or probing workers', async t => {
  const { c, w, start, wire } = await configured(t);
  const anonymous = await start('status-anonymous');
  const before = wire.length;
  const result = await c.runtime.tool('worker_status', { name: 'Builder' });
  assert.equal(result.source, 'local-observations');
  assert.equal(result.workers.length, 1);
  assert.equal(result.workers[0].sessionId, 'w');
  assert.equal(wire.length, before);
  await w.runtime.tool('worker_status', {});
  await assert.rejects(anonymous.runtime.tool('worker_status', {}), /configured/);
});

test('work reports persist as public worker-authored state and notify without approving or assigning', async t => {
  const { c, w, root, launches } = await configured(t);
  const before = c.messages.length;
  for (const status of ['blocked', 'needs_decision', 'ready_for_review']) {
    const result = await w.runtime.tool('report_work', { status, summary: 'Public finding and requested decision' });
    assert.equal(result.accepted, true);
    const [report] = await readWorkerReports(root, ['w']);
    assert.equal(report.status, status); assert.equal(report.sessionId, 'w');
    assert.equal((await readObservationSnapshot(root)).reports[0].status, status);
    assert.match(c.messages.at(-1).text, /not approval or verified completion/);
  }
  await w.runtime.tool('report_work', { status: 'clear' });
  assert.equal((await readWorkerReports(root, ['w']))[0].status, 'clear');
  assert.equal(c.messages.length, before + 4);
  assert.equal(launches.length, 0);
});
test('work reports reject anonymous/unloaded/coordinator senders, worker destinations and bad payloads', async t => {
  const { c, w, start, root } = await configured(t);
  const anonymous = await start('anonymous');
  for (const runtime of [c.runtime, anonymous.runtime]) await assert.rejects(runtime.tool('report_work', { status: 'blocked', summary: 'x' }), /configured.*worker/);
  w.runtime.responsibility = undefined;
  await assert.rejects(w.runtime.tool('report_work', { status: 'blocked', summary: 'x' }), /configured.*worker/);
  const message = { version: 1, kind: 'report', from: 'w', to: 'c', payload: { status: 'blocked', summary: 'x' } };
  await assert.rejects(w.runtime.receive({ ...message, to: 'w' }), /permission/);
  await assert.rejects(c.runtime.receive({ ...message, from: 'anonymous' }), /configured worker/);
  await assert.rejects(c.runtime.receive({ ...message, from: 'c' }), /configured worker/);
  for (const payload of [{status:'done',summary:'x'}, {status:'blocked',summary:''}, {status:'clear',summary:'x'}, {status:'needs_decision',summary:'x'.repeat(2001)}]) {
    assert.throws(() => envelope({ ...message, payload }), /report/);
    await assert.rejects(c.runtime.receive({ ...message, payload }), /report/);
  }
  assert.deepEqual(await readWorkerReports(root, ['w']), []);
});
test('report updates serialize, ignore payload identity and keep stored report if notification fails', { timeout: 5000 }, async t => {
  const { c, w, root } = await configured(t);
  const state = c.runtime.state.bind(c.runtime);
  let calls = 0, releaseFirst, firstQueued, secondReceived, secondCompleted = false;
  const gate = new Promise(resolve => { releaseFirst = resolve; });
  const queued = new Promise(resolve => { firstQueued = resolve; });
  const received = new Promise(resolve => { secondReceived = resolve; });
  c.runtime.state = async () => {
    const call = ++calls;
    // First receive authorizes at call 1. Its admitted report then performs
    // this fresh state check inside the serialized write callback (call 2).
    if (call === 2) { firstQueued(); await gate; }
    const result = await state();
    if (call === 3) secondReceived();
    return result;
  };
  t.after(() => { releaseFirst(); c.runtime.state = state; });
  const first = w.runtime.tool('report_work', { status: 'blocked', summary: 'first' });
  await queued;
  const second = w.runtime.tool('report_work', { status: 'clear' }).then(value => { secondCompleted = true; return value; });
  try {
    await received;
    // Let the second receive finish admission, while the first write stays
    // blocked. This is an event-loop boundary, not a timing/order guess.
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(c.runtime.pendingReports, 2, 'both receipts must be admitted concurrently');
    assert.equal(secondCompleted, false, 'second receipt must await the first queued write');
    assert.deepEqual(await readWorkerReports(root, ['w']), []);
  } finally { releaseFirst(); }
  await Promise.all([first, second]);
  c.runtime.state = state;
  assert.equal((await readWorkerReports(root, ['w']))[0].status, 'clear');
  c.host.deliver = () => { throw new Error('notification rejected'); };
  await assert.rejects(c.runtime.receive({ version:1, kind:'report', from:'w', to:'c', payload:{status:'ready_for_review',summary:'public result',sessionId:'c'} }), /Report stored.*notification/);
  assert.equal((await readWorkerReports(root, ['w']))[0].status, 'ready_for_review');
  assert.deepEqual(await readWorkerReports(root, ['c']), []);
});

test('retired dashboard metadata migrates only as coordinator and is never advertised by list', async t => {
  const { c, w, wire } = await configured(t);
  const original = await c.runtime.store.read(), before = wire.length;
  await c.runtime.store.update('c', config => { config.agents.find(a => a.coordinator).dashboardPort = 42000; });
  for (const runtime of [c.runtime, w.runtime]) assert.deepEqual(await runtime.tool('list', {}), original);
  await assert.rejects(w.runtime.retireDashboardMetadata(), /permission/);
  assert.equal((await c.runtime.store.read()).agents[0].dashboardPort, 42000);
  await c.runtime.retireDashboardMetadata();
  assert.deepEqual(await c.runtime.store.read(), original);
  await c.runtime.retireDashboardMetadata();
  for (const runtime of [c.runtime, w.runtime]) assert.deepEqual(await runtime.tool('list', {}), original);
  assert.equal(wire.length, before, 'migration/list must not prompt workers or probe endpoints');
});
test('idle/steering messages and independent status reports share reporting without worker turn', async t => {
  const { c, w, wire } = await configured(t);
  await c.runtime.tool('send', { to: 'Builder', message: 'Implement the assigned task' });
  assert.equal(w.messages.at(-1).busy, false);
  w.host.busy = () => true;
  await c.runtime.tool('send', { to: 'Builder', message: 'Report progress and continue' });
  assert.equal(w.messages.at(-1).busy, true);
  const before = w.messages.length;
  await c.runtime.tool('request_status', { to: 'Builder' });
  const deadline = Date.now() + 3000;
  while (!c.messages.at(-1)?.text.includes('Intercom status')) {
    if (Date.now() >= deadline) assert.fail(`Timed out observing status report; last coordinator message: ${c.messages.at(-1)?.text}; worker notices: ${w.notices.join('; ')}`);
    // Observe asynchronous receipt only; never resend the request or initiate recovery.
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(w.messages.length, before);
  assert.match(c.messages.at(-1).text, /"busy":true/);
  assert.ok(wire.some(x => x.message.kind === 'request_status'));
  assert.ok(wire.some(x => x.message.kind === 'status'));
  await assert.rejects(c.runtime.tool('report_status', {}), /worker-only/);
});
test('unknown status does not register; current port changes are bookkeeping; every send rereads', async t => {
  const { c, w, endpoints, wire } = await configured(t);
  const oldPort = w.runtime.endpoint.port, newPort = 40001;
  const handler = endpoints.get(oldPort); endpoints.delete(oldPort); endpoints.set(newPort, handler);
  w.runtime.endpoint.port = newPort;
  await w.runtime.report();
  assert.equal((await c.runtime.store.read()).agents.find(a => a.sessionId === 'w').port, newPort);
  await c.runtime.tool('send', { to: 'Builder', message: 'hello' });
  assert.equal(wire.at(-1).port, newPort);
  await c.runtime.receive({ version: 1, kind: 'status', from: 'removed', to: 'c', payload: { port: 40003, busy: false } });
  assert.equal((await c.runtime.store.read()).agents.length, 2);
  assert.match(c.messages.at(-1).text, /"configured":false/);
});
test('recipient and control role validation; stop/close fail before any transport/host cancellation', async t => {
  const { c, w, wire } = await configured(t);
  await assert.rejects(w.runtime.receive({ version: 1, kind: 'reload', from: 'c', to: 'not-w', payload: {} }), /mismatch/);
  await assert.rejects(w.runtime.receive({ version: 1, kind: 'reload', from: 'w', to: 'w', payload: {} }), /coordinator sender/);
  for (const op of ['stop_worker', 'close_worker']) {
    const before = wire.length;
    await assert.rejects(c.runtime.tool(op, { to: 'Builder' }), op === 'stop_worker' ? /Unsupported Pi host/ : /supported Linux Herdr provider/);
    assert.equal(wire.length, before);
  }
  for (const kind of ['stop', 'close']) await assert.rejects(w.runtime.receive({ version: 1, kind, from: 'c', to: 'w', payload: {} }), /No cancellation or shutdown/);
});
test('coordinator unavailable leaves endpoint open; no retries/replacement and session cleanup', async t => {
  const { c, w, start, wire, endpoints } = await configured(t);
  await c.runtime.close();
  const n = await start('new-worker');
  assert.ok(endpoints.has(n.runtime.endpoint.port));
  assert.match(n.notices.join('\n'), /unreachable/);
  const before = wire.length;
  await assert.rejects(w.runtime.tool('send', { to: 'Coordinator', message: 'result' }), /unreachable/);
  assert.equal(wire.length, before + 1);
  const port = w.runtime.endpoint.port;
  await w.runtime.close(); assert.equal(endpoints.has(port), false);
  await assert.rejects(w.runtime.tool('list', {}), /inactive/);
});
test('resume, launcher setting and explicit removal do not orchestrate other actions', async t => {
  const { c, w, launches, start } = await configured(t);
  await c.runtime.tool('set_multiplexer', { multiplexer: 'none' });
  await w.runtime.close();
  await c.runtime.tool('resume_worker', { to: 'Builder', confirmClosed: true });
  assert.equal(launches.at(-1).sessionId, 'w'); assert.equal(launches.at(-1).multiplexer, 'none');
  const resumed = await start('w'); // Real status announcement clears the in-flight resume fence.
  await resumed.runtime.close();
  await c.runtime.tool('remove_worker', { to: 'Builder' });
  assert.equal((await c.runtime.store.read()).agents.length, 1);
});
test('resume requires manual closure confirmation and fences concurrent/uncertain launches', async t => {
  const { c, w, launches, start } = await configured(t);
  await assert.rejects(c.runtime.tool('resume_worker', { to: 'Builder' }), /explicit user confirmation/);
  assert.equal(launches.length, 0);
  await w.runtime.close();
  let release;
  c.runtime.options.probe = agent => new Promise(resolve => { release = () => resolve({ sessionId: agent.sessionId, state: 'disconnected', checkedAt: new Date().toISOString(), reason: 'refused' }); });
  const first = c.runtime.tool('resume_worker', { to: 'Builder', confirmClosed: true });
  while (!release) await new Promise(resolve => setTimeout(resolve, 1));
  await assert.rejects(c.runtime.tool('resume_worker', { to: 'Builder', confirmClosed: true }), /in flight/);
  release(); await first;
  assert.equal(launches.length, 1);
  await assert.rejects(c.runtime.tool('resume_worker', { to: 'Builder', confirmClosed: true }), /in flight|uncertain/);
  const resumed = await start('w'); // A real configured status announcement retires the local attempt fence.
  await resumed.runtime.close();
  c.runtime.options.probe = async agent => ({ sessionId: agent.sessionId, state: 'disconnected', checkedAt: new Date().toISOString(), reason: 'refused' });
  c.runtime.options.launch = async () => { throw new Error('uncertain launch failure'); };
  await assert.rejects(c.runtime.tool('resume_worker', { to: 'Builder', confirmClosed: true }), /uncertain launch failure/);
  await assert.rejects(c.runtime.tool('resume_worker', { to: 'Builder', confirmClosed: true }), /in flight|uncertain/);
  assert.ok((await c.runtime.store.read()).agents.some(a => a.sessionId === 'w'));
});
test('preflight and in-flight status cannot unfence an uncertain resume failure', async t => {
  for (const when of ['preflight', 'launch']) {
    const { c, w } = await configured(t);
    const port = w.runtime.endpoint.port;
    await w.runtime.close();
    const status = () => c.runtime.receive({ version:1, kind:'status', from:'w', to:'c', payload:{port,busy:false} });
    c.runtime.options.probe = async agent => {
      if (when === 'preflight') await status();
      return {sessionId:agent.sessionId,state:'unknown',checkedAt:new Date().toISOString(),reason:'legacy'};
    };
    let calls = 0;
    c.runtime.options.launch = async () => {
      calls++;
      if (when === 'launch') await status();
      throw new Error('uncertain submission');
    };
    await assert.rejects(c.runtime.tool('resume_worker', {to:'Builder',confirmClosed:true}), /uncertain submission/);
    await assert.rejects(c.runtime.tool('resume_worker', {to:'Builder',confirmClosed:true}), /in flight|uncertain/);
    assert.equal(calls,1);
  }
});
test('a delayed preflight status write is not a post-launch announcement', async t => {
  const { c, w } = await configured(t);
  const port = w.runtime.endpoint.port;
  await w.runtime.close();
  const update = c.runtime.store.update.bind(c.runtime.store);
  let releaseWrite, status;
  c.runtime.store.update = async (...args) => {
    await new Promise(resolve => { releaseWrite = resolve; });
    return update(...args);
  };
  c.runtime.options.probe = async agent => {
    status = c.runtime.receive({version:1,kind:'status',from:'w',to:'c',payload:{port,busy:false}});
    while (!releaseWrite) await new Promise(resolve => setTimeout(resolve,1));
    return {sessionId:agent.sessionId,state:'unknown',checkedAt:new Date().toISOString(),reason:'legacy'};
  };
  let launches = 0;
  c.runtime.options.launch = async () => { launches++; releaseWrite(); await status; return {launched:true}; };
  await c.runtime.tool('resume_worker', {to:'Builder',confirmClosed:true});
  await assert.rejects(c.runtime.tool('resume_worker', {to:'Builder',confirmClosed:true}), /in flight|uncertain/);
  assert.equal(launches,1);
});
test('worker removal during directory resolution is rechecked before resume launch', async t => {
  const { c, launches } = await configured(t);
  const store = c.runtime.store, root = store.root, state = c.runtime.state.bind(c.runtime);
  const probe = c.runtime.options.probe;
  let pending, triggered = false, armed = false;
  c.runtime.options.probe = async (...args) => {
    const result = await probe(...args);
    armed = true; // Target lookup and probe must finish before injecting removal.
    return result;
  };
  Object.defineProperty(store, 'root', { get() {
    if (armed && !triggered) {
      triggered = true;
      pending = store.update('c', config => { config.agents = config.agents.filter(a => a.sessionId !== 'w'); });
    }
    return root;
  } });
  c.runtime.state = async () => { if (pending) await pending; return state(); };
  await assert.rejects(c.runtime.tool('resume_worker', {to:'Builder',confirmClosed:true}), /configuration changed/);
  assert.equal(triggered, true);
  assert.equal(launches.length,0);
});
test('changed worker endpoint during resume check prevents launch', async t => {
  const { c, launches } = await configured(t);
  c.runtime.options.probe = async agent => {
    await c.runtime.store.update('c', config => { config.agents.find(a => a.sessionId === agent.sessionId).port++; });
    return {sessionId:agent.sessionId,state:'disconnected',checkedAt:new Date().toISOString(),reason:'refused'};
  };
  await assert.rejects(c.runtime.tool('resume_worker', {to:'Builder',confirmClosed:true}), /configuration changed/);
  assert.equal(launches.length,0);
});
test('existing worker startup restores role/name, reports new port and starts no work', async t => {
  const { c, w, start } = await configured(t);
  const oldPort = w.runtime.endpoint.port;
  await w.runtime.close();
  const resumed = await start('w');
  assert.equal(resumed.runtime.responsibility.name, 'Builder');
  assert.deepEqual(resumed.names, ['Builder']);
  assert.equal(resumed.messages.length, 0);
  assert.notEqual(resumed.runtime.endpoint.port, oldPort);
  assert.equal((await c.runtime.store.read()).agents.find(a => a.sessionId === 'w').port, resumed.runtime.endpoint.port);
  assert.match(c.messages.at(-1).text, /Intercom status/);
});
test('close or session switch during directory resolution prevents create/resume launch', async t => {
  for (const operation of ['create_worker', 'resume_worker']) {
    for (const transition of ['close', 'switch']) {
      const { c, launches } = await configured(t);
      const store = c.runtime.store, root = store.root;
      let invalidated = false, closing;
      Object.defineProperty(store, 'root', { get() {
        if (!invalidated) {
          invalidated = true;
          queueMicrotask(() => {
            if (transition === 'close') closing = c.runtime.close();
            else c.host.sessionId = () => 'fork';
          });
        }
        return root;
      } });
      await assert.rejects(c.runtime.tool(operation, { to: 'Builder', confirmClosed: true }), /inactive|replaced/);
      await closing;
      assert.equal(launches.length, 0);
    }
  }
});
test('close invalidates queued coordinator tool and status writes', async t => {
  for (const operation of ['configure_worker', 'set_multiplexer', 'remove_worker', 'status', 'dashboard_port']) {
    const { c } = await configured(t);
    const store = c.runtime.store;
    if (operation === 'dashboard_port') await store.update('c', config => { config.agents[0].dashboardPort = 42000; });
    const original = await store.read();
    let release, entered, queued;
    const started = new Promise(resolve => { entered = resolve; });
    const blocker = store.update('c', async () => { entered(); await new Promise(resolve => { release = resolve; }); });
    await started;
    const reachedQueue = new Promise(resolve => { queued = resolve; });
    const update = store.update.bind(store);
    store.update = (...args) => { queued(); return update(...args); };
    const pending = operation === 'status'
      ? c.runtime.receive({ version: 1, kind: 'status', from: 'w', to: 'c', payload: { port: 49999, busy: false } })
      : operation === 'dashboard_port' ? c.runtime.retireDashboardMetadata()
      : c.runtime.tool(operation, { to: 'Builder', multiplexer: 'none', sessionId: 'w2', name: 'Other', port: 40001, projectDirectory: '.', description: 'Other remit' });
    const rejected = assert.rejects(pending, /inactive|replaced/);
    await reachedQueue;
    await c.runtime.close(); release(); await blocker; await rejected;
    assert.deepEqual(await store.read(), original);
  }
});
test('close while listener startup is pending disposes the late endpoint', async t => {
  const { c, endpoints } = await configured(t);
  await c.runtime.close();
  const listen = c.runtime.options.listen;
  let release, entered, latePort;
  const started = new Promise(resolve => { entered = resolve; });
  c.runtime.options.listen = async (...args) => {
    const endpoint = await listen(...args); latePort = endpoint.port;
    entered(); await new Promise(resolve => { release = resolve; });
    return endpoint;
  };
  const pending = c.runtime.start();
  const rejected = assert.rejects(pending, /inactive|replaced/);
  await started; await c.runtime.close(); release(); await rejected;
  assert.equal(endpoints.has(latePort), false);
  assert.equal(c.runtime.endpoint, undefined);
});
test('anonymous startup cannot register across a directory-resolution lifecycle change', async t => {
  const { c, wire, root } = await configured(t);
  let runtime, invalidated = false, closing;
  runtime = new Intercom({ cwd: root, sessionId: () => 'anonymous', busy: () => false,
    deliver: () => {}, setName: async () => {}, notify: () => {} }, {
    ...c.runtime.options,
    store: base => {
      const store = new ConfigStore(base);
      Object.defineProperty(store, 'root', { get() {
        if (!invalidated) {
          invalidated = true;
          queueMicrotask(() => {
            closing = runtime.close();
            // Simulate the same object's next active lifecycle before realpath completes.
            runtime.active = true;
            runtime.endpoint = { port: 49999, close: async () => {} };
          });
        }
        return base;
      } });
      return store;
    },
  });
  t.after(() => runtime.close());
  const before = wire.length;
  await assert.rejects(runtime.start(), /lifecycle replaced/);
  await closing;
  assert.equal(wire.length, before);
});
test('deferred status from a closed lifecycle does not report after restart', async t => {
  const { c, w, wire } = await configured(t);
  await w.runtime.receive({ version: 1, kind: 'request_status', from: 'c', to: 'w', payload: {} });
  await w.runtime.close();
  // Reactivate synchronously to exercise the generation check, not just active=false.
  w.runtime.active = true; w.runtime.initialId = 'w';
  const before = wire.length;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(wire.length, before);
  assert.equal(w.notices.some(text => text.startsWith('Status report failed:')), false);
});
test('live session ID changes invalidate old runtime rather than granting cached role', async t => {
  const { c } = await configured(t);
  c.host.sessionId = () => 'fork-id';
  await assert.rejects(c.runtime.tool('create_worker', {}), /replaced/);
});
