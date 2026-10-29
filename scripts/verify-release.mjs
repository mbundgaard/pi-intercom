import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PACKAGE_NAME = '@comput/pi-intercom';
const STABLE_TAG = /^v((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))$/u;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Pure, exact release identity validation. Never normalize or coerce input. */
export function validateRelease({ tag, packageJson, packageLock } = {}) {
  const match = typeof tag === 'string' ? STABLE_TAG.exec(tag) : null;
  // JavaScript's $ also matches before a final newline: require the full match.
  if (!match || match[0] !== tag) throw new Error('RELEASE_TAG must be a canonical stable vX.Y.Z tag');
  const version = match[1];
  if (!version.split('.').every(segment => Number.isSafeInteger(Number(segment)))) throw new Error('Release version numeric segments must be safe integers');
  if (!object(packageJson) || packageJson.name !== PACKAGE_NAME) throw new Error('Invalid package identity');
  if (packageJson.version !== version) throw new Error('Package version does not match release tag');
  if (!object(packageLock) || packageLock.name !== PACKAGE_NAME) throw new Error('Invalid lockfile identity');
  if (packageLock.version !== version) throw new Error('Lockfile version does not match release tag');
  const root = object(packageLock.packages) ? packageLock.packages[''] : undefined;
  if (!object(root) || root.name !== PACKAGE_NAME) throw new Error('Invalid lockfile root package identity');
  if (root.version !== version) throw new Error('Lockfile root version does not match release tag');
  return version;
}

async function main() {
  try {
    const [packageJson, packageLock] = await Promise.all([
      readFile('package.json', 'utf8').then(JSON.parse),
      readFile('package-lock.json', 'utf8').then(JSON.parse),
    ]);
    const version = validateRelease({ tag: process.env.RELEASE_TAG, packageJson, packageLock });
    process.stdout.write(`${version}\n`);
  } catch {
    // No raw environment values, file contents, filesystem paths or stack traces.
    process.stderr.write('Release verification failed.\n');
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
