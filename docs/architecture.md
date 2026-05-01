# Architecture

This document expands on [`AGENTS.md`](../AGENTS.md). `AGENTS.md` remains the canonical source of truth.

## Execution Flow

Before any operational command (`install`, `status`, `kick`, `uninstall`, or `run`) proceeds, the CLI checks `process.platform` and exits with a clean macOS-only error on non-`darwin` platforms. Root help and the root `--version` flag remain available everywhere.

### `install [--time HH:MM]`

1. Parse and validate the requested time.
2. Capture the absolute Node path from `process.execPath`.
3. Resolve the CLI script path from `process.argv[1]`.
4. Resolve the absolute `claude` and `codex` binary paths and embed their directories in the plist `PATH`.
5. Generate a launchd plist whose `ProgramArguments` are:
   - absolute Node path
   - absolute CLI script path
   - `run`
   - `--time`
   - configured `HH:MM`
6. Snapshot the current `pmset repeat wakeorpoweron` rule.
7. Set one `pmset repeat wakeorpoweron MTWRFSU` at `time - 1 minute` (first kick only).
8. Register or replace the launchd agent.
9. If launchd registration fails, remove the new plist and restore the previous `pmset` rule.

### `status`

1. Check whether the launchd plist exists.
2. If missing, print `Not installed.`
3. If present, parse `Hour` and `Minute` from the plist.

### Foreground update checks

1. Only foreground interactive commands (`install`, `status`, `kick`, `uninstall`) may check for updates.
2. Look up the latest published version with npm and cache the result under `~/.quota-beat`.
3. If a newer version exists, prompt the user before running `npm install -g @yesongh/quota-beat@<resolved-version>`.
4. Exit after a successful self-update so the user can re-run the command under the new version.
5. Never perform this flow in `run`.

The reusable design notes and rollout pitfalls for this flow live in
[`docs/self-update-pattern.md`](./self-update-pattern.md).

### `kick`

1. Resolve available providers from `PATH` (Claude Code, Codex — missing ones are skipped with a warning).
2. Wait for network for up to 30 seconds (checks DNS for `api.anthropic.com` and `api.openai.com`).
3. For each available provider, run a minimal request immediately. Claude uses the user's configured Claude Code default model.
4. If a provider's first attempt fails, retry at most once after a random 5 to 10 second delay.
5. Codex runs with `--skip-git-repo-check` because launchd may start qbeat outside a trusted git repository.
6. Append a JSON Lines record for each attempt under `~/.quota-beat/logs/kick.jsonl` (includes a `provider` field).
7. Exit with success if at least one provider succeeded, or failure if all failed.
8. Do not mutate scheduling state.

### `run --time HH:MM`

1. Validate the required scheduled time passed by launchd.
2. Wait for network readiness, then add a random 0 to `jitterMinutes` delay before the first provider invocation.
3. Attempt the same kick flow as `kick` for all available providers.
4. Emit failures to stderr so launchd logs remain useful.
5. Preserve the per-attempt kick JSONL log for deeper inspection, including delay metadata.

`run` does not touch pmset. Wake scheduling is permanent via `pmset repeat` (set once during `install`).

### `uninstall`

1. Remove the launchd agent.
2. Cancel the `pmset repeat wakeorpoweron` rule.
3. Leave the globally installed binary untouched.

## Why Absolute Node Path Matters

launchd runs with a minimal default environment and does not reliably see user-managed Node installations in `PATH`.

Because of that, the plist must not execute the script directly through `#!/usr/bin/env node`.
It must invoke the absolute Node binary captured at install time.

## Why The Plist Must Not Use `RunAtLoad`

`RunAtLoad` would fire the agent immediately during install, bootstrap, or reload, which breaks the product contract of "kick at a fixed daily time."

The agent should only run from `StartCalendarInterval`.

## Why `pmset repeat` Instead of `pmset schedule`

`pmset schedule wake` creates a one-shot event that is consumed after firing. This requires daily re-scheduling, which is impossible from launchd (no `sudo` access).

`pmset repeat wakeorpoweron` is a permanent recurring rule — set once at install, repeats every day. No re-scheduling needed.

Note: `pmset repeat` is global and supports only **one** `wakeorpoweron` event per day. If the user has an existing rule, `install` overwrites it. `uninstall` cancels it entirely.

Because only one daily wake is possible via `pmset repeat`, quota-beat registers the wake 1 minute before the first kick only. The 2nd and 3rd kicks (at +5h and +10h) fire only when the Mac is already awake at those times, via their `StartCalendarInterval` entries in the launchd plist.

## Current File Map

- [`bin/qbeat.mjs`](../bin/qbeat.mjs)
  Node entry shim.
- [`src/cli.mjs`](../src/cli.mjs)
  Command orchestration.
- [`src/help.mjs`](../src/help.mjs)
  Root help text, command help text, and usage hints.
- [`src/update.mjs`](../src/update.mjs)
  Interactive npm version checks, cached latest-version lookup, prompt flow, and self-update execution.
- [`src/scheduler.mjs`](../src/scheduler.mjs)
  launchd and pmset integration.
- [`src/kick.mjs`](../src/kick.mjs)
  Provider definitions, network readiness check, and CLI execution (Claude Code, Codex).
- [`tests/cli.test.mjs`](../tests/cli.test.mjs)
  CLI validation, self-update behavior, and smoke tests.
- [`tests/scheduler.test.mjs`](../tests/scheduler.test.mjs)
  Time validation and plist generation/parsing.
