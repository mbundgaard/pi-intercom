import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Git may check out workflow YAML with CRLF on Windows; semantics are identical.
const workflow = (await readFile(new URL('../.github/workflows/publish.yml', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const ci = (await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');

test('publication is tag-push only, with no release/manual/branch trigger', () => {
  assert.match(ci, /npm audit --audit-level=low/);
  assert.doesNotMatch(ci, /npm publish|id-token: write/);
  assert.match(workflow, /^on:\n  push:\n    tags:\n      - 'v\*'$/m);
  assert.doesNotMatch(workflow, /^  (?:release|workflow_dispatch|pull_request|schedule):/m);
  assert.doesNotMatch(workflow, /^    branches:/m);
  assert.equal((workflow.match(/if: github\.event_name == 'push' && github\.ref_type == 'tag' && !github\.event\.deleted/g) ?? []).length, 2);
});

test('both release jobs pin the event SHA and verify annotated tag and manifest identity before installing', () => {
  const jobs = workflow.split(/^  publish:$/m);
  assert.equal(jobs.length, 2);
  for (const job of jobs) {
    assert.match(job, /ref: \$\{\{ github\.sha \}\}/);
    assert.match(job, /fetch-depth: 0/);
    assert.match(job, /RELEASE_TAG: \$\{\{ github\.ref_name \}\}/);
    assert.match(job, /git cat-file -t "\$GITHUB_REF"/);
    assert.match(job, /\$\{GITHUB_SHA\}\^\{commit\}/);
    assert.match(job, /\$\{GITHUB_REF\}\^\{commit\}/);
    assert.ok(job.indexOf('node scripts/verify-release.mjs') < job.indexOf('run: npm ci'));
    assert.match(job, /npm audit --audit-level=low/);
    assert.match(job, /npm run check:package/);
    assert.match(job, /git diff --exit-code HEAD --/);
  }
});

test('publisher uses OIDC and one exact saved archive, without token secrets or automatic mutation retries', () => {
  const publisher = workflow.split(/^  publish:$/m)[1];
  assert.match(publisher, /contents: read\n      id-token: write/);
  assert.match(publisher, /npm install --global npm@11/);
  assert.doesNotMatch(workflow, /secrets\.|NODE_AUTH_TOKEN|NPM_TOKEN|registry-url:/);
  assert.match(publisher, /npm pack --ignore-scripts --json --pack-destination/);
  assert.match(publisher, /actions\/upload-artifact@v4/);
  assert.equal((publisher.match(/run: npm publish /g) ?? []).length, 1);
  assert.match(publisher, /npm publish "\$RELEASE_ARCHIVE" .*--provenance --ignore-scripts --fetch-retries=0/);
  assert.ok(publisher.indexOf('node scripts/verify-published.mjs') > publisher.indexOf('run: npm publish'));
  for (const flag of ['--archive', '--version', '--commit', '--repo', '--workflow', '--run-id', '--run-attempt']) {
    assert.ok(publisher.includes(flag));
  }
  assert.match(publisher, /do not rerun publication, move the tag or reuse the version/);
});
