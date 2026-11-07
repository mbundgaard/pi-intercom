import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensureMonitorPane, closeMonitorPane } from '../dist/monitor-launcher.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'intercom-monitor-launch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = path.join(root, 'monitor.js'); await writeFile(script, '');
  const caller = { pane_id: 'w:p1', tab_id: 'w:t1', workspace_id: 'w' };
  const monitor = { pane_id: 'w:p2', tab_id: 'w:t1', label: 'Intercom monitor [coordinator]' };
  const calls = [], panes = [caller];
  let failAt;
  const options = { root, script, sessionId: 'coordinator', platform: 'linux', env: { HERDR_ENV: '1', HERDR_PANE_ID: 'w:p1' },
    run: async (file, args) => {
      calls.push(args); assert.equal(file, 'herdr');
      if (args[1] === failAt) throw new Error('injected failure');
      let result;
      switch (args[1]) {
        case 'current': result = { pane: caller }; break;
        case 'list': result = { panes }; break;
        case 'split': monitor.tab_id = caller.tab_id; panes.push({ ...monitor, label: undefined }); result = { pane: monitor }; break;
        case 'create': monitor.tab_id = 'w:t2'; panes.push({ ...monitor, label: undefined }); result = { tab: { tab_id: monitor.tab_id }, root_pane: { pane_id: monitor.pane_id } }; break;
        case 'close': panes.splice(panes.findIndex(p => p.pane_id === args[2]), 1); return '';
        case 'rename': panes.find(p => p.pane_id === args[2]).label = args[3]; result = {}; break;
        case 'swap': result = { swap: { changed: true } }; break;
        case 'layout': result = { layout: { focused_pane_id: caller.pane_id, panes: [
          { pane_id: monitor.pane_id, rect: { y: 0, height: 10 } }, { pane_id: caller.pane_id, rect: { y: 11, height: 30 } },
        ] } }; break;
        case 'run': return '';
        default: assert.fail(args.join(' '));
      }
      return JSON.stringify({ result });
    },
  };
  return { options, calls, panes, monitor, caller, fail: value => { failAt = value; } };
}

test('monitor creation uses live caller IDs, no-focus, verified swap, quoted Node command and reload reuses pane', async t => {
  const f = await fixture(t);
  const result = await ensureMonitorPane(f.options);
  assert.equal(result.pane, 'w:p2');
  assert.deepEqual(f.calls.find(a => a[1] === 'rename'), ['pane', 'rename', 'w:p2', 'Intercom monitor']);
  const split = f.calls.find(a => a[1] === 'split');
  assert.deepEqual(split.slice(0, 6), ['pane', 'split', '--pane', 'w:p1', '--direction', 'down']);
  assert.ok(split.includes('--no-focus'));
  assert.deepEqual(f.calls.find(a => a[1] === 'swap'), ['pane', 'swap', '--source-pane', 'w:p1', '--target-pane', 'w:p2']);
  assert.match(f.calls.find(a => a[1] === 'run')[3], /sh -c/);
  const before = f.calls.length;
  assert.match((await ensureMonitorPane(f.options)).outcome, /existing pane preserved/);
  assert.deepEqual(f.calls.slice(before).map(a => a[1]), ['current', 'list']);
});
test('missing marked pane after confirmed submission creates replacement; unrelated panes stay untouched', async t => {
  const f = await fixture(t); await ensureMonitorPane(f.options);
  f.panes.splice(1, 1);
  await ensureMonitorPane(f.options);
  assert.equal(f.calls.filter(a => a[1] === 'split').length, 2);
  assert.equal(f.calls.some(a => a[1] === 'close'), false);
});
test('uncertain split and unmarked partial launch are fenced across retry', async t => {
  for (const stage of ['split', 'rename']) {
    const f = await fixture(t); f.fail(stage);
    await assert.rejects(ensureMonitorPane(f.options), /no automatic cleanup/);
    const before = f.calls.length; f.fail(undefined);
    await assert.rejects(ensureMonitorPane(f.options), /no retry or duplicate/);
    assert.deepEqual(f.calls.slice(before).map(a => a[1]), ['current', 'list']);
  }
});
test('existing moved or duplicate markers fail without mutation', async t => {
  const f = await fixture(t);
  f.panes.push({ ...f.monitor, tab_id: 'other-tab' });
  await assert.rejects(ensureMonitorPane(f.options), /another tab/);
  f.panes.push({ ...f.monitor, pane_id: 'w:p3' });
  await assert.rejects(ensureMonitorPane(f.options), /Multiple monitor markers/);
  assert.equal(f.calls.some(a => a[1] === 'split'), false);
});
test('non-Herdr skips, missing compiled entry and stale owner reject before splitting', async t => {
  const f = await fixture(t);
  assert.match((await ensureMonitorPane({ ...f.options, env: {} })).outcome, /not inside Herdr/);
  await assert.rejects(ensureMonitorPane({ ...f.options, script: path.join(f.options.root, 'missing.js') }), /ENOENT/);
  await assert.rejects(ensureMonitorPane({ ...f.options, assertCurrent: () => { throw new Error('stale owner'); } }), /stale owner/);
  assert.equal(f.calls.some(a => a[1] === 'split'), false);
});
test('legacy label migrates to simple name and saved identity prevents duplicate creation', async t => {
  const f = await fixture(t);
  f.panes.push({ ...f.monitor });
  await ensureMonitorPane(f.options);
  assert.equal(f.panes[1].label, 'Intercom monitor');
  await ensureMonitorPane(f.options);
  assert.equal(f.calls.filter(a => a[1] === 'rename').length, 1);
  assert.equal(f.calls.some(a => a[1] === 'split' || a[1] === 'run'), false);
});
test('generic label alone is not ownership', async t => {
  const f = await fixture(t);
  f.panes.push({ ...f.monitor, label: 'Intercom monitor' });
  await assert.rejects(ensureMonitorPane(f.options), /Unowned monitor label/);
  assert.equal(f.calls.some(a => a[1] === 'split' || a[1] === 'rename'), false);
});

test('Windows monitor command uses encoded PowerShell and explicit Node executable', async t => {
  const f = await fixture(t);
  await ensureMonitorPane({ ...f.options, platform: 'win32', node: "C:/Node O'Brien/node.exe" });
  const command = f.calls.find(a => a[1] === 'run')[3];
  assert.match(command, /^powershell.exe /);
  const script = Buffer.from(command.split(' ').at(-1), 'base64').toString('utf16le');
  assert.match(script, /C:\/Node O''Brien\/node.exe/);
  assert.match(script, /'--root'/);
});

async function record(f) {
  const directory = path.join(f.options.root, '.pi-intercom');
  const name = (await readdir(directory)).find(name => /^monitor-.*\.json$/.test(name));
  const file = path.join(directory, name);
  return { file, state: JSON.parse(await readFile(file, 'utf8')) };
}
test('new-tab placement persists returned tab and pane, reuses and refuses relocation', async t => {
  for (const platform of ['linux', 'win32']) {
    const f = await fixture(t);
    const options = { ...f.options, platform, placement: 'new-tab' };
    await ensureMonitorPane(options);
    assert.deepEqual(f.calls.find(a => a[0] === 'tab'), ['tab', 'create', '--workspace', 'w', '--cwd', options.root, '--label', 'Intercom monitor', '--no-focus']);
    assert.ok(!f.calls.some(a => ['split', 'swap'].includes(a[1])));
    const saved = (await record(f)).state;
    assert.equal(saved.placement, 'new-tab'); assert.equal(saved.tab, 'w:t2'); assert.equal(saved.stage, 'submitted');
    assert.match((await ensureMonitorPane(options)).outcome, /existing pane preserved/);
    await assert.rejects(ensureMonitorPane(f.options), /close it first/);
    assert.equal(f.calls.filter(a => a[1] === 'create').length, 1);
  }
});
test('close only targets owned monitor pane, observes absence, keeps sibling and allows reopen', async t => {
  for (const placement of ['coordinator-tab', 'new-tab']) {
    const f = await fixture(t); await ensureMonitorPane({ ...f.options, placement });
    f.panes.push({ pane_id: 'w:p3', tab_id: f.monitor.tab_id, label: 'Worker' });
    const result = await closeMonitorPane(f.options);
    assert.match(result.outcome, /absence observed/);
    assert.deepEqual(f.calls.filter(a => a[1] === 'close'), [['pane', 'close', 'w:p2']]);
    assert.ok(f.panes.some(p => p.pane_id === 'w:p3'));
    assert.equal((await record(f)).state.stage, 'closed');
    assert.match((await closeMonitorPane(f.options)).outcome, /no owned monitor pane present/);
    await ensureMonitorPane(f.options);
    assert.equal((await record(f)).state.stage, 'submitted');
  }
});
test('close refuses legacy adoption, moved ownership, changed labels and caller mismatch', async t => {
  const legacy = await fixture(t); legacy.panes.push({ ...legacy.monitor });
  await assert.rejects(closeMonitorPane(legacy.options), /no saved ownership/);
  await ensureMonitorPane(legacy.options);
  await assert.rejects(closeMonitorPane(legacy.options), /lacks launcher-created ownership proof/);
  assert.ok(!legacy.calls.some(a => a[1] === 'close'));
  for (const mutate of [f => { f.panes[1].tab_id = 'other'; }, f => { f.panes[1].label = 'Worker'; }, f => { f.options.env.HERDR_PANE_ID = 'wrong'; }]) {
    const f = await fixture(t); await ensureMonitorPane(f.options); mutate(f);
    await assert.rejects(closeMonitorPane(f.options));
    assert.ok(!f.calls.some(a => a[1] === 'close'));
  }
});
test('uncertain close and tab creation are fenced with no second mutation', async t => {
  for (const stage of ['create', 'close']) {
    const f = await fixture(t);
    if (stage === 'close') await ensureMonitorPane(f.options);
    f.fail(stage);
    const action = stage === 'create' ? () => ensureMonitorPane({ ...f.options, placement: 'new-tab' }) : () => closeMonitorPane(f.options);
    await assert.rejects(action()); f.fail(undefined);
    await assert.rejects(action(), /inspection|partial launch/);
    await assert.rejects(ensureMonitorPane(f.options), /inspection|partial launch/);
    assert.equal(f.calls.filter(a => a[1] === stage).length, 1);
  }
});
test('fresh close preflight rejects changed ownership after pending save without closing', async t => {
  for (const change of [f => { f.panes[1].label = 'Worker'; }, f => { f.panes[1].tab_id = 'moved'; }, f => { f.panes.splice(1, 1); }]) {
    const f = await fixture(t); await ensureMonitorPane(f.options);
    const run = f.options.run; let lists = 0;
    f.options.run = async (file, args) => {
      if (args[1] === 'list' && ++lists === 2) {
        assert.equal((await record(f)).state.stage, 'close_pending'); change(f);
      }
      return run(file, args);
    };
    await assert.rejects(closeMonitorPane(f.options), /ownership changed before close/);
    assert.ok(!f.calls.some(a => a[1] === 'close'));
    assert.equal((await record(f)).state.stage, 'close_pending');
  }
});

test('close acknowledgment without observed absence cannot clear pending ownership', async t => {
  const f = await fixture(t); await ensureMonitorPane(f.options);
  const run = f.options.run;
  f.options.run = async (file, args) => args[1] === 'close' ? JSON.stringify({ result: {} }) : run(file, args);
  await assert.rejects(closeMonitorPane(f.options), /absence not confirmed/);
  assert.equal((await record(f)).state.stage, 'close_pending');
  await assert.rejects(closeMonitorPane(f.options), /partial launch/);
});
test('invalid returned tab identity and lifecycle invalidation preserve pending fences', async t => {
  const f = await fixture(t), run = f.options.run;
  f.options.run = async (file, args) => args[1] === 'create' ? JSON.stringify({ result: { tab: { tab_id: 'w:t1' }, root_pane: { pane_id: 'w:p9' } } }) : run(file, args);
  await assert.rejects(ensureMonitorPane({ ...f.options, placement: 'new-tab' }), /distinct new tab/);
  assert.ok(!f.calls.some(a => ['rename', 'run'].includes(a[1])));
  assert.equal((await record(f)).state.stage, 'tab_pending');
  const g = await fixture(t); await ensureMonitorPane(g.options);
  let stale = false; const original = g.options.run;
  g.options.run = async (file, args) => { const value = await original(file, args); if (args[1] === 'close') stale = true; return value; };
  g.options.assertCurrent = () => { if (stale) throw new Error('stale lifecycle'); };
  await assert.rejects(closeMonitorPane(g.options), /stale lifecycle/);
  assert.equal((await record(g)).state.stage, 'close_pending');
  g.options.assertCurrent = undefined;
  await assert.rejects(closeMonitorPane(g.options), /inspection/);
});
test('old submitted ownership can close, but unowned generic labels in any tab block mutations', async t => {
  const f = await fixture(t); await ensureMonitorPane(f.options);
  const saved = await record(f); delete saved.state.tab; delete saved.state.placement;
  await writeFile(saved.file, JSON.stringify(saved.state));
  assert.match((await closeMonitorPane(f.options)).outcome, /absence observed/);
  const g = await fixture(t); g.panes.push({ pane_id: 'w:p3', tab_id: 'w:t3', label: 'Intercom monitor' });
  await assert.rejects(ensureMonitorPane(g.options), /Unowned monitor label/);
  await assert.rejects(closeMonitorPane(g.options), /Unowned monitor label/);
  assert.ok(!g.calls.some(a => ['close', 'split', 'create'].includes(a[1])));
});

test('open and close share an exclusive lock; no control action runs while held', async t => {
  const f = await fixture(t); await ensureMonitorPane(f.options);
  const { file } = await record(f); await writeFile(`${file}.lock`, '');
  const before = f.calls.length;
  await assert.rejects(closeMonitorPane(f.options), /locked/);
  await assert.rejects(ensureMonitorPane(f.options), /locked/);
  assert.deepEqual(f.calls.slice(before).map(a => a[1]), ['current', 'current']);
});
