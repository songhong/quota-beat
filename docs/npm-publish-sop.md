# npm Publish SOP

This document is the canonical release procedure for publishing `quota-beat` to npm.

## Scope

- Use this SOP only when you are intentionally publishing a new npm release.
- Do not bump `package.json` version for docs-only or draft changes by default.
- Only bump the version when the maintainer explicitly decides to publish.

## Semver Policy

- `patch`: docs, metadata, tests, packaging fixes, or backward-compatible bug fixes.
- `minor`: backward-compatible user-visible features or CLI enhancements.
- `major`: breaking changes to commands, flags, output contracts, scheduling behavior, or runtime assumptions.

## Preconditions

- Work from a clean git tree or understand the exact files being released.
- Be on the branch you intend to publish from.
- Be logged in to npm with a maintainer account.
- Have already run the repo verification expected for the change.

Recommended checks:

```bash
git status --short
npm whoami
npm test
```

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

### 3. Verify the publish payload

```bash
npm pack --dry-run
```

Check that the tarball contains the expected CLI files, source files, and readmes, and does not include unrelated local artifacts.

### 4. Publish to npm

```bash
npm publish --access public
```

`quota-beat` is an unscoped public package, so `--access public` is safe and explicit.

### 5. Verify the published result

```bash
npm view quota-beat version
```

Optional install check:

```bash
npm install -g quota-beat@latest
qbeat --help
```

## Post-Release

- Push the release commit and tag after publish:

```bash
git push origin HEAD --follow-tags
```

- If the release included extra docs or metadata changes, make sure they are part of the same release history.
- If the published package changes install or upgrade behavior, re-check the related README sections.

## Quick Checklist

```bash
git status --short
npm whoami
npm test
npm version patch
npm pack --dry-run
npm publish --access public
npm view quota-beat version
git push origin HEAD --follow-tags
```
