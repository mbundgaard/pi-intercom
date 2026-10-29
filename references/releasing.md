# Tag-only npm releases

## Authorization and scope

Obtain explicit authorization before committing, pushing, tagging or publishing. Preparing files or validating locally is not permission to release. Publishing does not install the extension or reload any Pi session; those require separate authorization.

This procedure applies to **new tags containing the tag-only workflow**. Historical tags retain their original workflow files. Never move an existing tag or rerun a legacy publisher to adopt this flow. Choose a new, unused version when the owner authorizes a release.

## Automatic workflow

`.github/workflows/publish.yml` responds only to pushed `v*` tags. There are no GitHub Release or manual-dispatch triggers. Branch commits cannot publish; ordinary main/PR CI remains separate.

Both jobs check out the triggering `github.sha`, not latest main. The workflow requires an annotated tag and checks that its peeled commit, the event SHA's peeled commit and checked-out HEAD match. `scripts/verify-release.mjs` requires canonical stable `vX.Y.Z` with safe-integer components: no leading zeros, prereleases, build metadata or suffixes. The tag must match all three fields exactly:

- `package.json.version`
- `package-lock.json.version`
- `package-lock.json.packages[""].version`

Package names must also be `@comput/pi-intercom`. Missing or malformed fields fail closed, before dependency installation.

Windows and Linux run `npm ci`, typecheck, tests, **full-tree `npm audit --audit-level=low`**, and isolated package-content/install checks. Ordinary main/PR CI has the same audit gate so known findings can be caught before creating an immutable release tag. Any reported vulnerability blocks publication; do not omit development dependencies or lower the threshold to get a release through. Dependency remediation is separate reviewed work.

After successful validation, the Ubuntu publisher performs another clean install, audit and package check/build from the same commit. Tracked source modifications are rejected. It packs once into a runner-temporary directory, checks the pack metadata and SHA-512/SHA-1, retains that archive as a workflow artifact, then publishes **that exact archive**, with lifecycle scripts disabled and transport retries disabled for the publish command.

The workflow grants `contents: read`; only the publishing job also has `id-token: write`. It uses GitHub-hosted runners, Node 24 and npm 11 with Trusted Publishing and provenance. No stored npm token, token secret, token-bearing npmrc or token-based setup-node registry configuration is used.

## npm Trusted Publisher

Configure/check this on the **`@comput/pi-intercom` package**, not just the npm account:

- Provider: GitHub Actions
- Organization/user: `mbundgaard`
- Repository: `pi-intercom`
- Workflow filename: `publish.yml` (not the full path)
- Environment: empty; this workflow does not declare one
- Allowed actions: direct `npm publish` must be permitted, not only staged publishing

The existing mapping may already match. Do not replace credentials, add a token fallback or change permissions without authorization. Provenance signing alone does not prove npm publishing authorization. Package repository metadata must match `https://github.com/mbundgaard/pi-intercom`.

## Release procedure

The commands below are examples for a shell with Git/Node/npm. Substitute the reviewed version and exact commit. Do not execute the mutation steps without explicit owner authorization.

1. Review the working tree, including new files, and the proposed release scope. Exclude `.pi-intercom/`, local credentials and machine state. Resolve security-audit blockers first.
2. Choose a stable unused version. Successfully query npm's public version list and inspect previous release workflow outcomes; a network/authentication error is **not** evidence that a version is unused. Check both local tags and remote refs. If any earlier publication outcome is uncertain, stop and inspect it first; registry visibility may lag.
3. Update `package.json` and both lockfile version fields together, for example `npm version X.Y.Z --no-git-tag-version`. Update the changelog in README's release-history section and relevant compatibility/upgrade notes. This does not create a tag.
4. Run local validation:

   ```sh
   RELEASE_TAG=vX.Y.Z node scripts/verify-release.mjs
   npm ci
   npm run typecheck
   npm test
   npm audit --audit-level=low
   npm run check:package
   git diff --check
   ```

   On PowerShell, set `$env:RELEASE_TAG = 'vX.Y.Z'` before invoking the validator. Use the actual version, not literal placeholders.
5. Confirm the proposed npm version and Git tag remain unused immediately before release. Example read-only checks:

   ```sh
   npm view @comput/pi-intercom versions --json --prefer-online
   git tag --list vX.Y.Z
   git ls-remote --tags origin refs/tags/vX.Y.Z 'refs/tags/vX.Y.Z^{}'
   ```

   Require successful network queries and inspect their output; do not interpret command failures as absence. Do not reuse an existing local or remote tag.
6. With explicit authorization, stage only reviewed files, commit and push that release commit to main. Confirm main CI passes for **that exact SHA**, not an earlier green run. Do not publish yet if any required check fails.
7. Create an annotated tag pointing to the reviewed release commit, then push only that tag:

   ```sh
   git tag -a vX.Y.Z <release-commit> -m "Release vX.Y.Z"
   git push origin refs/tags/vX.Y.Z
   ```

   Never use a blanket `git push --tags`, move a release tag, or tag an unreviewed newer HEAD. The tag push itself starts publication. **Do not manually trigger a second run.** Complete one release before starting another; GitHub concurrency is not an unlimited release queue.
8. Inspect the tag-triggered workflow, npm version metadata, downloaded artifact and provenance linkage as described below. A GitHub Release page can be added afterward for release notes; it is not the publishing trigger.

## Verification and uncertainty

`scripts/verify-published.mjs` performs read-only verification after npm accepts the publish command. It compares the public archive byte-for-byte and by SHA-512 with the retained local archive built from the exact tag checkout, verifies registry integrity metadata (and SHA-1 when supplied), and checks decoded SLSA provenance linkage: archive subject digest, repository, source commit, workflow path, tag ref, and GitHub run/attempt URL.

The script accepts `--archive`, `--version`, `--commit`, `--repo`, `--workflow`, `--run-id` and `--run-attempt` for later verification against the retained artifact. The workflow supplies these values from its verified checkout and GitHub event. It does not run npm publish or any mutation command. Downloads are restricted to the expected HTTPS npm registry endpoints, without redirects or credentials, and have size/time limits.

Read-only polling for transient errors/visibility lag is bounded to 15 minutes and at most 31 attempts. A mismatch fails immediately. A timeout or missing verification evidence is **not proof that publication failed**. Preserve the workflow artifact and inspect the publish step, registry version and provenance before deciding what to do. Do not rerun a publishing job merely because its later verification step failed. Never blindly retry publication, move the tag or reuse a published version.

This is **artifact equality and decoded provenance-linkage verification**, not independent cryptographic verification of the DSSE signature, certificate chain or transparency-log inclusion. Do not describe it as such. The retained CI-built archive is the reference artifact; reproducing an archive locally with different npm/toolchain versions may yield different gzip bytes and is not an equivalent reference.

Report success only after workflow publication and the required artifact/linkage checks succeed. State any remaining verification limitation plainly. Installation and `/reload` remain separate actions.
