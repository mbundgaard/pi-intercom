import test from 'node:test';
import assert from 'node:assert/strict';
import { launchers, psQuote, encoded } from '../dist/launcher.js';
const options = { extension: "D:/a space/O'Brien/index.ts", platform: 'win32', env: { HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'w1', HERDR_PANE_ID: 'w1:p9' }, sessionExists: async () => true };
test('Herdr uses one returned tab/pane, no split/focus, explicit extension/resume args', async () => {
  const calls = [];
  const l = launchers({ ...options, run: async (file, args) => {
    calls.push({ file, args });
    return JSON.stringify({ result: { tab: { tab_id: 'w1:t42' }, root_pane: { pane_id: 'w1:p71' } } });
  } });
  const r = await l.launch({ multiplexer: 'herdr', cwd: "D:/project/O'Brien $HOME;root", workspaceRoot: "D:/project/O'Brien $HOME;root", sessionId: 'session-id' });
  assert.equal(r.registrationAwaited, false);
  assert.deepEqual(calls[0].args, ['tab', 'create', '--workspace', 'w1', '--cwd', "D:/project/O'Brien $HOME;root", '--label', 'Intercom (anonymous)', '--no-focus']);
  assert.deepEqual(calls[1].args.slice(0, 3), ['pane', 'run', 'w1:p71']);
  assert.equal(r.commandSubmitted, true);
  assert.match(r.piReadiness, /not observed/);
  const script = Buffer.from(calls[1].args[3].split(' ').at(-1), 'base64').toString('utf16le');
  assert.match(script, /Get-Command pi\.ps1/);
  assert.match(script, /'D:\/a space\/O''Brien\/index\.ts'/);
  assert.match(script, /'--session' 'session-id'/);
  assert.ok(script.includes("'--intercom-root' 'D:/project/O''Brien $HOME;root'"));
  assert.doesNotMatch(script, /Start-Process|HERDR_.*Remove/);
  assert.ok(!calls.some(c => c.args[0] === 'agent'));
});
test('missing Herdr, resume failure and partial launch failure never fall back or clean up', async () => {
  const missing = launchers({ ...options, env: {}, run: async () => assert.fail('no command') });
  await assert.rejects(missing.launch({ multiplexer: 'herdr', cwd: 'D:/p', workspaceRoot: 'D:/p' }), /no fallback/);
  const noSession = launchers({ ...options, sessionExists: async () => false, run: async () => assert.fail('must not launch') });
  await assert.rejects(noSession.launch({ multiplexer: 'none', cwd: 'D:/p', workspaceRoot: 'D:/p', sessionId: 'missing' }), /not found/);
  let count = 0;
  const partial = launchers({ ...options, run: async () => {
    if (++count === 1) return JSON.stringify({ result: { tab: { tab_id: 't' }, root_pane: { pane_id: 'p' } } });
    throw new Error('agent_not_ready');
  } });
  await assert.rejects(partial.launch({ multiplexer: 'herdr', cwd: 'D:/p', workspaceRoot: 'D:/p' }), /may remain/); assert.equal(count, 2);
});
test('none creates visible terminal with encoded arguments; no inherited Herdr context', async () => {
  let script;
  const l = launchers({ ...options, run: async (file, args) => {
    assert.equal(file, 'powershell.exe');
    script = Buffer.from(args.at(-1), 'base64').toString('utf16le'); return '12345\r\n';
  } });
  const r = await l.launch({ multiplexer: 'none', cwd: "\\\\server\\share\\O'Brien root", workspaceRoot: "\\\\server\\share\\O'Brien root" });
  assert.equal(r.terminalLaunched, true); assert.match(script, /-WindowStyle Normal/); assert.match(script, /-NoExit/);
  const base64 = script.match(/'-EncodedCommand','([^']+)'/)[1];
  const inner = Buffer.from(base64, 'base64').toString('utf16le');
  assert.ok(inner.includes("'--intercom-root' '\\\\server\\share\\O''Brien root'"));
  assert.match(inner, /HERDR_\*/); assert.match(inner, /O''Brien/); assert.match(inner, /'-e'/);
  assert.equal(psQuote("a'b"), "'a''b'"); assert.equal(Buffer.from(encoded('hello'), 'base64').toString('utf16le'), 'hello');
});
test('launcher requires explicit absolute root before session lookup or process creation', async () => {
  const launcher = launchers({ ...options, sessionExists: async () => assert.fail('no lookup'), run: async () => assert.fail('no launch') });
  for (const workspaceRoot of [undefined, '', '.', 'D:relative', 'D:/bad\0root']) {
    await assert.rejects(launcher.launch({ multiplexer: 'herdr', cwd: 'D:/p', workspaceRoot, sessionId: 'saved' }), /explicit absolute workspace root/);
  }
});
test('launcher rejects parent and unrelated roots before session lookup or spawn', async () => {
  const launcher = launchers({ ...options, sessionExists: async () => assert.fail('no lookup'), run: async () => assert.fail('no launch') });
  for (const workspaceRoot of ['D:/', 'D:/parent', 'D:/unrelated']) {
    await assert.rejects(launcher.launch({ multiplexer: 'herdr', cwd: 'D:/parent/child', workspaceRoot, sessionId: 'saved' }), /root must equal its working directory/);
  }
  await assert.rejects(launcher.launch({ multiplexer: 'none', cwd: '\\\\server\\share\\child', workspaceRoot: '\\\\server\\share', sessionId: 'saved' }), /root must equal its working directory/);
});
test('Windows launcher allows platform-equivalent same cwd roots', async () => {
  const launcher = launchers({ ...options, run: async () => JSON.stringify({ result: { tab: { tab_id: 't' }, root_pane: { pane_id: 'p' } } }) });
  const result = await launcher.launch({ multiplexer: 'herdr', cwd: 'D:/Project/./', workspaceRoot: 'd:\\project' });
  assert.equal(result.commandSubmitted, true);
});
test('name sync resolves current pane tab rather than focused tab', async () => {
  const calls = [];
  const l = launchers({ ...options, run: async (file, args) => { calls.push(args); return JSON.stringify({ result: { pane: { tab_id: 'w2:t7' } } }); } });
  await l.syncName('Builder');
  assert.deepEqual(calls, [['pane', 'current', '--current'], ['tab', 'rename', 'w2:t7', 'Builder']]);
});
