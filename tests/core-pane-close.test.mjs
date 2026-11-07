import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createCoreCloseProvider } from '../dist/core-pane-close.js';

async function fixture(t) {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'hc-close-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const files = [path.join(dir, 'c.jsonl'), path.join(dir, 'w.jsonl')];
  await Promise.all(files.map((f, i) => writeFile(f, JSON.stringify({ type: 'session', id: i ? 'worker' : 'coordinator' }) + '\n')));
  const core = 'a'.repeat(32), calls = [], processes = new Map([[100, { start: '10', state: 'S' }], [200, { start: '20', state: 'S' }]]);
  const records = new Map([['t1', { address: 't1', state: 'live', created_ms: 1, foreground: { pid: 100 }, parent: null }], ['t2', { address: 't2', state: 'live', created_ms: 2, foreground: { pid: 200 }, parent: 't1' }]]);
  const f = { version: 1, calls, processes, records, after: undefined, committed: false,
    value: { spaces: [{ id: 'sp1', name: 'Project', tabs: [1, 2].map(i => ({ id: `tb${i}`, name: i === 1 ? 'Main' : 'Worker', root: { id: `tb${i}`, type: 'row', children: [{ id: `p${i}`, type: 'block', content: { terminal: `t${i}` } }] } })) }] },
  };
  const call = async (method, params) => {
    calls.push({ method, params });
    let result;
    if (method === 'server.status') result = { version: '0.1.18', core: { id: core, name: 'host' }, pid: 99 };
    else if (method === 'terminal.get') result = records.get(params.terminal);
    else if (method === 'terminal.list') result = { terminals: [...records.values()], hidden_finished: 0, machines: [] };
    else if (method === 'doc.get') result = { version: f.version, value: f.value };
    else if (method === 'terminal.kill') {
      assert.equal(f.committed, true, 'kill must follow the handoff commit');
      assert.equal(params.terminal, 't2');
      const r = records.get('t2'); r.state = 'finished'; r.foreground = null; r.finished_ms = 100;
      processes.delete(200); result = r;
    } else if (method === 'doc.set') {
      assert.equal(params.version, f.version); f.value = structuredClone(params.value); result = { version: ++f.version };
    } else assert.fail(method);
    result = structuredClone(result); await f.after?.(method, params, result); return result;
  };
  const options = i => ({ sessionId: () => i ? 'worker' : 'coordinator', sessionFile: () => files[i], env: { HC_TERMINAL_ID: i ? 't2' : 't1' }, platform: 'linux', pid: i ? 200 : 100, processIdentity: async pid => processes.get(pid), call, verificationMs: 0 });
  const c = createCoreCloseProvider(options(0)), w = createCoreCloseProvider(options(1));
  f.c = c; f.identity = await w.getIdentity(); f.guard = () => {}; f.commit = async () => { f.committed = true; }; return f;
}
test('guarded core close commits before one stop, verifies process exit, and removes only worker tab', async t => {
  const f = await fixture(t), main = structuredClone(f.value.spaces[0].tabs[0]);
  await f.c.inspect(f.identity, 'worker', f.guard);
  assert.deepEqual(await f.c.close(f.identity, 'worker', f.guard, f.commit), { paneClosed: true, workerExited: true });
  assert.deepEqual(f.value.spaces[0].tabs, [main]);
  assert.equal(f.calls.filter(c => c.method === 'terminal.kill').length, 1);
  await assert.rejects(f.c.close(f.identity, 'worker', f.guard, f.commit));
  assert.equal(f.calls.filter(c => c.method === 'terminal.kill').length, 1);
});
test('identity mismatch, active descendants and rejected handoff commit prevent termination', async t => {
  for (const kind of ['session', 'pid', 'child', 'commit']) {
    const f = await fixture(t);
    if (kind === 'session') f.identity.sessionId = 'another';
    if (kind === 'pid') f.processes.set(200, { start: '99', state: 'S' });
    if (kind === 'child') f.records.set('t3', { address: 't3', state: 'live', parent: 't2' });
    await assert.rejects(f.c.close(f.identity, 'worker', f.guard, kind === 'commit' ? async () => { throw new Error('epoch invalidated'); } : f.commit));
    assert.equal(f.calls.some(c => c.method === 'terminal.kill'), false);
  }
});
test('lost stop response remains uncertain and never permits replay', async t => {
  const f = await fixture(t);
  f.after = method => { if (method === 'terminal.kill') throw new Error('lost response'); };
  await assert.rejects(f.c.close(f.identity, 'worker', f.guard, f.commit), /uncertain/);
  await assert.rejects(f.c.close(f.identity, 'worker', f.guard, f.commit));
  assert.equal(f.calls.filter(c => c.method === 'terminal.kill').length, 1);
});
test('layout CAS conflict after termination is uncertain, with Main preserved', async t => {
  const f = await fixture(t), main = structuredClone(f.value.spaces[0].tabs[0]);
  f.after = method => { if (method === 'doc.set') throw new Error('conflict'); };
  await assert.rejects(f.c.close(f.identity, 'worker', f.guard, f.commit), /uncertain/);
  assert.deepEqual(f.value.spaces[0].tabs[0], main);
});
test('core worker close stays disabled on Windows without process-start identity proof', () => {
  assert.equal(createCoreCloseProvider({ platform: 'win32', env: { HC_TERMINAL_ID: 't1' }, sessionId: () => 'c', sessionFile: () => undefined }), undefined);
});
