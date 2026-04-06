# Architecture

This document expands on [`AGENTS.md`](../AGENTS.md). `AGENTS.md` remains the canonical source of truth.

## Execution Flow

### `install [--time HH:MM]`

1. Parse and validate the requested time.
2. Capture the absolute Node path from `process.execPath`.
3. Resolve the CLI script path from `process.argv[1]`.
4. Resolve the absolute `claude` binary path and embed its directory in the plist `PATH`.
5. Generate a launchd plist whose `ProgramArguments` are:
   - absolute Node path
   - absolute CLI script path
   - `run`
   - `--time`
   - configured `HH:MM`
6. Snapshot the current `pmset repeat wakeorpoweron` rule.
7. Set `pmset repeat wakeorpoweron MTWRFSU` at `time - 2 minutes`.
8. Register or replace the launchd agent.
9. If launchd registration fails, remove the new plist and restore the previous `pmset` rule.

### `status`

1. Check whether the launchd plist exists.
2. If missing, print `Not installed.`
3. If present, parse `Hour` and `Minute` from the plist.

### Foreground update checks

1. Only foreground interactive commands (`install`, `status`, `kick`, `uninstall`) may check for updates.
2. Look up the latest published version with npm and cache the result under `~/.quota-beat`.
3. If a newer version exists, prompt the user before running `npm install -g quota-beat@latest`.
4. Exit after a successful self-update so the user can re-run the command under the new version.
5. Never perform this flow in `run`.

### `kick`

1. Wait for network for up to 30 seconds.
2. Run a minimal Claude CLI request immediately.
3. If the first attempt fails, retry at most once after a random 5 to 10 second delay.
4. Append a JSON Lines record for each Claude attempt under `~/.quota-beat/logs/claude.jsonl`.
5. Exit with success or failure.
6. Do not mutate scheduling state.

### `run --time HH:MM`

1. Validate the required scheduled time passed by launchd.
2. Wait for network readiness, then add a random 0 to 5 minute delay before the first Claude invocation.
3. Attempt the same Claude kick flow as `kick`.
4. Emit failures to stderr so launchd logs remain useful.
5. Preserve the per-attempt Claude JSONL log for deeper inspection, including delay metadata.

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

Note: `pmset repeat` is global (one rule per type). If the user has an existing `wakeorpoweron` repeat rule, `install` will overwrite it. `uninstall` cancels it entirely.

## Current File Map

- [`bin/qbeat.mjs`](../bin/qbeat.mjs)
  Node entry shim.
- [`src/cli.mjs`](../src/cli.mjs)
  Command orchestration.
- [`src/help.mjs`](../src/help.mjs)
  Root help text, command help text, and usage hints.
- [`src/scheduler.mjs`](../src/scheduler.mjs)
  launchd and pmset integration.
- [`src/kick.mjs`](../src/kick.mjs)
  Network + Claude execution.
- [`tests/cli.test.mjs`](../tests/cli.test.mjs)
  CLI validation, self-update behavior, and smoke tests.
- [`tests/scheduler.test.mjs`](../tests/scheduler.test.mjs)
  Time validation and plist generation/parsing.
