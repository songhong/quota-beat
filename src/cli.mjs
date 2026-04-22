import { mkdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
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
  computeKickTimes,
  normalizeTime,
  parseJitterMinutes,
  plistPath,
  readInstalledConfig,
  readPmsetRepeat,
  registerLaunchd,
  schedulePmsetRepeat,
  setPmsetRepeatWakeTimes,
  unregisterLaunchd,
} from './scheduler.mjs';
import { PACKAGE_VERSION } from './meta.mjs';
import { maybeSelfUpdate } from './update.mjs';

const SUPPORTED_PLATFORM = 'darwin';

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

const MAX_JITTER_MINUTES = 30;

function parseJitterValue(command, value) {
  if (value == null) return 1;
  if (!/^\d+$/.test(value)) {
    throw new Error(`--jitter must be a positive integer (minutes).\n${usageHint(command)}`);
  }
  const n = Number(value);
  if (n < 1 || n > MAX_JITTER_MINUTES) {
    throw new Error(`--jitter must be between 1 and ${MAX_JITTER_MINUTES} (minutes).\n${usageHint(command)}`);
  }
  return n;
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

function restorePmsetRepeat(wakeTimes) {
  if (!wakeTimes || wakeTimes.length === 0) {
    cancelPmsetRepeat();
    return;
  }

  setPmsetRepeatWakeTimes(wakeTimes);
}

function rollbackFailedInstall(previousInstall, previousWakeTimes) {
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
    restorePmsetRepeat(previousWakeTimes);
  } catch (err) {
    errors.push(`pmset rollback failed: ${err.message}`);
  }

  return errors;
}

function assertSupportedPlatform(command) {
  if (process.platform === SUPPORTED_PLATFORM) {
    return;
  }

  throw new Error(
    `quota-beat supports macOS only. \`${command}\` is unavailable on ${process.platform} because quota-beat depends on launchd and pmset.`
  );
}

async function runClaudeKick({ scheduled = false, jitterMinutes = 1 } = {}) {
  console.log('Checking network...');
  const networkReady = await waitForNetwork(30000);
  if (!networkReady) {
    throw new Error('Network not available after 30s.');
  }

  let preLaunchDelayMs = null;
  if (scheduled) {
    preLaunchDelayMs = choosePreLaunchDelayMs(jitterMinutes * 60 * 1000);
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
    jitter: { type: 'string' },
  });
  if (maybePrintCommandHelp('install', values)) {
    return;
  }

  assertInstallRunAsUser();
  const time = parseTimeValue('install', values.time, {
    defaultTime: DEFAULT_INSTALL_TIME,
  });
  const jitterMinutes = parseJitterValue('install', values.jitter);
  const nodePath = process.execPath;
  const scriptPath = resolve(process.argv[1]);
  const claudePath = resolveClaudePath();
  const logDir = logDirPath();
  const previousInstall = readPreviousInstallState();
  const previousWakeTimes = readPmsetRepeat();

  prepareLaunchdLogs(logDir);

  const envPath = [...new Set([dirname(claudePath), dirname(nodePath)])].join(':');
  const plist = buildPlist({ time, nodePath, scriptPath, logDir, envPath, jitterMinutes });
  schedulePmsetRepeat(time, jitterMinutes);
  try {
    registerLaunchd(plist);
  } catch (err) {
    const rollbackErrors = rollbackFailedInstall(previousInstall, previousWakeTimes);
    if (rollbackErrors.length > 0) {
      throw new Error(`${err.message} Rollback also failed: ${rollbackErrors.join('; ')}`);
    }
    throw err;
  }

  console.log(`Installed: ${time} (jitter: ${jitterMinutes}m)`);
  console.log('Daily wakes + kicks scheduled.');
}

async function cmdStatus(args) {
  const { values } = parseCommandArgs('status', args);
  if (maybePrintCommandHelp('status', values)) {
    return;
  }

  let time, jitterMinutes;
  try {
    ({ time, jitterMinutes } = readInstalledConfig());
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.log('Not installed.');
      showInstallNextStep();
      return;
    }
    console.error(`Installed, but the launchd plist is unreadable: ${err.message}`);
    process.exit(1);
  }

  const kicks = computeKickTimes(time, jitterMinutes);
  console.log('Installed: yes');
  console.log(`Time: ${time} — kicks at ${kicks.join(', ')} (up to ${jitterMinutes}m jitter each)`);
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
    jitter: { type: 'string' },
  });

  parseTimeValue('run', values.time, { required: true });
  const jitterMinutes = parseJitterValue('run', values.jitter);

  try {
    await runClaudeKick({ scheduled: true, jitterMinutes });
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

    if (command === '-v' || command === '--version') {
      console.log(PACKAGE_VERSION);
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

    if (HELP_COMMANDS.has(command)) {
      assertSupportedPlatform(command);
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
