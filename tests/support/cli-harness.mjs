import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const binPath = join(repoRoot, 'bin', 'qbeat.mjs');
const plistFileName = 'com.quota-beat.kick.plist';

const pmsetShim = `#!/usr/bin/env node
const { existsSync, readFileSync, writeFileSync } = require('node:fs');

const statePath = process.env.QUOTA_BEAT_PMSET_STATE;
const args = process.argv.slice(2);

function loadState() {
  if (!existsSync(statePath)) {
    return { repeats: [] };
  }
  return JSON.parse(readFileSync(statePath, 'utf8'));
}

function saveState(state) {
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function render(state) {
  const lines = ['Scheduled power events:'];
  if (state.repeats && state.repeats.length > 0) {
    const eventLines = state.repeats.map(t => \`  wakeorpoweron at \${t}\`).join('\\n');
    lines.push(\` Repeating:\\n\${eventLines}\`);
  }
  return \`\${lines.join('\\n')}\\n\`;
}

const state = loadState();

if (args[0] === '-g' && args[1] === 'sched') {
  process.stdout.write(render(state));
  process.exit(0);
}

if (args[0] === 'repeat' && args[1] === 'cancel' && args[2] === 'wakeorpoweron') {
  state.repeats = [];
  saveState(state);
  process.exit(0);
}

if (args[0] === 'repeat') {
  // Parse multiple triplets: wakeorpoweron MTWRFSU HH:MM:SS [wakeorpoweron MTWRFSU HH:MM:SS ...]
  const times = [];
  let i = 1;
  while (i + 2 < args.length) {
    if (args[i] === 'wakeorpoweron') {
      times.push(args[i + 2]);
      i += 3;
    } else {
      break;
    }
  }
  if (times.length > 0) {
    state.repeats = times;
    saveState(state);
    process.exit(0);
  }
}

console.error(\`Unexpected pmset args: \${args.join(' ')}\`);
process.exit(1);
`;

const sudoShim = `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');

const [command, ...args] = process.argv.slice(2);
const result = spawnSync(command, args, { stdio: 'inherit', env: process.env });

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
`;

const launchctlShim = `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');

const args = process.argv.slice(2);

appendFileSync(
  process.env.QUOTA_BEAT_LAUNCHCTL_LOG,
  \`\${JSON.stringify(args)}\\n\`
);

if (args[0] === 'bootstrap') {
  const exitCode = Number(process.env.QUOTA_BEAT_LAUNCHCTL_BOOTSTRAP_EXIT_CODE || '0');
  if (exitCode !== 0) {
    process.stderr.write('bootstrap failed\\n');
    process.exit(exitCode);
  }
}

process.exit(0);
`;

const npmShim = `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');

const logPath = process.env.QUOTA_BEAT_NPM_LOG;
const args = process.argv.slice(2);

if (args[0] === 'view' && args[2] === 'version' && args[3] === '--json') {
  const version = process.env.QUOTA_BEAT_NPM_VIEW_VERSION;
  if (!version) {
    process.stderr.write('missing QUOTA_BEAT_NPM_VIEW_VERSION\\n');
    process.exit(1);
  }

  process.stdout.write(JSON.stringify(version));
  process.exit(0);
}

if (args[0] === 'install' && args[1] === '-g') {
  appendFileSync(logPath, \`\${JSON.stringify(args)}\\n\`);
  process.exit(Number(process.env.QUOTA_BEAT_NPM_INSTALL_EXIT_CODE || '0'));
}

process.stderr.write(\`Unexpected npm args: \${args.join(' ')}\\n\`);
process.exit(1);
`;

const claudeShim = `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');

appendFileSync(
  process.env.QUOTA_BEAT_CLAUDE_LOG,
  \`\${JSON.stringify(process.argv.slice(2))}\\n\`
);

function finish() {
  const exitCode = Number(process.env.QUOTA_BEAT_CLAUDE_EXIT_CODE || '0');
  if (exitCode !== 0) {
    process.stderr.write(process.env.QUOTA_BEAT_CLAUDE_STDERR || 'claude failed');
    process.exit(exitCode);
  }

  process.stdout.write('OK\\n');
}

if (process.env.QUOTA_BEAT_CLAUDE_REQUIRE_STDIN_EOF === '1') {
  let finished = false;
  const waitMs = Number(process.env.QUOTA_BEAT_CLAUDE_STDIN_WAIT_MS || '200');
  process.stdin.on('end', () => {
    finished = true;
    finish();
  });
  process.stdin.resume();
  setTimeout(() => {
    if (!finished) {
      process.stderr.write('stdin did not close');
      process.exit(98);
    }
  }, waitMs);
} else {
  finish();
}
`;

const codexShim = `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');

appendFileSync(
  process.env.QUOTA_BEAT_CODEX_LOG,
  \`\${JSON.stringify(process.argv.slice(2))}\\n\`
);

function finish() {
  const exitCode = Number(process.env.QUOTA_BEAT_CODEX_EXIT_CODE || '0');
  if (exitCode !== 0) {
    process.stderr.write(process.env.QUOTA_BEAT_CODEX_STDERR || 'codex failed');
    process.exit(exitCode);
  }

  process.stdout.write('OK\\n');
}

finish();
`;

function writeExecutable(path, content) {
  writeFileSync(path, content, { mode: 0o755 });
}

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

export function createCliSandbox(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'quota-beat-tests-'));
  const homeDir = join(root, 'home');
  const binDir = join(root, 'bin');
  const stateDir = join(root, 'state');
  const platformPatchPath = join(root, 'platform-darwin.cjs');
  const pmsetStatePath = join(stateDir, 'pmset.json');
  const launchctlLogPath = join(stateDir, 'launchctl.log');
  const claudeLogPath = join(stateDir, 'claude.log');
  const codexLogPath = join(stateDir, 'codex.log');
  const npmLogPath = join(stateDir, 'npm.log');

  ensureDir(homeDir);
  ensureDir(binDir);
  ensureDir(stateDir);

  writeFileSync(
    pmsetStatePath,
    JSON.stringify({ repeats: options.initialRepeats ?? [] }, null, 2)
  );
  writeFileSync(launchctlLogPath, '');
  writeFileSync(claudeLogPath, '');
  writeFileSync(codexLogPath, '');
  writeFileSync(npmLogPath, '');
  writeFileSync(
    platformPatchPath,
    `Object.defineProperty(process, 'platform', { value: 'darwin' });`
  );

  writeExecutable(join(binDir, 'pmset'), pmsetShim);
  writeExecutable(join(binDir, 'sudo'), sudoShim);
  writeExecutable(join(binDir, 'launchctl'), launchctlShim);
  writeExecutable(join(binDir, 'npm'), npmShim);
  writeExecutable(join(binDir, 'claude'), claudeShim);
  writeExecutable(join(binDir, 'codex'), codexShim);

  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  return {
    root,
    homeDir,
    pmsetStatePath,
    launchctlLogPath,
    claudeLogPath,
    codexLogPath,
    npmLogPath,
    kickLogPath: join(homeDir, '.quota-beat', 'logs', 'kick.jsonl'),
    plistPath: join(homeDir, 'Library', 'LaunchAgents', plistFileName),
    env(extraEnv = {}) {
      const { NODE_OPTIONS: extraNodeOptions, ...restEnv } = extraEnv;
      const inheritedNodeOptions = extraNodeOptions?.trim();
      const nodeOptions = [`--require ${platformPatchPath}`];
      if (inheritedNodeOptions) {
        nodeOptions.push(inheritedNodeOptions);
      }

      return {
        ...process.env,
        HOME: homeDir,
        PATH: `${binDir}:${process.env.PATH}`,
        NODE_OPTIONS: nodeOptions.join(' '),
        QUOTA_BEAT_PMSET_STATE: pmsetStatePath,
        QUOTA_BEAT_LAUNCHCTL_LOG: launchctlLogPath,
        QUOTA_BEAT_CLAUDE_LOG: claudeLogPath,
        QUOTA_BEAT_CODEX_LOG: codexLogPath,
        QUOTA_BEAT_NPM_LOG: npmLogPath,
        ...restEnv,
      };
    },
  };
}

export async function runCli(sandbox, args, options = {}) {
  return execFileAsync(process.execPath, [binPath, ...args], {
    cwd: repoRoot,
    env: sandbox.env(options.env),
  });
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function readLines(path) {
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean);
}

export function writeFile(path, content) {
  ensureDir(dirname(path));
  writeFileSync(path, content);
}

export function createDnsPatch(sandbox, mode) {
  const patchPath = join(sandbox.root, `${mode}-dns.cjs`);
  const patch = mode === 'success'
    ? `const dns = require('node:dns'); dns.promises.lookup = async () => ({ address: '127.0.0.1', family: 4 });`
    : `const dns = require('node:dns'); dns.promises.lookup = async () => { throw new Error('offline'); };`;

  writeFileSync(patchPath, patch);
  return patchPath;
}

export function createGetuidPatch(sandbox, uid) {
  const patchPath = join(sandbox.root, `uid-${uid}.cjs`);
  writeFileSync(patchPath, `process.getuid = () => ${JSON.stringify(uid)};`);
  return patchPath;
}

export function createPlatformPatch(sandbox, platform) {
  const patchPath = join(sandbox.root, `platform-${platform}.cjs`);
  writeFileSync(
    patchPath,
    `Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} });`
  );
  return patchPath;
}
