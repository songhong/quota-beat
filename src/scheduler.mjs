import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

const PLIST_LABEL = 'com.quota-beat.kick';
const DEFAULT_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

export function normalizeTime(value) {
  if (!/^\d{2}:\d{2}$/.test(value)) {
    throw new Error('Time must use HH:MM in 24-hour format.');
  }

  const [hours, minutes] = value.split(':').map(Number);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    throw new Error('Time must be between 00:00 and 23:59.');
  }

  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function addMinutesToTime(h, m, deltaMinutes) {
  const total = (h * 60 + m + deltaMinutes) % (24 * 60);
  return { hours: Math.floor(total / 60), minutes: total % 60 };
}

function hhmm({ hours, minutes }) {
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function computeKickEntries(time, jitterMinutes) {
  const normalized = normalizeTime(time);
  const [h, m] = normalized.split(':').map(Number);
  return [
    { hours: h, minutes: m },
    addMinutesToTime(h, m, 5 * 60 + jitterMinutes),
    addMinutesToTime(h, m, 10 * 60 + 2 * jitterMinutes),
  ];
}

export function computeKickTimes(time, jitterMinutes) {
  return computeKickEntries(time, jitterMinutes).map(hhmm);
}

export function plistPath() {
  return join(homedir(), 'Library', 'LaunchAgents', `${PLIST_LABEL}.plist`);
}

export function buildPlist({ time, nodePath, scriptPath, logDir, envPath, jitterMinutes = 1 }) {
  const normalized = normalizeTime(time);
  const pathValue = envPath ? `${envPath}:${DEFAULT_PATH}` : DEFAULT_PATH;

  const kicks = computeKickEntries(time, jitterMinutes);

  const intervals = kicks.map(({ hours, minutes }) =>
    `  <dict>\n    <key>Hour</key>\n    <integer>${hours}</integer>\n    <key>Minute</key>\n    <integer>${minutes}</integer>\n  </dict>`
  ).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_LABEL}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${pathValue}</string>
  </dict>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${scriptPath}</string>
    <string>run</string>
    <string>--time</string>
    <string>${normalized}</string>
    <string>--jitter</string>
    <string>${jitterMinutes}</string>
  </array>
  <key>StartCalendarInterval</key>
  <array>
${intervals}
  </array>
  <key>StandardOutPath</key>
  <string>${logDir}/launchd.stdout.log</string>
  <key>StandardErrorPath</key>
  <string>${logDir}/launchd.stderr.log</string>
</dict>
</plist>`;
}

export function parseScheduledTime(plistContent) {
  const match = plistContent.match(
    /<key>StartCalendarInterval<\/key>\s*<array>\s*<dict>\s*<key>Hour<\/key>\s*<integer>(\d+)<\/integer>\s*<key>Minute<\/key>\s*<integer>(\d+)<\/integer>/s
  );

  if (!match) {
    throw new Error('Could not parse Hour/Minute from plist.');
  }

  return normalizeTime(`${match[1].padStart(2, '0')}:${match[2].padStart(2, '0')}`);
}

export function parseJitterMinutes(plistContent) {
  const match = plistContent.match(/<string>--jitter<\/string>\s*<string>(\d+)<\/string>/s);
  return match ? parseInt(match[1], 10) : 1;
}

export function readInstalledConfig() {
  const content = readFileSync(plistPath(), 'utf-8');
  return {
    time: parseScheduledTime(content),
    jitterMinutes: parseJitterMinutes(content),
  };
}

function wakeTimeForHM(h, m) {
  const wakeH = m >= 1 ? h : (h + 23) % 24;
  const wakeM = (m - 1 + 60) % 60;
  return `${String(wakeH).padStart(2, '0')}:${String(wakeM).padStart(2, '0')}:00`;
}

export function setPmsetRepeatWakeTimes(wakeTimes) {
  const repeatArgs = [];
  for (const t of wakeTimes) {
    repeatArgs.push('wakeorpoweron', 'MTWRFSU', t);
  }
  execFileSync('sudo', ['pmset', 'repeat', ...repeatArgs], { stdio: 'inherit' });
}

export function schedulePmsetRepeat(time, jitterMinutes = 1) {
  const kicks = computeKickEntries(time, jitterMinutes);
  const wakeTimes = kicks.map(({ hours, minutes }) => wakeTimeForHM(hours, minutes));
  setPmsetRepeatWakeTimes(wakeTimes);
}

export function cancelPmsetRepeat() {
  execFileSync(
    'sudo',
    ['pmset', 'repeat', 'cancel', 'wakeorpoweron'],
    { stdio: 'inherit' }
  );
}

export function parsePmsetRepeatOutput(output) {
  const matches = [...output.matchAll(/wakeorpoweron\s+at\s+(\d{2}:\d{2}:\d{2})/gi)];
  if (matches.length === 0) return null;
  return matches.map(m => m[1]);
}

export function readPmsetRepeat() {
  const output = execFileSync('pmset', ['-g', 'sched'], { encoding: 'utf-8' });
  return parsePmsetRepeatOutput(output);
}

export function registerLaunchd(plistContent) {
  const dest = plistPath();
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, plistContent);

  const uid = process.getuid();
  try {
    execFileSync('launchctl', ['bootout', `gui/${uid}`, dest], { stdio: 'ignore' });
  } catch {
    // may not be loaded yet, ignore
  }
  execFileSync('launchctl', ['bootstrap', `gui/${uid}`, dest]);
}

export function unregisterLaunchd() {
  const dest = plistPath();
  const uid = process.getuid();
  try {
    execFileSync('launchctl', ['bootout', `gui/${uid}`, dest], { stdio: 'ignore' });
  } catch {
    // not loaded
  }
  try {
    unlinkSync(dest);
  } catch {
    // not found
  }
}
