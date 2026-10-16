import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ConfigStore, directory, named, validateConfig } from '../dist/config.js';
import { listen, send, envelope, BODY_LIMIT } from '../dist/transport.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'intercom-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return new ConfigStore(root);
}
const worker = (id = 'worker', name = 'Builder') => ({ sessionId: id, name, port: 12345, description: 'Build only assigned work', projectDirectory: '.' });
test('atomic first creation publishes complete config: exactly one winner', async t => {
  const s = await fixture(t);
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => new ConfigStore(s.root).initialize(`session-${i}`, 12345)));
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal((await s.read()).agents.length, 1);
});
test('exact-root discovery, explicit same-root validation and invalid config preservation', async t => {
  const s = await fixture(t); await s.initialize('coordinator', 12345);
  const child = path.join(s.root, 'a', 'b'); await mkdir(child, { recursive: true });
  assert.equal(await ConfigStore.discover(child), undefined);
  await assert.rejects(ConfigStore.workspace(child, s.root), /must equal/);
  assert.equal((await ConfigStore.workspace(s.root, s.root)).root, await realpath(s.root));
  assert.equal(await directory(s.root, child), 'a/b');
  await assert.rejects(directory(s.root, '..'), /descendant/);
  await writeFile(s.file, '{broken');
  assert.equal(await ConfigStore.discover(child), undefined);
  await assert.rejects(ConfigStore.discover(s.root));
  await assert.rejects(ConfigStore.workspace(child, s.root), /must equal/);
  await assert.rejects(ConfigStore.workspace(s.root, s.root));
  await assert.rejects(s.update('coordinator', c => c.agents.pop()));
  assert.equal(await readFile(s.file, 'utf8'), '{broken');
});
test('coordinator writes only, unique case-insensitive names, serialized writes', async t => {
  const s = await fixture(t); await s.initialize('coordinator', 12345);
  await assert.rejects(s.configure('unknown', worker()), /permission/);
  await s.configure('coordinator', worker());
  assert.equal(named(await s.read(), 'bUiLdEr').name, 'Builder');
  await assert.rejects(s.configure('coordinator', worker('other', 'builder')), /duplicate/);
  await assert.rejects(s.configure('coordinator', worker('other', 'COORDINATOR')), /duplicate|reserved/);
  await s.configure('coordinator', worker());
  await Promise.all(Array.from({ length: 20 }, (_, i) => s.configure('coordinator', worker(`w${i}`, `Worker${i}`))));
  assert.equal((await s.read()).agents.length, 22);
  await assert.rejects(s.configure('coordinator', worker('coordinator')), /coordinator/);
});
test('schema rejects malformed version, port, duplicate IDs, traversal', async t => {
  const s = await fixture(t); await s.initialize('c', 12345);
  const c = await s.read();
  for (const patch of [{ version: 2 }, { multiplexer: 'tmux' }, { agents: [] }]) assert.throws(() => validateConfig({ ...c, ...patch }));
  for (const patch of [{ port: 0 }, { projectDirectory: '../elsewhere' }, { name: 'bad\nname' }]) {
    assert.throws(() => validateConfig({ ...c, agents: [...c.agents, { ...worker(), coordinator: false, ...patch }] }));
  }
  assert.throws(() => envelope({ version: 1, kind: 'status', from: 'w', to: 'c', payload: { port: 1, busy: 'yes' } }));
});
test('optional dashboardPort accepts legacy/coordinator entries and rejects invalid or worker values without repair', async t => {
  const s = await fixture(t); await s.initialize('c', 12345);
  await s.configure('c', worker());
  const original = await s.read();
  assert.equal(validateConfig(original).agents[0].dashboardPort, undefined);
  for (const value of [1, 65535]) {
    const candidate = structuredClone(original); candidate.agents[0].dashboardPort = value;
    assert.equal(validateConfig(candidate).agents[0].dashboardPort, value);
  }
  for (const value of [0, 65536, -1, 1.5, null, '12345']) {
    const candidate = structuredClone(original); candidate.agents[0].dashboardPort = value;
    assert.throws(() => validateConfig(candidate), /invalid port/);
  }
  const invalidWorker = structuredClone(original); invalidWorker.agents[1].dashboardPort = 12345;
  assert.throws(() => validateConfig(invalidWorker), /coordinator-only/);
  const invalidJson = JSON.stringify(invalidWorker);
  await writeFile(s.file, invalidJson);
  await assert.rejects(s.update('c', c => { c.agents[0].dashboardPort = 54321; }), /coordinator-only/);
  assert.equal(await readFile(s.file, 'utf8'), invalidJson);
});
test('loopback receipt, port fallback, rejection, body bound and no retry', async t => {
  let received = 0;
  const a = await listen(undefined, async m => { received++; if (m.to !== 'a') throw new Error('recipient mismatch'); });
  const b = await listen(a.port, async () => {});
  t.after(async () => { await a.close(); await b.close(); });
  assert.notEqual(a.port, b.port);
  const m = { version: 1, kind: 'message', from: 'b', to: 'a', payload: { message: 'hello' } };
  await send(a.port, m); assert.equal(received, 1);
  await assert.rejects(send(a.port, { ...m, to: 'wrong' }), /recipient mismatch/);
  assert.equal(received, 2);
  await assert.rejects(send(a.port, { ...m, payload: { message: 'a'.repeat(BODY_LIMIT) } }));
  const res = await fetch(`http://127.0.0.1:${a.port}/intercom`, { method: 'POST', body: 'x'.repeat(BODY_LIMIT + 1) });
  assert.equal(res.status, 413);
  assert.equal(received, 2);
});
test('temporary write/sync/close failures preserve the original error and remove partial files', async t => {
  const base = await fixture(t);
  await base.initialize('c', 12345);
  const original = await readFile(base.file, 'utf8');
  for (const stage of ['writeFile', 'sync', 'close']) {
    const failure = new Error(`injected ${stage} failure`);
    class FaultStore extends ConfigStore {
      async openTemporary(file) {
        const handle = await super.openTemporary(file);
        return {
          writeFile: async data => { await handle.writeFile(data); if (stage === 'writeFile') throw failure; },
          sync: async () => { if (stage === 'sync') throw failure; await handle.sync(); },
          close: async () => { await handle.close(); throw stage === 'close' ? failure : new Error('secondary close failure'); },
        };
      }
    }
    const store = new FaultStore(base.root);
    for (const operation of [() => store.update('c', c => { c.multiplexer = 'none'; }), () => store.initialize('other', 12346)]) {
      await assert.rejects(operation(), error => error === failure);
      assert.equal(await readFile(base.file, 'utf8'), original);
      assert.deepEqual(await readdir(path.dirname(base.file)), ['config.json']);
    }
  }
});
test('lifecycle guard rejects queued mutation and rejects publication after temporary creation', async t => {
  const s = await fixture(t); await s.initialize('c', 12345);
  const original = await readFile(s.file, 'utf8');
  let valid = true, mutated = false, release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const blocker = s.update('c', async () => { entered(); await new Promise(resolve => { release = resolve; }); });
  await started;
  const guard = () => { if (!valid) throw new Error('lifecycle invalid'); };
  const queued = s.update('c', () => { mutated = true; }, guard);
  const rejected = assert.rejects(queued, /lifecycle invalid/);
  valid = false; release(); await blocker; await rejected;
  assert.equal(mutated, false);
  class InvalidateOnClose extends ConfigStore {
    async openTemporary(file) {
      const handle = await super.openTemporary(file);
      return { writeFile: data => handle.writeFile(data), sync: () => handle.sync(), close: async () => { await handle.close(); valid = false; } };
    }
  }
  const store = new InvalidateOnClose(s.root);
  valid = true;
  await assert.rejects(store.update('c', c => { c.multiplexer = 'none'; }, guard), /lifecycle invalid/);
  valid = true;
  await assert.rejects(store.initialize('other', 12346, guard), /lifecycle invalid/);
  assert.equal(await readFile(s.file, 'utf8'), original);
  assert.deepEqual(await readdir(path.dirname(s.file)), ['config.json']);
});
test('receipt deadline bounds a stalled receiver and never retries', async t => {
  let count = 0;
  const a = await listen(undefined, async () => { count++; await new Promise(() => {}); });
  t.after(() => a.close());
  await assert.rejects(send(a.port, { version: 1, kind: 'reload', from: 'c', to: 'w', payload: {} }, 30), /timeout/);
  assert.equal(count, 1);
});
