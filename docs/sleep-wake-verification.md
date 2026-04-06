# Sleep/Wake Verification

This checklist is the shortest end-to-end validation flow for verifying that `quota-beat` can:

1. install its global CLI entrypoints
2. register `launchd` and `pmset`
3. wake a sleeping Mac
4. run the scheduled Claude kick

Use this when validating from a clean machine state or after packaging changes.

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
npm uninstall -g quota-beat
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

## 7. Wait For The Trigger Window

Timeline:

- `HH:MM - 2 minutes`: the Mac should wake because of `pmset repeat wakeorpoweron`
- `HH:MM`: `launchd` should start `qbeat run --time HH:MM`
- up to 30 seconds later: the process should wait for network
- after network is ready: the scheduled run may delay Claude launch by a random `0` to `5` minutes
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
tail -n 50 ~/.quota-beat/logs/launchd.stdout.log
tail -n 50 ~/.quota-beat/logs/launchd.stderr.log
tail -n 10 ~/.quota-beat/logs/claude.jsonl
```

Expected:

- `qbeat status` still reports the installed time
- `pmset -g sched` still shows the repeating wake rule
- `launchd.stdout.log` shows the scheduled run flow, including network check and Claude launch
- `launchd.stderr.log` is empty or contains only actionable failure output
- `claude.jsonl` contains a fresh JSON Lines record for the scheduled run

For a successful scheduled run, the latest `claude.jsonl` entry should usually include:

- `"attempt": 1`
- `"success": true`
- `"preLaunchDelayMs": ...`

If the first Claude invocation fails, the latest entries may instead show:

- the first record with `"willRetry": true`
- a second record for attempt `2`

## 9. Clean Up After The Test

```bash
qbeat uninstall
pmset -g sched
ls ~/Library/LaunchAgents | grep quota-beat
```

Expected:

- the launch agent is removed
- the quota-beat-owned repeating wake is gone

