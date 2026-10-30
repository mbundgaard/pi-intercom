import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { parseArguments, parseEnvironment, registryURL, validateExpected, verifyMetadata, verifyTarball, verifyProvenance, verifyPublished } from '../scripts/verify-published.mjs';

const expected = { version: '0.6.1', commit: 'f32e1eabee2fa210e88f821ec03071d285fd0b6e', repo: 'comput-sh/pi-intercom', workflow: '.github/workflows/publish.yml', runId: '36774874526', runAttempt: '1' };
const local = Buffer.from('exact locally packed archive bytes');
const digest = (algorithm, encoding = 'hex') => createHash(algorithm).update(local).digest(encoding);
const tarball = 'https://registry.npmjs.org/@comput/pi-intercom/-/pi-intercom-0.6.1.tgz';
const attestations = 'https://registry.npmjs.org/-/npm/v1/attestations/@comput%2fpi-intercom@0.6.1';
const metadata = () => ({ name: '@comput/pi-intercom', version: expected.version, gitHead: expected.commit, dist: {
  tarball, integrity: `sha512-${digest('sha512', 'base64')}`, shasum: digest('sha1'),
  attestations: { url: attestations, provenance: { predicateType: 'https://slsa.dev/provenance/v1' } },
} });
// Public npm0.6.1 SLSAv1 shape, with fixture archive digest; no signatures are verified.
const statement = () => ({
  _type: 'https://in-toto.io/Statement/v1', predicateType: 'https://slsa.dev/provenance/v1',
  subject: [{ name: 'pkg:npm/%40comput/pi-intercom@0.6.1', digest: { sha512: digest('sha512') } }],
  predicate: { buildDefinition: {
    buildType: 'https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1',
    externalParameters: { workflow: { ref: 'refs/tags/v0.6.1', repository: 'https://github.com/comput-sh/pi-intercom', path: '.github/workflows/publish.yml' } },
    resolvedDependencies: [{ uri: 'git+https://github.com/comput-sh/pi-intercom@refs/tags/v0.6.1', digest: { gitCommit: expected.commit } }],
  }, runDetails: { metadata: { invocationId: 'https://github.com/comput-sh/pi-intercom/actions/runs/36774874526/attempts/1' } } },
});
const bundle = (value = statement()) => ({ attestations: [{ predicateType: 'https://slsa.dev/provenance/v1', bundle: { dsseEnvelope: {
  payloadType: 'application/vnd.in-toto+json', payload: Buffer.from(JSON.stringify(value)).toString('base64'),
} } }] });
const json = value => new Response(JSON.stringify(value), { status: 200 });
function harness(override) {
  let time = 0;
  const calls = [], delays = [];
  return { calls, delays, dependencies: {
    now: () => time,
    delay: async ms => { delays.push(ms); time += ms; },
    fetch: async (url, options) => {
      calls.push(url);
      assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'manual');
      assert.equal(options.credentials, 'omit'); assert.ok(options.signal instanceof AbortSignal);
      const response = await override?.(url, calls.length, options);
      if (response) return response;
      if (url === tarball) return new Response(local);
      if (url === attestations) return json(bundle());
      return json(metadata());
    },
  } };
}

test('exact metadata, archive bytes/hashes and public SLSAv1 linkage pass without signature claims', async () => {
  const dist = verifyMetadata(metadata(), expected);
  assert.equal(verifyTarball(local, Buffer.from(local), dist), digest('sha512'));
  const result = verifyProvenance(bundle(), expected, digest('sha512'));
  assert.equal(result.linkageChecked, true); assert.equal(result.signaturesVerified, false);
  const h = harness();
  assert.deepEqual(await verifyPublished(expected, local, h.dependencies), result);
  assert.equal(h.calls.length, 3); assert.deepEqual(h.delays, []);
});

test('metadata, URL and archive mismatches fail closed', () => {
  for (const mutate of [m => m.name = 'another-package', m => m.version = '0.6.2', m => m.gitHead = '0'.repeat(40), m => delete m.dist.attestations,
    m => m.dist.integrity = 'sha1-other', m => m.dist.tarball = 'https://evil.example/file', m => m.dist.attestations.url = 'http://registry.npmjs.org/file']) {
    const m = metadata(); mutate(m); assert.throws(() => verifyMetadata(m, expected));
  }
  for (const url of ['http://registry.npmjs.org/file', 'https://registry.npmjs.org.evil.example/file', 'https://user:secret@registry.npmjs.org/file',
    'https://registry.npmjs.org:444/file', 'https://registry.npmjs.org/file?token=secret', 'https://registry.npmjs.org/file#fragment', 'https://registry.npmjs.org/a/../file']) assert.throws(() => registryURL(url));
  const dist = metadata().dist;
  assert.throws(() => verifyTarball(local, Buffer.from('different bytes'), dist));
  assert.throws(() => verifyTarball(local, local, { ...dist, integrity: `sha512-${Buffer.alloc(64).toString('base64')}` }));
  assert.throws(() => verifyTarball(local, local, { ...dist, shasum: '0'.repeat(40) }));
});

test('every provenance identity and ambiguity mismatch is rejected', () => {
  const mutations = [s => s._type = 'unknown', s => s.predicateType = 'unknown', s => s.subject.push(s.subject[0]), s => s.subject[0].name = 'other',
    s => s.subject[0].digest.sha512 = '0'.repeat(128), s => s.predicate.buildDefinition.buildType = 'unknown',
    s => s.predicate.buildDefinition.externalParameters.workflow.repository += '-other', s => s.predicate.buildDefinition.externalParameters.workflow.path = '.github/workflows/other.yml',
    s => s.predicate.buildDefinition.externalParameters.workflow.ref = 'refs/heads/main',
    s => s.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit = '0'.repeat(40), s => s.predicate.buildDefinition.resolvedDependencies[0].uri += '-other',
    s => s.predicate.buildDefinition.resolvedDependencies.push(s.predicate.buildDefinition.resolvedDependencies[0]),
    s => s.predicate.runDetails.metadata.invocationId = 'https://github.com/comput-sh/pi-intercom/actions/runs/36774874526/attempts/2'];
  for (const mutate of mutations) { const value = statement(); mutate(value); assert.throws(() => verifyProvenance(bundle(value), expected, digest('sha512'))); }
  const duplicate = bundle(); duplicate.attestations.push(duplicate.attestations[0]); assert.throws(() => verifyProvenance(duplicate, expected, digest('sha512')));
  for (const payload of ['not base64!', Buffer.from('not json').toString('base64'), '']) {
    const value = bundle(); value.attestations[0].bundle.dsseEnvelope.payload = payload;
    assert.throws(() => verifyProvenance(value, expected, digest('sha512')));
  }
});

test('only visibility and transient transport failures retry; hard errors stop immediately', async () => {
  for (const status of [404, 408, 429, 500, 503]) {
    const h = harness((_url, call) => call === 1 ? new Response('', { status }) : undefined);
    await verifyPublished(expected, local, h.dependencies); assert.deepEqual(h.delays, [30000]);
  }
  for (const response of [new Response('', { status: 302, headers: { location: 'https://evil.example/' } }), new Response('', { status: 403 }), new Response('{broken'), json({ ...metadata(), version: 'wrong' })]) {
    const h = harness(() => response);
    await assert.rejects(verifyPublished(expected, local, h.dependencies), /verification failed/);
    assert.equal(h.calls.length, 1); assert.deepEqual(h.delays, []);
  }
  const network = harness((_url, call) => { if (call === 1) throw new Error('private credentials'); });
  await verifyPublished(expected, local, network.dependencies); assert.equal(network.delays.length, 1);
  const brokenRead = harness((_url, call) => call === 1 ? new Response(new ReadableStream({ start(controller) { controller.error(new Error('private body')); } })) : undefined);
  await verifyPublished(expected, local, brokenRead.dependencies); assert.equal(brokenRead.delays.length, 1);
});

test('polling deadline and attempt cap terminate without retry-publish', async () => {
  const h = harness(() => new Response('', { status: 404 }));
  await assert.rejects(verifyPublished(expected, local, h.dependencies));
  assert.equal(h.delays.reduce((sum, ms) => sum + ms, 0), 900000);
  assert.equal(h.calls.length, 30);
  const frozen = harness(() => new Response('', { status: 404 }));
  frozen.dependencies.now = () => 0; frozen.dependencies.delay = async () => {};
  await assert.rejects(verifyPublished(expected, local, frozen.dependencies));
  assert.equal(frozen.calls.length, 31);
});

test('whole-response deadline aborts stalled fetch and stalled body reads', async () => {
  for (const bodyOnly of [false, true]) {
    const times = [0, 899999, 899999, 900000];
    let signal, calls = 0;
    await assert.rejects(verifyPublished(expected, local, {
      now: () => times.shift() ?? 900000,
      delay: async () => assert.fail('budget already exhausted'),
      fetch: async (_url, options) => {
        calls++; signal = options.signal;
        if (bodyOnly) return new Response(new ReadableStream({ start() {}, cancel() {} }));
        return new Promise(() => {});
      },
    }), /verification failed/);
    assert.equal(calls, 1); assert.equal(signal.aborted, true);
  }
});

test('oversized headers and streaming bodies fail closed without polling', async () => {
  for (const response of [new Response('', { headers: { 'content-length': '999999999' } }), new Response(Buffer.alloc(2 * 1024 * 1024 + 1))]) {
    const h = harness(() => response);
    await assert.rejects(verifyPublished(expected, local, h.dependencies));
    assert.equal(h.calls.length, 1); assert.deepEqual(h.delays, []);
  }
});

test('workflow environment requires exact tag identity and an absolute retained archive', () => {
  const env = { RELEASE_ARCHIVE: '/temporary/exact.tgz', RELEASE_VERSION: expected.version, RELEASE_COMMIT: expected.commit,
    GITHUB_REPOSITORY: expected.repo, GITHUB_REF: 'refs/tags/v0.6.1', GITHUB_RUN_ID: expected.runId, GITHUB_RUN_ATTEMPT: expected.runAttempt };
  assert.deepEqual(parseEnvironment(env), { archive: '/temporary/exact.tgz', ...expected });
  for (const patch of [{ GITHUB_REF: 'refs/heads/main' }, { GITHUB_REF: 'refs/tags/v0.6.2' }, { RELEASE_ARCHIVE: 'relative.tgz' },
    { RELEASE_WORKFLOW: '' }, { GITHUB_RUN_ATTEMPT: undefined }, { RELEASE_COMMIT: undefined }]) assert.throws(() => parseEnvironment({ ...env, ...patch }));
  assert.deepEqual(parseEnvironment({ ...env, NODE_AUTH_TOKEN: 'NEVER-CONSUMED' }), { archive: '/temporary/exact.tgz', ...expected });
});

test('CLI arguments are explicit, exact, import-safe and do not leak raw failures', () => {
  const args = ['--archive', '/temporary/exact.tgz', '--version', expected.version, '--commit', expected.commit, '--repo', expected.repo,
    '--workflow', expected.workflow, '--run-id', expected.runId, '--run-attempt', expected.runAttempt];
  assert.deepEqual(parseArguments(args), { archive: '/temporary/exact.tgz', ...expected });
  for (const invalid of [args.slice(2), [...args, '--extra', 'bad'], args.map(arg => arg === '--archive' ? '--version' : arg)]) assert.throws(() => parseArguments(invalid));
  for (const patch of [{ version: '0.6.1\n' }, { version: '01.2.3' }, { repo: 'owner/repo/extra' }, { workflow: '../private' }, { commit: 'bad' }, { runId: '0' }, { runAttempt: '-1' }]) assert.throws(() => validateExpected({ ...expected, ...patch }));
  const result = spawnSync(process.execPath, ['scripts/verify-published.mjs', '--private', 'SECRET'], { encoding: 'utf8' });
  assert.equal(result.status, 1); assert.equal(result.stdout, ''); assert.doesNotMatch(result.stderr, /SECRET|stack|--private/);
  assert.match(result.stderr, /Publication may already have succeeded; do not retry publication/);
});
