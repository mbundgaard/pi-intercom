import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, readdir, realpath, unlink, rename } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigStore } from '../dist/config.js';
import { Intercom } from '../dist/runtime.js';

async function fixture(t) {
  const base = await mkdtemp(path.join(tmpdir(), 'intercom-root-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'workspace'), child = path.join(root, 'nested', 'worker'), outside = path.join(base, 'workspace-other');
  await mkdir(child, { recursive: true }); await mkdir(outside);
  return { base, root, child, outside };
}
function runtime(t, cwd, options = {}, id = 'local') {
  const events = { stores: [], observers: [], listens: [], sends: [], launches: [] };
  const instance = new Intercom({ cwd, sessionId: () => id, busy: () => false, deliver() {}, setName: async () => {}, notify() {} }, {
    launch: async request => { events.launches.push(request); return {}; },
    store: root => { events.stores.push(root); return new ConfigStore(root); },
    observe: root => { events.observers.push(root); return { record() {}, close() {} }; },
    listen: async preferred => { events.listens.push(preferred); return { port: preferred ?? 32000, close: async () => {} }; },
    send: async (port, message) => { events.sends.push({ port, message }); },
    ...options,
  });
  t.after(() => instance.close());
  return { instance, events };
}
function noResources(events) {
  assert.deepEqual(events.stores, []); assert.deepEqual(events.observers, []);
  assert.deepEqual(events.listens, []); assert.deepEqual(events.sends, []);
}

test('valid and malformed ancestor configs are ignored; fresh sessions initialize only exact cwd', async t => {
  for (const malformed of [false, true]) {
    const f = await fixture(t), ancestor = new ConfigStore(f.root);
    await ancestor.initialize('ancestor', 12345);
    if (malformed) await writeFile(ancestor.file, '{malformed ancestor');
    const before = await readFile(ancestor.file, 'utf8');
    assert.equal(await ConfigStore.discover(f.child), undefined);
    const { instance, events } = runtime(t, f.child);
    await instance.start();
    assert.equal(instance.store.root, await realpath(f.child));
    assert.equal((await instance.state()).me.coordinator, true);
    assert.deepEqual(events.stores, [await realpath(f.child)]);
    assert.deepEqual(events.observers, [await realpath(f.child)]);
    assert.deepEqual(events.listens, [undefined]); assert.deepEqual(events.sends, []);
    assert.equal(await readFile(ancestor.file, 'utf8'), before);
    assert.deepEqual(await readdir(path.dirname(ancestor.file)), ['config.json']);
  }
});

test('local config is used; malformed local config rejects without ancestor fallback or startup resources', async t => {
  const f = await fixture(t); await new ConfigStore(f.root).initialize('ancestor', 12345);
  const local = new ConfigStore(f.child); await local.initialize('local', 23456);
  assert.equal((await ConfigStore.discover(f.child)).root, await realpath(f.child));
  const good = runtime(t, f.child); await good.instance.start();
  assert.deepEqual(good.events.listens, [23456]); await good.instance.close();
  await writeFile(local.file, '{malformed local');
  const bad = runtime(t, f.child); await assert.rejects(bad.instance.start()); noResources(bad.events);
  assert.equal(await readFile(local.file, 'utf8'), '{malformed local');
});

test('explicit parent roots reject before any config read, even with valid or malformed parent/local configs', async t => {
  const f = await fixture(t), parent = new ConfigStore(f.root);
  await parent.initialize('coordinator', 12345);
  await mkdir(path.join(f.child, '.pi-intercom')); await writeFile(path.join(f.child, '.pi-intercom/config.json'), '{nested unrelated');
  for (const malformed of [false, true]) {
    if (malformed) await writeFile(parent.file, '{malformed parent');
    const before = await readFile(parent.file, 'utf8');
    const read = ConfigStore.prototype.read;
    let configReads = 0;
    ConfigStore.prototype.read = async function () { configReads++; return read.call(this); };
    const { instance, events } = runtime(t, f.child, { workspaceRoot: f.root }, 'worker');
    try { await assert.rejects(instance.start(), /must equal.*parent configs are forbidden/); }
    finally { ConfigStore.prototype.read = read; }
    assert.equal(configReads, 0); noResources(events);
    assert.equal(await readFile(parent.file, 'utf8'), before);
    assert.equal(await readFile(path.join(f.child, '.pi-intercom/config.json'), 'utf8'), '{nested unrelated');
  }
});

test('explicit same-cwd worker uses only its local root config', async t => {
  const f = await fixture(t), local = new ConfigStore(f.child);
  await local.initialize('coordinator', 12345);
  await local.configure('coordinator', { sessionId: 'worker', name: 'Worker', description: 'Scoped work', port: 23456, projectDirectory: '.' });
  const { instance, events } = runtime(t, f.child, { workspaceRoot: f.child }, 'worker');
  await instance.start();
  assert.equal(instance.store.root, await realpath(f.child)); assert.equal((await instance.state()).me.name, 'Worker');
  assert.deepEqual(events.stores, [await realpath(f.child)]); assert.deepEqual(events.observers, [await realpath(f.child)]);
  assert.deepEqual(events.listens, [23456]); assert.equal(events.sends[0].port, 12345); assert.equal(events.sends[0].message.kind, 'status');
});

test('explicit root missing config, malformed config, sibling-prefix escape and file root reject before resources', async t => {
  const f = await fixture(t);
  await new ConfigStore(f.child).initialize('local', 23456); // Must not be a fallback.
  for (const root of [f.root, f.outside, path.join(f.base, 'missing')]) {
    const { instance, events } = runtime(t, root === f.root ? f.root : f.child, { workspaceRoot: root });
    await assert.rejects(instance.start()); noResources(events);
  }
  await assert.rejects(readFile(path.join(f.root, '.pi-intercom/config.json')), { code: 'ENOENT' });
  await mkdir(path.join(f.root, '.pi-intercom')); await writeFile(path.join(f.root, '.pi-intercom/config.json'), '{bad root');
  const bad = runtime(t, f.root, { workspaceRoot: f.root }); await assert.rejects(bad.instance.start()); noResources(bad.events);
  const file = path.join(f.base, 'not-directory'); await writeFile(file, 'x');
  await assert.rejects(ConfigStore.workspace(f.child, file), /not a directory/);
  await assert.rejects(ConfigStore.workspace(f.child, 'relative'), /absolute/);
});

test('escaping metadata junction/symlink rejects read/init/update and runtime before any outside writes', async t => {
  const f = await fixture(t), outside = new ConfigStore(f.outside); await outside.initialize('outside', 12345);
  const before = await readFile(outside.file, 'utf8');
  await symlink(path.dirname(outside.file), path.join(f.root, '.pi-intercom'), process.platform === 'win32' ? 'junction' : 'dir');
  const escaped = new ConfigStore(f.root);
  await assert.rejects(escaped.read(), /escapes session root/);
  await assert.rejects(escaped.initialize('new', 23456), /escapes session root/);
  await assert.rejects(escaped.update('outside', c => { c.agents[0].port = 23456; }), /escapes session root/);
  const bad = runtime(t, f.root); await assert.rejects(bad.instance.start(), /escapes session root/); noResources(bad.events);
  assert.equal(await readFile(outside.file, 'utf8'), before);
  assert.deepEqual(await readdir(path.dirname(outside.file)), ['config.json']);
});

test('dangling metadata link is not treated as a missing config eligible for initialization', async t => {
  const f = await fixture(t);
  await symlink(path.join(f.outside, 'missing'), path.join(f.root, '.pi-intercom'), process.platform === 'win32' ? 'junction' : 'dir');
  const bad = runtime(t, f.root); await assert.rejects(bad.instance.start(), /cannot be resolved safely/); noResources(bad.events);
  await assert.rejects(new ConfigStore(f.root).initialize('local', 23456), /cannot be resolved safely/);
  assert.deepEqual(await readdir(f.outside), []);
});

test('explicit cwd symlink/junction outside root rejects; canonical root aliases and internal metadata links work', async t => {
  const f = await fixture(t); await new ConfigStore(f.root).initialize('coordinator', 12345);
  const escape = path.join(f.root, 'escape');
  await symlink(f.outside, escape, process.platform === 'win32' ? 'junction' : 'dir');
  const bad = runtime(t, escape, { workspaceRoot: f.root }); await assert.rejects(bad.instance.start(), /must equal/); noResources(bad.events);
  const alias = path.join(f.base, 'alias'); await symlink(f.root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await ConfigStore.workspace(f.root, alias)).root, await realpath(f.root));
  const internal = path.join(f.outside, 'state'); await mkdir(internal);
  const bytes = await readFile(path.join(f.root, '.pi-intercom/config.json'));
  await writeFile(path.join(internal, 'config.json'), bytes);
  await symlink(internal, path.join(f.outside, '.pi-intercom'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await new ConfigStore(f.outside).read()).agents[0].sessionId, 'coordinator');
});

test('external or dangling config-file symlinks fail closed without touching target', async t => {
  const f = await fixture(t); await mkdir(path.join(f.root, '.pi-intercom'));
  const target = path.join(f.outside, 'external.json'); await writeFile(target, '{private external');
  const file = path.join(f.root, '.pi-intercom/config.json');
  try { await symlink(target, file, 'file'); }
  catch (error) { if (process.platform === 'win32' && error.code === 'EPERM') { t.skip('file symlinks require Windows privilege; directory junction escapes tested separately'); return; } throw error; }
  const store = new ConfigStore(f.root);
  for (const operation of [() => store.read(), () => store.initialize('local', 23456), () => store.update('local', () => {})]) await assert.rejects(operation(), /escapes session root/);
  assert.equal(await readFile(target, 'utf8'), '{private external');
  await unlink(target);
  await assert.rejects(ConfigStore.discover(f.root), /cannot be resolved safely/);
});

test('validated root redirected between operations cannot adopt another config through a junction or symlink', async t => {
  const f = await fixture(t), store = new ConfigStore(f.root), external = new ConfigStore(f.outside);
  await store.initialize('local', 12345); await external.initialize('external', 23456);
  const original = await readFile(external.file, 'utf8');
  const { instance } = runtime(t, f.root); await instance.start();
  const saved = path.join(f.base, 'saved-workspace'); await rename(f.root, saved);
  await symlink(f.outside, f.root, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(store.read(), /canonical location changed/);
  await assert.rejects(store.update('external', config => { config.agents[0].port = 34567; }), /canonical location changed/);
  await assert.rejects(store.initialize('replacement', 34567), /canonical location changed/);
  await assert.rejects(instance.state(), /canonical location changed/);
  assert.equal(await readFile(external.file, 'utf8'), original);
  assert.deepEqual(await readdir(path.dirname(external.file)), ['config.json']);
});

test('default missing-config startup pins root before an asynchronous listener can observe a redirect', async t => {
  const f = await fixture(t), external = new ConfigStore(f.outside); await external.initialize('external', 23456);
  const original = await readFile(external.file, 'utf8');
  let release, entered, closed = false;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const { instance } = runtime(t, f.root, { listen: async () => {
    entered(); await gate; return { port: 34567, close: async () => { closed = true; } };
  } });
  const pending = instance.start(); const rejected = assert.rejects(pending, /canonical location changed/);
  await started;
  await rename(f.root, path.join(f.base, 'saved-startup-root'));
  await symlink(f.outside, f.root, process.platform === 'win32' ? 'junction' : 'dir');
  release(); await rejected;
  assert.equal(closed, true); assert.equal(await readFile(external.file, 'utf8'), original);
  assert.deepEqual(await readdir(path.dirname(external.file)), ['config.json']);
});

test('cleanup after stable root or metadata redirect preserves the original error and never unlinks outside files', async t => {
  for (const moveRoot of [false, true]) {
    const f = await fixture(t), external = new ConfigStore(f.outside);
    await external.initialize('external', 23456);
    const original = await readFile(external.file, 'utf8');
    const failure = new Error('injected close failure after redirect');
    let redirect = false, outsideTemp;
    class RedirectingStore extends ConfigStore {
      async openTemporary(file) {
        const handle = await super.openTemporary(file);
        return {
          writeFile: (...args) => handle.writeFile(...args), sync: () => handle.sync(),
          close: async () => {
            await handle.close();
            if (!redirect) return;
            redirect = false;
            const from = moveRoot ? f.root : path.join(f.root, '.pi-intercom');
            const to = moveRoot ? f.outside : path.join(f.outside, '.pi-intercom');
            await rename(from, path.join(f.base, 'saved-before-redirect'));
            await symlink(to, from, process.platform === 'win32' ? 'junction' : 'dir');
            outsideTemp = path.join(f.outside, '.pi-intercom', path.basename(file));
            await writeFile(outsideTemp, 'outside collision must survive cleanup');
            throw failure;
          },
        };
      }
    }
    const store = new RedirectingStore(f.root); await store.initialize('local', 12345);
    redirect = true;
    await assert.rejects(store.update('local', config => { config.agents[0].port = 34567; }), error => error === failure);
    assert.equal(await readFile(outsideTemp, 'utf8'), 'outside collision must survive cleanup');
    assert.equal(await readFile(external.file, 'utf8'), original);
  }
});

test('custom store cannot redirect validated root; create/resume only launch same-cwd workers', async t => {
  const f = await fixture(t); await new ConfigStore(f.root).initialize('local', 12345);
  const bad = runtime(t, f.root, { store: () => new ConfigStore(f.outside) });
  await assert.rejects(bad.instance.start(), /retain validated session root/);
  assert.deepEqual(bad.events.observers, []); assert.deepEqual(bad.events.listens, []);
  let probes = 0;
  const good = runtime(t, f.root, { probe: async () => { probes++; return { state: 'disconnected', checkedAt: null, reason: 'refused', sessionId: 'w' }; } });
  await good.instance.start();
  await assert.rejects(good.instance.tool('create_worker', { projectDirectory: 'nested/worker' }), /must equal.*forbidden parent config/);
  assert.equal(good.events.launches.length, 0);
  await good.instance.tool('configure_worker', { sessionId: 'w', name: 'Worker', description: 'Work', port: 23456, projectDirectory: 'nested/worker' });
  await good.instance.tool('stop_reminders', {});
  const before = await good.instance.store.read();
  await assert.rejects(good.instance.tool('resume_worker', { to: 'Worker', confirmClosed: true }), /must equal.*forbidden parent config/);
  assert.equal(probes, 0); assert.equal(good.events.launches.length, 0);
  assert.equal(good.instance.resumeFences.size, 0); assert.equal(good.instance.reminders.cancel, undefined);
  assert.deepEqual(await good.instance.store.read(), before);
  assert.equal((await good.instance.tool('list', {})).agents.find(a => a.sessionId === 'w').projectDirectory, 'nested/worker');
  await good.instance.tool('create_worker', { projectDirectory: '.' });
  assert.equal(good.events.launches[0].workspaceRoot, await realpath(f.root));
  assert.equal(good.events.launches[0].cwd, await realpath(f.root));
  await good.instance.tool('configure_worker', { sessionId: 'w', name: 'Worker', description: 'Work', port: 23456, projectDirectory: '.' });
  await good.instance.tool('resume_worker', { to: 'Worker', confirmClosed: true });
  assert.equal(probes, 1);
  assert.equal(good.events.launches[1].workspaceRoot, await realpath(f.root));
  assert.equal(good.events.launches[1].cwd, await realpath(f.root));
});
