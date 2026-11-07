import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, writeFile, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { ensureCoreMonitorPane, closeCoreMonitorPane } from '../dist/core-monitor.js';

const clone = structuredClone;
const scopeLabel = 'pi-intercom.monitor.scope';
const tokenLabel = 'pi-intercom.monitor.token';
const layout = () => ({
  metadata: { preserved: ['future', 7] },
  spaces: [{ id: 'sp1', name: 'Project', folder: '/work', extra: 42, tabs: [
    { id: 'tb1', name: 'Coordinator', extra: { retained: true }, root: {
      id: 'tb1', type: 'row', font: 'test-font', background: '#ffffff', children: [
        { id: 'p1', type: 'block', content: { terminal: 't1' }, custom: 'kept' },
        { id: 's1', type: 'column', size: { weight: 2 }, children: [
          { id: 'p2', type: 'block', content: { terminal: 't2' } },
          { id: 'pmod', type: 'block', content: { mod: 'markdown', props: { terminal: 't1', filename: 'file' } } },
        ] },
      ],
    } },
    { id: 'tb2', name: 'Other', root: { id: 'tb2', type: 'row', children: [{ id: 'p3', type: 'block', content: { terminal: 't3' } }] } },
  ] }],
});
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'core-monitor-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = path.join(root, 'monitor.mjs');
  await writeFile(script, '// mocked: never executed\n');
  const sessionId = 'coordinator-session';
  const key = createHash('sha256').update(sessionId).digest('hex').slice(0, 24);
  const file = path.join(root, '.pi-intercom', `monitor-${key}.json`);
  const f = {
    root, script, file, value: layout(), version: 5, core: 'permanent-core-a', coreVersion: '0.1.18', calls: [], monitor: undefined,
    caller: { address: 't1', state: 'live', created_ms: 101, labels: { 'herdr.space': 'sp1', 'herdr.tab': 'tb1' } },
    before: undefined, after: undefined, extraInventory: [],
    async ledger() { return JSON.parse(await readFile(file, 'utf8')); },
    mutations() { return f.calls.filter(c => ['terminal.run', 'doc.set', 'terminal.kill', 'terminal.label', 'terminal.keep'].includes(c.method)); },
    async putLedger(value) { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(value)); },
  };
  f.call = async (method, params) => {
    f.calls.push({ method, params: clone(params) });
    await f.before?.(method, params);
    let result;
    switch (method) {
      case 'server.status': result = { core: { id: f.core, name: 'host' }, version: f.coreVersion, pid: 404 }; break;
      case 'terminal.get':
        if (params.terminal === 't1') result = f.caller;
        else if (params.terminal === f.monitor?.address) result = f.monitor;
        else throw new Error('unknown terminal');
        break;
      case 'terminal.list':
        assert.deepEqual(Object.keys(params).sort(), params.labels ? ['all', 'labels'] : ['all']);
        assert.equal(params.all, params.labels ? false : true);
        result = { terminals: [...(f.monitor ? [f.monitor] : []), ...f.extraInventory].filter(r => params.all || r?.state !== 'finished'), hidden_finished: 0, machines: [] }; break;
      case 'doc.get': assert.deepEqual(params, { name: 'herdr-app' }); result = { version: f.version, value: f.value }; break;
      case 'terminal.run': {
        // Actual filesystem persistence is checked *inside* the mocked mutation.
        const pending = await f.ledger();
        assert.equal(pending.stage, 'run_pending');
        assert.equal(pending.token, params.labels[tokenLabel]);
        assert.deepEqual(pending.argv, params.argv);
        assert.equal(await readFile(`${file}.lock`, 'utf8'), '');
        f.monitor = {
          address: 't9', state: 'live', created_ms: 777, argv: clone(params.argv), cwd: params.cwd,
          labels: clone(params.labels), parent: params.parent, keep: false, notify: false, die_with_parent: false, template: null,
        };
        result = f.monitor; break;
      }
      case 'terminal.kill':
        assert.equal((await f.ledger()).stage, 'close_pending');
        assert.equal(params.terminal, f.monitor.address);
        f.monitor.state = 'finished'; f.monitor.foreground = null;
        result = { stopped: true }; break;
      case 'doc.set':
        assert.ok(['attach_pending', 'close_pending'].includes((await f.ledger()).stage));
        assert.equal(params.name, 'herdr-app');
        assert.equal(params.version, f.version);
        f.value = clone(params.value); result = { version: ++f.version }; break;
      default: throw new Error(`Unexpected API call: ${method}`);
    }
    result = clone(result);
    await f.after?.(method, params, result);
    return result;
  };
  f.options = { root, script, sessionId, node: process.execPath, platform: 'linux', placement: 'coordinator-tab', env: { HC_TERMINAL_ID: 't1' }, call: f.call };
  return f;
}

test('top quarter uses one CAS, retains all old content and IDs except root wrapper, and never focuses or auto-adopts', async t => {
  const f = await fixture(t), before = clone(f.value);
  const result = await ensureCoreMonitorPane(f.options);
  const owner = await f.ledger();
  assert.equal(owner.stage, 'submitted'); assert.equal(owner.core, f.core);
  const root = f.value.spaces[0].tabs[0].root;
  assert.equal(root.id, 'tb1'); assert.equal(root.type, 'column');
  assert.deepEqual(root.children[0], { id: result.pane, type: 'block', title: 'Intercom monitor', content: { terminal: 't9' }, size: { weight: 1 } });
  assert.deepEqual(root.children[1], { ...before.spaces[0].tabs[0].root, id: owner.lower, size: { weight: 3 } });
  const expected = clone(before); expected.spaces[0].tabs[0].root = root;
  assert.deepEqual(f.value, expected);
  assert.match(owner.pane, /^p[0-9a-f]{32}$/); assert.match(owner.lower, /^s[0-9a-f]{32}$/);
  const run = f.calls.find(c => c.method === 'terminal.run').params;
  // Windows temp paths may use an 8.3 alias; launch must use the canonical root.
  const canonicalRoot = await realpath(f.root);
  assert.deepEqual(run, { argv: [process.execPath, f.script, '--root', canonicalRoot], cwd: canonicalRoot, caller: 't1', parent: 't1', outlive_parent: true,
    no_notify: true, keep: false, rm: false, wait: false, labels: { [scopeLabel]: owner.scope, [tokenLabel]: owner.token } });
  assert.deepEqual(f.mutations().map(c => c.method), ['terminal.run', 'doc.set']);
  assert.equal(f.calls.find(c => c.method === 'doc.set').params.version, 5);
  assert.match(result.outcome, /remote Windows rendering not verified/);
  assert.deepEqual((await readdir(path.dirname(f.file))).filter(x => x.endsWith('.lock') || x.endsWith('.tmp')), []);
});

test('new tab appends to caller space without changing any existing fields or private focus', async t => {
  const f = await fixture(t), before = clone(f.value);
  const result = await ensureCoreMonitorPane({ ...f.options, placement: 'new-tab' });
  const tab = f.value.spaces[0].tabs.at(-1), owner = await f.ledger();
  assert.match(tab.id, /^tb[0-9a-f]{32}$/);
  assert.notEqual(tab.id, 'tb1'); assert.equal(tab.id, owner.tab);
  assert.equal(tab.name, 'Intercom monitor'); assert.equal(tab.root.id, tab.id);
  assert.equal(tab.root.children[0].id, result.pane);
  const expected = clone(before); expected.spaces[0].tabs.push(tab);
  assert.deepEqual(f.value, expected);
  assert.equal(JSON.stringify(f.value).includes('focused'), false);
});

test('verified submitted monitor is reused read-only, different placement refuses close-first', async t => {
  const f = await fixture(t);
  const opened = await ensureCoreMonitorPane(f.options);
  f.calls.length = 0;
  const reused = await ensureCoreMonitorPane(f.options);
  assert.equal(reused.pane, opened.pane); assert.match(reused.outcome, /existing owned/);
  assert.deepEqual(f.mutations(), []);
  await assert.rejects(ensureCoreMonitorPane({ ...f.options, placement: 'new-tab' }), /different placement; close it first/);
  assert.deepEqual(f.mutations(), []);
});

test('legacy and malformed records never become new-core ownership', async t => {
  for (const saved of [{ version: 1, stage: 'submitted', pane: 'p9' }, { version: 2, backend: 'wrong' }, null, {}]) {
    const f = await fixture(t); await f.putLedger(saved);
    await assert.rejects(ensureCoreMonitorPane(f.options), /legacy\/unknown ownership/);
    assert.deepEqual(f.mutations(), []);
  }
});

test('completed legacy ownership is retired once without adoption or terminal cleanup', async t => {
  const f = await fixture(t);
  const old = { version: 1, sessionId: f.options.sessionId, workspace: 'w3', caller: 'w3:p1', stage: 'submitted', pane: 'w3:p8' };
  await f.putLedger(old);
  await ensureCoreMonitorPane(f.options);
  const files = (await readdir(path.dirname(f.file))).filter(n => n.includes('.retired-'));
  assert.equal(files.length, 1);
  assert.deepEqual(JSON.parse(await readFile(path.join(path.dirname(f.file), files[0]), 'utf8')), old);
  assert.equal((await f.ledger()).version, 2);
  assert.deepEqual(f.mutations().map(c => c.method), ['terminal.run', 'doc.set']);
  f.calls.length = 0; await ensureCoreMonitorPane(f.options);
  assert.deepEqual(f.mutations(), []);
  assert.equal((await readdir(path.dirname(f.file))).filter(n => n.includes('.retired-')).length, 1);
});

test('legacy retirement requires a usable core and does not retire uncertain legacy intents', async t => {
  for (const mode of ['unreachable', 'pending', 'wrong-session']) {
    const f = await fixture(t);
    const old = { version: 1, sessionId: f.options.sessionId, workspace: 'w3', caller: 'w3:p1', stage: 'submitted', pane: 'w3:p8' };
    if (mode === 'pending') old.stage = 'run_pending';
    if (mode === 'wrong-session') old.sessionId = 'other';
    await f.putLedger(old);
    if (mode === 'unreachable') f.before = () => { throw new Error('connection refused'); };
    await assert.rejects(ensureCoreMonitorPane(f.options), error => !error.message.includes('Terminal unknown may remain'));
    assert.deepEqual(await f.ledger(), old);
    assert.deepEqual(f.mutations(), []);
  }
});

test('missing or finished monitor with no layout reference is retired and replaced once', async t => {
  for (const mode of ['missing', 'finished']) {
    const f = await fixture(t); await ensureCoreMonitorPane(f.options);
    if (mode === 'missing') f.monitor = undefined;
    else f.monitor.state = 'finished';
    f.value = layout(); f.calls.length = 0;
    await ensureCoreMonitorPane(f.options);
    assert.equal((await f.ledger()).stage, 'submitted');
    assert.deepEqual(f.mutations().map(c => c.method), ['terminal.run', 'doc.set']);
    assert.equal((await readdir(path.dirname(f.file))).filter(n => n.includes('.retired-')).length, 1);
  }
});

test('missing live inventory is not absence proof on query failure or when an unlabeled live terminal remains', async t => {
  for (const mode of ['unreachable', 'live', 'incomplete']) {
    const f = await fixture(t); await ensureCoreMonitorPane(f.options);
    const saved = await f.ledger();
    if (mode !== 'live') f.monitor = undefined;
    else { f.extraInventory = [{ ...f.monitor, labels: {} }]; f.monitor = undefined; }
    f.value = layout(); f.calls.length = 0;
    f.after = (method, params, result) => {
      if (method === 'terminal.list' && params.labels) result.terminals = [];
      if (mode === 'unreachable' && method === 'terminal.list' && !params.labels) throw new Error('connection lost');
      if (mode === 'incomplete' && method === 'terminal.list' && !params.labels) result.hidden_finished = 1;
    };
    await assert.rejects(ensureCoreMonitorPane(f.options));
    assert.deepEqual(await f.ledger(), saved);
    assert.deepEqual(f.mutations(), []);
  }
});

test('different cores with colliding session/terminal/layout IDs cannot share ownership', async t => {
  const f = await fixture(t); await ensureCoreMonitorPane(f.options);
  f.calls.length = 0; f.core = 'different-core';
  await assert.rejects(ensureCoreMonitorPane(f.options), /scope or core identity differs/);
  assert.deepEqual(f.mutations(), []);
});

test('missing/old server identity and unsupported inputs fail before mutation', async t => {
  for (const version of ['0.1.17', '0.0.99', 'garbage']) {
    const f = await fixture(t); f.coreVersion = version;
    await assert.rejects(ensureCoreMonitorPane(f.options), /0.1.18/); assert.deepEqual(f.mutations(), []);
  }
  const f = await fixture(t); f.core = '';
  await assert.rejects(ensureCoreMonitorPane(f.options), /permanent server identity/);
  for (const change of [{ env: {} }, { env: { HC_TERMINAL_ID: 'remote/t1' } }, { placement: undefined }, { placement: 'focused' }, { script: 'relative.mjs' }, { node: '/bin/sh' }, { platform: 'darwin' }]) {
    f.calls.length = 0;
    await assert.rejects(ensureCoreMonitorPane({ ...f.options, ...change })); assert.deepEqual(f.calls, []);
  }
});

test('unknown layout schemas, floats, duplicate terminals and node IDs fail before effects', async t => {
  const mutations = [
    v => v.spaces[0].tabs[0].root.type = 'stack',
    v => v.spaces[0].tabs[0].root.floating = [{ id: 'float', content: { terminal: 't1' } }],
    v => v.spaces[0].tabs[0].root.children.push({ id: 'duplicate', type: 'block', content: { terminal: 't1' } }),
    v => v.spaces[0].tabs[0].root.children.push({ id: 'p1', type: 'block', content: { terminal: 't4' } }),
    v => v.spaces[0].tabs[0].root.children[0].content = { agent: 'focused' },
    v => v.spaces[0].tabs[0].root.children[0].content = { terminal: 't1', mod: 'unknown' },
    v => v.spaces[0].tabs[0].root.children[0].content.terminal = 'remote/t1',
    v => v.spaces[0].tabs[0].root.id = 'wrong',
    v => v.spaces[0].machine = 'other-machine',
    v => v.spaces[0].tabs[0].root.min = 500,
    v => v.spaces[0].tabs[0].root.hidden = true,
    v => v.spaces[0].tabs[0].root.children[0].hidden = 'invalid',
    v => v.spaces[0].tabs[0].root.children[0].size = { relative: 0.25 },
    v => v.spaces[0].tabs[0].root.children[0].size = { weight: -1 },
    v => v.spaces[0].tabs[0].root.children[0].max = 'invalid',
    v => v.spaces[0].id = 'remote/sp1',
  ];
  for (const change of mutations) {
    const f = await fixture(t); change(f.value);
    await assert.rejects(ensureCoreMonitorPane(f.options)); assert.deepEqual(f.mutations(), []);
  }
});

test('caller not live, wrong labels or ambiguous mapping fail before effects', async t => {
  for (const change of [f => f.caller.state = 'finished', f => f.caller.created_ms = 0, f => f.caller.labels['herdr.tab'] = 'tb2', f => f.caller.address = 't99']) {
    const f = await fixture(t); change(f);
    await assert.rejects(ensureCoreMonitorPane(f.options)); assert.deepEqual(f.mutations(), []);
  }
});

test('unowned monitor marker or scope inventory is not adoption permission', async t => {
  for (const mode of ['marker', 'inventory']) {
    const f = await fixture(t);
    if (mode === 'marker') f.value.spaces[0].tabs[1].name = 'Intercom monitor';
    else f.before = (method, params) => { if (method === 'terminal.list') f.extraInventory = [{ address: 't8', labels: params.labels }]; };
    await assert.rejects(ensureCoreMonitorPane(f.options), /unowned monitor/); assert.deepEqual(f.mutations(), []);
  }
});

test('lost terminal.run response is persistently fenced, even when a terminal was created', async t => {
  const f = await fixture(t);
  f.after = method => { if (method === 'terminal.run') throw new Error('response lost'); };
  await assert.rejects(ensureCoreMonitorPane(f.options), /response lost/);
  assert.equal((await f.ledger()).stage, 'run_pending');
  f.after = undefined; f.calls.length = 0;
  await assert.rejects(ensureCoreMonitorPane(f.options), /partial launch/); assert.deepEqual(f.mutations(), []);
});

test('CAS conflict, malformed acknowledgment and lost success are never retried', async t => {
  for (const mode of ['conflict', 'malformed', 'lost']) {
    const f = await fixture(t);
    if (mode === 'conflict') f.before = method => { if (method === 'doc.set') throw new Error('conflict'); };
    else f.after = (method, _params, result) => { if (method === 'doc.set') { if (mode === 'lost') throw new Error('lost acknowledgment'); result.version = null; } };
    await assert.rejects(ensureCoreMonitorPane(f.options));
    assert.equal((await f.ledger()).stage, 'attach_pending');
    assert.equal(f.calls.filter(c => c.method === 'doc.set').length, 1);
    f.before = f.after = undefined; f.calls.length = 0;
    await assert.rejects(ensureCoreMonitorPane(f.options), /partial launch/); assert.deepEqual(f.mutations(), []);
  }
});

test('fresh document preserves concurrent unrelated changes rather than writing a stale snapshot', async t => {
  const f = await fixture(t);
  f.after = method => { if (method === 'terminal.run') { f.value.metadata.concurrent = 'keep me'; f.value.spaces[0].tabs[1].name = 'Renamed elsewhere'; f.version++; } };
  await ensureCoreMonitorPane(f.options);
  assert.equal(f.value.metadata.concurrent, 'keep me');
  assert.equal(f.value.spaces[0].tabs[1].name, 'Renamed elsewhere');
  assert.equal(f.calls.find(c => c.method === 'doc.set').params.version, 6);
});

test('caller moving during creation or immediately before run is fenced without layout write', async t => {
  for (const moment of ['before', 'after']) {
    const f = await fixture(t); let documents = 0;
    f.after = method => {
      if ((moment === 'after' && method === 'terminal.run') || (moment === 'before' && method === 'doc.get' && ++documents === 1)) {
        f.caller.created_ms++; // A reused/moved caller must never inherit this operation.
      }
    };
    await assert.rejects(ensureCoreMonitorPane(f.options), /caller moved or identity changed/);
    assert.equal(f.calls.filter(c => c.method === 'doc.set').length, 0);
    assert.equal(f.calls.filter(c => c.method === 'terminal.run').length, moment === 'before' ? 0 : 1);
  }
});

test('fresh token, start argv, created time, parent, flags and adoption labels must all match', async t => {
  const changes = [
    m => m.labels[tokenLabel] = 'forged', m => m.created_ms++, m => m.argv[0] = '/bin/sh',
    m => m.cwd = '/elsewhere', m => m.keep = true, m => m.notify = true,
    m => m.die_with_parent = true, m => m.parent = 't2', m => m.template = 'agent',
    m => m.labels['herdr.space'] = 'sp1', m => m.state = 'finished',
  ];
  for (const change of changes) {
    const f = await fixture(t);
    f.after = method => { if (method === 'terminal.run') change(f.monitor); };
    await assert.rejects(ensureCoreMonitorPane(f.options), /identity|ownership/);
    assert.equal(f.calls.filter(c => c.method === 'doc.set').length, 0);
  }
});

test('core switch during creation refuses to attach and leaves intent for inspection', async t => {
  const f = await fixture(t);
  f.after = method => { if (method === 'terminal.run') f.core = 'switched-core'; };
  await assert.rejects(ensureCoreMonitorPane(f.options), /core identity changed/);
  assert.equal((await f.ledger()).stage, 'attach_pending');
  assert.equal(f.calls.filter(c => c.method === 'doc.set').length, 0);
});

test('lock excludes concurrent opens and is released without erasing pending ownership', async t => {
  const f = await fixture(t);
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const waiting = new Promise(resolve => { entered = resolve; });
  f.before = async method => { if (method === 'terminal.run') { entered(); await gate; } };
  const first = ensureCoreMonitorPane(f.options);
  await waiting;
  await assert.rejects(ensureCoreMonitorPane(f.options), /monitor locked/);
  release(); await first;
  assert.equal(f.calls.filter(c => c.method === 'terminal.run').length, 1);
  assert.equal((await f.ledger()).stage, 'submitted');
});

test('missing script, oversized document and invalidation cannot cause a spawn', async t => {
  const f = await fixture(t);
  await assert.rejects(ensureCoreMonitorPane({ ...f.options, script: path.join(f.root, 'missing.mjs') }));
  assert.deepEqual(f.mutations(), []);
  f.value.metadata.large = 'a'.repeat(1000000);
  await assert.rejects(ensureCoreMonitorPane(f.options), /layout too large/); assert.deepEqual(f.mutations(), []);
  f.calls.length = 0;
  await assert.rejects(ensureCoreMonitorPane({ ...f.options, assertCurrent() { throw new Error('stale owner'); } }), /stale owner/);
  assert.deepEqual(f.calls, []);
});

test('reuse refuses moved monitor geometry or changed identity, never silently restores it', async t => {
  for (const mode of ['geometry', 'identity', 'missing']) {
    const f = await fixture(t); await ensureCoreMonitorPane(f.options); f.calls.length = 0;
    if (mode === 'geometry') f.value.spaces[0].tabs[0].root.children.reverse();
    else if (mode === 'identity') f.monitor.created_ms++;
    else f.monitor = undefined;
    await assert.rejects(ensureCoreMonitorPane(f.options)); assert.deepEqual(f.mutations(), []);
  }
});

test('owned monitor closes once, restores coordinator layout and permits a subsequent open', async t => {
  const f = await fixture(t), original = clone(f.value);
  await ensureCoreMonitorPane(f.options); f.calls.length = 0;
  const result = await closeCoreMonitorPane(f.options);
  assert.match(result.outcome, /finished and pane absence/);
  assert.deepEqual(f.value, original);
  assert.equal((await f.ledger()).stage, 'closed');
  assert.deepEqual(f.mutations().map(c => c.method), ['terminal.kill', 'doc.set']);
  f.calls.length = 0;
  await assert.rejects(closeCoreMonitorPane(f.options), /partial launch/);
  assert.deepEqual(f.mutations(), []);
  await ensureCoreMonitorPane(f.options);
  assert.equal((await f.ledger()).stage, 'submitted');
});

test('close rejects every live descendant, including unlabeled, outliving and deep children through finished records', async t => {
  for (const depth of [1, 2, 8]) {
    const f = await fixture(t); await ensureCoreMonitorPane(f.options); f.calls.length = 0;
    let parent = f.monitor.address;
    for (let i = 0; i < depth; i++) {
      const address = `t${100 + i}`;
      f.extraInventory.push({ address, parent, state: i === depth - 1 ? 'live' : 'finished', labels: {}, die_with_parent: false });
      parent = address;
    }
    const saved = await readFile(f.file, 'utf8');
    await assert.rejects(closeCoreMonitorPane(f.options), /live monitor descendant exists/);
    assert.deepEqual(f.mutations(), []);
    assert.equal(await readFile(f.file, 'utf8'), saved);
  }
});

test('unrelated live terminals and finished descendants do not masquerade as live children', async t => {
  const f = await fixture(t); await ensureCoreMonitorPane(f.options); f.calls.length = 0;
  f.extraInventory = [
    { address: 't10', parent: 't9', state: 'finished' },
    { address: 't11', parent: 't10', state: 'finished' },
    { address: 't12', parent: 't1', state: 'live' },
    { address: 'remote/t13', parent: 'remote/t1', state: 'live' },
  ];
  await closeCoreMonitorPane(f.options);
  assert.equal(f.extraInventory.filter(r => r.state === 'live').length, 2);
  assert.equal(f.calls.filter(c => c.method === 'terminal.kill').length, 1);
});

test('child registered between inventory checks fences close before kill', async t => {
  const f = await fixture(t); await ensureCoreMonitorPane(f.options); f.calls.length = 0;
  f.after = method => {
    if (method === 'terminal.list') f.extraInventory.push({ address: 't10', parent: 't9', state: 'live', die_with_parent: true });
  };
  await assert.rejects(closeCoreMonitorPane(f.options), /inventory changed/);
  assert.ok(f.extraInventory.length >= 1);
  assert.equal((await f.ledger()).stage, 'close_pending');
  assert.deepEqual(f.mutations(), []);
});

test('malformed or duplicate full inventory cannot be interpreted as child-free', async t => {
  for (const record of [null, {}, { address: 't10', state: 'unknown' }, { address: 't10', state: 'live', parent: 7 }, { address: 't9', state: 'live' }]) {
    const f = await fixture(t); await ensureCoreMonitorPane(f.options); f.calls.length = 0;
    f.extraInventory = [record];
    await assert.rejects(closeCoreMonitorPane(f.options), /ambiguous descendant inventory/);
    assert.deepEqual(f.mutations(), []);
  }
});

test('close preserves ledger and document on ownership, caller, geometry, core or invalidation failures', async t => {
  const changes = [
    f => f.monitor.labels[tokenLabel] = 'wrong', f => f.monitor.created_ms++, f => f.monitor.keep = true,
    f => f.monitor.argv[0] = '/bin/sh', f => f.monitor.parent = 't2', f => f.monitor.state = 'finished',
    f => f.caller.created_ms++, f => f.caller.labels['herdr.tab'] = 'tb2',
    f => f.value.spaces[0].tabs[0].root.children.reverse(), f => f.core = 'other',
    f => f.after = method => { if (method === 'terminal.list') f.core = 'switched'; },
    f => f.options.assertCurrent = () => { throw new Error('stale caller'); },
  ];
  for (const change of changes) {
    const f = await fixture(t); await ensureCoreMonitorPane(f.options); f.calls.length = 0; change(f);
    const saved = await readFile(f.file, 'utf8'), before = clone(f.value);
    await assert.rejects(closeCoreMonitorPane(f.options));
    assert.equal(await readFile(f.file, 'utf8'), saved); assert.deepEqual(f.value, before);
    assert.deepEqual(f.mutations(), []);
  }
});

test('close never promotes old/pending ledgers to new ownership, and uses the same open lock', async t => {
  for (const mode of ['legacy', 'run_pending', 'attach_pending', 'close_pending', 'closed', 'locked']) {
    const f = await fixture(t); await ensureCoreMonitorPane(f.options); f.calls.length = 0;
    const owner = await f.ledger();
    if (mode === 'locked') await writeFile(`${f.file}.lock`, 'other owner');
    else if (mode === 'legacy') await f.putLedger({ version: 1, pane: owner.pane });
    else await f.putLedger({ ...owner, stage: mode });
    const saved = await readFile(f.file, 'utf8');
    await assert.rejects(closeCoreMonitorPane(f.options));
    assert.deepEqual(f.mutations(), []); assert.equal(await readFile(f.file, 'utf8'), saved);
    if (mode === 'locked') assert.equal(await readFile(`${f.file}.lock`, 'utf8'), 'other owner');
  }
});

test('separate-tab close preflight preserves coordinator geometry and every sibling tab', async t => {
  const f = await fixture(t);
  await ensureCoreMonitorPane({ ...f.options, placement: 'new-tab' }); f.calls.length = 0;
  const before = clone(f.value); before.spaces[0].tabs.pop();
  // Closing is tied to saved ownership, not today's preferred placement.
  await closeCoreMonitorPane({ ...f.options, placement: undefined });
  assert.deepEqual(f.value, before); assert.equal((await f.ledger()).stage, 'closed');
  assert.deepEqual(f.mutations().map(c => c.method), ['terminal.kill', 'doc.set']);
});

test('Windows close uses the same core identity contract without Linux signals', async t => {
  const f = await fixture(t); await ensureCoreMonitorPane(f.options); f.calls.length = 0;
  await closeCoreMonitorPane({ ...f.options, platform: 'win32' });
  assert.deepEqual(f.mutations().map(c => c.method), ['terminal.kill', 'doc.set']);
});

test('lost kill response and failed removal retain a pending fence and never replay', async t => {
  for (const phase of ['terminal.kill', 'doc.set']) {
    const f = await fixture(t); await ensureCoreMonitorPane(f.options); f.calls.length = 0;
    f.after = method => { if (method === phase) throw new Error('response lost'); };
    await assert.rejects(closeCoreMonitorPane(f.options));
    assert.equal((await f.ledger()).stage, 'close_pending');
    assert.equal(f.calls.filter(c => c.method === 'terminal.kill').length, 1);
    f.after = undefined; f.calls.length = 0;
    await assert.rejects(closeCoreMonitorPane(f.options), /partial launch/);
    await assert.rejects(ensureCoreMonitorPane(f.options), /partial launch/);
    assert.deepEqual(f.mutations(), []);
  }
});

test('closing separate-tab monitor preserves another pane subsequently added to that tab', async t => {
  const f = await fixture(t); await ensureCoreMonitorPane({ ...f.options, placement: 'new-tab' });
  const tab = f.value.spaces[0].tabs.at(-1), sibling = { id: 'pother', type: 'block', content: { terminal: 't99' } };
  tab.root.children.push(sibling); f.calls.length = 0;
  await closeCoreMonitorPane(f.options);
  assert.deepEqual(f.value.spaces[0].tabs.at(-1).root.children, [sibling]);
  assert.deepEqual(f.calls.filter(c => c.method === 'terminal.kill').map(c => c.params.terminal), ['t9']);
});

test('production open and close each use one bound session, with a mocked core socket only', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t), endpoint = path.join(f.root, 'rpc.sock');
  let connections = 0;
  const methods = ['hello', 'server.status', 'terminal.get', 'terminal.list', 'terminal.run', 'terminal.kill', 'doc.get', 'doc.set'];
  const sockets = new Set();
  const server = createServer(socket => {
    connections++; sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    let buffer = '';
    socket.on('data', async chunk => {
      buffer += chunk;
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      const request = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      try {
        const result = request.method === 'hello'
          ? { generation: 1, framed: false, version: f.coreVersion, core: { id: f.core, name: 'host' }, methods, features: [] }
          : await f.call(request.method, request.params);
        socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
      } catch (error) {
        socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { message: String(error) } })}\n`);
      }
    });
  });
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(endpoint, resolve); });
  const options = { ...f.options, call: undefined, env: { HC_TERMINAL_ID: 't1', HC_SOCKET: endpoint } };
  await ensureCoreMonitorPane(options);
  assert.equal(connections, 1);
  assert.deepEqual(f.mutations().map(c => c.method), ['terminal.run', 'doc.set']);
  f.calls.length = 0;
  await closeCoreMonitorPane(options);
  assert.equal(connections, 2);
  assert.deepEqual(f.mutations().map(c => c.method), ['terminal.kill', 'doc.set']);
});
