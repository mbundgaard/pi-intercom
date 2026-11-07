import test from 'node:test';
import assert from 'node:assert/strict';
import { preflightCoreWorkerLayout, attachCoreWorkerLayout, CoreWorkerLayoutUncertainError } from '../dist/core-worker-layout.js';
import { renameCoreTab } from '../dist/herdr-core.js';

const request = { caller: 't1', cwd: '/project', workspaceRoot: '/project', platform: 'linux' };
const layout = () => ({
  spaces: [{ id: 'sp1', name: 'Project', folder: '/project', future: { keep: 1 }, tabs: [
    { id: 'tb1', name: 'Coordinator', extra: [1, 2], root: { id: 'tb1', type: 'row', gap: 9, children: [
      { id: 'p1', type: 'block', content: { terminal: 't1' }, background: 'black' },
    ] } },
  ] }], futureField: { preserved: true },
});
function fixture() {
  const f = {
    value: layout(), version: 3, coreId: 'core-identity', calls: [],
    caller: { address: 't1', state: 'live', created_ms: 100, labels: { 'herdr.space': 'sp1', 'herdr.tab': 'tb1' } },
    worker: undefined,
  };
  f.call = async (method, params) => {
    f.calls.push({ method, params: structuredClone(params) });
    switch (method) {
      case 'server.status': return { core: { id: f.coreId } };
      case 'terminal.get':
        assert.ok(['t1', 't2'].includes(params.terminal));
        return structuredClone(params.terminal === 't1' ? f.caller : f.worker);
      case 'doc.get': assert.deepEqual(params, { name: 'herdr-app' }); return { version: f.version, value: structuredClone(f.value) };
      case 'doc.set':
        assert.equal(params.name, 'herdr-app'); assert.equal(params.version, f.version);
        f.value = structuredClone(params.value); return { version: ++f.version };
      case 'terminal.label':
        assert.equal(params.terminal, 't2');
        assert.ok(f.calls.some(c => c.method === 'doc.set'), 'labels must follow CAS');
        Object.assign(f.worker.labels, params.labels); return structuredClone(f.worker);
      default: assert.fail(`unexpected API mutation or call: ${method}`);
    }
  };
  f.create = ticket => {
    f.worker = { address: 't2', state: 'live', created_ms: Math.max(Date.now(), ticket.startedAtMs), cwd: '/project', parent: 't1', labels: { custom: 'keep' }, foreground: { cwd: '/project' } };
    return structuredClone(f.worker);
  };
  return f;
}
const mutations = f => f.calls.filter(c => ['doc.set', 'terminal.label'].includes(c.method));
async function prepared(overrides = {}) {
  const f = fixture();
  const ticket = await preflightCoreWorkerLayout({ ...request, ...overrides }, f.call);
  const created = f.create(ticket);
  return { f, ticket, created };
}
async function uncertain(promise) {
  await assert.rejects(promise, e => {
    assert.ok(e instanceof CoreWorkerLayoutUncertainError);
    assert.equal(e.outcomeUncertain, true);
    assert.match(e.message, /outcome unknown/);
    assert.match(e.message, /no automatic cleanup\/retry\/replacement/);
    return true;
  });
}

test('read-only preflight pins caller creation, core identity and document mapping before creation', async () => {
  const f = fixture();
  const ticket = await preflightCoreWorkerLayout(request, f.call);
  assert.equal(ticket.callerCreatedMs, 100);
  assert.equal(ticket.coreId, 'core-identity');
  assert.equal(ticket.space, 'sp1'); assert.equal(ticket.tab, 'tb1'); assert.equal(ticket.pane, 'p1');
  assert.equal(ticket.version, 3); assert.equal(ticket.name, 'Intercom (anonymous)');
  assert.ok(Object.isFrozen(ticket)); assert.equal(f.worker, undefined);
  assert.deepEqual(mutations(f), []);
});

test('one dedicated anonymous tab: random app-local IDs, original metadata intact, no focus calls', async () => {
  const { f, ticket, created } = await prepared();
  const before = structuredClone(f.value);
  const result = await attachCoreWorkerLayout(ticket, created, f.call);
  assert.match(result.tab, /^tb[0-9a-f]{32}$/); assert.match(result.pane, /^p[0-9a-f]{32}$/);
  assert.notEqual(result.tab, result.pane);
  assert.equal(result.space, 'sp1'); assert.equal(result.coreId, ticket.coreId);
  assert.equal(result.layoutConfirmed, true); assert.equal(result.uiAcknowledged, false);
  assert.equal(result.terminalCreatedMs, created.created_ms);
  const added = f.value.spaces[0].tabs.pop();
  assert.deepEqual(f.value, before);
  assert.deepEqual(added, { id: result.tab, name: 'Intercom (anonymous)', root: { id: result.tab, type: 'row', children: [{ id: result.pane, type: 'block', content: { terminal: 't2' } }] } });
  assert.deepEqual(mutations(f).map(c => c.method), ['doc.set', 'terminal.label']);
  assert.deepEqual(f.worker.labels, { custom: 'keep', 'herdr.space': 'sp1', 'herdr.tab': result.tab });
  const writeIndex = f.calls.findIndex(c => c.method === 'doc.set');
  const labelIndex = f.calls.findIndex(c => c.method === 'terminal.label');
  assert.ok(f.calls.slice(writeIndex + 1, labelIndex).some(c => c.method === 'doc.get'));
  assert.ok(f.calls.every(c => !Object.hasOwn(c.params, 'on') && !Object.hasOwn(c.params, 'caller')));
});

test('current authoritative caller mapping and current version override stale preflight and borrowed labels', async () => {
  const { f, ticket, created } = await prepared();
  f.value.spaces.push({ id: 'sp2', name: 'Moved', folder: '/other', tabs: f.value.spaces[0].tabs.splice(0) });
  f.version = 9; // Another client moved the caller after preflight.
  const result = await attachCoreWorkerLayout(ticket, created, f.call);
  assert.equal(result.space, 'sp2'); assert.equal(f.value.spaces[0].tabs.length, 0);
  assert.equal(f.value.spaces[1].tabs.length, 2);
  assert.equal(mutations(f)[0].params.version, 9);
  assert.equal(f.worker.labels['herdr.space'], 'sp2');
  assert.equal(f.caller.labels['herdr.space'], 'sp1', 'caller labels are not rewritten or treated as authority');
});

test('resume label is optional and subsequent existing renameCoreTab synchronizes configured name', async () => {
  const { f, ticket, created } = await prepared({ name: 'Resumed worker' });
  await attachCoreWorkerLayout(ticket, created, f.call);
  assert.equal(f.value.spaces[0].tabs[1].name, 'Resumed worker');
  await renameCoreTab('t2', 'Configured worker', f.call);
  assert.equal(f.value.spaces[0].tabs[1].name, 'Configured worker');
  assert.equal(f.value.spaces[0].tabs[0].name, 'Coordinator');
});

test('fresh launches generate independent IDs', async () => {
  const a = await prepared(), b = await prepared();
  const x = await attachCoreWorkerLayout(a.ticket, a.created, a.f.call);
  const y = await attachCoreWorkerLayout(b.ticket, b.created, b.f.call);
  assert.notEqual(x.tab, y.tab); assert.notEqual(x.pane, y.pane);
});

test('preflight refuses unavailable, missing, ambiguous and unsupported documents without mutation', async () => {
  const bad = [
    f => { f.value = null; },
    f => { f.value = {}; },
    f => { f.version = -1; },
    f => { f.version = Number.MAX_SAFE_INTEGER + 1; },
    f => { f.value.spaces[0].tabs[0].root.children[0].content.terminal = 't3'; },
    f => { f.value.spaces[0].tabs[0].root.children.push({ id: 'p2', type: 'block', content: { terminal: 't1' } }); },
    f => { f.value.spaces[0].tabs[0].root.type = 'stack'; },
    f => { f.value.spaces[0].id = 'remote/sp1'; },
    f => { f.value.spaces[0].tabs[0].root.floating = [{ id: 'float', content: { terminal: 't1' } }]; },
    f => { f.value.spaces[0].tabs[0].root.floating = [{ id: 'p1', content: { mod: 'foo' } }]; },
  ];
  for (const change of bad) {
    const f = fixture(); change(f);
    await assert.rejects(preflightCoreWorkerLayout(request, f.call));
    assert.equal(f.worker, undefined); assert.deepEqual(mutations(f), []);
  }
  const f = fixture();
  await assert.rejects(preflightCoreWorkerLayout(request, async (method, params) => {
    if (method === 'doc.get') throw new Error('offline');
    return f.call(method, params);
  }));
  assert.deepEqual(mutations(f), []);
});

test('preflight identity failures and unsafe roots refuse before worker creation', async () => {
  for (const change of [f => f.caller.state = 'finished', f => f.caller.created_ms = undefined, f => f.caller.address = 't9', f => f.coreId = '']) {
    const f = fixture(); change(f);
    await assert.rejects(preflightCoreWorkerLayout(request, f.call));
    assert.deepEqual(mutations(f), []);
  }
  for (const override of [{ caller: 'remote/t1' }, { caller: 'worker' }, { cwd: '/project/child' }, { workspaceRoot: '/' }, { cwd: 'relative' }, { name: 'bad\nname' }]) {
    const f = fixture();
    await assert.rejects(preflightCoreWorkerLayout({ ...request, ...override }, f.call));
    assert.equal(f.calls.length, 0);
  }
});

test('caller or core replacement during preflight is rejected', async () => {
  for (const method of ['server.status', 'terminal.get']) {
    const f = fixture(); let reads = 0;
    await assert.rejects(preflightCoreWorkerLayout(request, async (m, p) => {
      const r = await f.call(m, p);
      if (m === method && ++reads === 2) { if (m === 'server.status') r.core.id = 'other'; else r.created_ms++; }
      return r;
    }));
    assert.deepEqual(mutations(f), []);
  }
});

test('fresh worker result and actual terminal facts must agree on identity, root cwd and parent', async () => {
  const changes = [
    r => r.address = 't1', r => r.address = 'remote/t2', r => r.address = 'worker',
    r => r.created_ms = 1, r => delete r.created_ms, r => r.state = 'finished',
    r => r.parent = 't9', r => r.cwd = '/project/subdir', r => r.cwd = '/',
    r => r.first_message = { sent: true }, r => r.foreground.cwd = '/elsewhere',
  ];
  for (const change of changes) {
    for (const actual of [false, true]) {
      const { f, ticket, created } = await prepared();
      change(actual ? f.worker : created);
      await uncertain(attachCoreWorkerLayout(ticket, created, f.call));
      assert.deepEqual(mutations(f), []);
    }
  }
});

test('caller, core, mapping and worker ownership changes before CAS fail closed', async () => {
  for (const change of [
    f => f.coreId = 'other-core', f => f.caller.created_ms++, f => f.caller.state = 'finished',
    f => f.value = null, f => f.version--,
    f => f.value.spaces[0].tabs[0].root.children[0].content.terminal = 't9',
    f => f.worker.labels['herdr.space'] = 'sp1', f => f.worker.labels['herdr.tab'] = 'tb1',
    f => f.value.spaces[0].tabs[0].root.children.push({ id: 'p2', type: 'block', content: { terminal: 't2' } }),
    f => f.value.spaces[0].tabs[0].root.floating = [{ id: 'float', content: { terminal: 't2' } }],
  ]) {
    const { f, ticket, created } = await prepared(); change(f);
    await uncertain(attachCoreWorkerLayout(ticket, created, f.call));
    assert.deepEqual(mutations(f), []);
  }
});

test('late worker replacement before CAS is detected', async () => {
  const { f, ticket, created } = await prepared(); let reads = 0;
  await uncertain(attachCoreWorkerLayout(ticket, created, async (method, params) => {
    const result = await f.call(method, params);
    if (method === 'terminal.get' && params.terminal === 't2' && ++reads === 2) result.created_ms++;
    return result;
  }));
  assert.deepEqual(mutations(f), []);
});

test('CAS conflict, transport failure and malformed acknowledgment are never retried or labeled', async () => {
  for (const mode of ['conflict', 'disconnect-after-write', 'missing-version', 'old-version']) {
    const { f, ticket, created } = await prepared(); let writes = 0;
    const call = async (method, params) => {
      if (method !== 'doc.set') return f.call(method, params);
      writes++;
      if (mode === 'conflict') throw new Error('conflict');
      await f.call(method, params);
      if (mode === 'disconnect-after-write') throw new Error('disconnected');
      return mode === 'missing-version' ? {} : { version: params.version };
    };
    await uncertain(attachCoreWorkerLayout(ticket, created, call));
    assert.equal(writes, 1);
    assert.equal(f.calls.some(c => c.method === 'terminal.label'), false);
    const count = f.calls.length;
    await uncertain(attachCoreWorkerLayout(ticket, created, call));
    assert.equal(f.calls.length, count, 'same ticket cannot replay even after uncertainty');
  }
});

test('write readback validates version, worker placement, caller space and unchanged metadata before labeling', async () => {
  for (const change of [
    f => f.version--,
    f => f.value.spaces[0].tabs.pop(),
    f => f.value.spaces[0].tabs[1].name = 'wrong',
    f => delete f.value.futureField,
    f => f.value.spaces[0].tabs[1].root.children.push({ id: 'extra', type: 'block', content: { terminal: 't9' } }),
    f => f.value.spaces.push({ id: 'sp2', name: '', tabs: [f.value.spaces[0].tabs.shift()] }),
  ]) {
    const { f, ticket, created } = await prepared();
    await uncertain(attachCoreWorkerLayout(ticket, created, async (method, params) => {
      const result = await f.call(method, params);
      if (method === 'doc.set') change(f);
      return result;
    }));
    assert.deepEqual(mutations(f).map(c => c.method), ['doc.set']);
  }
});

test('post-CAS identity changes never label or remove the created tab', async () => {
  for (const change of [f => f.coreId = 'other', f => f.worker.created_ms++, f => f.caller.created_ms++]) {
    const { f, ticket, created } = await prepared();
    await uncertain(attachCoreWorkerLayout(ticket, created, async (method, params) => {
      const result = await f.call(method, params); if (method === 'doc.set') change(f); return result;
    }));
    assert.deepEqual(mutations(f).map(c => c.method), ['doc.set']);
    assert.equal(f.value.spaces[0].tabs.length, 2);
  }
});

test('label failure, invalid acknowledgment, readback or later document change remains uncertain without cleanup', async () => {
  for (const mode of ['transport', 'ack', 'readback', 'doc']) {
    const { f, ticket, created } = await prepared();
    await uncertain(attachCoreWorkerLayout(ticket, created, async (method, params) => {
      const result = await f.call(method, params);
      if (method === 'terminal.label') {
        if (mode === 'transport') throw new Error('delivery unknown');
        if (mode === 'ack') return {};
        if (mode === 'readback') f.worker.labels['herdr.tab'] = 'wrong';
        if (mode === 'doc') { f.value.spaces[0].tabs[1].name = 'wrong'; f.version++; }
      }
      return result;
    }));
    assert.deepEqual(mutations(f).map(c => c.method), ['doc.set', 'terminal.label']);
    assert.equal(f.value.spaces[0].tabs.length, 2);
  }
});

test('a newer unrelated edit is retained and not overwritten during readback', async () => {
  const { f, ticket, created } = await prepared();
  const result = await attachCoreWorkerLayout(ticket, created, async (method, params) => {
    const r = await f.call(method, params);
    if (method === 'doc.set') { f.value.spaces[0].name = 'User rename'; f.version++; }
    return r;
  });
  assert.equal(result.version, 5); assert.equal(f.value.spaces[0].name, 'User rename');
  assert.equal(mutations(f).filter(c => c.method === 'doc.set').length, 1);
});

test('tickets are one-shot, including concurrent calls and forged/copied tokens', async () => {
  const { f, ticket, created } = await prepared();
  await uncertain(attachCoreWorkerLayout({ ...ticket }, created, f.call));
  const first = attachCoreWorkerLayout(ticket, created, f.call);
  await uncertain(attachCoreWorkerLayout(ticket, created, f.call));
  await first;
  assert.equal(mutations(f).filter(c => c.method === 'doc.set').length, 1);
});

test('floating mod metadata and unknown fields survive without turning mod props into terminal identity', async () => {
  const { f, ticket, created } = await prepared();
  f.value.spaces[0].tabs[0].root.floating = [{ id: 'float', content: { mod: 'viewer', props: { terminal: 't2' } }, edge: 'left', future: 42 }];
  f.value.spaces[0].tabs[0].root.children[0].futureMetadata = { preserved: true };
  const before = structuredClone(f.value);
  await attachCoreWorkerLayout(ticket, created, f.call);
  f.value.spaces[0].tabs.pop();
  assert.deepEqual(f.value, before);
});

test('Windows root comparisons are normalized without borrowing space folder or caller cwd', async () => {
  const f = fixture();
  const ticket = await preflightCoreWorkerLayout({ ...request, platform: 'win32', cwd: 'C:\\Project', workspaceRoot: 'c:/project/' }, f.call);
  const created = f.create(ticket);
  for (const record of [created, f.worker]) { record.cwd = 'c:/Project/'; record.foreground.cwd = 'C:\\Project'; }
  await attachCoreWorkerLayout(ticket, created, f.call);
  assert.equal(f.value.spaces[0].folder, '/project', 'existing space metadata is not rewritten');
});
