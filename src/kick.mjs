import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { promises as dns } from 'node:dns';

const CLAUDE_ARGS = [
  '-p',
  '--model', 'haiku',
  '--no-session-persistence',
  '--tools', '',
  '--no-chrome',
  'Reply with exactly OK.',
];

const MAX_LOG_PREVIEW = 200;
const TEST_SKIP_SLEEP = process.env.QUOTA_BEAT_TEST_SKIP_SLEEP === '1';

export function claudeInvocationLogPath() {
  return join(homedir(), '.quota-beat', 'logs', 'claude.jsonl');
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

function writeClaudeAttemptLog(entry) {
  const logPath = claudeInvocationLogPath();
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
}

async function checkNetwork() {
  try {
    await dns.lookup('api.anthropic.com');
    return true;
  } catch {
    return false;
  }
}

export async function waitForNetwork(timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await checkNetwork()) return true;
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

function spawnClaude(timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', CLAUDE_ARGS, {
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
          ? `claude exited with signal ${signal}: ${detailText}`
          : `claude exited with code ${code}: ${detailText}`;
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

export async function executeClaude({ retries = 2, timeoutMs = 60000, preLaunchDelayMs = null } = {}) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    const started = Date.now();
    const startedAt = new Date(started).toISOString();
    try {
      const result = await spawnClaude(timeoutMs);
      const finished = Date.now();
      writeClaudeAttemptLog({
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
      writeClaudeAttemptLog({
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
