import test from 'node:test';
import assert from 'node:assert/strict';
import extension from '../dist/index.js';
import { AgentSession } from '@earendil-works/pi-coding-agent';
import { mkdtemp, mkdir, rm, access, writeFile, readFile } from 'node:fs/promises';
import { Server } from 'node:net';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ConfigStore } from '../dist/config.js';
import { Intercom } from '../dist/runtime.js';
import { listen, send } from '../dist/transport.js';
import { readObservationSnapshot } from '../dist/snapshot.js';

// These exercise the Windows/Linux adapter, but never construct a Pi host or launch a process.
async function adapter(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'intercom-quality-adapter-'));
  const inheritedHerdr = process.env.HERDR_ENV;
  delete process.env.HERDR_ENV;
  const tools = new Map(), events = new Map(), flags = new Map(), flagValues = new Map(), messages = [], notices = [], names = [], widgets = [];
  let id = 'adapter-coordinator', idle = true, name = '', failName = false;
  const pi = {
    registerTool: tool => tools.set(tool.name, tool), on: (event, handler) => events.set(event, handler),
    registerFlag: (name, options) => flags.set(name, options), getFlag: name => flagValues.get(name),
    getSessionName: () => name,
    setSessionName: value => { if (failName) throw new Error('injected name failure'); name = value; names.push(value); },
    sendUserMessage: (content, options) => messages.push({ content, options }),
  };
  extension(pi);
  const ctx = { cwd: root, mode: 'tui', isProjectTrusted: () => true, isIdle: () => idle,
    sessionManager: { getSessionId: () => id, getBranch: () => [], getSessionFile: () => undefined }, ui: { notify: (text, level) => notices.push({ text, level }),
      setWidget: (...args) => widgets.push(args) } };
  t.after(async () => {
    try { await events.get('session_shutdown')(); }
    finally {
      if (inheritedHerdr === undefined) delete process.env.HERDR_ENV; else process.env.HERDR_ENV = inheritedHerdr;
      await rm(root, { recursive: true, force: true });
    }
  });
  return { root, ctx, tools, events, flags, messages, notices, names, widgets,
    setRootFlag: value => flagValues.set('intercom-root', value),
    setId: value => { id = value; }, setIdle: value => { idle = value; }, failName: value => { failName = value; },
    setDelivery: deliver => { pi.sendUserMessage = deliver; },
    start: () => events.get('session_start')({}, ctx),
    prompt: () => events.get('before_agent_start')({ systemPrompt: 'Original system prompt' }, ctx),
    invoke: (operation, args = {}) => tools.get(`intercom_${operation}`).execute('test', args, undefined, undefined, ctx) };
}
const supportedHost = { skip: !['win32', 'linux'].includes(process.platform) ? 'Windows/Linux extension startup adapter' : false };

test('adapter without root flag ignores ancestor config and inherited root env', supportedHost, async t => {
  const a = await adapter(t), store = new ConfigStore(a.root);
  await store.initialize('parent-coordinator', 12345);
  const before = await readFile(store.file, 'utf8');
  const child = path.join(a.root, 'independent-child'); await mkdir(child);
  const oldEnv = process.env.PI_INTERCOM_ROOT;
  process.env.PI_INTERCOM_ROOT = a.root;
  t.after(() => { if (oldEnv === undefined) delete process.env.PI_INTERCOM_ROOT; else process.env.PI_INTERCOM_ROOT = oldEnv; });
  a.ctx.cwd = child; await a.start();
  assert.equal((await new ConfigStore(child).read()).agents[0].sessionId, 'adapter-coordinator');
  assert.equal(await readFile(store.file, 'utf8'), before);
  assert.match((await a.prompt()).systemPrompt, /Identity: Coordinator/);
});
test('explicit CLI root equal to cwd survives replacement but never widens changed cwd', supportedHost, async t => {
  const a = await adapter(t), registrations = [];
  const coordinator = await listen(undefined, async message => { registrations.push(message); });
  t.after(() => coordinator.close());
  await new ConfigStore(a.root).initialize('workspace-coordinator', coordinator.port);
  a.setRootFlag(a.root); a.setId('same-root-worker'); await a.start();
  assert.equal(registrations[0].from, 'same-root-worker');
  assert.match((await a.prompt()).systemPrompt, /Anonymous\/unloaded worker/);
  a.setId('replacement-worker'); await a.start();
  assert.equal(registrations.at(-1).from, 'replacement-worker');
  const child = path.join(a.root, "worker O'Brien"); await mkdir(child);
  a.ctx.cwd = child; await a.start();
  await assert.rejects(a.invoke('list'), /not initialized/);
  assert.ok(a.notices.some(notice => notice.level === 'error'));
  await assert.rejects(access(path.join(child, '.pi-intercom')), /ENOENT/);
});
test('explicit parent root rejects before reading valid parent config or creating resources', supportedHost, async t => {
  const a = await adapter(t), store = new ConfigStore(a.root);
  await store.initialize('parent-coordinator', 12345);
  const before = await readFile(store.file, 'utf8');
  const child = path.join(a.root, 'child'); await mkdir(child);
  a.ctx.cwd = child; a.setRootFlag(a.root);
  const originalRead = ConfigStore.prototype.read, originalListen = Server.prototype.listen;
  let reads = 0, listens = 0;
  ConfigStore.prototype.read = async function() { reads++; return originalRead.call(this); };
  Server.prototype.listen = function() { listens++; assert.fail('no listener for parent root'); };
  try { await a.start(); }
  finally { ConfigStore.prototype.read = originalRead; Server.prototype.listen = originalListen; }
  assert.equal(reads, 0); assert.equal(listens, 0);
  await assert.rejects(a.invoke('list'), /not initialized/);
  assert.equal(await readFile(store.file, 'utf8'), before);
  await assert.rejects(access(path.join(child, '.pi-intercom')), /ENOENT/);
});
test('empty, relative or configless explicit roots never fall back or start a listener', supportedHost, async t => {
  const a = await adapter(t), originalListen = Server.prototype.listen;
  Server.prototype.listen = function() { assert.fail('invalid root must fail before listening'); };
  try {
    for (const root of ['', '.', a.root]) {
      a.setRootFlag(root); await a.start();
      await assert.rejects(a.invoke('list'), /not initialized/);
      await assert.rejects(access(path.join(a.root, '.pi-intercom')), /ENOENT/);
    }
  } finally { Server.prototype.listen = originalListen; }
});

test('empty roster skips monitor; first registered worker requests it without probing liveness', supportedHost, async t => {
  const a = await adapter(t); await a.start();
  assert.equal(a.widgets.length, 0);
  assert.equal(a.messages.length, 0);
  assert.equal(a.notices.some(n => /monitor|Herdr/i.test(n.text)), false);
  await a.invoke('configure_worker', {sessionId:'saved-worker',name:'Builder',description:'Saved worker',port:12346,projectDirectory:'.'});
  assert.ok(a.notices.some(n => /not inside Herdr/.test(n.text)));
  await a.invoke('send', {to:'Coordinator',message:'Messaging works without monitor'});
  assert.equal(a.messages.length, 1);
  const count = a.notices.filter(n => /monitor|Herdr/i.test(n.text)).length;
  a.setId('monitor-replacement-worker'); await a.start();
  assert.equal(a.widgets.length, 0);
  assert.equal(a.notices.filter(n => /monitor|Herdr/i.test(n.text)).length, count, 'worker sessions do not request a monitor');
});

test('startup with a saved disconnected worker still requests monitor without renaming coordinator', supportedHost, async t => {
  const a = await adapter(t), store = new ConfigStore(a.root);
  await store.initialize('adapter-coordinator', 12345);
  await store.configure('adapter-coordinator', {sessionId:'offline-worker',name:'Offline',description:'Retained worker',port:12346,projectDirectory:'.'});
  await a.start();
  assert.ok(a.notices.some(n => /not inside Herdr/.test(n.text)));
  assert.deepEqual(a.names, []);
});

test('phase telemetry uses only public discriminants and never reads reasoning or tool payloads', supportedHost, async t => {
  const a = await adapter(t); await a.start();
  await a.events.get('agent_start')({}, a.ctx);
  const privatePayload = { get delta() { assert.fail('must not read reasoning'); }, type: 'thinking_delta' };
  await a.events.get('message_update')({ assistantMessageEvent: privatePayload, get message() { assert.fail('must not read message'); } }, a.ctx);
  await a.events.get('message_update')({ assistantMessageEvent: privatePayload }, a.ctx);
  await a.events.get('tool_execution_start')({ toolCallId: 't', toolName: 'read', get args() { assert.fail('must not read arguments'); } }, a.ctx);
  await a.events.get('tool_execution_end')({ toolCallId: 't', get result() { assert.fail('must not read result'); } }, a.ctx);
  await a.events.get('agent_settled')({}, a.ctx);
  await a.events.get('session_shutdown')();
  const snapshot = await readObservationSnapshot(a.root);
  const phases = snapshot.events.filter(e => e.event === 'host.activity');
  assert.deepEqual(phases.map(e => [e.phase, e.detail]), [
    ['working', 'processing'], ['thinking', 'thinking'], ['tool', 'reading_files'], ['working', 'processing'], ['idle', 'settled'],
  ]);
});

test('handoff settlement observes only persisted successful tool IDs and new input invalidates readiness', supportedHost, async t => {
  const a = await adapter(t); await a.start();
  const originalSettled = Intercom.prototype.workerSettled, originalStarted = Intercom.prototype.workerStarted;
  let ids, invalidations = 0;
  Intercom.prototype.workerSettled = function(value) { ids = [...value]; };
  Intercom.prototype.workerStarted = function() { invalidations++; };
  t.after(() => { Intercom.prototype.workerSettled = originalSettled; Intercom.prototype.workerStarted = originalStarted; });
  const privateBody = () => assert.fail('must not inspect message bodies or reasoning');
  a.ctx.sessionManager.getBranch = () => [
    {type:'message',message:{role:'assistant',get content(){return privateBody();}}},
    {type:'message',message:{role:'toolResult',toolCallId:'saved',isError:false,get content(){return privateBody();}}},
    {type:'message',message:{role:'toolResult',toolCallId:'failed',isError:true,get content(){return privateBody();}}},
    {type:'custom',get message(){return privateBody();}},
  ];
  await a.events.get('input')({},a.ctx);
  await a.events.get('agent_start')({},a.ctx);
  await a.events.get('agent_settled')({},a.ctx);
  assert.equal(invalidations,2); assert.deepEqual(ids,['saved']);
});

test('SDK blocks nested handoff execution while top-level persisted-result proof remains valid', supportedHost, async t => {
  const a = await adapter(t); await a.start();
  const definition = a.tools.get('intercom_report_handoff');
  assert.equal(definition.exposure, 'model-only');
  for (const [name, tool] of a.tools) if (name !== definition.name) assert.equal(tool.exposure, 'direct');
  const originalTool = Intercom.prototype.tool, originalSettled = Intercom.prototype.workerSettled;
  let executions = 0, settledIds;
  Intercom.prototype.tool = async function(operation, _args, id) {
    executions++; assert.equal(operation, 'report_handoff'); assert.equal(id, 'top-level-handoff');
    return { saved: true, closure: 'awaiting_turn_settlement' };
  };
  Intercom.prototype.workerSettled = function(ids) { settledIds = [...ids]; };
  t.after(() => { Intercom.prototype.tool = originalTool; Intercom.prototype.workerSettled = originalSettled; });
  // Use the installed SDK's callable filter AND execution pipeline, not a copied
  // exposure rule: even a caller that knows the hidden name cannot invoke it.
  const sdk = AgentSession.prototype;
  assert.equal(typeof sdk._getCallableTools, 'function');
  assert.equal(typeof sdk._executeNestedToolCall, 'function');
  const host = {
    _toolDefinitions: new Map([...a.tools].map(([name, tool]) => [name, { definition: tool }])),
    _toolRegistry: new Map([...a.tools].map(([name, tool]) => [name, { ...tool,
      execute: (id, args, signal, update) => tool.execute(id, args, signal, update, a.ctx),
    }])),
    getActiveToolNames: () => [...a.tools.keys()],
    _getToolExposure: sdk._getToolExposure,
    _getCallableTools: sdk._getCallableTools,
    _findLastAssistantMessage: () => ({ role: 'assistant', content: [] }),
    agent: { toolExecution: 'parallel', state: { messages: [], tools: [] } },
    _extensionRunner: { emit: async () => {} }, _emit: () => {},
  };
  assert.ok(!host._getCallableTools().some(tool => tool.name === definition.name));
  assert.ok(host._getCallableTools().some(tool => tool.name === 'intercom_worker_status'));
  const result = await sdk._executeNestedToolCall.call(host, 'parent', definition.name, { jobId: 'job', summary: 'Public handoff' }, {});
  assert.equal(result.isError, true);
  assert.match(result.result.content[0].text, /not found/);
  assert.equal(executions, 0, 'nested invocation must not enter Intercom or save a handoff');
  await definition.execute('top-level-handoff', { jobId: 'job', summary: 'Public handoff' }, undefined, undefined, a.ctx);
  assert.equal(executions, 1);
  a.ctx.sessionManager.getBranch = () => [{ type: 'message', message: { role: 'toolResult', toolCallId: 'top-level-handoff', isError: false } }];
  await a.events.get('agent_settled')({}, a.ctx);
  assert.deepEqual(settledIds, ['top-level-handoff']);
});

test('single extension registers all agreed tools without starting resources in factory', async () => {
  const tools = new Map(), events = new Map(), flags = new Map();
  extension({ registerTool: t => tools.set(t.name, t), on: (name, handler) => events.set(name, handler),
    registerFlag: (name, options) => flags.set(name, options), getFlag: () => assert.fail('flags resolve only during session_start') });
  assert.equal(flags.get('intercom-root').type, 'string');
  assert.equal(flags.get('intercom-root').default, undefined);
  assert.equal(tools.size, 16);
  assert.deepEqual([...events.keys()], ['session_start', 'session_shutdown', 'input', 'agent_start', 'agent_settled', 'message_update', 'tool_execution_start', 'tool_execution_end', 'before_agent_start']);
  const configure = tools.get('intercom_configure_worker');
  assert.deepEqual([...configure.parameters.required].sort(), ['description', 'name', 'port', 'projectDirectory', 'sessionId']);
  assert.match(tools.get('intercom_stop_worker').description, /disabled/);
  assert.match(tools.get('intercom_reload_worker').description, /NOT Pi extension reload/);
  assert.match(tools.get('intercom_stop_reminders').description, /Coordinator only/);
  assert.deepEqual(Object.keys(tools.get('intercom_stop_reminders').parameters.properties), []);
  await assert.rejects(tools.get('intercom_list').execute('test', {}, undefined, undefined, {}), /not initialized/);
  await events.get('session_shutdown')();
  await events.get('session_shutdown')();
});

test('reminder stop tool routes through runtime with the owning cancellation signal', supportedHost, async t => {
  const a = await adapter(t); await a.start();
  const original = Intercom.prototype.tool;
  const controller = new AbortController();
  let received;
  Intercom.prototype.tool = async function(operation, args, id, signal) {
    received = { operation, args, id, signal };
    return { stopped: true };
  };
  t.after(() => { Intercom.prototype.tool = original; });
  const tool = a.tools.get('intercom_stop_reminders');
  const result = await tool.execute('stop-test', {}, controller.signal, undefined, a.ctx);
  assert.deepEqual(received, { operation: 'stop_reminders', args: {}, id: 'stop-test', signal: controller.signal });
  assert.deepEqual(JSON.parse(result.content[0].text), { stopped: true });
  received = undefined; controller.abort();
  await assert.rejects(tool.execute('cancelled', {}, controller.signal, undefined, a.ctx), /abort/i);
  assert.equal(received, undefined, 'an already-cancelled tool must not reach runtime');
});

test('adapter rejects untrusted/noninteractive startup before creating config', supportedHost, async t => {
  const a = await adapter(t);
  a.ctx.isProjectTrusted = () => false;
  await assert.rejects(a.start(), /trust/);
  await assert.rejects(access(path.join(a.root, '.pi-intercom', 'config.json')), /ENOENT/);
  await assert.rejects(a.invoke('list'), /not initialized/);
  a.ctx.isProjectTrusted = () => true; a.ctx.mode = 'rpc';
  await assert.rejects(a.start(), /interactive/);
  await assert.rejects(access(path.join(a.root, '.pi-intercom', 'config.json')), /ENOENT/);
  assert.equal(a.messages.length, 0);
});

test('adapter startup is passive, adds responsibility, routes idle/steering and replaces session listener', supportedHost, async t => {
  const a = await adapter(t); await a.start();
  assert.equal(a.messages.length, 0);
  assert.deepEqual(a.names, []);
  const prompt = await a.prompt();
  assert.match(prompt.systemPrompt, /^Original system prompt/);
  assert.match(prompt.systemPrompt, /Identity: Coordinator \(adapter-coordinator\)/);
  assert.match(prompt.systemPrompt, /Responsibility is not a work assignment/);
  const store = new ConfigStore(a.root), old = (await store.read()).agents[0];
  await a.invoke('send', { to: 'Coordinator', message: 'Idle message' });
  assert.deepEqual(a.messages.at(-1).options, { deliverAs: 'steer' });
  a.setIdle(false);
  await a.invoke('send', { to: 'Coordinator', message: 'Busy message' });
  assert.deepEqual(a.messages.at(-1).options, { deliverAs: 'steer' });
  // A replaced session must not inherit the old coordinator role or listener.
  a.setId('replacement-worker');
  await a.start();
  await assert.rejects(a.invoke('create_worker'), /permission/);
  assert.match((await a.prompt()).systemPrompt, /Anonymous\/unloaded worker/);
  await assert.rejects(send(old.port, { version: 1, kind: 'message', from: old.sessionId, to: old.sessionId,
    payload: { message: 'Must not reach old session' } }));
  await a.events.get('session_shutdown')();
  await assert.rejects(a.invoke('list'), /not initialized/);
  assert.equal(await a.prompt(), undefined);
});

test('adapter always supplies steering: installed host keeps idle normal and handles idle-snapshot to busy-acceptance race', supportedHost, async t => {
  // Source-backed mocked compatibility probe, not a live Pi session. Deliberately
  // fail if the pinned host changes this branch rather than testing stale copied behavior.
  const hostSource = await readFile(fileURLToPath(new URL('./core/agent-session.js', import.meta.resolve('@earendil-works/pi-coding-agent'))), 'utf8');
  assert.match(hostSource, /streamingBehavior: options\?\.deliverAs/);
  const start = hostSource.indexOf('// If streaming, queue via steer()');
  // Pi1.4 validates the model directly after the unchanged queue branch;
  //0.84 flushed pending bash first. Accept only these known boundary markers.
  const boundaries = ['// Flush any pending bash', '// Validate model'].map(marker => hostSource.indexOf(marker, start)).filter(index => index > start);
  const end = boundaries.length ? Math.min(...boundaries) : -1;
  assert.ok(start >= 0 && end > start, 'installed prompt streaming branch must remain identifiable');
  const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
  const accept = new AsyncFunction('options', 'expandedText', 'currentImages',
    `const preflightResult = undefined; ${hostSource.slice(start, end)} return 'normal idle prompt continues';`);
  const queued = [], host = { isStreaming: true,
    _queueSteer: async text => { queued.push(text); },
    _queueFollowUp: async () => assert.fail('must not switch to follow-up delivery') };
  await assert.rejects(accept.call(host, undefined, 'negative control'), /Agent is already processing/);
  const a = await adapter(t); await a.start();
  const submissions = [];
  let busyAtAcceptance = false;
  a.setDelivery((content, options) => {
    // Pi can await input hooks after Intercom samples isIdle; another message can
    // start processing there. Reproduce that change without launching any host.
    submissions.push(Promise.resolve().then(() => {
      host.isStreaming = busyAtAcceptance;
      return accept.call(host, { streamingBehavior: options?.deliverAs }, content);
    }).then(value => ({ value }), error => ({ error })));
  });
  await a.invoke('send', { to: 'Coordinator', message: 'Idle normal prompt' });
  assert.deepEqual(await submissions[0], { value: 'normal idle prompt continues' });
  assert.equal(queued.length, 0, 'explicit steering does not queue when host is idle');
  // ctx.isIdle remains true: the runtime snapshot is deliberately stale.
  busyAtAcceptance = true;
  await a.invoke('send', { to: 'Coordinator', message: 'Race-safe incoming prompt' });
  assert.equal((await submissions[1]).error, undefined);
  assert.equal(queued.length, 1); assert.match(queued[0], /Race-safe incoming prompt/);
});

test('adapter anonymous configure/reload loads responsibility without a work turn; name errors remain explicit', supportedHost, async t => {
  const a = await adapter(t), registrations = [];
  const coordinator = await listen(undefined, async message => { registrations.push(message); });
  t.after(() => coordinator.close());
  const store = new ConfigStore(a.root); await store.initialize('other-coordinator', coordinator.port);
  a.setId('adapter-worker'); await a.start();
  assert.equal(registrations.length, 1); assert.equal(registrations[0].kind, 'registration');
  assert.match((await a.prompt()).systemPrompt, /Anonymous\/unloaded worker/);
  const workerPort = registrations[0].payload.port;
  await store.configure('other-coordinator', { sessionId: 'adapter-worker', name: 'Quality', port: workerPort,
    projectDirectory: '.', description: 'Only review explicitly assigned work' });
  assert.match((await a.prompt()).systemPrompt, /Anonymous\/unloaded worker/);
  const control = { version: 1, kind: 'reload', from: 'other-coordinator', to: 'adapter-worker', payload: {} };
  a.failName(true);
  await assert.rejects(send(workerPort, control), /injected name failure/);
  assert.equal(a.messages.length, 0);
  assert.match((await a.prompt()).systemPrompt, /Only review explicitly assigned work/);
  // Failed name sync leaves useful endpoint and loaded responsibility intact, with explicit reload recovery.
  a.failName(false); await send(workerPort, control);
  assert.deepEqual(a.names, ['Quality']);
  assert.equal(a.messages.length, 0);
  await send(workerPort, { ...control, kind: 'message', payload: { message: 'Explicit review task' } });
  assert.equal(a.messages.length, 1);
  assert.match(a.messages[0].content, /Explicit review task/);
});

test('coordinator startup opens only the messaging listener and activity hooks stay passive', supportedHost, async t => {
  const a = await adapter(t), bound = [];
  const originalListen = Server.prototype.listen;
  Server.prototype.listen = function(...args) {
    this.once('listening', () => { const address = this.address(); if (address && typeof address !== 'string') bound.push(address.port); });
    return originalListen.apply(this, args);
  };
  try { await a.start(); } finally { Server.prototype.listen = originalListen; }
  const config = await new ConfigStore(a.root).read();
  assert.deepEqual(bound, [config.agents[0].port]);
  assert.equal(a.notices.some(n => /read-only dashboard:|http:\/\//.test(n.text)), false);
  const list = JSON.parse((await a.invoke('list')).content[0].text);
  assert.equal(list.dashboardUrl, undefined);
  a.setIdle(false);
  await a.events.get('agent_start')({ message: 'PRIVATE_EVENT_BODY' }, a.ctx);
  a.setIdle(true);
  await a.events.get('agent_settled')({ message: 'PRIVATE_EVENT_BODY' }, a.ctx);
  assert.equal(a.messages.length, 0, 'activity telemetry must not prompt a worker');
  await a.events.get('session_shutdown')();
  await assert.rejects(send(bound[0], { version: 1, kind: 'message', from: 'adapter-coordinator', to: 'adapter-coordinator', payload: { message: 'closed' } }));
  const snapshot = await readObservationSnapshot(a.root);
  const activity = snapshot.events.filter(event => event.event === 'host.activity');
  assert.deepEqual(activity.map(event => [event.outcome, event.busy]), [['started', true], ['settled', false]]);
  assert.doesNotMatch(JSON.stringify(snapshot.events), /PRIVATE_EVENT_BODY|task\.completed/);
});

test('failed legacy metadata migration leaves messaging usable', supportedHost, async t => {
  const a = await adapter(t), store = new ConfigStore(a.root);
  await store.initialize('adapter-coordinator', 12345);
  const legacy = await store.read(); legacy.agents[0].dashboardPort = 34568;
  await writeFile(store.file, JSON.stringify(legacy));
  const originalUpdate = ConfigStore.prototype.update;
  ConfigStore.prototype.update = function(id, mutate, guard) {
    return originalUpdate.call(this, id, async config => {
      const hadLegacy = config.agents.some(agent => agent.dashboardPort !== undefined);
      await mutate(config);
      if (hadLegacy && !config.agents.some(agent => agent.dashboardPort !== undefined)) throw new Error('injected migration failure');
    }, guard);
  };
  try { await a.start(); } finally { ConfigStore.prototype.update = originalUpdate; }
  assert.ok(a.notices.some(notice => ['warning', 'error'].includes(notice.level) && /legacy|migration|metadata/i.test(notice.text)));
  assert.equal(JSON.parse(await readFile(store.file, 'utf8')).agents[0].dashboardPort, 34568);
  await a.invoke('send', { to: 'Coordinator', message: 'Messaging survives migration failure' });
  assert.equal(a.messages.length, 1);
});

test('coordinator startup removes legacy dashboardPort without exposing a browser URL', supportedHost, async t => {
  const a = await adapter(t), store = new ConfigStore(a.root);
  await store.initialize('adapter-coordinator', 12345);
  const legacy = await store.read(); legacy.agents[0].dashboardPort = 34568;
  await writeFile(store.file, JSON.stringify(legacy));
  await a.start();
  assert.equal(JSON.parse(await readFile(store.file, 'utf8')).agents[0].dashboardPort, undefined);
  const list = JSON.parse((await a.invoke('list')).content[0].text);
  assert.equal(list.dashboardUrl, undefined);
  await a.invoke('send', { to: 'Coordinator', message: 'Messaging survives browser retirement' });
  assert.equal(a.messages.length, 1);
});

test('shutdown during pending legacy migration fences the write and new monitor setup', supportedHost, async t => {
  const a = await adapter(t), store = new ConfigStore(a.root), bound = [];
  // Force the supported occupied-port fallback deterministically. Counting bind
  // attempts as listeners previously made this test flaky when 12345 was busy.
  const occupied = new Server();
  await new Promise((resolve, reject) => { occupied.once('error', reject); occupied.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => occupied.close(resolve)));
  await store.initialize('adapter-coordinator', occupied.address().port);
  const legacy = await store.read(); legacy.agents[0].dashboardPort = 34568;
  await writeFile(store.file, JSON.stringify(legacy));
  const originalUpdate = ConfigStore.prototype.update, originalListen = Server.prototype.listen;
  let entered, release;
  const pendingWrite = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  ConfigStore.prototype.update = function(id, mutate, guard) {
    return originalUpdate.call(this, id, async config => {
      const hadLegacy = config.agents.some(agent => agent.dashboardPort !== undefined);
      await mutate(config);
      if (hadLegacy && !config.agents.some(agent => agent.dashboardPort !== undefined)) { entered(); await gate; }
    }, guard);
  };
  Server.prototype.listen = function(...args) {
    const failed = () => this.off('listening', listening);
    const listening = () => {
      this.off('error', failed);
      const address = this.address();
      if (address && typeof address !== 'string') bound.push(address.port);
    };
    this.once('listening', listening);
    this.once('error', failed);
    try { return originalListen.apply(this, args); }
    catch (error) { this.off('listening', listening); this.off('error', failed); throw error; }
  };
  let starting;
  try {
    starting = a.start();
    await Promise.race([pendingWrite, starting.then(() => { throw new Error('startup ended before migration'); })]);
    await a.events.get('session_shutdown')();
    release(); await starting;
  } finally {
    release();
    ConfigStore.prototype.update = originalUpdate; Server.prototype.listen = originalListen;
    await starting;
  }
  assert.equal(bound.length, 1);
  assert.equal(a.notices.some(notice => /monitor|Herdr/i.test(notice.text)), false, 'obsolete startup never reaches monitor ensure');
  const saved = JSON.parse(await readFile(store.file, 'utf8'));
  assert.equal(saved.agents[0].dashboardPort, 34568, 'guard prevents obsolete migration write');
  await assert.rejects(send(bound[0], { version: 1, kind: 'message', from: 'adapter-coordinator', to: 'adapter-coordinator', payload: { message: 'closed' } }));
  await assert.rejects(a.invoke('list'), /not initialized/);
});

test('worker name-sync failure still retains its endpoint and configured permissions', supportedHost, async t => {
  const a = await adapter(t); await a.start();
  await a.invoke('configure_worker', {sessionId:'name-failure-worker',name:'Builder',description:'Saved worker',port:12346,projectDirectory:'.'});
  a.setId('name-failure-worker'); a.failName(true); await a.start();
  assert.ok(a.notices.some(n => /Name\/responsibility synchronization failed/.test(n.text)));
  await a.invoke('list');
});

test('coordinator startup does not attempt name synchronization; malformed config reports failure', supportedHost, async t => {
  const a = await adapter(t); a.failName(true); await a.start();
  assert.equal(a.notices.some(n => /Name\/responsibility synchronization failed/.test(n.text)), false);
  assert.deepEqual(a.names, []);
  assert.equal(a.messages.length, 0);
  await a.invoke('list');
  await a.invoke('send', { to: 'Coordinator', message: 'Endpoint retained' });
  assert.equal(a.messages.length, 1);
  await a.events.get('session_shutdown')();
  const store = new ConfigStore(a.root); await writeFile(store.file, '{broken');
  await a.start();
  assert.ok(a.notices.some(n => n.level === 'error'));
  await assert.rejects(a.invoke('list'), /not initialized/);
});
