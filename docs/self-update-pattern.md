# Self-Update Pattern

This document captures the current npm self-update design used by `quota-beat`
and the release issues discovered while rolling it out. The pattern is reusable
for other globally installed Node CLI projects.

## Reusable Core

The current pattern is intentionally small:

1. Only check for updates in interactive foreground commands.
2. Skip checks in non-interactive or background execution paths.
3. Query npm for the latest published version.
4. Cache the latest-version lookup for a short TTL to keep the CLI low-noise.
5. Compare the installed version against the published version.
6. Prompt before changing the global install.
7. Install the exact resolved version, not `@latest`.
8. Exit after a successful update so the user can re-run under the new version.

In `quota-beat`, the relevant code lives in [`src/update.mjs`](../src/update.mjs).

## Why This Pattern Reuses Well

It works well for other CLIs because it avoids most of the operational risk:

- Interactive-only checks avoid surprising behavior in automation.
- A cache avoids hitting the registry on every command.
- Prompting keeps package mutation explicit.
- Installing the exact published version makes the update deterministic.
- Exiting after update avoids mixing old process state with new installed files.

## The Important Rule: Install The Exact Version

Do not run the self-update with:

```bash
npm install -g <package>@latest
```

Use the already-resolved version instead:

```bash
npm install -g <package>@<resolved-version>
```

Why:

- `npm view <package> version` and `npm install <package>@latest` are separate
  registry operations.
- Right after a fresh release, they can temporarily observe different registry
  state.
- That can produce a bad UX where the CLI announces `1.2.3`, but `@latest`
  still installs `1.2.2`.

This exact failure happened in `quota-beat` during the `0.1.7` to `0.1.8`
rollout.

## Rollout Issues We Hit

### 1. First package publish may still require one manual npm publish

If the package does not exist on npm yet, GitHub Actions trusted publishing may
not be enough by itself. The package record may need to be bootstrapped first
with one manual publish from a maintainer machine.

For `quota-beat`, that flow is documented in
[`docs/npm-publish-sop.md`](./npm-publish-sop.md).

### 2. Manual npm publish may require OTP

If npm account settings require 2FA for publish operations, a manual publish
must include an OTP:

```bash
npm publish --access public --otp=<code>
```

`EOTP` means the package payload was prepared successfully, but npm rejected the
publish because the one-time password was missing, wrong, or expired.

### 3. A broken updater cannot fix itself retroactively

If version `1.2.2` contains a broken self-update path, and the fix ships in
`1.2.3`, users on `1.2.2` may still fail to self-update to `1.2.3`.

That also happened here:

- `0.1.7` still updated via `@latest`
- the fix shipped in `0.1.8`
- moving from `0.1.7` to `0.1.8` still required one manual install on the
  affected machine

The practical rule is:

- treat updater changes like migration code
- expect the first version containing the fix to sometimes require one manual
  hop

## Integration Checklist For Other Projects

If you want to reuse this in another CLI:

1. Keep update checks out of non-interactive or scheduled execution.
2. Resolve the package name and current installed version from local metadata.
3. Cache the registry lookup under a project-owned state directory.
4. Compare versions in code instead of shelling out to semver tooling.
5. Prompt clearly and include both current and target versions.
6. Install `<package>@<resolved-version>`, never `<package>@latest`.
7. Exit immediately after a successful update.
8. Add tests for:
   - update available
   - update declined
   - registry lookup failure
   - non-interactive path
   - updater command arguments
   - version comparison edge cases
9. Document the one-time bootstrap publish path if trusted publishing is used.
10. Document the manual recovery command for users on a broken updater version.

## Suggested Recovery Wording

If a release fixes the updater itself, user-facing docs should include a manual
fallback like:

```bash
npm install -g <package>@<fixed-version>
```

For `quota-beat`, the recovery form is:

```bash
npm install -g @yesongh/quota-beat@<fixed-version>
```
