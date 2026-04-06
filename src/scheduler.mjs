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

export function plistPath() {
  return join(homedir(), 'Library', 'LaunchAgents', `${PLIST_LABEL}.plist`);
}

export function buildPlist({ time, nodePath, scriptPath, logDir, envPath }) {
  const normalized = normalizeTime(time);
  const [hours, minutes] = normalized.split(':').map(Number);
  const pathValue = envPath ? `${envPath}:${DEFAULT_PATH}` : DEFAULT_PATH;

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
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>${hours}</integer>
    <key>Minute</key>
    <integer>${minutes}</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>${logDir}/launchd.stdout.log</string>
  <key>StandardErrorPath</key>
  <string>${logDir}/launchd.stderr.log</string>
</dict>
</plist>`;
}

export function parseScheduledTime(plistContent) {
  const match = plistContent.match(
    /<key>StartCalendarInterval<\/key>\s*<dict>\s*<key>Hour<\/key>\s*<integer>(\d+)<\/integer>\s*<key>Minute<\/key>\s*<integer>(\d+)<\/integer>/s
  );

  if (!match) {
    throw new Error('Could not parse Hour/Minute from plist.');
  }

  return normalizeTime(`${match[1].padStart(2, '0')}:${match[2].padStart(2, '0')}`);
}

export function readScheduledTime() {
  return parseScheduledTime(readFileSync(plistPath(), 'utf-8'));
}

export function wakeTimeForKickTime(time) {
  const normalized = normalizeTime(time);
  const [hours, minutes] = normalized.split(':').map(Number);
  const wakeHours = minutes >= 2 ? hours : (hours + 23) % 24;
  const wakeMinutes = (minutes - 2 + 60) % 60;
  return `${String(wakeHours).padStart(2, '0')}:${String(wakeMinutes).padStart(2, '0')}:00`;
}

export function setPmsetRepeatWakeTime(wakeTime) {
  execFileSync(
    'sudo',
    ['pmset', 'repeat', 'wakeorpoweron', 'MTWRFSU', wakeTime],
    { stdio: 'inherit' }
  );
}

export function schedulePmsetRepeat(time) {
  setPmsetRepeatWakeTime(wakeTimeForKickTime(time));
}

export function cancelPmsetRepeat() {
  execFileSync(
    'sudo',
    ['pmset', 'repeat', 'cancel', 'wakeorpoweron'],
    { stdio: 'inherit' }
  );
}

export function parsePmsetRepeatOutput(output) {
  const match = output.match(/wakeorpoweron\s+at\s+(\d{2}:\d{2}:\d{2})/i);
  if (!match) return null;
  return match[1];
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
