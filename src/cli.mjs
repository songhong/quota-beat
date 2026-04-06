import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import {
  DEFAULT_INSTALL_TIME,
  HELP_COMMANDS,
  RECOMMENDED_COMMAND,
  printCommandHelp,
  printUsage,
  showInstallNextStep,
  usageHint,
} from './help.mjs';
import {
  choosePreLaunchDelayMs,
  executeClaude,
  formatDelay,
  sleepDelay,
  waitForNetwork,
} from './kick.mjs';
import {
  buildPlist,
  cancelPmsetRepeat,
  normalizeTime,
  plistPath,
  readPmsetRepeat,
  readScheduledTime,
  registerLaunchd,
  schedulePmsetRepeat,
  setPmsetRepeatWakeTime,
  unregisterLaunchd,
} from './scheduler.mjs';

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf-8')
);
const PACKAGE_NAME = packageJson.name;
const PACKAGE_VERSION = packageJson.version;
const UPDATE_ELIGIBLE_COMMANDS = new Set([...HELP_COMMANDS].filter(c => c !== 'run'));
const DEFAULT_UPDATE_CHECK_TTL_MS = 24 * 60 * 60 * 1000;

function parseCommandArgs(command, args, options = {}) {
  try {
    return parseArgs({
      args,
      options: {
        help: { type: 'boolean', short: 'h' },
        ...options,
      },
      allowPositionals: false,
      strict: true,
    });
  } catch (err) {
    throw new Error(`${err.message}\n${usageHint(command)}`);
  }
}

function parseTimeValue(command, value, { defaultTime, required = false } = {}) {
  if (value == null) {
    if (required) {
      throw new Error(`Missing required option --time.\n${usageHint(command)}`);
    }

    return normalizeTime(defaultTime);
  }

  try {
    return normalizeTime(value);
  } catch (err) {
    throw new Error(`Invalid --time value: ${err.message}\n${usageHint(command)}`);
  }
}

function maybePrintCommandHelp(command, values) {
  if (!values.help) {
    return false;
  }

  printCommandHelp(command);
  return true;
}

function logDirPath() {
  return join(homedir(), '.quota-beat', 'logs');
}

function stateDirPath() {
  return join(homedir(), '.quota-beat');
}

function updateCacheFilePath() {
  return join(stateDirPath(), 'update-check.json');
}

function updateCheckTtlMs() {
  const override = Number(process.env.QUOTA_BEAT_UPDATE_TTL_MS);
  return Number.isFinite(override) && override >= 0
    ? override
    : DEFAULT_UPDATE_CHECK_TTL_MS;
}

function prepareLaunchdLogs(logDir) {
  mkdirSync(logDir, { recursive: true });
}

function readPreviousInstallState() {
  try {
    return { plistContent: readFileSync(plistPath(), 'utf-8') };
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function restorePmsetRepeat(wakeTime) {
  if (wakeTime) {
    setPmsetRepeatWakeTime(wakeTime);
    return;
  }

  cancelPmsetRepeat();
}

function rollbackFailedInstall(previousInstall, previousWakeTime) {
  const errors = [];

  try {
    if (previousInstall) {
      registerLaunchd(previousInstall.plistContent);
    } else {
      unregisterLaunchd();
    }
  } catch (err) {
    errors.push(`launchd rollback failed: ${err.message}`);
  }

  try {
    restorePmsetRepeat(previousWakeTime);
  } catch (err) {
    errors.push(`pmset rollback failed: ${err.message}`);
  }

  return errors;
}

function parseVersion(value) {
  const match = value.match(/^(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) {
    return null;
  }

  return {
    parts: match[1].split('.').map(Number),
    prerelease: match[2] ?? null,
  };
}

export function isNewerVersion(currentVersion, latestVersion) {
  const current = parseVersion(currentVersion);
  const latest = parseVersion(latestVersion);
  if (!current || !latest) {
    return false;
  }

  const width = Math.max(current.parts.length, latest.parts.length);
  for (let index = 0; index < width; index += 1) {
    const currentPart = current.parts[index] ?? 0;
    const latestPart = latest.parts[index] ?? 0;
    if (latestPart !== currentPart) {
      return latestPart > currentPart;
    }
  }

  if (current.prerelease && !latest.prerelease) {
    return true;
  }

  return false;
}

function loadUpdateCache() {
  try {
    return JSON.parse(readFileSync(updateCacheFilePath(), 'utf-8'));
  } catch {
    return null;
  }
}

function saveUpdateCache(latestVersion) {
  mkdirSync(stateDirPath(), { recursive: true });
  writeFileSync(
    updateCacheFilePath(),
    JSON.stringify(
      {
        checkedAt: Date.now(),
        latestVersion,
      },
      null,
      2
    )
  );
}

function shouldCheckForUpdates(command) {
  if (!UPDATE_ELIGIBLE_COMMANDS.has(command)) {
    return false;
  }

  if (process.env.QUOTA_BEAT_DISABLE_UPDATE_CHECK === '1') {
    return false;
  }

  if (process.env.QUOTA_BEAT_FORCE_UPDATE_CHECK === '1') {
    return true;
  }

  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function fetchLatestPublishedVersion() {
  if (process.env.QUOTA_BEAT_NPM_VIEW_VERSION) {
    return process.env.QUOTA_BEAT_NPM_VIEW_VERSION;
  }

  try {
    const output = execFileSync(
      'npm',
      ['view', PACKAGE_NAME, 'version', '--json'],
      {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 3000,
      }
    ).trim();
    const parsed = JSON.parse(output);
    return typeof parsed === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

async function confirmSelfUpdate(latestVersion) {
  const preset = process.env.QUOTA_BEAT_AUTO_UPDATE?.trim().toLowerCase();
  if (preset) {
    return !['0', 'false', 'n', 'no'].includes(preset);
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = await rl.question(
      `A newer version of ${PACKAGE_NAME} is available (${PACKAGE_VERSION} -> ${latestVersion}). Update now? [Y/n] `
    );
    return ['', 'y', 'yes'].includes(answer.trim().toLowerCase());
  } finally {
    rl.close();
  }
}

function runSelfUpdate() {
  const result = spawnSync(
    'npm',
    ['install', '-g', `${PACKAGE_NAME}@latest`],
    { stdio: 'inherit' }
  );

  if (result.error) {
    throw result.error;
  }

  if ((result.status ?? 1) !== 0) {
    throw new Error(
      `npm install -g ${PACKAGE_NAME}@latest exited with code ${result.status ?? 1}.`
    );
  }
}

async function maybeSelfUpdate(command) {
  if (!shouldCheckForUpdates(command)) {
    return false;
  }

  const cache = loadUpdateCache();
  const stale = !cache
    || typeof cache.checkedAt !== 'number'
    || (Date.now() - cache.checkedAt) >= updateCheckTtlMs();
  const latestVersion = stale ? fetchLatestPublishedVersion() : cache.latestVersion;

  if (stale) {
    saveUpdateCache(latestVersion);
  }

  if (!latestVersion || !isNewerVersion(PACKAGE_VERSION, latestVersion)) {
    return false;
  }

  const confirmed = await confirmSelfUpdate(latestVersion);
  if (!confirmed) {
    return false;
  }

  console.log(`Updating ${PACKAGE_NAME} to ${latestVersion}...`);
  try {
    runSelfUpdate();
  } catch (err) {
    console.error(`Automatic update failed: ${err.message}`);
    return false;
  }

  console.log(`Update completed. Re-run ${RECOMMENDED_COMMAND} to use ${latestVersion}.`);
  return true;
}

async function runClaudeKick({ scheduled = false } = {}) {
  console.log('Checking network...');
  const networkReady = await waitForNetwork(30000);
  if (!networkReady) {
    throw new Error('Network not available after 30s.');
  }

  let preLaunchDelayMs = null;
  if (scheduled) {
    preLaunchDelayMs = choosePreLaunchDelayMs();
    console.log(`Network ready. Delaying Claude launch for ${formatDelay(preLaunchDelayMs)}.`);
    await sleepDelay(preLaunchDelayMs);
  }

  console.log('Kicking Claude Code...');
  await executeClaude({ preLaunchDelayMs });
}

function resolveClaudePath() {
  try {
    return execFileSync('/usr/bin/which', ['claude'], { encoding: 'utf-8' }).trim();
  } catch {
    throw new Error(
      'Claude CLI not found in PATH. Install it first: https://docs.anthropic.com/en/docs/claude-code'
    );
  }
}

function assertInstallRunAsUser() {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    throw new Error(
      `Run \`${RECOMMENDED_COMMAND} install --time HH:MM\` as your normal user. Do not use \`sudo ${RECOMMENDED_COMMAND} install\`.`
    );
  }
}

async function cmdInstall(args) {
  const { values } = parseCommandArgs('install', args, {
    time: { type: 'string' },
  });
  if (maybePrintCommandHelp('install', values)) {
    return;
  }

  assertInstallRunAsUser();
  const time = parseTimeValue('install', values.time, {
    defaultTime: DEFAULT_INSTALL_TIME,
  });
  const nodePath = process.execPath;
  const scriptPath = resolve(process.argv[1]);
  const claudePath = resolveClaudePath();
  const logDir = logDirPath();
  const previousInstall = readPreviousInstallState();
  const previousWakeTime = readPmsetRepeat();

  prepareLaunchdLogs(logDir);

  const envPath = [...new Set([dirname(claudePath), dirname(nodePath)])].join(':');
  const plist = buildPlist({ time, nodePath, scriptPath, logDir, envPath });
  schedulePmsetRepeat(time);
  try {
    registerLaunchd(plist);
  } catch (err) {
    const rollbackErrors = rollbackFailedInstall(previousInstall, previousWakeTime);
    if (rollbackErrors.length > 0) {
      throw new Error(`${err.message} Rollback also failed: ${rollbackErrors.join('; ')}`);
    }
    throw err;
  }

  console.log(`Installed: ${time}`);
  console.log('Daily wake + kick scheduled.');
}

async function cmdStatus(args) {
  const { values } = parseCommandArgs('status', args);
  if (maybePrintCommandHelp('status', values)) {
    return;
  }

  let time;
  try {
    time = readScheduledTime();
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.log('Not installed.');
      showInstallNextStep();
      return;
    }
    console.error(`Installed, but the launchd plist is unreadable: ${err.message}`);
    process.exit(1);
  }

  console.log('Installed: yes');
  console.log(`Time: ${time}`);
  console.log(`Change it with: ${RECOMMENDED_COMMAND} install --time HH:MM`);
  console.log(`Remove it with: ${RECOMMENDED_COMMAND} uninstall`);
}

async function cmdKick(args) {
  const { values } = parseCommandArgs('kick', args);
  if (maybePrintCommandHelp('kick', values)) {
    return;
  }

  try {
    await runClaudeKick();
    console.log('Kick completed.');
  } catch (err) {
    console.error(`Kick failed: ${err.message}`);
    process.exit(1);
  }
}

async function cmdRun(args) {
  const { values } = parseCommandArgs('run', args, {
    time: { type: 'string' },
  });
  if (maybePrintCommandHelp('run', values)) {
    return;
  }

  parseTimeValue('run', values.time, { required: true });

  try {
    await runClaudeKick({ scheduled: true });
    console.log('Scheduled kick completed.');
  } catch (err) {
    console.error(`Scheduled kick failed: ${err.message}`);
    process.exitCode = 1;
  }
}

async function cmdUninstall(args) {
  const { values } = parseCommandArgs('uninstall', args);
  if (maybePrintCommandHelp('uninstall', values)) {
    return;
  }

  unregisterLaunchd();
  try {
    cancelPmsetRepeat();
  } catch {
    // may not have a repeat rule
  }

  console.log('Uninstalled launchd and pmset schedules.');
}

export async function run(args) {
  try {
    const [command, ...rest] = args;

    if (!command || command === '-h' || command === '--help') {
      printUsage();
      return;
    }

    if (command === 'help') {
      const [topic] = rest;
      if (!topic) {
        printUsage();
        return;
      }

      if (!HELP_COMMANDS.has(topic)) {
        throw new Error(`Unknown help topic: ${topic}\nRun \`${RECOMMENDED_COMMAND} --help\` to see available commands.`);
      }

      printCommandHelp(topic);
      return;
    }

    if (HELP_COMMANDS.has(command) && (rest.includes('-h') || rest.includes('--help'))) {
      printCommandHelp(command);
      return;
    }

    if (await maybeSelfUpdate(command)) {
      return;
    }

    switch (command) {
      case 'install':
        return await cmdInstall(rest);
      case 'status':
        return await cmdStatus(rest);
      case 'kick':
        return await cmdKick(rest);
      case 'uninstall':
        return await cmdUninstall(rest);
      case 'run':
        return await cmdRun(rest);
      default:
        throw new Error(
          `Unknown command: ${command}\nRun \`${RECOMMENDED_COMMAND} --help\` to see available commands.`
        );
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
