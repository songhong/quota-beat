# npm Publish SOP

This document is the canonical release procedure for publishing `quota-beat` to npm.

## Scope

- Use this SOP only when you are intentionally publishing a new npm release.
- Do not bump `package.json` version for docs-only or draft changes by default.
- Only bump the version when the maintainer explicitly decides to publish.
- Publishing is performed by GitHub Actions via npm trusted publishing, not by running `npm publish` manually on a maintainer laptop.

## Semver Policy

- `patch`: docs, metadata, tests, packaging fixes, or backward-compatible bug fixes.
- `minor`: backward-compatible user-visible features or CLI enhancements.
- `major`: breaking changes to commands, flags, output contracts, scheduling behavior, or runtime assumptions.

## Preconditions

- Work from a clean git tree or understand the exact files being released.
- Be on the branch you intend to publish from.
- Have already run the repo verification expected for the change.
- Have push access to the GitHub repository.
- The npm package must already be configured with a trusted publisher that points to this repository and the workflow filename `publish.yml`.

Recommended checks:

```bash
git status --short
npm test
```

## One-Time Setup

Configure npm trusted publishing before relying on the workflow:

1. On npmjs.com, open the `quota-beat` package settings and add a Trusted Publisher for GitHub Actions.
2. Use:
   - Organization or user: `songhong`
   - Repository: `quota-beat`
   - Workflow filename: `publish.yml`
3. After the first successful trusted publish, set package publishing access to "Require two-factor authentication and disallow tokens".
4. Do not keep a long-lived npm publish token in GitHub Actions secrets for this repo.

## Release Steps

### 1. Confirm the release scope

- Review the diff and decide whether this release is `patch`, `minor`, or `major`.
- If the change affects behavior, update `AGENTS.md` and any relevant docs in the same change.

### 2. Bump the version intentionally

- Only do this step when you are actually publishing.
- Run `npm version <patch|minor|major>` from a clean git tree.
- This updates `package.json`, creates a release commit, and creates a matching git tag such as `v0.1.1`.

Examples:

```bash
npm version patch
```

```bash
npm version minor
```

```bash
npm version major
```

This is the preferred default because each published npm version should map cleanly to a git commit and tag for traceability.

### 3. Push the release commit and tag

```bash
git push origin HEAD --follow-tags
```

Pushing the tag triggers [`.github/workflows/publish.yml`](../.github/workflows/publish.yml), which:

- verifies the tag matches `package.json`
- runs `npm test`
- runs `npm pack --dry-run`
- publishes to npm with trusted publishing

### 4. Verify the GitHub Actions publish run

- Confirm the `Publish Package` workflow succeeded for the pushed tag.
- If the workflow fails before npm accepts the release, fix the issue and re-run the workflow or push a corrected replacement tag as appropriate.

### 4a. Retry the same version only when the package was not published

- If the GitHub Actions run fails and `npm view quota-beat version` still shows the previous release, it is acceptable to keep the same version and re-push the same tag after fixing the workflow or tests.
- In that recovery path, move the existing tag to the new fixed commit and force-push the tag:

```bash
git tag -fa v0.1.2 -m "v0.1.2"
git push --force origin refs/tags/v0.1.2
```

- Do not reuse a published version. If npm already accepted the release, the next attempt must use a new semver version.

### 5. Verify the published result

```bash
npm view quota-beat version
```

Optional install check:

```bash
npm install -g quota-beat@latest
qbeat --help
```

## CI Notes

- The publish workflow currently runs on `ubuntu-latest`, not macOS.
- CLI tests that exercise install, status, kick, uninstall, or the internal `run` path must not depend on the runner's real `process.platform`.
- The test harness in [`tests/support/cli-harness.mjs`](../tests/support/cli-harness.mjs) is responsible for simulating `darwin` by default and for preserving any extra `NODE_OPTIONS` required by individual tests.
- If a GitHub Actions failure says a public CLI command is unavailable on Linux, treat that as a test harness regression first, not as a release-only issue.

## Post-Release

- If the release included extra docs or metadata changes, make sure they are part of the same release history.
- If the published package changes install or upgrade behavior, re-check the related README sections.

## Quick Checklist

```bash
git status --short
npm test
npm version patch
git push origin HEAD --follow-tags
npm view quota-beat version
```
