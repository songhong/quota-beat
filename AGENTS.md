# AGENTS

This file is the canonical engineering source of truth for this repository.

- For Codex: load this file first.
- For Claude CLI and Gemini CLI: their tool-specific entry files only point here.
- Historical docs under `docs/superpowers/` are not canonical for the current implementation.

## Project Summary

`quota-beat` is a macOS-only CLI that kicks Claude Code at a fixed daily time.
Interactive foreground commands may also check for a newer published npm version and offer a self-update.

Public commands:
- `qbeat install [--time HH:MM]`
- `qbeat status`
- `qbeat kick`
- `qbeat uninstall`

Internal command:
- `qbeat run --time HH:MM`

## Runtime Architecture

The implementation is intentionally small and split into four modules:

- [`src/cli.mjs`](src/cli.mjs)
  Command routing, time parsing, install/status/kick/uninstall flow.
- [`src/help.mjs`](src/help.mjs)
  Root help text, command help text, and usage hints.
- [`src/scheduler.mjs`](src/scheduler.mjs)
  launchd plist generation, plist parsing, pmset wake scheduling, wake cleanup.
- [`src/kick.mjs`](src/kick.mjs)
  Network readiness check, minimal Claude CLI execution, and Claude attempt logging.

Detailed architecture notes live in [`docs/architecture.md`](docs/architecture.md).
The shortest full-machine sleep/wake validation checklist lives in [`docs/sleep-wake-verification.md`](docs/sleep-wake-verification.md).
The canonical npm publish procedure lives in [`docs/npm-publish-sop.md`](docs/npm-publish-sop.md).

## Non-Negotiable Invariants

- macOS only. The tool depends on `launchd` and `pmset`.
- Time format is strict `HH:MM` in 24-hour format.
- `install` is an overwrite operation. Re-running it replaces the configured time.
- `install` must not leave a partial quota-beat state behind.
  If launchd registration fails after `pmset` is updated, quota-beat must roll back the wake rule and remove the new plist.
- `status` uses the installed plist as the only source of truth. There is no state file.
- `kick` runs Claude immediately and does not schedule the next wake.
- `run` is launchd-only. It attempts the Claude kick only. After network readiness, it randomizes the first Claude launch by 0 to 5 minutes. Wake scheduling is handled by `pmset repeat` (set once during `install`).
- `run` requires an explicit `--time HH:MM`.
- Automatic update checks must never run in `run`.
  launchd executions must stay non-interactive and must not require npm.
- Every Claude CLI attempt is appended to `~/.quota-beat/logs/claude.jsonl` as JSON Lines.
  This log is additive and is separate from the launchd stdout/stderr files.
- Claude execution is intentionally conservative:
  wait for network up to 30 seconds, attempt once, then retry at most one more time after a random 5 to 10 second delay.
- launchd must not rely on `#!/usr/bin/env node`.
  The plist must invoke the absolute Node path captured from `process.execPath` at install time.
- The plist must not use `RunAtLoad`.
  Installing or reloading the agent must not trigger an immediate off-schedule Claude kick.
- The plist must include `EnvironmentVariables > PATH` with the directories
  containing both the `claude` and `node` binaries resolved at install time.
  launchd's default PATH (`/usr/bin:/bin:/usr/sbin:/sbin`) does not include
  user-managed tool directories like `/opt/homebrew/bin`.
- pmset uses `pmset repeat wakeorpoweron` (recurring) instead of one-shot `pmset schedule wake`.
  `uninstall` cancels via `pmset repeat cancel wakeorpoweron`.

## Operational Notes

- `install` needs `sudo` for `pmset repeat wakeorpoweron`.
- Do not run `qbeat install` itself under `sudo`.
  `launchd` registration must happen in the logged-in user's `gui/<uid>` domain, while `qbeat` escalates only the internal `pmset` call.
- If the user's Node or Claude CLI installation path changes after install, they must run `qbeat install --time HH:MM` again so the plist captures the new paths.
- `uninstall` removes launchd and quota-beat-owned pmset wake entries. It does not uninstall the globally installed binary.
- npm installs two command names: `qbeat` and `quotabeat`.
  Documentation and help text should recommend `qbeat` as the default.
- Interactive update checks should be low-noise.
  Cache the latest-version lookup and only prompt in an interactive terminal.
- Foreground commands should provide `-h`/`--help` output with concrete examples,
  and common failure or empty-state paths should point to the next useful command.
- Releases follow semver.
  Use `patch` for docs, metadata, tests, or backward-compatible fixes;
  use `minor` for backward-compatible user-visible features;
  use `major` for breaking CLI or runtime behavior changes.
- Do not bump the package version for docs-only changes by default.
  Only update the version when a maintainer explicitly asks to publish a release.
- When publishing, prefer `npm version patch|minor|major` from a clean git tree
  so the npm release maps to a dedicated git commit and git tag.

## Verification

Fast verification:

```bash
npm test
```

Real macOS verification:

```bash
sudo -v
node bin/qbeat.mjs install --time 07:00
node bin/qbeat.mjs status
pmset -g sched
launchctl print gui/$(id -u)/com.quota-beat.kick
tail -n 5 ~/.quota-beat/logs/claude.jsonl
node bin/qbeat.mjs uninstall
```

For a full clean-machine sleep/wake validation flow, use [`docs/sleep-wake-verification.md`](docs/sleep-wake-verification.md).

## Release

- Use [`docs/npm-publish-sop.md`](docs/npm-publish-sop.md) for every npm release.
- Validate the semver bump against the actual scope of the change before publishing.
- Do not change the version just because release documentation changed.
- Publish from a clean git tree so `npm version` can create the release commit and tag.
- If the release changes behavior, update this file and the relevant docs in the same change.

## Change Rules

- Keep the code dependency-free unless there is a strong reason not to.
- Prefer changing behavior in `cli/scheduler/kick` rather than adding new subsystems.
- If behavior changes, update this file first or in the same change.
- All documentation must use project-relative paths (e.g. `src/cli.mjs`), never absolute paths.
