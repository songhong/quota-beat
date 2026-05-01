import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { promises as dns } from 'node:dns';

const PROVIDERS = [
  {
    name: 'claude',
    displayName: 'Claude Code',
    command: 'claude',
    args: [
      '-p',
      '--model', 'haiku',
      '--no-session-persistence',
      '--tools', '',
      '--no-chrome',
      'Reply with exactly OK.',
    ],
    dnsHost: 'api.anthropic.com',
  },
  {
    name: 'codex',
    displayName: 'Codex',
    command: 'codex',
    args: ['exec', '--ephemeral', '-c', 'model_reasoning_effort=low', 'Reply with exactly OK.'],
    dnsHost: 'api.openai.com',
    timeoutMs: 180000,
  },
];

export { PROVIDERS };

const MAX_LOG_PREVIEW = 200;
const TEST_SKIP_SLEEP = process.env.QUOTA_BEAT_TEST_SKIP_SLEEP === '1';

export function kickLogPath() {
  return join(homedir(), '.quota-beat', 'logs', 'kick.jsonl');
}

function readTestDelayMs(envVar) {
  const raw = process.env[envVar];
  if (raw == null) return null;

  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${envVar} must be a non-negative integer.`);
  }
  return value;
}

function randomIntInclusive(min, max, testEnvVar) {
  const testValue = readTestDelayMs(testEnvVar);
  if (testValue != null) return testValue;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function formatDelayMs(ms) {
  const seconds = ms / 1000;
  return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(3)}s`;
}

async function sleep(ms) {
  if (TEST_SKIP_SLEEP || ms === 0) return;
  await new Promise(resolve => setTimeout(resolve, ms));
}

function summarizeOutput(value) {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= MAX_LOG_PREVIEW) return normalized;
  return `${normalized.slice(0, MAX_LOG_PREVIEW)}...`;
}

function failurePreview(stdout, stderr) {
  return summarizeOutput(stderr) || summarizeOutput(stdout);
}

function writeKickLog(entry) {
  const logPath = kickLogPath();
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
}

async function checkDns(host) {
  try {
    await dns.lookup(host);
    return true;
  } catch {
    return false;
  }
}

export async function waitForNetwork(providers, timeoutMs = 30000) {
  const hosts = [...new Set(providers.map(p => p.dnsHost))];
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    for (const host of hosts) {
      if (await checkDns(host)) return true;
    }
    await sleep(1000);
  }
  return false;
}

export function choosePreLaunchDelayMs(maxDelayMs = 60000) {
  return randomIntInclusive(0, maxDelayMs, 'QUOTA_BEAT_TEST_PRELAUNCH_DELAY_MS');
}

export function chooseRetryDelayMs() {
  return randomIntInclusive(5000, 10000, 'QUOTA_BEAT_TEST_RETRY_DELAY_MS');
}

export async function sleepDelay(ms) {
  await sleep(ms);
}

export function formatDelay(ms) {
  return formatDelayMs(ms);
}

function spawnProvider(provider, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const child = spawn(provider.command, provider.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });

    child.on('close', (code, signal) => {
      if (code === 0) resolve({ stdout, stderr, exitCode: code, signal });
      else {
        const detailText = failurePreview(stdout, stderr);
        const detail = signal
          ? `${provider.command} exited with signal ${signal}: ${detailText}`
          : `${provider.command} exited with code ${code}: ${detailText}`;
        const err = new Error(detail);
        err.exitCode = code;
        err.signal = signal;
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      }
    });

    child.on('error', err => {
      err.exitCode = null;
      err.signal = null;
      err.stdout = stdout;
      err.stderr = stderr;
      reject(err);
    });
  });
}

export async function executeProvider(provider, { retries = 2, timeoutMs = 60000, preLaunchDelayMs = null } = {}) {
  const effectiveTimeoutMs = provider.timeoutMs ?? timeoutMs;
  let lastErr;
  for (let i = 0; i < retries; i++) {
    const started = Date.now();
    const startedAt = new Date(started).toISOString();
    try {
      const result = await spawnProvider(provider, effectiveTimeoutMs);
      const finished = Date.now();
      writeKickLog({
        provider: provider.name,
        attempt: i + 1,
        success: true,
        startedAt,
        finishedAt: new Date(finished).toISOString(),
        durationMs: finished - started,
        exitCode: result.exitCode,
        signal: result.signal,
        stdoutPreview: summarizeOutput(result.stdout),
        stderrPreview: summarizeOutput(result.stderr),
        ...(i === 0 && preLaunchDelayMs != null ? { preLaunchDelayMs } : {}),
      });
      return result;
    } catch (err) {
      lastErr = err;
      const finished = Date.now();
      const willRetry = i < retries - 1;
      const retryDelayMs = willRetry ? chooseRetryDelayMs() : null;
      writeKickLog({
        provider: provider.name,
        attempt: i + 1,
        success: false,
        startedAt,
        finishedAt: new Date(finished).toISOString(),
        durationMs: finished - started,
        exitCode: err.exitCode ?? null,
        signal: err.signal ?? null,
        stdoutPreview: summarizeOutput(err.stdout ?? ''),
        stderrPreview: summarizeOutput(err.stderr ?? ''),
        errorMessage: err.message,
        willRetry,
        ...(i === 0 && preLaunchDelayMs != null ? { preLaunchDelayMs } : {}),
        ...(retryDelayMs != null ? { retryDelayMs } : {}),
      });
      if (willRetry) {
        console.error(
          `Attempt ${i + 1} failed: ${err.message}. Retrying in ${formatDelayMs(retryDelayMs)}...`
        );
        await sleep(retryDelayMs);
      }
    }
  }
  throw lastErr;
}

export async function runKick({ scheduled = false, jitterMinutes = 1, availableProviders = PROVIDERS } = {}) {
  console.log('Checking network...');
  const networkReady = await waitForNetwork(availableProviders);
  if (!networkReady) {
    throw new Error('Network not available after 30s.');
  }

  let preLaunchDelayMs = null;
  if (scheduled) {
    preLaunchDelayMs = choosePreLaunchDelayMs(jitterMinutes * 60 * 1000);
    console.log(`Network ready. Delaying launch for ${formatDelay(preLaunchDelayMs)}.`);
    await sleepDelay(preLaunchDelayMs);
  }

  const errors = [];
  for (const provider of availableProviders) {
    console.log(`Kicking ${provider.displayName}...`);
    try {
      await executeProvider(provider, { preLaunchDelayMs });
    } catch (err) {
      console.error(`Kick failed for ${provider.displayName}: ${err.message}`);
      errors.push(err);
    }
  }

  if (errors.length === availableProviders.length) {
    throw errors[0];
  }
}
