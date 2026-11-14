// Explicit live check: uses a real core and production layout adapter, no model or Pi worker.
// It briefly creates one terminal/tab, then removes only those confirmed test resources.
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { withCoreSession, locateTerminalTab } from '../dist/herdr-core.js';
import { preflightCoreWorkerLayout, attachCoreWorkerLayout } from '../dist/core-worker-layout.js';

if (process.argv[2] !== '--create-test-terminal' || process.argv.length !== 3) {
  throw new Error('Explicit --create-test-terminal required. This creates a real temporary terminal and tab; no core restart is performed.');
}
const caller = process.env.HC_TERMINAL_ID;
if (!caller) throw new Error('Run inside the Herdr terminal being diagnosed');
const root = process.cwd();
const directory = path.join(root, '.pi-intercom');
await mkdir(directory, { recursive: true });
const record = path.join(directory, 'herdr-live-check.pending.json');
const proof = { caller, root, stage: 'preflight', terminal: undefined, created: undefined, tab: undefined };
await writeFile(record, JSON.stringify(proof), { flag: 'wx', mode: 0o600 });
const save = async () => writeFile(record, JSON.stringify(proof), { mode: 0o600 });
try {
  await withCoreSession(async call => {
    const initial = await call('doc.get', {name:'herdr-app'});
    const original = locateTerminalTab(initial.value, caller);
    const title = original.tab.name;
    const ticket = await preflightCoreWorkerLayout({caller,cwd:root,workspaceRoot:root,name:'Intercom integration check'},call);
    proof.stage = 'run_pending'; await save();
    const created = await call('terminal.run', {
      argv:[process.execPath,'-e','console.log("Intercom live integration check"); setTimeout(() => {}, 120000)'],
      cwd:root,caller,parent:caller,outlive_parent:true,no_notify:true,wait:false,keep:false,
    });
    proof.terminal = created.address; proof.created = created.created_ms;
    proof.stage = 'attach_pending'; await save();
    const attached = await attachCoreWorkerLayout(ticket,created,call);
    proof.tab = attached.tab; proof.stage = 'attached'; await save();
    const running = await call('terminal.get',{terminal:created.address});
    assert.equal(running.state,'live'); assert.equal(running.created_ms,created.created_ms);
    assert.equal(running.parent,caller);
    const document = await call('doc.get',{name:'herdr-app'});
    const own = locateTerminalTab(document.value,created.address);
    assert.equal(own.tab.id,attached.tab);
    assert.equal(locateTerminalTab(document.value,caller).tab.name,title);
    const inventory = await call('terminal.list',{all:true});
    assert.ok(Array.isArray(inventory.terminals));
    assert.ok(!inventory.terminals.some(t=>t.parent===created.address));
    proof.stage = 'stop_pending'; await save();
    await call('terminal.kill',{terminal:created.address});
    const ended = await call('terminal.get',{terminal:created.address});
    assert.equal(ended.state,'finished'); assert.equal(ended.created_ms,created.created_ms);
    const latest = await call('doc.get',{name:'herdr-app'});
    const at = locateTerminalTab(latest.value,created.address);
    assert.equal(at.tab.id,attached.tab);
    assert.equal(at.tab.root.children.length,1);
    assert.equal(at.tab.root.children[0].content.terminal,created.address);
    assert.ok(!at.tab.root.floating?.length);
    at.space.tabs.splice(at.space.tabs.indexOf(at.tab),1);
    const written = await call('doc.set',{name:'herdr-app',version:latest.version,value:latest.value});
    assert.equal(written.version,latest.version+1);
    const final = await call('doc.get',{name:'herdr-app'});
    assert.deepEqual(final.value,latest.value);
    assert.equal(locateTerminalTab(final.value,caller).tab.name,title);
    proof.stage = 'complete'; await save();
  },{requiredMethods:['terminal.get','terminal.list','terminal.run','terminal.kill','terminal.label','doc.get','doc.set']});
  const completed = record.replace('.pending.json',`.completed-${Date.now()}.json`);
  await rename(record,completed);
  console.log(JSON.stringify({passed:true,terminal:proof.terminal,tab:proof.tab,terminalFinished:true,testTabRemoved:true,coordinatorTitlePreserved:true,piWorkerStarted:false,remoteRenderingVerified:false,evidence:completed}));
} catch (error) {
  console.error(`Live check failed at ${proof.stage}. Inspect ${record}; no automatic replay or uncertain cleanup.`);
  throw error;
}
