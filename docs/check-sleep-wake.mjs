#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PLIST_PATH = join(homedir(), 'Library', 'LaunchAgents', 'com.quota-beat.kick.plist');
const CLAUDE_LOG_PATH = join(homedir(), '.quota-beat', 'logs', 'claude.jsonl');
const WAKE_LEAD_MS = 2 * 60 * 1000;
const WAKE_MATCH_WINDOW_MS = 2 * 60 * 1000;

function fail(message, exitCode = 1) {
  console.error(`Error: ${message}`);
  process.exit(exitCode);
}

function run(command, args) {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    const detail = error.stderr?.trim() || error.message;
    fail(`${command} ${args.join(' ')} failed: ${detail}`);
  }
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function formatOffset(date) {
  const totalMinutes = -date.getTimezoneOffset();
  const sign = totalMinutes >= 0 ? '+' : '-';
  const absoluteMinutes = Math.abs(totalMinutes);
  const hours = Math.floor(absoluteMinutes / 60);
  const minutes = absoluteMinutes % 60;
  return `${sign}${pad(hours)}:${pad(minutes)}`;
}

function formatLocalDateTime(date) {
  return [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
    formatOffset(date),
  ].join(' ');
}

function formatLocalDate(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatDuration(ms) {
  if (ms == null) return 'n/a';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(3)}s`;
}

function parseArgs(argv) {
  if (argv.includes('-h') || argv.includes('--help')) {
    console.log(`Usage: node docs/check-sleep-wake.mjs [YYYY-MM-DD]

Inspect the latest scheduled quota-beat run, or the latest scheduled run on a given local date.
Exit code is 0 when both the quota-beat wake schedule and the Claude kick are verified.`);
    process.exit(0);
  }

  if (argv.length > 1) {
    fail('accepts at most one optional date argument in YYYY-MM-DD format');
  }

  const requestedDate = argv[0];
  if (requestedDate != null && !/^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) {
    fail('date must use YYYY-MM-DD format');
  }

  return { requestedDate };
}

function readPlistSchedule() {
  if (!existsSync(PLIST_PATH)) {
    fail(`launch agent not found at ${PLIST_PATH}`);
  }

  const plist = JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', PLIST_PATH]));
  const schedule = plist.StartCalendarInterval ?? {};
  const hour = Number(schedule.Hour);
  const minute = Number(schedule.Minute);

  if (!Number.isInteger(hour) || !Number.isInteger(minute)) {
    fail(`unable to read StartCalendarInterval from ${PLIST_PATH}`);
  }

  return {
    hour,
    minute,
    runTime: `${pad(hour)}:${pad(minute)}`,
  };
}

function readClaudeEntries() {
  if (!existsSync(CLAUDE_LOG_PATH)) {
    fail(`Claude attempt log not found at ${CLAUDE_LOG_PATH}`);
  }

  const lines = readFileSync(CLAUDE_LOG_PATH, 'utf8')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    fail(`Claude attempt log is empty at ${CLAUDE_LOG_PATH}`);
  }

  return lines.map((line, index) => {
    try {
      const entry = JSON.parse(line);
      return { ...entry, __line: index + 1 };
    } catch {
      fail(`invalid JSON on line ${index + 1} of ${CLAUDE_LOG_PATH}`);
    }
  });
}

function collectScheduledRuns(entries) {
  const runs = [];

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!Object.prototype.hasOwnProperty.call(entry, 'preLaunchDelayMs')) continue;

    const attempts = [entry];
    let cursor = index + 1;
    while (
      cursor < entries.length &&
      !Object.prototype.hasOwnProperty.call(entries[cursor], 'preLaunchDelayMs')
    ) {
      attempts.push(entries[cursor]);
      cursor += 1;
    }

    const firstAttemptDate = new Date(entry.startedAt);
    runs.push({
      startIndex: index,
      firstAttempt: entry,
      attempts,
      localDate: formatLocalDate(firstAttemptDate),
    });
  }

  if (runs.length === 0) {
    fail('no scheduled quota-beat runs were found in claude.jsonl');
  }

  return runs;
}

function selectRun(runs, requestedDate) {
  if (requestedDate == null) return runs.at(-1);

  const matchingRuns = runs.filter(run => run.localDate === requestedDate);
  if (matchingRuns.length > 0) return matchingRuns.at(-1);

  const availableDates = [...new Set(runs.map(run => run.localDate))].join(', ');
  fail(`no scheduled run found for ${requestedDate}. Available dates: ${availableDates}`);
}

function parsePmsetEvents() {
  const output = run('/usr/bin/pmset', ['-g', 'log']);
  return output
    .split('\n')
    .map(line => line.trimEnd())
    .filter(Boolean)
    .map(line => {
      const match = line.match(
        /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) ([+-]\d{4}) (.+)$/
      );
      if (!match) return null;

      const [, dateTime, offset, message] = match;
      const offsetWithColon = `${offset.slice(0, 3)}:${offset.slice(3)}`;
      return {
        line,
        message,
        timestamp: new Date(`${dateTime}${offsetWithColon}`),
      };
    })
    .filter(Boolean);
}

function isSleepEvent(event) {
  return (
    event.message.includes('Entering Sleep state') ||
    /^Sleep\s/.test(event.message) ||
    event.message.startsWith('Sleep\t')
  );
}

function isWakeScheduleEvent(event) {
  return event.message.includes('com.apple.powermanagement.wakeschedule');
}

function isDisplayOnEvent(event) {
  return event.message.includes('Display is turned on');
}

function isDisplayOffEvent(event) {
  return event.message.includes('Display is turned off');
}

function describeAttemptResult(run) {
  const success = run.attempts.find(entry => entry.success);
  if (success) {
    return `success on attempt ${success.attempt} at ${formatLocalDateTime(new Date(success.finishedAt))}`;
  }

  const lastAttempt = run.attempts.at(-1);
  return `failed after attempt ${lastAttempt.attempt} at ${formatLocalDateTime(
    new Date(lastAttempt.finishedAt)
  )}`;
}

function findLast(events, predicate) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (predicate(events[index])) return events[index];
  }
  return null;
}

function findFirst(events, predicate) {
  for (const event of events) {
    if (predicate(event)) return event;
  }
  return null;
}

function main() {
  if (process.platform !== 'darwin') {
    fail('this script only works on macOS');
  }

  const { requestedDate } = parseArgs(process.argv.slice(2));
  const schedule = readPlistSchedule();
  const claudeEntries = readClaudeEntries();
  const scheduledRuns = collectScheduledRuns(claudeEntries);
  const run = selectRun(scheduledRuns, requestedDate);

  const firstAttemptAt = new Date(run.firstAttempt.startedAt);
  const localRunTarget = new Date(
    firstAttemptAt.getFullYear(),
    firstAttemptAt.getMonth(),
    firstAttemptAt.getDate(),
    schedule.hour,
    schedule.minute,
    0,
    0
  );
  const expectedWakeAt = new Date(localRunTarget.getTime() - WAKE_LEAD_MS);
  const pmsetEvents = parsePmsetEvents();

  const lastSleep = findLast(pmsetEvents, event => {
    return isSleepEvent(event) && event.timestamp.getTime() <= expectedWakeAt.getTime();
  });
  const nextSleep = findFirst(pmsetEvents, event => {
    return isSleepEvent(event) && event.timestamp.getTime() >= firstAttemptAt.getTime();
  });
  const observedWake = findFirst(pmsetEvents, event => {
    const delta = Math.abs(event.timestamp.getTime() - expectedWakeAt.getTime());
    return isWakeScheduleEvent(event) && delta <= WAKE_MATCH_WINDOW_MS;
  });
  const displayOn = findFirst(pmsetEvents, event => {
    const delta = Math.abs(event.timestamp.getTime() - expectedWakeAt.getTime());
    return isDisplayOnEvent(event) && delta <= WAKE_MATCH_WINDOW_MS;
  });
  const displayOffAfterWake = observedWake
    ? findFirst(pmsetEvents, event => {
        return (
          isDisplayOffEvent(event) &&
          event.timestamp.getTime() >= observedWake.timestamp.getTime()
        );
      })
    : null;

  const kickSucceeded = run.attempts.some(entry => entry.success);
  const wakeObserved = observedWake != null;
  const overallPass = wakeObserved && kickSucceeded;

  console.log('Quota-Beat Sleep/Wake Check');
  console.log('');
  console.log(`Inspection date: ${requestedDate ?? run.localDate}`);
  console.log(`Installed qbeat run time: ${schedule.runTime}`);
  console.log(`Expected qbeat wake: ${formatLocalDateTime(expectedWakeAt)}`);
  console.log(`Expected qbeat run: ${formatLocalDateTime(localRunTarget)}`);
  console.log('');
  console.log('Timeline');
  console.log(
    `- Last sleep before wake: ${lastSleep ? lastSleep.line : 'not found in retained pmset log'}`
  );
  console.log(
    `- Observed qbeat wake: ${observedWake ? observedWake.line : 'not found near expected wake time'}`
  );
  console.log(
    `- Display on near wake: ${displayOn ? displayOn.line : 'not found near expected wake time'}`
  );
  console.log(
    `- First Claude attempt: ${formatLocalDateTime(firstAttemptAt)} (line ${run.firstAttempt.__line}, preLaunchDelayMs=${run.firstAttempt.preLaunchDelayMs}, duration=${formatDuration(run.firstAttempt.durationMs)})`
  );
  console.log(`- Claude result: ${describeAttemptResult(run)}`);
  console.log(
    `- Next sleep after kick: ${nextSleep ? nextSleep.line : 'not found after the scheduled Claude kick'}`
  );
  if (displayOffAfterWake != null) {
    console.log(`- First display-off after wake: ${displayOffAfterWake.line}`);
  }
  console.log('');
  console.log('Verdict');
  console.log(`- Wake schedule observed: ${wakeObserved ? 'yes' : 'no'}`);
  console.log(`- Scheduled Claude attempt observed: yes`);
  console.log(`- Scheduled Claude success: ${kickSucceeded ? 'yes' : 'no'}`);
  console.log(`- Overall pass: ${overallPass ? 'yes' : 'no'}`);

  process.exit(overallPass ? 0 : 1);
}

main();
