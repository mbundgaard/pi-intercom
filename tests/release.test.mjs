import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { validateRelease } from '../scripts/verify-release.mjs';

const script = fileURLToPath(new URL('../scripts/verify-release.mjs', import.meta.url));
function release(version = '1.2.3') {
  return {
    tag: `v${version}`,
    packageJson: { name: '@comput/pi-intercom', version },
    packageLock: { name: '@comput/pi-intercom', version, lockfileVersion: 3,
      packages: { '': { name: '@comput/pi-intercom', version } } },
  };
}

test('pure release validator accepts exact stable identity and does not mutate input', () => {
  for (const version of ['0.0.0', '0.8.0', '1.2.3', '123.456.789', '9007199254740991.0.0']) {
    const input = release(version), original = structuredClone(input);
    assert.equal(validateRelease(input), version);
    assert.deepEqual(input, original);
  }
});

test('tag validation rejects missing, noncanonical, prerelease, build and injection forms', () => {
  for (const tag of [undefined, null, false, 123, '', '1.2.3', 'V1.2.3', 'v1.2', 'v1.2.3.4',
    'v01.2.3', 'v1.02.3', 'v1.2.03', 'v00.0.0', 'v-1.2.3', 'v+1.2.3',
    'v1.2.3-alpha', 'v1.2.3-rc.1', 'v1.2.3+build', 'v1.2.3+sha.abc',
    ' v1.2.3', 'v1.2.3 ', 'v1.2.3\n', 'v1.2.3\r\n', 'v1.2.3\0',
    'refs/heads/main', 'refs/heads/v1.2.3', 'refs/tags/v1.2.3', '../v1.2.3',
    'v1.2.3; echo injected', 'v1.2.3$(echo injected)', 'v1.2.3\nINJECTED=value', 'v１.2.3']) {
    assert.throws(() => validateRelease({ ...release(), tag }), /canonical stable/);
  }
  assert.throws(() => validateRelease(), /canonical stable/);
});

test('each numeric version segment must stay within the safe integer limit', () => {
  for (const version of ['9007199254740992.0.0', '0.9007199254740992.0', '0.0.9007199254740992', `${'9'.repeat(400)}.0.0`]) {
    assert.throws(() => validateRelease(release(version)), /safe integers/);
  }
});

test('all package and lockfile identities and versions are mandatory and exact', () => {
  const mutations = [
    input => { delete input.packageJson; },
    input => { input.packageJson = []; },
    input => { delete input.packageJson.name; },
    input => { input.packageJson.name = '@other/pi-intercom'; },
    input => { delete input.packageJson.version; },
    input => { input.packageJson.version = '1.2.4'; },
    input => { input.packageJson.version = 'v1.2.3'; },
    input => { input.packageJson.version = '1.2.3-rc.1'; },
    input => { input.packageJson.version = '1.2.3+build'; },
    input => { input.packageJson.version = 123; },
    input => { delete input.packageLock; },
    input => { input.packageLock = null; },
    input => { input.packageLock = []; },
    input => { delete input.packageLock.name; },
    input => { input.packageLock.name = '@other/pi-intercom'; },
    input => { delete input.packageLock.version; },
    input => { input.packageLock.version = '1.2.4'; },
    input => { input.packageLock.version = '1.2.3\n'; },
    input => { delete input.packageLock.packages; },
    input => { input.packageLock.packages = []; },
    input => { input.packageLock.packages = {}; },
    input => { input.packageLock.packages[''] = null; },
    input => { input.packageLock.packages[''] = []; },
    input => { delete input.packageLock.packages[''].name; },
    input => { input.packageLock.packages[''].name = '@other/pi-intercom'; },
    input => { delete input.packageLock.packages[''].version; },
    input => { input.packageLock.packages[''].version = '1.2.4'; },
    input => { input.packageLock.packages[''].version = '01.2.3'; },
  ];
  for (const mutate of mutations) { const input = release(); mutate(input); assert.throws(() => validateRelease(input)); }
  const mismatch = release(); mismatch.tag = 'v9.9.9';
  assert.throws(() => validateRelease(mismatch), /version does not match/);
});

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'intercom-release-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
async function writeManifest(directory, input = release()) {
  await writeFile(path.join(directory, 'package.json'), JSON.stringify(input.packageJson));
  await writeFile(path.join(directory, 'package-lock.json'), JSON.stringify(input.packageLock));
}
function cli(directory, tag) {
  const env = { ...process.env };
  delete env.RELEASE_TAG; delete env.NODE_OPTIONS; delete env.NODE_PATH;
  if (tag !== undefined) env.RELEASE_TAG = tag;
  const result = spawnSync(process.execPath, [script], { cwd: directory, env, encoding: 'utf8', timeout: 5000, maxBuffer: 16384 });
  assert.equal(result.error, undefined); assert.equal(result.signal, null);
  return result;
}
function rejected(result) {
  assert.equal(result.status, 1); assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'Release verification failed.\n');
}

test('CLI reads only cwd manifests and emits only the verified public version', async t => {
  const directory = await fixture(t); await writeManifest(directory);
  const result = cli(directory, 'v1.2.3');
  assert.equal(result.status, 0); assert.equal(result.stdout, '1.2.3\n'); assert.equal(result.stderr, '');
});

test('CLI fails closed for missing env, branch refs, suffixes and manifest mismatch', async t => {
  const directory = await fixture(t); await writeManifest(directory);
  for (const tag of [undefined, '', 'refs/heads/main', 'refs/tags/v1.2.3', 'v01.2.3', 'v1.2.3-rc.1', 'v1.2.3+build', 'v1.2.3\n', 'v9.9.9']) rejected(cli(directory, tag));
  const mismatch = release(); delete mismatch.packageLock.packages[''].version;
  await writeManifest(directory, mismatch); rejected(cli(directory, 'v1.2.3'));
});

test('CLI rejects missing or malformed manifests without exposing contents or stack traces', async t => {
  const directory = await fixture(t);
  rejected(cli(directory, 'v1.2.3'));
  await writeManifest(directory); await rm(path.join(directory, 'package-lock.json'));
  rejected(cli(directory, 'v1.2.3'));
  await writeManifest(directory); await writeFile(path.join(directory, 'package-lock.json'), '{PRIVATE_FIXTURE_TEXT');
  rejected(cli(directory, 'v1.2.3'));
  await writeManifest(directory); await writeFile(path.join(directory, 'package.json'), '{PRIVATE_FIXTURE_TEXT');
  rejected(cli(directory, 'v1.2.3'));
});

test('importing the pure validator never reads manifests, prints output or runs CLI', async t => {
  const directory = await fixture(t);
  const moduleUrl = new URL('../scripts/verify-release.mjs', import.meta.url).href;
  const env = { ...process.env }; delete env.NODE_OPTIONS; delete env.NODE_PATH; delete env.RELEASE_TAG;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', `await import(${JSON.stringify(moduleUrl)});`], {
    cwd: directory, env, encoding: 'utf8', timeout: 5000, maxBuffer: 16384,
  });
  assert.equal(result.error, undefined); assert.equal(result.status, 0);
  assert.equal(result.stdout, ''); assert.equal(result.stderr, '');
});
