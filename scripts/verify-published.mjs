import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const NAME = '@comput/pi-intercom';
const SLSA = 'https://slsa.dev/provenance/v1';
const MAX_ARCHIVE = 32 * 1024 * 1024, MAX_JSON = 2 * 1024 * 1024;
const MAX_WAIT = 15 * 60 * 1000, INTERVAL = 30000, FETCH_TIMEOUT = 10000, MAX_ATTEMPTS = 31;
class VerificationError extends Error { constructor() { super('Published release verification failed.'); } }
class VisibilityError extends Error { constructor() { super('Published release is not yet readable.'); } }
const requireValue = value => { if (!value) throw new VerificationError(); };
const exact = (pattern, value) => typeof value === 'string' && pattern.exec(value)?.[0] === value;
const hash = (bytes, algorithm, encoding = 'hex') => createHash(algorithm).update(bytes).digest(encoding);

export function validateExpected(expected) {
  requireValue(expected && exact(/(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)/u, expected.version));
  requireValue(expected.version.split('.').every(part => Number.isSafeInteger(Number(part))));
  requireValue(exact(/[a-f0-9]{40}/u, expected.commit));
  requireValue(exact(/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/u, expected.repo));
  requireValue(exact(/\.github\/workflows\/[A-Za-z0-9_-]+\.ya?ml/u, expected.workflow));
  requireValue(exact(/[1-9][0-9]*/u, expected.runId) && exact(/[1-9][0-9]*/u, expected.runAttempt));
  return expected;
}

/** All remote reads stay on the public npm registry, without credentials or redirects. */
export function registryURL(value) {
  requireValue(typeof value === 'string' && value.length <= 2048);
  let url;
  try { url = new URL(value); } catch { throw new VerificationError(); }
  requireValue(url.protocol === 'https:' && url.hostname === 'registry.npmjs.org' && !url.port && !url.username && !url.password && !url.hash && !url.search);
  requireValue(url.href === value);
  return value;
}

export function verifyMetadata(metadata, expected) {
  validateExpected(expected);
  requireValue(metadata?.name === NAME && metadata.version === expected.version);
  requireValue(metadata.gitHead === undefined || metadata.gitHead === expected.commit);
  const dist = metadata.dist;
  requireValue(dist && exact(/sha512-[A-Za-z0-9+/]{86}==/u, dist.integrity));
  requireValue(dist.shasum === undefined || exact(/[a-f0-9]{40}/u, dist.shasum));
  requireValue(dist.attestations?.provenance?.predicateType === SLSA);
  registryURL(dist.tarball); registryURL(dist.attestations.url);
  return dist;
}

export function verifyTarball(localArchive, remoteArchive, dist) {
  requireValue(Buffer.isBuffer(localArchive) && Buffer.isBuffer(remoteArchive));
  requireValue(localArchive.length > 0 && localArchive.length <= MAX_ARCHIVE && remoteArchive.length <= MAX_ARCHIVE);
  requireValue(localArchive.equals(remoteArchive));
  const sha512 = hash(localArchive, 'sha512');
  requireValue(dist.integrity === `sha512-${hash(localArchive, 'sha512', 'base64')}`);
  requireValue(dist.shasum === undefined || dist.shasum === hash(localArchive, 'sha1'));
  return sha512;
}

/** Decoded linkage checks only: NOT independent DSSE signature/certificate verification. */
export function verifyProvenance(attestations, expected, sha512) {
  validateExpected(expected);
  requireValue(exact(/[a-f0-9]{128}/u, sha512) && Array.isArray(attestations?.attestations));
  const matches = attestations.attestations.filter(item => item?.predicateType === SLSA);
  requireValue(matches.length === 1);
  const envelope = matches[0]?.bundle?.dsseEnvelope;
  requireValue(envelope?.payloadType === 'application/vnd.in-toto+json');
  requireValue(typeof envelope.payload === 'string' && envelope.payload.length <= MAX_JSON);
  const decoded = Buffer.from(envelope.payload, 'base64');
  requireValue(decoded.toString('base64') === envelope.payload);
  let statement;
  try { statement = JSON.parse(decoded.toString('utf8')); } catch { throw new VerificationError(); }
  requireValue(statement?._type === 'https://in-toto.io/Statement/v1' && statement.predicateType === SLSA);
  requireValue(Array.isArray(statement.subject) && statement.subject.length === 1);
  requireValue(statement.subject[0]?.name === `pkg:npm/%40comput/pi-intercom@${expected.version}` && statement.subject[0]?.digest?.sha512 === sha512);
  const build = statement.predicate?.buildDefinition;
  requireValue(build?.buildType === 'https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1');
  const repository = `https://github.com/${expected.repo}`, ref = `refs/tags/v${expected.version}`;
  const workflow = build.externalParameters?.workflow;
  requireValue(workflow?.repository === repository && workflow.ref === ref && workflow.path === expected.workflow);
  requireValue(Array.isArray(build.resolvedDependencies) && build.resolvedDependencies.length === 1);
  const source = build.resolvedDependencies[0];
  requireValue(source?.uri === `git+${repository}@${ref}` && source.digest?.gitCommit === expected.commit);
  const run = `${repository}/actions/runs/${expected.runId}/attempts/${expected.runAttempt}`;
  requireValue(statement.predicate?.runDetails?.metadata?.invocationId === run);
  return { sha512, run, linkageChecked: true, signaturesVerified: false };
}

async function fetchBytes(url, maxBytes, timeoutMs, fetch) {
  registryURL(url);
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new VisibilityError()); }, timeoutMs);
  });
  const read = async () => {
    let response;
    try { response = await fetch(url, { method: 'GET', redirect: 'manual', credentials: 'omit', signal: controller.signal }); }
    catch { throw new VisibilityError(); }
    if (controller.signal.aborted) { void response.body?.cancel().catch(() => {}); throw new VisibilityError(); }
    if (response.status !== 200) {
      void response.body?.cancel().catch(() => {});
      if ([404, 408, 429].includes(response.status) || response.status >= 500 && response.status <= 599) throw new VisibilityError();
      throw new VerificationError();
    }
    const length = response.headers.get('content-length');
    if (length !== null && (!exact(/[0-9]+/u, length) || Number(length) > maxBytes)) throw new VerificationError();
    requireValue(response.body);
    const reader = response.body.getReader(), chunks = [];
    const cancel = () => { void reader.cancel().catch(() => {}); };
    controller.signal.addEventListener('abort', cancel, { once: true });
    let size = 0;
    try {
      while (true) {
        if (controller.signal.aborted) throw new VisibilityError();
        let chunk;
        try { chunk = await reader.read(); } catch { throw new VisibilityError(); }
        if (chunk.done) break;
        size += chunk.value.byteLength;
        requireValue(size <= maxBytes);
        chunks.push(Buffer.from(chunk.value));
      }
      return Buffer.concat(chunks, size);
    } finally { controller.signal.removeEventListener('abort', cancel); cancel(); }
  };
  try { return await Promise.race([read(), timeout]); }
  finally { clearTimeout(timer); controller.abort(); }
}
const parseJSON = bytes => {
  try { return JSON.parse(bytes.toString('utf8')); } catch { throw new VerificationError(); }
};

/** Read-only visibility polling. Mismatches and unexpected formats never retry. */
export async function verifyPublished(expected, localArchive, { fetch = globalThis.fetch, delay = ms => new Promise(resolve => setTimeout(resolve, ms)), now = () => performance.now() } = {}) {
  validateExpected(expected);
  requireValue(Buffer.isBuffer(localArchive) && localArchive.length > 0 && localArchive.length <= MAX_ARCHIVE);
  const deadline = now() + MAX_WAIT;
  const get = (url, limit) => {
    const remaining = deadline - now();
    requireValue(remaining > 0);
    return fetchBytes(url, limit, Math.min(FETCH_TIMEOUT, remaining), fetch);
  };
  for (let attempt = 0; attempt < MAX_ATTEMPTS && now() < deadline; attempt++) {
    try {
      const metadata = parseJSON(await get(`https://registry.npmjs.org/@comput%2fpi-intercom/${expected.version}`, MAX_JSON));
      const dist = verifyMetadata(metadata, expected);
      const sha512 = verifyTarball(localArchive, await get(dist.tarball, MAX_ARCHIVE), dist);
      return verifyProvenance(parseJSON(await get(dist.attestations.url, MAX_JSON)), expected, sha512);
    } catch (error) {
      if (!(error instanceof VisibilityError)) throw new VerificationError();
      const remaining = deadline - now();
      if (remaining <= 0 || attempt + 1 === MAX_ATTEMPTS) break;
      await delay(Math.min(INTERVAL, remaining));
    }
  }
  throw new VerificationError();
}

export function parseArguments(args) {
  const names = new Map([['--archive', 'archive'], ['--version', 'version'], ['--commit', 'commit'], ['--repo', 'repo'], ['--workflow', 'workflow'], ['--run-id', 'runId'], ['--run-attempt', 'runAttempt']]);
  const result = {};
  requireValue(args.length === names.size * 2);
  for (let index = 0; index < args.length; index += 2) {
    const key = names.get(args[index]);
    requireValue(key && result[key] === undefined && typeof args[index + 1] === 'string' && args[index + 1].length > 0);
    result[key] = args[index + 1];
  }
  requireValue(typeof result.archive === 'string' && !result.archive.includes('\0'));
  validateExpected(result);
  return result;
}

/** Workflow mode: no ambient credentials or root settings are consumed. */
export function parseEnvironment(env) {
  const expected = {
    archive: env.RELEASE_ARCHIVE, version: env.RELEASE_VERSION, commit: env.RELEASE_COMMIT,
    repo: env.GITHUB_REPOSITORY, workflow: env.RELEASE_WORKFLOW ?? '.github/workflows/publish.yml',
    runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT,
  };
  validateExpected(expected);
  requireValue(env.GITHUB_REF === `refs/tags/v${expected.version}`);
  requireValue(typeof expected.archive === 'string' && path.isAbsolute(expected.archive) && !expected.archive.includes('\0'));
  return expected;
}

async function main() {
  let file;
  try {
    const options = process.argv.length > 2 ? parseArguments(process.argv.slice(2)) : parseEnvironment(process.env);
    file = await open(options.archive, 'r');
    const stat = await file.stat();
    requireValue(stat.isFile() && stat.size > 0 && stat.size <= MAX_ARCHIVE);
    // Fixed-size read also bounds a concurrently growing local file.
    const archive = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < archive.length) {
      const result = await file.read(archive, size, archive.length - size, null);
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    requireValue(size === stat.size);
    await verifyPublished(options, archive.subarray(0, size));
    process.stdout.write('Published archive bytes, hashes and decoded provenance linkage checked. DSSE signatures/certificate chain not independently verified.\n');
  } catch {
    process.stderr.write('Published release verification failed. Publication may already have succeeded; do not retry publication. Inspect the retained archive and registry. No publish action was performed by this verifier.\n');
    process.exitCode = 1;
  } finally { await file?.close().catch(() => {}); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
