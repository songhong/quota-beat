# quota-beat

[English](README.md) | [中文](README.zh-CN.md)

Kick Claude Code at a fixed time every morning, even while your Mac is asleep.

## Why

Claude Code's quota resets every 5 hours, starting from your first usage of the day. By sending a minimal request at a fixed early hour (e.g. 07:00), you anchor the reset cycle to predictable windows:

| Window | Reset at | |
|---|---|---|
| Morning | 07:00 | Start fresh |
| Afternoon | 12:00 | Back from lunch |
| Evening | 17:00 | One more round |

Without this anchor, the cycle drifts based on whenever you happen to start. `quota-beat` wakes your Mac and fires that first request automatically, even while asleep.

## Requirements

- macOS (depends on `launchd` and `pmset`)
- Node.js >= 18
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- `sudo` access (required for `pmset repeat wakeorpoweron`)

## Install

```bash
npm install -g quota-beat
```

This package installs two command aliases: `qbeat` (recommended) and `quotabeat`.

## Upgrade

```bash
npm install -g quota-beat@latest
```

## Quick Start

```bash
# Schedule a daily kick at 07:00 (default)
qbeat install

# Or pick your own time
qbeat install --time 06:00

# Verify
qbeat status
```

## Commands

### `qbeat install [--time HH:MM]`

Register a daily `launchd` job and a `pmset` wake schedule.

- Time must be in 24-hour `HH:MM` format. Defaults to `07:00`.
- Running `install` again **replaces** the existing schedule.
- Requires `sudo` for `pmset`.

### `qbeat status`

Show the configured daily time. Reads directly from the installed `launchd` plist — no state file involved.

### `qbeat kick`

Run a Claude Code kick immediately. Does **not** modify any schedule.

### `qbeat uninstall`

Remove the `launchd` job and all quota-beat-owned `pmset` wake entries. Does **not** remove the globally installed `qbeat` binaries.

### Automatic update prompt

When you run `qbeat` in an interactive terminal, it may check npm for a newer published version about once per day.
If one is available, `qbeat` offers to run `npm install -g quota-beat@latest` for you.
The background scheduled path never performs update checks or prompts.

## How It Works

```
┌─────────────────────────────────────────────────────┐
│  pmset repeat wakeorpoweron (configured time − 2 min)│
│        ↓  Mac wakes from sleep                      │
│  launchd fires the scheduled quota-beat job         │
│        ↓                                            │
│  1. Wait for network (up to 30s)                    │
│  2. Send minimal Claude CLI request                 │
│  3. Append Claude attempt log                       │
└─────────────────────────────────────────────────────┘
```

1. **`pmset repeat wakeorpoweron`** wakes your Mac 2 minutes before the configured time every day.
2. **`launchd`** triggers the installed quota-beat job at the exact configured time.
3. The tool checks network connectivity (DNS lookup to `api.anthropic.com`, retries for up to 30 seconds).
4. A minimal Claude CLI request (`claude -p --model haiku "Reply with exactly OK."`) is sent to activate the quota.
5. Each Claude attempt is appended to `~/.quota-beat/logs/claude.jsonl` for later inspection.

## Architecture

Five zero-dependency modules:

| Module | Responsibility |
|---|---|
| `src/cli.mjs` | Command routing, argument parsing, install/status/kick/uninstall flow |
| `src/help.mjs` | Root help text, command help text, and usage hints |
| `src/update.mjs` | Interactive npm version checks, cache management, prompting, and self-update |
| `src/scheduler.mjs` | launchd plist generation & parsing, pmset wake scheduling & cleanup |
| `src/kick.mjs` | Network readiness check, Claude CLI execution |

Key design decisions:

- **Absolute Node path in plist** — `launchd` runs with a minimal `PATH` and can't reliably find user-managed Node installations. The plist embeds the absolute `process.execPath` captured at install time.
- **Scoped pmset cleanup** — quota-beat cancels only the `wakeorpoweron` repeat rule it manages, avoiding broader `pmset` resets.
- **No state file** — `status` reads the installed plist as the single source of truth.

See [`docs/architecture.md`](docs/architecture.md) for detailed execution flows.

## Logs

launchd stdout/stderr logs are written to:

```
~/.quota-beat/logs/launchd.stdout.log
~/.quota-beat/logs/launchd.stderr.log
```

Each Claude CLI attempt is also appended as one JSON record per line to:

```
~/.quota-beat/logs/claude.jsonl
```

This file captures whether the real Claude invocation succeeded, its exit code, and short stdout/stderr previews.

## Troubleshooting

**`qbeat status` says "Not installed"**
Run `qbeat install --time HH:MM` again.

**Upgrade to the latest published build**
Run `npm install -g quota-beat@latest`.

**Node path changed (e.g. after nvm switch)**
Re-run `qbeat install --time HH:MM` to capture the new `process.execPath`.

**pmset requires sudo**
`install` and `uninstall` need `sudo` to manage wake schedules. Run `sudo -v` first or use a passwordless sudoers entry for `pmset`.

**Do not run `qbeat install` with `sudo`**
Run `qbeat install --time HH:MM` as your normal login user. `qbeat` handles the internal `sudo pmset ...` step itself, and `launchd` registration must stay in your user `gui/<uid>` domain.

**Verify the launchd job is loaded**

```bash
launchctl print gui/$(id -u)/com.quota-beat.kick
```

**Verify pmset wake schedule**

```bash
pmset -g sched
```

## Development

```bash
# Run tests
npm test

# Full macOS verification
sudo -v
node bin/qbeat.mjs install --time 07:00
node bin/qbeat.mjs status
pmset -g sched
launchctl print gui/$(id -u)/com.quota-beat.kick
node bin/qbeat.mjs uninstall
```

## License

MIT
