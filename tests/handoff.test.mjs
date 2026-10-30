import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Intercom } from '../dist/runtime.js';
import { ConfigStore, validateConfig } from '../dist/config.js';
import { envelope, send } from '../dist/transport.js';
import { HandoffWorkflow } from '../dist/handoff.js';

const identity = { workspaceId: 'space', paneId: 'pane', terminalId: 'terminal', sessionId: 'w', sessionFile: '/private/session.jsonl', pid: 123, processStart: '456' };
const pause = () => new Promise(resolve => setTimeout(resolve, 5));
// Fixture-only diagnostics: bounded public states/codes, never raw config,
// summary text, pane identity, filesystem paths or full exception messages.
const activeDiagnostics = new Set();
async function until(check) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await pause(); }
  const diagnostics = [...activeDiagnostics].slice(0, 16).map(snapshot => snapshot());
  assert.fail(`condition did not settle; fixture diagnostics: ${JSON.stringify(diagnostics).slice(0, 12000)}`);
}
async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'intercom-handoff-'));
  await new ConfigStore(root).initialize('c', 12345);
  const wire = [], deliveries = [], closes = [], inspections = [];
  const updates = [], publicationListeners = new Set(), pendingWaits = new Set();
  let lastPublishedJob = null, lastReadState = null, firstUpdateFailure = null, busy = false;
  const recordUpdate = event => { updates.push(event); if (updates.length > 24) updates.shift(); };
  const diagnostics = () => {
    const pending = c.handoff?.jobs.get('w'); // Test-only visibility into the retained failure fence.
    return { lastReadState, lastPublishedState: lastPublishedJob?.state ?? null, firstUpdateFailure, updates, wireKinds: wire.slice(-16).map(message => message.kind), closeCalls: closes.length,
      runtimeJob: pending ? { state: pending.job.state, ended: pending.ended, closing: pending.closing } : null };
  };
  activeDiagnostics.add(diagnostics);
  t.after(() => { activeDiagnostics.delete(diagnostics); });
  const provider = {
    getIdentity: async () => ({ ...identity }),
    inspect: async (proof, id, guard) => { guard(); inspections.push(proof); assert.equal(id, 'w'); },
    close: async (proof, id, guard, beforeSubmit) => { guard(); await beforeSubmit(); guard(); closes.push(proof); assert.equal(id, 'w'); return options.outcome ?? { paneClosed: true, workerExited: true }; },
    ...options.provider,
  };
  const shared = { launch: async () => assert.fail('no launch'), observe: () => ({ record() {}, close() {} }),
    closeProvider: provider, closeTimeoutMs: options.timeout ?? 2000,
    send: async (port, message) => { wire.push(message); if (options.intercept) await options.intercept(message); await send(port, message); },
  };
  const host = id => ({ cwd: root, sessionId: () => id, busy: () => id === 'w' && busy,
    deliver: text => { deliveries.push({ id, text }); options.onDelivery?.({ id, text }); }, setName: async () => {}, notify() {} });
  const c = new Intercom(host('c'), shared), w = new Intercom(host('w'), shared);
  t.after(async () => { await w.close(); await c.close(); await rm(root, { recursive: true, force: true }); });
  await c.start();
  const update = c.store.update.bind(c.store);
  c.store.update = async (id, mutate, guard) => {
    let attemptedState = null;
    try {
      const result = await update(id, async config => {
        await mutate(config);
        attemptedState = config.agents.find(agent => agent.sessionId === 'w')?.closeJob?.state ?? null;
        recordUpdate({ stage: 'mutated', state: attemptedState });
      }, guard);
      recordUpdate({ stage: 'published', state: attemptedState });
      const job = result.agents.find(agent => agent.sessionId === 'w')?.closeJob;
      lastPublishedJob = job ? { ...job } : null;
      for (const notify of [...publicationListeners]) notify();
      return result;
    } catch (error) {
      const failure = { stage: 'rejected', state: attemptedState, code: typeof error.code === 'string' ? error.code.slice(0, 64) : null,
        syscall: typeof error.syscall === 'string' ? error.syscall.slice(0, 64) : null };
      firstUpdateFailure ??= failure;
      recordUpdate(failure);
      throw error;
    }
  };
  await w.start();
  await c.tool('configure_worker', { sessionId: 'w', port: w.endpoint.port, projectDirectory: '.', name: 'Worker', description: 'Scoped work' });
  await c.tool('reload_worker', { to: 'Worker' });
  const entry = async () => {
    const value = (await c.store.read()).agents.find(a => a.sessionId === 'w');
    lastReadState = value?.closeJob ? { state: value.closeJob.state, reason: value.closeJob.reason ?? null } : null;
    return value;
  };
  const waitForJob = async expectedState => {
    // Observe real successful publication, not repeated file opens that impose
    // an unrelated Windows continuous-reader availability requirement.
    const published = await new Promise((resolve, reject) => {
      let timer;
      const cleanup = () => { clearTimeout(timer); publicationListeners.delete(check); pendingWaits.delete(cancel); };
      const check = () => {
        if (lastPublishedJob?.state === expectedState) { cleanup(); resolve({ ...lastPublishedJob }); }
      };
      const cancel = () => { cleanup(); reject(new Error('fixture ended before job publication')); };
      publicationListeners.add(check); pendingWaits.add(cancel);
      timer = setTimeout(() => {
        cleanup();
        reject(new Error(`job did not reach ${expectedState}; fixture diagnostics: ${JSON.stringify(diagnostics()).slice(0, 12000)}`));
      }, 3000);
      check(); // Subscribe then check the cached publication: no missed event.
    });
    const actual = await entry();
    assert.equal(actual.closeJob.jobId, published.jobId);
    assert.equal(actual.closeJob.state, expectedState, 'published state must exist in the actual config file');
    return actual.closeJob;
  };
  t.after(() => { for (const cancel of [...pendingWaits]) cancel(); });
  const request = async () => (await c.tool('close_worker', { to: 'Worker' })).job;
  const prepared = async () => until(async () => deliveries.find(d => d.id === 'w' && d.text.includes('intercom_report_handoff')));
  const report = async job => { w.workerStarted(); await w.tool('report_handoff', { jobId: job.jobId, summary: 'Completed tests; pending review. src/runtime.ts' }, 'handoff-tool'); };
  return { c, w, root, wire, deliveries, closes, inspections, provider, shared, entry, waitForJob, request, prepared, report, setBusy: value => { busy = value; } };
}

test('close returns after durable enqueue, not worker response; summary/tool settlement/commit precede one close', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { provider: { getIdentity: async () => { await gate; return identity; } } });
  const job = await f.request();
  assert.equal(job.state, 'requested'); assert.equal((await f.entry()).closeJob.jobId, job.jobId);
  assert.equal(f.closes.length, 0);
  assert.equal((await f.request()).jobId, job.jobId);
  release(); await f.prepared();
  assert.equal(f.wire.filter(m => m.kind === 'close_prepare').length, 1);
  await f.report(job);
  assert.equal((await f.entry()).handoff.summary, 'Completed tests; pending review. src/runtime.ts');
  assert.equal((await f.entry()).closeJob.state, 'awaiting_settlement');
  assert.equal(f.closes.length, 0);
  f.w.workerSettled(new Set(['wrong-tool'])); await pause(); assert.equal(f.closes.length, 0);
  f.w.workerSettled(new Set(['handoff-tool']));
  await f.waitForJob('closed');
  assert.equal(f.closes.length, 1);
  assert.deepEqual(f.wire.filter(m => ['handoff_report', 'close_ready', 'close_commit'].includes(m.kind)).map(m => m.kind), ['handoff_report', 'close_ready', 'close_commit']);
  f.w.workerSettled(new Set(['handoff-tool'])); await pause(); assert.equal(f.closes.length, 1);
  const publicConfig = JSON.stringify(await f.c.store.read());
  assert.doesNotMatch(publicConfig, /session\.jsonl|terminalId|processStart|workspaceId|"pid"/);
});

test('roles, wire bounds, explicit correlation and active-job work/config fences', async t => {
  const f = await fixture(t); const job = await f.request(); await f.prepared();
  await assert.rejects(f.w.tool('report_handoff', { jobId: 'wrong', summary: 'x' }, 'tool'));
  await assert.rejects(f.w.tool('report_handoff', { jobId: job.jobId, summary: 'x'.repeat(4001) }, 'tool'));
  for (const op of ['send', 'reload_worker', 'resume_worker', 'remove_worker']) {
    await assert.rejects(f.c.tool(op, { to: 'Worker', message: 'new work', confirmClosed: true }), /fenced/);
  }
  await assert.rejects(f.c.tool('configure_worker', { sessionId: 'w', port: f.w.endpoint.port, projectDirectory: '.', name: 'Worker', description: 'changed' }), /fenced/);
  const msg = { version: 1, kind: 'close_commit', from: 'w', to: 'w', payload: { jobId: job.jobId, instanceId: 'x', readyNonce: 'y' } };
  await assert.rejects(f.w.receive(msg));
  await assert.rejects(f.w.receive({ ...msg, from: 'c' }));
  assert.throws(() => envelope({ ...msg, payload: { ...msg.payload, arbitrary: identity } }));
  assert.throws(() => envelope({ ...msg, payload: { ...msg.payload, readyNonce: 'x'.repeat(129) } }));
  const health = await f.w.tool('report_status', {}); assert.equal(health.accepted, true);
  assert.equal(f.closes.length, 0);
});

test('failed atomic summary persistence prevents readiness and pane closure', async t => {
  const f = await fixture(t); const job = await f.request(); await f.prepared();
  const update = f.c.store.update.bind(f.c.store);
  let fail = true;
  f.c.store.update = async (...args) => { if (fail) throw new Error('private disk failure'); return update(...args); };
  await assert.rejects(f.report(job));
  f.w.workerSettled(new Set(['handoff-tool'])); await pause(); assert.equal(f.closes.length, 0);
  assert.equal((await f.entry()).handoff, undefined);
  fail = false;
});

test('summary temporary-file sync crossing deadline cannot publish a late handoff or close', async t => {
  const f = await fixture(t, { timeout: 300 }); const job = await f.request(); await f.prepared();
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const open = f.c.store.openTemporary.bind(f.c.store);
  let first = true;
  f.c.store.openTemporary = async file => {
    const handle = await open(file);
    return {
      writeFile: (...args) => handle.writeFile(...args), close: () => handle.close(),
      sync: async () => { if (first) { first = false; entered(); await gate; } await handle.sync(); },
    };
  };
  const report = f.report(job); const rejected = assert.rejects(report);
  await started;
  await new Promise(resolve => setTimeout(resolve, Math.max(0, Date.parse(job.deadlineAt) - Date.now()) + 20));
  release(); await rejected;
  await f.waitForJob('timed_out');
  assert.equal((await f.entry()).handoff, undefined); assert.equal(f.closes.length, 0);
});

test('new turn after handoff invalidates readiness even with old successful tool result', async t => {
  const f = await fixture(t); const job = await f.request(); await f.prepared(); await f.report(job);
  f.w.workerStarted(); f.w.workerSettled(new Set(['handoff-tool'])); await pause();
  assert.equal(f.wire.filter(m => m.kind === 'close_ready').length, 0);
  assert.equal(f.closes.length, 0);
});

test('new turn before commit ACK rejects closure', async t => {
  let worker;
  const f = await fixture(t, { intercept: async message => { if (message.kind === 'close_commit') worker.workerStarted(); } });
  worker = f.w;
  const job = await f.request(); await f.prepared(); await f.report(job);
  f.w.workerSettled(new Set(['handoff-tool']));
  await f.waitForJob('failed');
  assert.equal((await f.entry()).closeJob.reason, 'commit_rejected'); assert.equal(f.closes.length, 0);
});

test('deadline never forces close; coordinator reload interrupts pending jobs without replay', { timeout: 10000 }, async t => {
  let delivered;
  const prepared = new Promise(resolve => { delivered = resolve; });
  const f = await fixture(t, { timeout: 120, onDelivery: ({ id, text }) => {
    if (id === 'w' && text.includes('intercom_report_handoff')) delivered();
  } });
  // Freeze the workflow deadline while real filesystem/network preparation runs.
  // Advance only after the actual worker request arrives, not after a wall-clock
  // guess; the real production timeout callback and late-report guard still run.
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const job = await f.request(); await prepared;
  assert.equal((await f.entry()).closeJob.state, 'awaiting_handoff');
  t.mock.timers.tick(120);
  await f.waitForJob('timed_out');
  assert.equal(f.closes.length, 0);
  await assert.rejects(f.w.tool('report_handoff', { jobId: job.jobId, summary: 'too late' }, 'late-tool'));
  t.mock.timers.reset();
  const g = await fixture(t); await g.request(); await g.prepared();
  const sent = g.wire.length;
  await g.c.close(); await g.c.start();
  assert.equal((await g.entry()).closeJob.state, 'interrupted');
  assert.equal(g.wire.length, sent); assert.equal(g.closes.length, 0);
});

test('worker runtime replacement rejects stale commit instance', async t => {
  let worker;
  const f = await fixture(t, { intercept: async message => {
    if (message.kind === 'close_commit') { await worker.close(); await worker.start(); }
  } });
  worker = f.w;
  const job = await f.request(); await f.prepared(); await f.report(job);
  f.w.workerSettled(new Set(['handoff-tool']));
  await f.waitForJob('failed');
  assert.equal(f.closes.length, 0);
});

test('unverified close is uncertain, persists summary and fences retry/resume through reload', async t => {
  const f = await fixture(t, { outcome: { paneClosed: true, workerExited: false } });
  const job = await f.request(); await f.prepared(); await f.report(job);
  f.w.workerSettled(new Set(['handoff-tool']));
  await f.waitForJob('uncertain');
  await f.c.close(); await f.c.start();
  await assert.rejects(f.request());
  await assert.rejects(f.c.tool('resume_worker', { to: 'Worker', confirmClosed: true }), /fenced/);
  assert.equal(f.closes.length, 1); assert.equal((await f.entry()).handoff.jobId, job.jobId);
});

test('coordinator reload with closing intent becomes uncertain and cannot replay', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { provider: { close: async (_p, _id, guard, beforeSubmit) => { guard(); await gate; guard(); await beforeSubmit(); return { paneClosed: true, workerExited: true }; } } });
  const job = await f.request(); await f.prepared(); await f.report(job);
  f.w.workerSettled(new Set(['handoff-tool']));
  await f.waitForJob('closing');
  await f.c.close(); await f.c.start(); release();
  assert.equal((await f.entry()).closeJob.state, 'uncertain'); await assert.rejects(f.request());
});

test('same-ID reconfigure preserves handoff and closed job; validators reject private fields', async t => {
  const f = await fixture(t); const job = await f.request(); await f.prepared(); await f.report(job);
  f.w.workerSettled(new Set(['handoff-tool'])); await f.waitForJob('closed');
  await f.c.tool('configure_worker', { sessionId: 'w', port: f.w.endpoint.port, projectDirectory: '.', name: 'Renamed', description: 'New responsibility' });
  assert.equal((await f.entry()).handoff.jobId, job.jobId); assert.equal((await f.entry()).closeJob.state, 'closed');
  const config = await f.c.store.read(); config.agents.find(a => a.sessionId === 'w').closeJob.identity = identity;
  assert.throws(() => validateConfig(config));
});

test('new work during final provider inspection rejects last-moment commit before OS pane close', async t => {
  let release, inspecting, actualCloses = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { inspecting = resolve; });
  const f = await fixture(t, { provider: { close: async (_proof, _id, guard, beforeSubmit) => {
    guard(); inspecting(); await gate; guard(); await beforeSubmit(); guard(); actualCloses++;
    return { paneClosed: true, workerExited: true };
  } } });
  const job = await f.request(); await f.prepared(); await f.report(job);
  f.w.workerSettled(new Set(['handoff-tool'])); await started;
  f.w.workerStarted(); release();
  await f.waitForJob('failed');
  assert.equal((await f.entry()).closeJob.reason, 'commit_rejected'); assert.equal(actualCloses, 0);
});

test('in-memory job admission caps active jobs at sixteen before asynchronous work starts', async () => {
  const config = { multiplexer: 'herdr', agents: Array.from({ length: 17 }, (_, i) => ({ sessionId: `w-${i}`, coordinator: false, port: 1234, projectDirectory: '.', name: `W-${i}`, description: 'work' })) };
  const workflow = new HandoffWorkflow({
    state: async () => ({ id: 'c', config }), assertCurrent() {},
    update: async mutate => { mutate(config); }, send: async () => {}, deliver() {}, busy: () => false,
    provider: { getIdentity: async () => identity, inspect: async () => {}, close: async () => assert.fail('must not close') },
  });
  try {
    const jobs = await Promise.allSettled(config.agents.map(agent => workflow.request(agent)));
    assert.equal(jobs.filter(job => job.status === 'fulfilled').length, 16);
    assert.equal(jobs.filter(job => job.status === 'rejected').length, 1);
  } finally { workflow.dispose(); }
});

test('unpublished close intent fences concurrent resume and controls before config snapshot catches up', async t => {
  const f = await fixture(t);
  const original = f.c.store.update.bind(f.c.store);
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  f.c.store.update = async (...args) => { entered(); await gate; return original(...args); };
  const pending = f.request();
  await started;
  assert.equal((await f.entry()).closeJob, undefined);
  try {
    for (const op of ['resume_worker', 'remove_worker', 'reload_worker', 'send']) {
      await assert.rejects(f.c.tool(op, { to: 'Worker', confirmClosed: true, message: 'new work' }), /fenced/);
    }
    await assert.rejects(f.c.tool('configure_worker', { sessionId: 'w', port: f.w.endpoint.port, projectDirectory: '.', name: 'Worker', description: 'changed' }), /fenced/);
  } finally { release(); }
  await pending;
});
