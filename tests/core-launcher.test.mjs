import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchers } from '../dist/launcher.js';

const noTransport = async () => assert.fail('no production transport or CLI allowed');
const options = { platform: 'linux', extension: "/source/O'Brien $HOME;`echo bad`/index.ts",
  env: { HC_TERMINAL_ID: 't1b', HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'legacy', HERDR_PANE_ID: 'old-pane' },
  run: noTransport, coreCall: noTransport, sessionExists: async () => true };
const request = { multiplexer: 'herdr', cwd: '/project', workspaceRoot: '/project' };
const clone = value => structuredClone(value);
// Trusted CoreCall seam: hello/version/connection tests belong to herdr-core.test.
// This fixture exercises real layout preflight/attachment without any HC access.
function mock(overrides = {}) {
  const f = {
    calls: [], core: { core: { id: 'core-id', name: 'host' }, version: '0.1.18', pid: 1234 },
    caller: { address: 't1b', state: 'live', created_ms: 1, labels: { 'herdr.space': 'remote-space', 'herdr.tab': 'existing-tab' } },
    version: 1,
    value: { metadata: { preserve: true }, spaces: [{ id: 'remote-space', tabs: [{ id: 'existing-tab', name: 'Coordinator',
      root: { id: 'existing-tab', type: 'row', children: [{ id: 'caller-pane', type: 'block', content: { terminal: 't1b' } }] } }] }] },
  };
  f.coreCall = async (method, params) => {
    f.calls.push({ method, params: clone(params) });
    await f.before?.(method, params);
    if (Object.hasOwn(overrides, method)) {
      const value = overrides[method];
      if (value instanceof Error) throw value;
      return clone(typeof value === 'function' ? await value(params, f) : value);
    }
    let result;
    switch (method) {
      case 'server.status': result = f.core; break;
      case 'terminal.get':
        assert.ok(['t1b', 't29'].includes(params.terminal));
        result = params.terminal === 't1b' ? f.caller : f.worker; break;
      case 'doc.get':
        assert.deepEqual(params, { name: 'herdr-app' });
        result = { version: f.version, value: f.value }; break;
      case 'terminal.run':
        assert.equal(f.calls.filter(c => c.method === method).length, 1, 'no spawn retry');
        f.worker = { address: 't29', parent: params.parent, cwd: params.cwd, state: 'live', created_ms: Date.now(), labels: {} };
        result = f.worker; break;
      case 'doc.set':
        assert.ok(f.worker, 'no layout effects before terminal creation');
        assert.equal(params.name, 'herdr-app');
        assert.equal(params.version, f.version);
        f.value = clone(params.value); result = { version: ++f.version }; break;
      case 'terminal.label':
        assert.equal(params.terminal, 't29');
        assert.equal(f.value.spaces[0].tabs[1].root.children[0].content.terminal, 't29', 'document before adoption labels');
        f.worker.labels = clone(params.labels); result = f.worker; break;
      default: assert.fail(`unexpected API method ${method}`);
    }
    const response = clone(result);
    await f.after?.(method, params);
    return response;
  };
  f.launcher = extra => launchers({ ...options, coreCall: f.coreCall, ...extra });
  f.mutations = () => f.calls.filter(c => !['server.status', 'terminal.get', 'doc.get'].includes(c.method));
  return f;
}

test('HC preflights actual caller layout before explicit terminal.run and confirms one dedicated tab', async () => {
  const m = mock();
  const original = clone(m.value);
  const result = await m.launcher().launch(request);
  assert.deepEqual(m.calls.slice(0, 5).map(c => c.method), ['server.status', 'terminal.get', 'doc.get', 'server.status', 'terminal.get']);
  assert.equal(m.calls[5].method, 'terminal.run');
  assert.deepEqual(m.calls[5].params, {
    argv: ['/bin/sh', '-c', "exec pi '-e' '/source/O'\"'\"'Brien $HOME;`echo bad`/index.ts' '--intercom-root' '/project'"],
    cwd: '/project', caller: 't1b', parent: 't1b', outlive_parent: true, no_notify: true, wait: false, keep: false,
  });
  assert.deepEqual(m.mutations().map(c => c.method), ['terminal.run', 'doc.set', 'terminal.label']);
  assert.deepEqual(m.value.spaces[0].tabs[0], original.spaces[0].tabs[0]);
  assert.deepEqual(m.value.metadata, original.metadata);
  assert.equal(m.value.spaces[0].tabs.length, 2);
  const tab = m.value.spaces[0].tabs[1];
  assert.equal(tab.name, 'Intercom (anonymous)');
  assert.equal(result.tab, tab.id);
  assert.equal(result.pane, tab.root.children[0].id);
  assert.equal(result.space, 'remote-space');
  assert.equal(result.terminal, 't29');
  assert.equal(result.terminalCreatedMs, m.worker.created_ms);
  assert.equal(result.coreId, 'core-id');
  assert.equal(result.commandSubmitted, true);
  assert.equal(result.terminalState, 'live');
  assert.equal(result.layoutConfirmed, true);
  assert.equal(result.ui, 'render-unverified');
  assert.equal(result.uiAcknowledged, false);
  assert.match(result.uiReason, /remote UI rendering is not observed/);
  assert.match(result.piReadiness, /not observed/);
  assert.equal(result.registrationAwaited, false);
});

test('HC Linux resume preserves hostile literals through real /bin/sh and fake pi only', { skip: process.platform !== 'linux' }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'intercom-hc-quoting-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, "O'Brien $HOME;`echo bad`");
  await mkdir(cwd);
  await writeFile(path.join(root, 'pi'), '#!/bin/sh\nprintf "%s\\n" "$PWD" "$@"\n', { mode: 0o700 });
  const sessionId = "session'$HOME;`echo bad`";
  const lookups = [];
  const m = mock();
  await m.launcher({ sessionExists: async (...args) => { lookups.push(args); return true; } })
    .launch({ ...request, cwd, workspaceRoot: cwd, sessionId });
  assert.deepEqual(lookups, [[cwd, sessionId]]);
  const { argv, cwd: shellCwd } = m.calls.find(c => c.method === 'terminal.run').params;
  const { stdout } = await promisify(execFile)(argv[0], argv.slice(1), { cwd: shellCwd, env: { PATH: `${root}:/usr/bin:/bin` } });
  assert.deepEqual(stdout.trimEnd().split('\n'), [cwd, '-e', options.extension, '--intercom-root', cwd, '--session', sessionId]);
});

test('HC Windows launch uses encoded PowerShell and literal root/session without provider/task overrides', async () => {
  const m = mock();
  const cwd = "D:/O'Brien $HOME;root";
  const sessionId = "saved'`;not-a-task";
  await m.launcher({ platform: 'win32', extension: "D:/ext/O'Brien/index.ts" })
    .launch({ ...request, cwd, workspaceRoot: cwd, sessionId });
  const { argv } = m.calls.find(c => c.method === 'terminal.run').params;
  assert.deepEqual(argv.slice(0, -1), ['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand']);
  const script = Buffer.from(argv.at(-1), 'base64').toString('utf16le');
  assert.match(script, /Get-Command pi\.ps1/);
  assert.ok(script.includes("Set-Location -LiteralPath 'D:/O''Brien $HOME;root'"));
  assert.ok(script.includes("'-e' 'D:/ext/O''Brien/index.ts'"));
  assert.ok(script.includes("'--intercom-root' 'D:/O''Brien $HOME;root'"));
  assert.ok(script.includes("'--session' 'saved''`;not-a-task'"));
  assert.doesNotMatch(script, /Start-Process|--print|--task|--message|--provider/);
});

test('HC caller must be an explicit local address even with complete legacy environment', async () => {
  for (const id of ['', ' ', 'review', 'remote/t1', '--help', 't1\n', 't1;bad', 'tABC']) {
    await assert.rejects(launchers({ ...options, env: { ...options.env, HC_TERMINAL_ID: id } })
      .launch(request), /local HC_TERMINAL_ID/);
  }
});

test('HC missing layout, bad caller and changed preflight identity refuse all effects', async () => {
  const cases = [
    m => { m.core = null; },
    m => { m.core.core = {}; },
    m => { m.caller.address = 't99'; },
    m => { m.caller.state = 'finished'; },
    m => { delete m.caller.created_ms; },
    m => { m.value = null; },
    m => { m.value.spaces[0].tabs = []; },
    m => { m.value.spaces[0].tabs[0].root.type = 'stack'; },
    m => { m.before = method => { if (method === 'doc.get') m.core.core.id = 'changed'; }; },
    m => { m.before = method => { if (method === 'doc.get') m.caller.created_ms++; }; },
  ];
  for (const change of cases) {
    const m = mock(); change(m);
    await assert.rejects(m.launcher().launch(request), /preflight failed.*no fallback or launch attempted/s);
    assert.deepEqual(m.mutations(), []);
  }
  const m = mock({ 'doc.get': new Error('unavailable') });
  await assert.rejects(m.launcher().launch(request), /preflight failed/);
  assert.deepEqual(m.mutations(), []);
});

test('HC lost or invalid run responses remain uncertain with exactly one spawn and no cleanup', async () => {
  const created = () => ({ address: 't29', parent: 't1b', cwd: '/project', state: 'live', created_ms: Date.now() });
  for (const response of [new Error('timeout'), null, {},
    () => ({ ...created(), address: 't1b' }),
    () => ({ ...created(), address: 'remote/t29' }),
    () => ({ ...created(), parent: 't99' }),
    () => ({ ...created(), cwd: '/other' }),
    () => ({ ...created(), state: 'finished' }),
    () => ({ ...created(), first_message: { sent: true } }),
    () => ({ ...created(), created_ms: undefined }),
    () => ({ ...created(), created_ms: 1 }),
  ]) {
    const m = mock({ 'terminal.run': response });
    await assert.rejects(m.launcher().launch(request), e => {
      assert.equal(e.outcomeUncertain, true);
      assert.match(e.message, /may remain.*no automatic cleanup\/retry\/replacement/s); return true;
    });
    assert.deepEqual(m.mutations().map(c => c.method), ['terminal.run']);
  }
});

test('HC post-spawn identity and placement failures never retry, clean up or fall back', async () => {
  const cases = [
    m => { m.after = method => { if (method === 'terminal.run') m.core.core.id = 'changed'; }; },
    m => { m.after = method => { if (method === 'terminal.run') m.worker.created_ms++; }; },
    m => { m.after = method => { if (method === 'terminal.run') m.value = null; }; },
    m => { m.before = method => { if (method === 'doc.set') throw new Error('CAS conflict'); }; },
    m => { m.after = method => { if (method === 'doc.set') throw new Error('lost write response'); }; },
    m => { m.before = method => { if (method === 'terminal.label') throw new Error('label failure'); }; },
    m => { m.after = method => { if (method === 'terminal.label') m.value.spaces[0].tabs[1].name = 'changed'; }; },
  ];
  for (const change of cases) {
    const m = mock(); change(m);
    await assert.rejects(m.launcher().launch(request), e => e.outcomeUncertain === true && /no automatic cleanup\/retry\/replacement/.test(e.message));
    for (const method of ['terminal.run', 'doc.set', 'terminal.label']) {
      assert.ok(m.calls.filter(c => c.method === method).length <= 1, `${method} must never retry`);
    }
    assert.equal(m.calls.filter(c => c.method === 'terminal.run').length, 1);
    assert.ok(m.mutations().every(c => ['terminal.run', 'doc.set', 'terminal.label'].includes(c.method)));
  }
});

test('HC preserves root isolation and resume storage checks before API access', async () => {
  const strict = launchers({ ...options, sessionExists: async () => assert.fail('no lookup for invalid root') });
  for (const workspaceRoot of [undefined, '', '.', '/bad\0root']) {
    await assert.rejects(strict.launch({ ...request, workspaceRoot, sessionId: 'saved' }), /explicit absolute workspace root/);
  }
  for (const workspaceRoot of ['/', '/other']) {
    await assert.rejects(strict.launch({ ...request, workspaceRoot, sessionId: 'saved' }), /root must equal its working directory/);
  }
  await assert.rejects(launchers({ ...options, sessionExists: async () => false }).launch({ ...request, sessionId: 'missing' }), /saved Pi session not found/);
  await assert.rejects(strict.launch({ ...request, multiplexer: 'none' }), /No terminal fallback/);
});

test('HC name sync uses core layout identity and never falls back to legacy or labels', async () => {
  let calls = 0;
  const adapter = launchers({ ...options, coreCall: async method => {
    calls++; assert.equal(method, 'terminal.get'); throw new Error('core unavailable');
  } });
  await assert.rejects(adapter.syncName('Builder'), /core unavailable/);
  assert.equal(calls, 1);
  await assert.rejects(launchers({ ...options, env: { HC_TERMINAL_ID: '' } }).syncName('Builder'), /HC_TERMINAL_ID/);
});
