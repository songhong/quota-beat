# Sleep/Wake Verification

This checklist is the shortest end-to-end validation flow for verifying that `quota-beat` can:

1. install its global CLI entrypoints
2. register `launchd` and `pmset`
3. wake a sleeping Mac
4. run the scheduled Claude kick

Use this when validating from a clean machine state or after packaging changes.

For a faster post-run verdict, use [`docs/check-sleep-wake.mjs`](./check-sleep-wake.mjs).
It prints the latest or requested day's timeline as:

- last sleep
- qbeat expected wake
- observed wake schedule
- first Claude attempt
- final Claude result
- next sleep

It exits `0` only when the wake schedule is observed and the scheduled Claude kick succeeds.

When you need a raw evidence chain instead of only a pass/fail verdict, collect and compare:

- the configured `pmset` wake time from `pmset -g sched`
- the installed `launchd` run time from `launchctl print`
- the last sleep and wake records from `pmset -g log`
- the scheduled Claude attempt and outcome from `~/.quota-beat/logs/claude.jsonl`

The evidence chain is complete only when those timestamps line up.

## 0. Pick A Near-Future Test Time

Choose a test time 8 to 10 minutes from now.

Example:

- if the current time is `20:30`, use `20:38`

## 1. Confirm A Clean Starting State

```bash
which qbeat quotabeat
pmset -g sched
ls ~/Library/LaunchAgents | grep quota-beat
```

Expected:

- `which` does not find `qbeat` or `quotabeat`
- `pmset -g sched` has no quota-beat-owned repeating wake entry
- `~/Library/LaunchAgents` does not contain `com.quota-beat.kick.plist`

If the machine is not clean, remove the old install first:

```bash
npm uninstall -g @yesongh/quota-beat
rm -f ~/Library/LaunchAgents/com.quota-beat.kick.plist
sudo pmset repeat cancel wakeorpoweron
```

## 2. Install The Current Working Copy

```bash
cd /Users/songhong/Projects/tool/quota-beat
npm install -g .
which qbeat quotabeat
```

Expected:

- both commands resolve successfully
- `qbeat` is the default command used in the rest of this checklist

## 3. Run A Foreground Self-Check

```bash
qbeat kick
```

Expected:

- the command exits successfully
- Claude can be invoked from the current environment

If this step fails, stop here. Do not continue to sleep/wake validation until foreground `kick` works.

## 4. Install A Scheduled Test Run

Replace `HH:MM` with the test time chosen earlier.

```bash
sudo -v
qbeat install --time HH:MM
qbeat status
pmset -g sched
launchctl print gui/$(id -u)/com.quota-beat.kick
```

Expected:

- `qbeat status` reports `HH:MM`
- `pmset -g sched` shows a repeating wake at `HH:MM - 2 minutes`
- `launchctl print ...` shows `com.quota-beat.kick`

Example:

- if the installed time is `20:38`
- the repeating wake should be close to `20:36:00`

## 5. Clear Logs For A Clean Observation Window

```bash
rm -f ~/.quota-beat/logs/launchd.stdout.log
rm -f ~/.quota-beat/logs/launchd.stderr.log
rm -f ~/.quota-beat/logs/claude.jsonl
mkdir -p ~/.quota-beat/logs
```

## 6. Put The Mac To Sleep

Requirements:

- connected to power
- lid open
- user remains logged in

Sleep the Mac using the Apple menu or:

```bash
osascript -e 'tell application "System Events" to sleep'
```

You can also force immediate sleep with:

```bash
sudo pmset sleepnow
```

## 7. Wait For The Trigger Window

Timeline:

- `HH:MM - 2 minutes`: the Mac should wake because of `pmset repeat wakeorpoweron`
- `HH:MM`: `launchd` should start `qbeat run --time HH:MM`
- up to 30 seconds later: the process should wait for network
- after network is ready: the scheduled run may delay Claude launch by a random `0` to `3` minutes
- after that delay: Claude should be invoked once, with at most one retry after a short random delay if the first attempt fails

Important:

- a successful wake at `HH:MM - 2 minutes` is not enough
- a successful `launchd` trigger at `HH:MM` is not enough
- the validation is only complete if the Claude attempt log shows the scheduled execution actually ran

## 8. Inspect The Results After Wake

```bash
qbeat status
pmset -g sched
launchctl print gui/$(id -u)/com.quota-beat.kick
node docs/check-sleep-wake.mjs
```

Expected:

- `qbeat status` still reports the installed time
- `pmset -g sched` still shows the repeating wake rule
- the checker prints a timeline covering sleep, expected wake, observed wake, Claude kick, and the next sleep boundary when present
- the checker exits `0`
- the final verdict says `Wake schedule observed: yes`
- the final verdict says `Scheduled Claude success: yes`

If the checker fails or you need raw evidence, inspect the underlying logs:

```bash
tail -n 50 ~/.quota-beat/logs/launchd.stdout.log
tail -n 50 ~/.quota-beat/logs/launchd.stderr.log
tail -n 10 ~/.quota-beat/logs/claude.jsonl
```

For a successful scheduled run, the latest `claude.jsonl` entry should usually include:

- `"attempt": 1`
- `"success": true`
- `"preLaunchDelayMs": ...`

If the first Claude invocation fails, the latest entries may instead show:

- the first record with `"willRetry": true`
- a second record for attempt `2`

The checker also supports inspecting a specific local day:

```bash
node docs/check-sleep-wake.mjs YYYY-MM-DD
```

## 9. Build The Evidence Chain

Use this section when you need to prove exactly when the Mac slept, when it woke, when `quota-beat` ran, and whether the Mac went back to sleep afterward.

### 9.1 Confirm The Installed Schedule

```bash
qbeat status
pmset -g sched
launchctl print gui/$(id -u)/com.quota-beat.kick
```

Record these three facts:

- the installed `qbeat` time from `qbeat status`
- the repeating wake time from `pmset -g sched`
- the `run --time HH:MM` schedule from `launchctl print`

Expected relationship:

- `launchd` runs at `HH:MM`
- `pmset` wakes the Mac at `HH:MM - 2 minutes`

### 9.2 Capture The Last Sleep Before The Scheduled Wake

The checker already prints this, but for raw evidence use:

```bash
pmset -g log | rg 'Entering Sleep state'
```

Take the latest `Entering Sleep state` record that happened before the scheduled wake window.

Example shape:

```text
2026-04-07 20:19:03 +0800 Sleep Entering Sleep state due to 'Sleep Service Back to Sleep': ...
```

### 9.3 Capture The Observed Wake Around `HH:MM - 2 Minutes`

Start with the full local day:

```bash
pmset -g log | rg 'YYYY-MM-DD .*?(com.apple.powermanagement.wakeschedule|Display is turned on|Display is turned off)'
```

Then narrow it to the expected wake minute by editing the date and time prefix directly.

Example for an expected wake near `06:58` on `2026-04-09`:

```bash
pmset -g log | rg '2026-04-09 06:(57|58|59):.*(com.apple.powermanagement.wakeschedule|Display is turned on|Display is turned off)'
```

Expected evidence near the wake time:

- a `Created UserIsActive "com.apple.powermanagement.wakeschedule"` line
- a `Display is turned on` line at or near the same second
- optionally a `Display is turned off` line shortly after if the display went dark again

Example shape:

```text
2026-04-09 06:58:00 +0800 Assertions   PID 347(powerd) Created UserIsActive "com.apple.powermanagement.wakeschedule" ...
2026-04-09 06:58:00 +0800 Notification Display is turned on
2026-04-09 06:58:12 +0800 Notification Display is turned off
```

Interpretation:

- this proves macOS woke on a scheduled power event
- if the observed wake matches the `pmset -g sched` repeating wake configured by `quota-beat`, that wake is attributable to the installed `quota-beat` schedule

### 9.4 Capture The Scheduled Claude Attempt

Inspect the latest scheduled run in the additive Claude log:

```bash
nl -ba ~/.quota-beat/logs/claude.jsonl | tail -n 10
tail -n 50 ~/.quota-beat/logs/launchd.stdout.log
tail -n 50 ~/.quota-beat/logs/launchd.stderr.log
```

For a successful scheduled run, the latest scheduled `claude.jsonl` record should usually include:

- `"attempt": 1`
- `"success": true`
- `"preLaunchDelayMs": ...`

The `startedAt` and `finishedAt` timestamps are UTC in the JSON log. Convert them to local time when comparing them with `pmset -g log`.

Interpretation:

- `preLaunchDelayMs` explains why the first Claude attempt may happen a short time after `HH:MM`
- `launchd.stdout.log` should show `Checking network...`, then a delay message, then `Scheduled kick completed.`
- if attempt `1` fails and `willRetry` is true, the second record is still part of the same scheduled run

### 9.5 Check Whether The Mac Slept Again After The Kick

Use:

```bash
pmset -g log | rg '^YYYY-MM-DD .*Entering Sleep state'
```

Replace `YYYY-MM-DD` with the local date of the scheduled run, then compare the matching sleep records with the Claude `finishedAt` timestamp.

Interpretation:

- if a later `Entering Sleep state` record exists, that is the next sleep after the scheduled Claude kick
- if no later sleep record exists yet, record that the next sleep was not observed in the available logs
- not finding a later sleep does not invalidate the wake-and-run verification; it only means the post-run sleep boundary was not captured yet

### 9.6 Write The Final Timeline

For a complete evidence chain, write the final timeline in this order:

1. last sleep before the wake window
2. expected wake from `pmset -g sched`
3. observed wake from `pmset -g log`
4. expected `launchd` run time from `launchctl print`
5. first Claude attempt from `claude.jsonl`
6. final Claude result from `claude.jsonl`
7. next sleep after the kick, or `not found`

Only call the test fully proven when:

- the installed `launchd` and `pmset` times match the expected `HH:MM` and `HH:MM - 2 minutes`
- the observed wake matches the scheduled wake window
- the scheduled Claude attempt happened after that wake
- the Claude attempt log shows success, or a clearly attributable failure/retry chain

## 10. Clean Up After The Test

```bash
qbeat uninstall
pmset -g sched
ls ~/Library/LaunchAgents | grep quota-beat
```

Expected:

- the launch agent is removed
- the quota-beat-owned repeating wake is gone
