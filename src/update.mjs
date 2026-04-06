import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { HELP_COMMANDS, RECOMMENDED_COMMAND } from './help.mjs';
import { PACKAGE_NAME, PACKAGE_VERSION } from './meta.mjs';
const UPDATE_ELIGIBLE_COMMANDS = new Set([...HELP_COMMANDS].filter(command => command !== 'run'));
const DEFAULT_UPDATE_CHECK_TTL_MS = 24 * 60 * 60 * 1000;

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

export async function maybeSelfUpdate(command) {
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
