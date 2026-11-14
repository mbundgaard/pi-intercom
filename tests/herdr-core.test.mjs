import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { locateTerminalTab, renameCoreTab, terminalAddress, withCoreSession } from '../dist/herdr-core.js';

const layout = () => ({ spaces: [{ id: 'sp1', name: 'Project', tabs: [{ id: 'tb1', name: '', root: { id: 'tb1', type: 'row', children: [{ id: 'p1', type: 'block', content: { terminal: 't1' } }] } }] }], futureField: { preserved: true } });
function fixture() {
  let value = layout(), version = 3;
  const calls = [];
  const record = { address: 't1', state: 'live', created_ms: 100, labels: { 'herdr.space': 'sp1', 'herdr.tab': 'tb1' } };
  const call = async (method, params) => {
    calls.push({ method, params: structuredClone(params) });
    if (method === 'terminal.get') return structuredClone(record);
    if (method === 'doc.get') return { version, value: structuredClone(value) };
    assert.equal(method, 'doc.set'); assert.equal(params.version, version);
    value = structuredClone(params.value); return { version: ++version };
  };
  return { call, calls, record };
}
test('remote app tab rename changes only owning tab name via versioned core document', async () => {
  const f = fixture(); await renameCoreTab('t1', 'Runtime', f.call);
  const write = f.calls.find(c => c.method === 'doc.set');
  const expected = layout(); expected.spaces[0].tabs[0].name = 'Runtime';
  assert.deepEqual(write.params, { name: 'herdr-app', version: 3, value: expected });
  assert.equal(f.calls.filter(c => c.method === 'doc.set').length, 1);
});
test('matching tab name does not write and does not use focus', async () => {
  const f = fixture(); await renameCoreTab('t1', 'Runtime', f.call);
  f.calls.length = 0; await renameCoreTab('t1', 'Runtime', f.call);
  assert.deepEqual(f.calls.map(c => c.method), ['terminal.get', 'doc.get']);
});
test('missing, ambiguous or changed terminal ownership refuses before mutation', async () => {
  for (const change of [r => r.state = 'finished', r => r.address = 't2', r => r.labels['herdr.tab'] = 'other']) {
    const f = fixture(); change(f.record);
    await assert.rejects(renameCoreTab('t1', 'Worker', f.call));
    assert.equal(f.calls.some(c => c.method === 'doc.set'), false);
  }
  const duplicate = layout(); duplicate.spaces[0].tabs[0].root.children.push({ id: 'p2', type: 'block', content: { terminal: 't1' } });
  assert.throws(() => locateTerminalTab(duplicate, 't1'));
  assert.throws(() => locateTerminalTab(layout(), 't2'));
  const f = fixture(); let gets = 0;
  await assert.rejects(renameCoreTab('t1', 'Worker', async (method, params) => {
    const result = await f.call(method, params);
    if (method === 'terminal.get' && ++gets === 2) result.created_ms++;
    return result;
  }), /identity changed/);
  assert.equal(f.calls.some(c => c.method === 'doc.set'), false);
});
test('CAS conflict or uncertain mutation acknowledgment is never replayed', async () => {
  for (const mode of ['conflict', 'malformed']) {
    const f = fixture(); let mutations = 0;
    await assert.rejects(renameCoreTab('t1', 'Worker', async (method, params) => {
      if (method === 'doc.set') { mutations++; if (mode === 'conflict') throw new Error('conflict'); return {}; }
      return f.call(method, params);
    }));
    assert.equal(mutations, 1);
  }
});

const core = { id: 'core-local', name: 'local' };
const status = () => ({ core: { ...core }, version: '0.1.18', pid: 123 });
const hello = () => ({ core: { ...core }, version: '0.1.18', generation: 1, framed: false,
  methods: ['hello', 'server.status', 'terminal.get', 'terminal.list', 'doc.get', 'doc.set'], features: [] });
function transport(handler, overrides = {}) {
  const requests = [], events = [];
  let starts = 0, kills = 0;
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const reply = (request, result) => child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
  child.stdin = new Writable({ write(chunk, _encoding, done) {
    const request = JSON.parse(chunk.toString()); requests.push(request);
    queueMicrotask(() => {
      if (request.method === 'hello') reply(request, overrides.hello ?? hello());
      else if (request.method === 'server.status') reply(request, overrides.status ?? status());
      else handler?.(request, child, reply);
    });
    done();
  } });
  child.kill = () => { kills++; return true; };
  const options = {
    timeoutMs: 1000,
    readStatus: async () => { events.push('status'); return overrides.before ?? status(); },
    startClient: () => { starts++; events.push('connect'); return child; },
  };
  return { options, child, requests, events, get starts() { return starts; }, get kills() { return kills; } };
}

test('one verified connection binds all rename reads, CAS write and readback; handle expires', async () => {
  const f = fixture(); let saved;
  const t = transport((request, _child, reply) => {
    f.call(request.method, request.params).then(value => reply(request, value));
  });
  await withCoreSession(async call => { saved = call; await renameCoreTab('t1', 'Worker', call); }, t.options);
  assert.deepEqual(t.events, ['status', 'connect']);
  assert.deepEqual(t.requests.map(r => r.method), ['hello', 'server.status', 'terminal.get', 'doc.get', 'terminal.get', 'doc.set', 'doc.get']);
  assert.equal(t.starts, 1); assert.equal(t.kills, 1);
  assert.equal(new Set(t.requests.map(r => r.id)).size, t.requests.length);
  await assert.rejects(saved('doc.set', {}), /session is closed/);
  assert.equal(t.requests.filter(r => r.method === 'doc.set').length, 1);
});

test('invalid preflight never starts connect, and handshake/instance mismatches never enter operation', async () => {
  for (const before of [null, [], {}, { ...status(), version: null }, { ...status(), pid: 0 }]) {
    const t = transport(); t.options.readStatus = async () => before;
    await assert.rejects(withCoreSession(async () => assert.fail('operation entered'), t.options));
    assert.equal(t.starts, 0);
  }
  for (const change of [h => h.version = null, h => h.generation = 2, h => h.framed = true,
    h => h.core.id = 'other', h => h.core.name = 'other', h => h.methods = [], h => h.features = null]) {
    const h = hello(); change(h); const t = transport(undefined, { hello: h });
    await assert.rejects(withCoreSession(async () => assert.fail('operation entered'), t.options));
    assert.ok(t.requests.every(r => ['hello', 'server.status'].includes(r.method)));
    assert.equal(t.starts, 1); assert.equal(t.kills, 1);
  }
  for (const s of [{ ...status(), pid: 124 }, { ...status(), core: { id: 'other', name: 'local' } }, null]) {
    const t = transport(undefined, { status: s ?? [] });
    await assert.rejects(withCoreSession(async () => assert.fail('operation entered'), t.options), /instance changed/);
  }
});

test('product releases do not gate compatible protocol operations', async () => {
  for (const version of ['0.1.19', '0.2.0', '1.0.0', '2.0.0-dev+build', '0.1.17']) {
    const f = fixture();
    const t = transport((request, _child, reply) => { f.call(request.method, request.params).then(value => reply(request, value)); },
      { before: {...status(), version}, status: {...status(), version}, hello: {...hello(), version} });
    await withCoreSession(call => renameCoreTab('t1', 'Worker', call), t.options);
    assert.equal(t.requests.filter(r => r.method === 'doc.set').length, 1);
  }
});

test('missing operation capability is detected before callback or mutation', async () => {
  const t = transport();
  await assert.rejects(withCoreSession(() => assert.fail('entered'), {...t.options, requiredMethods:['terminal.run']}), /required API method unavailable: terminal.run/);
  assert.deepEqual(t.requests.map(r => r.method), ['hello']);
});

test('API errors identify method and code without exposing server payloads', async () => {
  const t = transport((request, child) => child.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,error:{code:-32602,message:'secret detail',data:'private'}})+'\n'));
  await assert.rejects(withCoreSession(call => call('doc.get', {}), t.options), error => {
    assert.match(error.message, /API rejected request doc.get; RPC code -32602/);
    assert.doesNotMatch(error.message, /secret|private/); return true;
  });
});

test('trailing data on a read is rejected before the next mutation can be sent', async () => {
  const t = transport((request, child) => child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\npartial`));
  await assert.rejects(withCoreSession(async call => {
    await call('doc.get', {}); await call('doc.set', {});
  }, t.options), error => error.uncertain === false && /trailing/.test(error.message));
  assert.equal(t.requests.some(r => r.method === 'doc.set'), false);
});

test('UTF-8 response split inside multibyte codepoint survives chunk boundaries', async () => {
  const t = transport((request, child) => {
    const raw = Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: 'ž🙂' })}\n`);
    for (const byte of raw) child.stdout.write(Buffer.from([byte]));
  });
  assert.equal(await withCoreSession(call => call('doc.get', {}), t.options), 'ž🙂');
});

for (const [name, response] of [
  ['null envelope', () => 'null\n'],
  ['array envelope', () => '[]\n'],
  ['malformed JSON', () => '{\n'],
  ['wrong ID', () => '{"jsonrpc":"2.0","id":"other","result":{}}\n'],
  ['missing result', r => JSON.stringify({ jsonrpc: '2.0', id: r.id }) + '\n'],
  ['wrong protocol', r => JSON.stringify({ jsonrpc: '1.0', id: r.id, result: {} }) + '\n'],
  ['error and result', r => JSON.stringify({ jsonrpc: '2.0', id: r.id, result: {}, error: null }) + '\n'],
  ['trailing JSON', r => JSON.stringify({ jsonrpc: '2.0', id: r.id, result: {} }) + '\n{}\n'],
  ['trailing partial data', r => JSON.stringify({ jsonrpc: '2.0', id: r.id, result: {} }) + '\ngarbage'],
  ['invalid UTF-8', r => Buffer.concat([Buffer.from(`{"jsonrpc":"2.0","id":"${r.id}","result":"`), Buffer.from([0xff]), Buffer.from('"}\n')])],
  ['trailing partial UTF-8', r => Buffer.concat([Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: r.id, result: {} }) + '\n'), Buffer.from([0xc3])])],
]) {
  test(`transport rejects ${name}, marks attempted write uncertain, never reconnects/replays`, async () => {
    const t = transport((request, child) => child.stdout.write(response(request)));
    await assert.rejects(withCoreSession(call => call('doc.set', {}), t.options), error => error.uncertain === true && /do not replay/.test(error.message));
    assert.equal(t.starts, 1); assert.equal(t.kills, 1);
    assert.equal(t.requests.filter(r => r.method === 'doc.set').length, 1);
  });
}

for (const [name, end] of [
  ['stdout EOF', (_r, child) => child.stdout.end()],
  ['EOF with unterminated response', (r, child) => child.stdout.end(JSON.stringify({ jsonrpc: '2.0', id: r.id, result: {} }))],
  ['process close', (_r, child) => child.emit('close', 0)],
  ['stdin error', (_r, child) => child.stdin.emit('error', new Error('EPIPE'))],
  ['stdout error', (_r, child) => child.stdout.emit('error', new Error('EIO'))],
  ['stderr error', (_r, child) => child.stderr.emit('error', new Error('EIO'))],
  ['response limit', (_r, child) => child.stdout.write(Buffer.alloc(1024 * 1024 + 1, 32))],
]) {
  test(`${name} after write poisons session even if callback catches request failure`, async () => {
    const t = transport(end);
    await assert.rejects(withCoreSession(async call => {
      await assert.rejects(call('doc.set', {}));
      await assert.rejects(call('doc.set', {}));
      return 'not success';
    }, t.options), error => error.uncertain === true);
    assert.equal(t.starts, 1); assert.equal(t.kills, 1);
    assert.equal(t.requests.filter(r => r.method === 'doc.set').length, 1);
  });
}

test('bounded timeout after write does not retry; preflight/callback hangs are also bounded', async () => {
  const t = transport(); t.options.timeoutMs = 20;
  await assert.rejects(withCoreSession(call => call('doc.set', {}), t.options), error => error.uncertain === true && /timed out/.test(error.message));
  assert.equal(t.starts, 1); assert.equal(t.kills, 1);
  assert.equal(t.requests.filter(r => r.method === 'doc.set').length, 1);
  const p = transport(); p.options.timeoutMs = 20; p.options.readStatus = () => new Promise(() => {});
  await assert.rejects(withCoreSession(async () => {}, p.options), /timed out/);
  assert.equal(p.starts, 0);
  const c = transport(); c.options.timeoutMs = 20;
  await assert.rejects(withCoreSession(() => new Promise(() => {}), c.options), /timed out/);
  assert.equal(c.kills, 1);
});

test('late preflight settlement after timeout cannot start a process', async () => {
  const t = transport(); let settle;
  t.options.timeoutMs = 20; t.options.readStatus = () => new Promise(resolve => { settle = resolve; });
  await assert.rejects(withCoreSession(async () => {}, t.options), /timed out/);
  settle(status()); await new Promise(resolve => setImmediate(resolve));
  assert.equal(t.starts, 0);
});

test('spawn exception/event and synchronous stdin exception are bounded without replay', async () => {
  const thrown = transport(); thrown.options.startClient = () => { throw new Error('spawn failed'); };
  await assert.rejects(withCoreSession(async () => {}, thrown.options), /spawn failed/);
  const event = transport(); const start = event.options.startClient;
  event.options.startClient = () => { const child = start(); queueMicrotask(() => child.emit('error', new Error('ENOENT'))); return child; };
  await assert.rejects(withCoreSession(async () => assert.fail('operation entered'), event.options), /could not start/);
  assert.equal(event.starts, 1); assert.equal(event.kills, 1);
  const t = transport();
  await assert.rejects(withCoreSession(call => {
    t.child.stdin.write = () => { throw new Error('EPIPE'); };
    return call('doc.set', {});
  }, t.options), error => error.uncertain === true);
  assert.equal(t.starts, 1); assert.equal(t.kills, 1);
});

test('unsupported methods and concurrent calls poison rather than reconnect', async () => {
  const t = transport();
  await assert.rejects(withCoreSession(call => call('server.stop', {}), t.options), /unsupported/);
  assert.equal(t.requests.length, 2);
  const c = transport();
  await assert.rejects(withCoreSession(async call => {
    await Promise.all([call('doc.get', {}), call('doc.get', {})]);
  }, c.options), /concurrent/);
  assert.equal(c.requests.length, 3);
});

test('full-operation request count and request size are bounded', async () => {
  const t = transport((r, _c, reply) => reply(r, {}));
  await assert.rejects(withCoreSession(async call => { for (let i = 0; i < 70; i++) await call('doc.get', {}); }, t.options), /excessive/);
  assert.equal(t.requests.length, 64);
  const big = transport();
  await assert.rejects(withCoreSession(call => call('doc.set', { value: 'x'.repeat(1024 * 1024) }), big.options), /request exceeded/);
  assert.equal(big.requests.length, 2);
});

test('unknown layout forms, stacks/floats and dynamic content are rejected, even outside target pane', () => {
  for (const bad of [null, [], { id: 'x', type: 'stack', children: [] },
    { id: 'x', type: 'grid', children: [] },
    { id: 'x', type: 'block', content: { tab: 'active' } },
    { id: 'x', type: 'block', content: { agent: 'focused' } },
    { id: 'x', type: 'block', content: { terminal: 't2', mod: 'x' } },
    { id: 'x', type: 'block', content: { terminal: 't2' }, children: [] },
    { id: 'x', type: 'row', children: [], content: { terminal: 't2' } },
    { id: 'x', type: 'row', children: [], floating: [{ id: 'f1', content: { terminal: 't1' } }] },
    { id: 'x', type: 'column', children: [], floating: null }]) {
    const value = layout(); value.spaces[0].tabs[0].root.children.push(bad);
    assert.throws(() => locateTerminalTab(value, 't1'));
  }
});

test('tested layout subset preserves metadata, mod blocks and uniquely identified mod-only floats', async () => {
  const value = layout(), tab = value.spaces[0].tabs[0];
  tab.root.floating = [{ id: 'float1', content: { mod: 'team', props: { terminal: 't1', nested: { id: 'p1' } } }, edge: 'left', hidden: true }];
  tab.root.hidden = false; tab.root.title = 'Unchanged';
  tab.root.children.push({ id: 'mod1', type: 'block', content: { mod: 'help', props: { future: true } } });
  tab.root.children[0].floating = [];
  assert.equal(locateTerminalTab(value, 't1').tab, tab);
  const expected = structuredClone(value); expected.spaces[0].tabs[0].name = 'Worker';
  let stored = value, version = 4;
  await renameCoreTab('t1', 'Worker', async (method, params) => {
    if (method === 'terminal.get') return fixture().record;
    if (method === 'doc.get') return { value: structuredClone(stored), version };
    assert.equal(method, 'doc.set'); stored = params.value; return { version: ++version };
  });
  assert.deepEqual(stored, expected);
});

test('exact CAS acknowledgement and monotonic readback version required without replay', async () => {
  for (const mode of ['jump', 'old', 'missing']) {
    const f = fixture(); let wrote = false;
    await assert.rejects(renameCoreTab('t1', 'Worker', async (method, params) => {
      const result = await f.call(method, params);
      if (method === 'doc.set') { wrote = true; if (mode === 'jump') result.version++; }
      if (method === 'doc.get' && wrote) { if (mode === 'old') result.version--; if (mode === 'missing') delete result.version; }
      return result;
    }), /version|acknowledgment/);
    assert.equal(f.calls.filter(c => c.method === 'doc.set').length, 1);
  }
});

test('read-only preflight failure prevents connect; invalid deadlines cannot start transport', async () => {
  const t = transport(); t.options.readStatus = async () => { throw new Error('no existing core'); };
  await assert.rejects(withCoreSession(async () => assert.fail('operation entered'), t.options), /no existing core/);
  assert.equal(t.starts, 0);
  for (const timeoutMs of [0, -1, Infinity, NaN, 10001]) {
    await assert.rejects(withCoreSession(async () => {}, { ...t.options, timeoutMs }), /deadline/);
  }
  assert.equal(t.starts, 0);
});

test('Unix default fails closed without explicit endpoint; no guessed socket or autostart CLI', { skip: process.platform === 'win32' }, async () => {
  await assert.rejects(withCoreSession(async () => assert.fail('operation entered'), { endpoint: '' }), /Unix hc server status\/connect may autostart/);
  await assert.rejects(withCoreSession(async () => assert.fail('operation entered'), { endpoint: 'relative.sock' }), /absolute local core endpoint/);
});

test('callback failure after acknowledged write still reports uncertainty without replay', async () => {
  const t = transport((r, _c, reply) => reply(r, {}));
  await assert.rejects(withCoreSession(async call => {
    await call('doc.set', {}); throw new Error('readback validation failed');
  }, t.options), error => error.uncertain === true && /do not replay/.test(error.message));
  assert.equal(t.requests.filter(r => r.method === 'doc.set').length, 1);
});

test('unsupported layout refuses rename before mutation', async () => {
  const f = fixture();
  await assert.rejects(renameCoreTab('t1', 'Worker', async (method, params) => {
    const result = await f.call(method, params);
    if (method === 'doc.get') result.value.spaces[0].tabs[0].root.floating = [{ id: 'f1', content: { terminal: 't1' } }];
    return result;
  }), /floating/);
  assert.equal(f.calls.some(c => c.method === 'doc.set'), false);
});

test('mod float IDs participate in global identity uniqueness and malformed float shapes fail closed', () => {
  for (const floating of [
    { id: 'p1', content: { mod: 'help' } },
    { id: 'f1', content: { mod: 'help', terminal: 't2' } },
    { id: 'f1', content: { mod: 'help' }, children: [] },
    { id: 'f1', content: { mod: 'help' }, edge: 'unknown' },
    { id: 'f1', content: { mod: 'help' }, align: 'unknown' },
  ]) {
    const value = layout(); value.spaces[0].tabs[0].root.floating = [floating];
    assert.throws(() => locateTerminalTab(value, 't1'));
  }
  const value = layout(); value.spaces[0].tabs[0].root.floating = [
    { id: 'f1', content: { mod: 'help' } }, { id: 'f1', content: { mod: 'help' } },
  ];
  assert.throws(() => locateTerminalTab(value, 't1'), /ambiguous/);
});

test('terminal identifiers reject trailing newline and layout duplicate IDs fail closed', () => {
  for (const bad of ['t1\n', 't1\r', ' t1', 'remote/t1', '', null]) assert.throws(() => terminalAddress(bad));
  const value = layout(); value.spaces[0].tabs[0].root.children.push({ id: 'p1', type: 'block', content: { terminal: 't2' } });
  assert.throws(() => locateTerminalTab(value, 't1'), /ambiguous/);
});
