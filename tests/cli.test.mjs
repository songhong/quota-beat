import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

const nodeBinDir = dirname(process.execPath);
import { describe, it } from 'node:test';
import {
  createCliSandbox,
  createDnsPatch,
  createGetuidPatch,
  createPlatformPatch,
  readJson,
  readLines,
  runCli,
  writeFile,
} from './support/cli-harness.mjs';
import { PACKAGE_NAME, PACKAGE_VERSION } from '../src/meta.mjs';

describe('qbeat CLI', () => {
  it('shows root help with command summary and examples', async t => {
    const sandbox = createCliSandbox(t);

    const { stdout } = await runCli(sandbox, ['--help']);

    assert.match(stdout, /Usage: qbeat <command> \[options\]/);
    assert.match(stdout, /Aliases: qbeat, quotabeat/);
    assert.match(stdout, /-v, --version\s+Show the installed qbeat version/);
    assert.match(stdout, /Keep Claude Code and Codex on a fixed daily wake \+ kick schedule on macOS\./);
    assert.match(stdout, /install\s+Register launchd \+ pmset wake at a fixed time/);
    assert.match(stdout, /status\s+Show the installed daily schedule/);
    assert.match(stdout, /kick\s+Kick Claude Code now/);
    assert.match(stdout, /uninstall\s+Remove launchd \+ pmset schedules/);
    assert.doesNotMatch(stdout, /^\s*run\s+/m);
    assert.match(stdout, /qbeat install --time 07:00/);
    assert.match(stdout, /Run `qbeat <command> -h` for command-specific help\./);
  });

  it('prints the installed version from the root flag', async t => {
    const sandbox = createCliSandbox(t);

    const { stdout } = await runCli(sandbox, ['--version'], {
      env: {
        QUOTA_BEAT_FORCE_UPDATE_CHECK: '1',
        QUOTA_BEAT_AUTO_UPDATE: 'yes',
        QUOTA_BEAT_NPM_VIEW_VERSION: '9.9.9',
      },
    });

    assert.equal(stdout.trim(), PACKAGE_VERSION);
    assert.deepEqual(readLines(sandbox.npmLogPath), []);
  });

  it('does not expose help for the internal run command', async t => {
    const sandbox = createCliSandbox(t);

    await assert.rejects(
      runCli(sandbox, ['help', 'run']),
      err => {
        assert.equal(err.code, 1);
        assert.match(err.stderr, /Unknown help topic: run/);
        assert.match(err.stderr, /Run `qbeat --help` to see available commands\./);
        return true;
      }
    );
  });

  it('shows detailed help for install', async t => {
    const sandbox = createCliSandbox(t);

    const { stdout } = await runCli(sandbox, ['install', '--help']);

    assert.match(stdout, /Usage: qbeat install \[--time HH:MM\] \[--jitter <minutes>\]/);
    assert.match(stdout, /--time HH:MM\s+First daily kick time in 24-hour format \(default: 07:00\)/);
    assert.match(stdout, /--jitter <minutes>\s+Max random delay before each kick, 1-30 \(default: 1\)/);
    assert.match(stdout, /Schedules 3 kicks per day/);
    assert.match(stdout, /install overwrites the existing qbeat schedule\./);
    assert.match(stdout, /Run qbeat as your normal user\. It will use sudo only for pmset\./);
  });

  it('still shows help on unsupported platforms', async t => {
    const sandbox = createCliSandbox(t);
    const platformPatch = createPlatformPatch(sandbox, 'win32');

    const { stdout } = await runCli(sandbox, ['--help'], {
      env: {
        NODE_OPTIONS: `--require ${platformPatch}`,
      },
    });

    assert.match(stdout, /Usage: qbeat <command> \[options\]/);
    assert.match(stdout, /macOS/);
  });

  it('rejects invalid install time with a clean error', async t => {
    const sandbox = createCliSandbox(t);

    await assert.rejects(
      runCli(sandbox, ['install', '--time', '7:00']),
      err => {
        assert.equal(err.code, 1);
        assert.match(err.stderr, /Invalid --time value: Time must use HH:MM in 24-hour format\./);
        assert.match(err.stderr, /See `qbeat install -h` for usage\./);
        assert.doesNotMatch(err.stderr, /file:\/\//);
        return true;
      }
    );
  });

  it('rejects unexpected install arguments', async t => {
    const sandbox = createCliSandbox(t);

    await assert.rejects(
      runCli(sandbox, ['install', 'extra']),
      err => {
        assert.equal(err.code, 1);
        assert.match(err.stderr, /Unexpected argument 'extra'/);
        assert.match(err.stderr, /See `qbeat install -h` for usage\./);
        return true;
      }
    );
  });

  it('rejects install when the whole command is run as root', async t => {
    const sandbox = createCliSandbox(t);
    const uidPatch = createGetuidPatch(sandbox, 0);

    await assert.rejects(
      runCli(sandbox, ['install', '--time', '08:30'], {
        env: {
          NODE_OPTIONS: `--require ${uidPatch}`,
        },
      }),
      err => {
        assert.equal(err.code, 1);
        assert.match(
          err.stderr,
          /Run `qbeat install --time HH:MM` as your normal user\. Do not use `sudo qbeat install`\./
        );
        return true;
      }
    );
  });

  it('installs the launch agent and schedules 3 pmset repeat wakes', async t => {
    const sandbox = createCliSandbox(t);

    const { stdout } = await runCli(sandbox, ['install', '--time', '08:30']);

    assert.match(stdout, /Installed: 08:30 \(jitter: 1m\)/);
    assert.match(stdout, /Daily wakes \+ kicks scheduled\./);

    const plist = readFileSync(sandbox.plistPath, 'utf8');
    assert.match(plist, new RegExp(`<string>${process.execPath}</string>`));
    assert.match(plist, /<string>run<\/string>/);
    assert.match(plist, /<string>--time<\/string>/);
    assert.match(plist, /<string>08:30<\/string>/);
    assert.match(plist, /<string>--jitter<\/string>/);
    assert.match(plist, /<string>1<\/string>/);
    assert.doesNotMatch(plist, /<key>RunAtLoad<\/key>/);
    assert.match(plist, /<key>PATH<\/key>/,
      'plist must include PATH so launchd can find the claude binary');

    // StartCalendarInterval must be an array with 3 entries
    assert.match(plist, /<key>StartCalendarInterval<\/key>\s*<array>/s);
    const dictMatches = [...plist.matchAll(/<dict>\s*<key>Hour<\/key>/g)];
    assert.equal(dictMatches.length, 3, 'plist must have 3 StartCalendarInterval entries');

    const launchctlCalls = readLines(sandbox.launchctlLogPath).map(line => JSON.parse(line));
    assert.deepEqual(launchctlCalls[0].slice(0, 2), ['bootout', `gui/${process.getuid()}`]);
    assert.deepEqual(launchctlCalls[1].slice(0, 2), ['bootstrap', `gui/${process.getuid()}`]);

    // 08:30 + jitter=1: kicks at 08:30, 13:31, 18:32 → wakes at 08:29, 13:30, 18:31
    const state = readJson(sandbox.pmsetStatePath);
    assert.deepEqual(state.repeats, ['08:29:00', '13:30:00', '18:31:00'],
      'pmset repeat should be set for all 3 kick wake times');
  });

  it('respects custom --jitter value', async t => {
    const sandbox = createCliSandbox(t);

    const { stdout } = await runCli(sandbox, ['install', '--time', '07:00', '--jitter', '2']);

    assert.match(stdout, /Installed: 07:00 \(jitter: 2m\)/);

    const plist = readFileSync(sandbox.plistPath, 'utf8');
    assert.match(plist, /<string>2<\/string>/);

    // 07:00 + jitter=2: kicks at 07:00, 12:02, 17:04 → wakes at 06:59, 12:01, 17:03
    const state = readJson(sandbox.pmsetStatePath);
    assert.deepEqual(state.repeats, ['06:59:00', '12:01:00', '17:03:00']);
  });

  it('rejects --jitter with non-integer or out-of-range values', async t => {
    const sandbox = createCliSandbox(t);

    await assert.rejects(
      runCli(sandbox, ['install', '--time', '07:00', '--jitter', '0']),
      /--jitter must be between 1 and 30/
    );

    await assert.rejects(
      runCli(sandbox, ['install', '--time', '07:00', '--jitter', '31']),
      /--jitter must be between 1 and 30/
    );

    await assert.rejects(
      runCli(sandbox, ['install', '--time', '07:00', '--jitter', 'abc']),
      /--jitter must be a positive integer/
    );

    await assert.rejects(
      runCli(sandbox, ['install', '--time', '07:00', '--jitter', '3abc']),
      /--jitter must be a positive integer/
    );
  });

  it('rolls back pmset and launchd changes when launchctl bootstrap fails', async t => {
    const sandbox = createCliSandbox(t);
    await runCli(sandbox, ['install', '--time', '07:00']);

    await assert.rejects(
      runCli(sandbox, ['install', '--time', '08:30'], {
        env: {
          QUOTA_BEAT_LAUNCHCTL_BOOTSTRAP_EXIT_CODE: '91',
        },
      }),
      err => {
        assert.equal(err.code, 1);
        assert.match(err.stderr, /launchctl bootstrap/);
        return true;
      }
    );

    const plist = readFileSync(sandbox.plistPath, 'utf8');
    assert.match(plist, /<string>07:00<\/string>/);

    // 07:00 + jitter=1: wakes at 06:59, 12:00, 17:01
    const state = readJson(sandbox.pmsetStatePath);
    assert.deepEqual(state.repeats, ['06:59:00', '12:00:00', '17:01:00'],
      'failed installs should restore the previous 3-wake schedule');
  });

  it('uses the plist as the only source of truth for status', async t => {
    const sandbox = createCliSandbox(t);
    await runCli(sandbox, ['install', '--time', '09:10']);

    const { stdout } = await runCli(sandbox, ['status']);

    assert.match(stdout, /Installed: yes/);
    // 09:10 + jitter=1: kicks at 09:10, 14:11, 19:12
    assert.match(stdout, /Time: 09:10 — kicks at 09:10, 14:11, 19:12 \(up to 1m jitter each\)/);
    assert.match(stdout, /Change it with: qbeat install --time HH:MM/);
    assert.match(stdout, /Remove it with: qbeat uninstall/);
  });

  it('reports not installed when the plist does not exist', async t => {
    const sandbox = createCliSandbox(t);

    const { stdout } = await runCli(sandbox, ['status']);

    assert.match(stdout, /^Not installed\./m);
    assert.match(stdout, /Next step: qbeat install --time 07:00/);
    assert.match(stdout, /See `qbeat install -h` for details\./);
  });

  it('rejects unexpected status arguments with a help hint', async t => {
    const sandbox = createCliSandbox(t);

    await assert.rejects(
      runCli(sandbox, ['status', 'extra']),
      err => {
        assert.equal(err.code, 1);
        assert.match(err.stderr, /Unexpected argument 'extra'/);
        assert.match(err.stderr, /See `qbeat status -h` for usage\./);
        return true;
      }
    );
  });

  it('fails fast with a clean error on unsupported platforms', async t => {
    const sandbox = createCliSandbox(t);
    const platformPatch = createPlatformPatch(sandbox, 'win32');

    await assert.rejects(
      runCli(sandbox, ['status'], {
        env: {
          NODE_OPTIONS: `--require ${platformPatch}`,
          QUOTA_BEAT_FORCE_UPDATE_CHECK: '1',
          QUOTA_BEAT_AUTO_UPDATE: 'yes',
          QUOTA_BEAT_NPM_VIEW_VERSION: '99.0.0',
        },
      }),
      err => {
        assert.equal(err.code, 1);
        assert.match(
          err.stderr,
          /quota-beat supports macOS only\. `status` is unavailable on win32 because quota-beat depends on launchd and pmset\./
        );
        return true;
      }
    );

    assert.deepEqual(readLines(sandbox.npmLogPath), []);
  });

  it('offers a self-update for interactive commands and exits after updating', async t => {
    const sandbox = createCliSandbox(t);

    const { stdout } = await runCli(sandbox, ['status'], {
      env: {
        QUOTA_BEAT_FORCE_UPDATE_CHECK: '1',
        QUOTA_BEAT_AUTO_UPDATE: 'yes',
        QUOTA_BEAT_NPM_VIEW_VERSION: '99.0.0',
      },
    });

    assert.match(stdout, new RegExp(`Updating ${PACKAGE_NAME.replace('/', '\\/')} to 99\\.0\\.0`));
    assert.match(stdout, /Update completed\. Re-run qbeat to use 99.0.0\./);
    assert.doesNotMatch(stdout, /Not installed\./);

    const npmCalls = readLines(sandbox.npmLogPath).map(line => JSON.parse(line));
    assert.deepEqual(npmCalls, [['install', '-g', `${PACKAGE_NAME}@99.0.0`]]);
  });

  it('continues the requested command when the update is declined', async t => {
    const sandbox = createCliSandbox(t);

    const { stdout } = await runCli(sandbox, ['status'], {
      env: {
        QUOTA_BEAT_FORCE_UPDATE_CHECK: '1',
        QUOTA_BEAT_AUTO_UPDATE: 'no',
        QUOTA_BEAT_NPM_VIEW_VERSION: '99.0.0',
      },
    });

    assert.match(stdout, /Not installed\./);
    assert.deepEqual(readLines(sandbox.npmLogPath), []);
  });

  it('emits update-check stderr output when npm view fails', async t => {
    const sandbox = createCliSandbox(t);

    const { stdout, stderr } = await runCli(sandbox, ['status'], {
      env: {
        QUOTA_BEAT_FORCE_UPDATE_CHECK: '1',
      },
    });

    assert.match(stdout, /Not installed\./);
    assert.match(
      stderr,
      new RegExp(`Update check failed: npm view ${PACKAGE_NAME.replace('/', '\\/')} version --json failed`)
    );
    assert.match(stderr, /status=1/);
  });

  it('fails status when the installed plist is unreadable', async t => {
    const sandbox = createCliSandbox(t);
    writeFile(sandbox.plistPath, '<plist></plist>');

    await assert.rejects(
      runCli(sandbox, ['status']),
      err => {
        assert.equal(err.code, 1);
        assert.match(err.stderr, /Installed, but the launchd plist is unreadable:/);
        return true;
      }
    );
  });

  it('runs claude immediately for kick', async t => {
    const sandbox = createCliSandbox(t);
    rmSync(join(sandbox.root, 'bin', 'codex'));
    const dnsPatch = createDnsPatch(sandbox, 'success');

    const { stdout } = await runCli(sandbox, ['kick'], {
      env: {
        NODE_OPTIONS: `--require ${dnsPatch}`,
        PATH: `${join(sandbox.root, 'bin')}:${nodeBinDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
      },
    });

    assert.match(stdout, /Checking network\.\.\./);
    assert.match(stdout, /Kicking Claude Code\.\.\./);
    assert.match(stdout, /Kick completed\./);
    assert.doesNotMatch(stdout, /Network ready\. Delaying Claude launch/);

    const claudeCalls = readLines(sandbox.claudeLogPath).map(line => JSON.parse(line));
    assert.deepEqual(claudeCalls, [[
      '-p',
      '--model',
      'haiku',
      '--no-session-persistence',
      '--tools',
      '',
      '--no-chrome',
      'Reply with exactly OK.',
    ]]);

    const invocationLog = readLines(sandbox.kickLogPath).map(line => JSON.parse(line));
    assert.equal(invocationLog.length, 1);
    assert.equal(invocationLog[0].provider, 'claude');
    assert.equal(invocationLog[0].attempt, 1);
    assert.equal(invocationLog[0].success, true);
    assert.equal(invocationLog[0].exitCode, 0);
    assert.equal(invocationLog[0].stdoutPreview, 'OK');
    assert.equal(invocationLog[0].stderrPreview, '');
    assert.equal('preLaunchDelayMs' in invocationLog[0], false);
  });

  it('closes claude stdin so non-interactive invocations can complete', async t => {
    const sandbox = createCliSandbox(t);
    rmSync(join(sandbox.root, 'bin', 'codex'));
    const dnsPatch = createDnsPatch(sandbox, 'success');

    const { stdout } = await runCli(sandbox, ['kick'], {
      env: {
        NODE_OPTIONS: `--require ${dnsPatch}`,
        PATH: `${join(sandbox.root, 'bin')}:${nodeBinDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
        QUOTA_BEAT_CLAUDE_REQUIRE_STDIN_EOF: '1',
      },
    });

    assert.match(stdout, /Kick completed\./);

    const invocationLog = readLines(sandbox.kickLogPath).map(line => JSON.parse(line));
    assert.equal(invocationLog.length, 1);
    assert.equal(invocationLog[0].provider, 'claude');
    assert.equal(invocationLog[0].success, true);
    assert.equal(invocationLog[0].stdoutPreview, 'OK');
  });

  it('adds a randomized launch delay for scheduled runs after network is ready', async t => {
    const sandbox = createCliSandbox(t);
    rmSync(join(sandbox.root, 'bin', 'codex'));
    const dnsPatch = createDnsPatch(sandbox, 'success');

    const { stdout } = await runCli(sandbox, ['run', '--time', '08:30', '--jitter', '1'], {
      env: {
        NODE_OPTIONS: `--require ${dnsPatch}`,
        PATH: `${join(sandbox.root, 'bin')}:${nodeBinDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
        QUOTA_BEAT_TEST_PRELAUNCH_DELAY_MS: '0',
        QUOTA_BEAT_TEST_SKIP_SLEEP: '1',
      },
    });

    assert.match(stdout, /Checking network\.\.\./);
    assert.match(stdout, /Network ready\. Delaying launch for 0s\./);
    assert.match(stdout, /Kicking Claude Code\.\.\./);
    assert.match(stdout, /Scheduled kick completed\./);

    const invocationLog = readLines(sandbox.kickLogPath).map(line => JSON.parse(line));
    assert.equal(invocationLog.length, 1);
    assert.equal(invocationLog[0].provider, 'claude');
    assert.equal(invocationLog[0].attempt, 1);
    assert.equal(invocationLog[0].success, true);
    assert.equal(invocationLog[0].preLaunchDelayMs, 0);
  });

  it('requires --time for the internal run command', async t => {
    const sandbox = createCliSandbox(t);

    await assert.rejects(
      runCli(sandbox, ['run']),
      err => {
        assert.equal(err.code, 1);
        assert.match(err.stderr, /Missing required option --time\./);
        assert.match(err.stderr, /Run `qbeat --help` to see available commands\./);
        return true;
      }
    );
  });

  it('surfaces claude failures during kick', async t => {
    const sandbox = createCliSandbox(t);
    rmSync(join(sandbox.root, 'bin', 'codex'));
    const dnsPatch = createDnsPatch(sandbox, 'success');

    await assert.rejects(
      runCli(sandbox, ['kick'], {
        env: {
          NODE_OPTIONS: `--require ${dnsPatch}`,
          PATH: `${join(sandbox.root, 'bin')}:${nodeBinDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
          QUOTA_BEAT_CLAUDE_EXIT_CODE: '9',
          QUOTA_BEAT_CLAUDE_STDERR: 'broken',
          QUOTA_BEAT_TEST_RETRY_DELAY_MS: '5000',
          QUOTA_BEAT_TEST_SKIP_SLEEP: '1',
        },
      }),
      err => {
        assert.equal(err.code, 1);
        assert.match(err.stderr, /Kick failed: claude exited with code 9: broken/);
        assert.match(err.stderr, /Retrying in 5s\.\.\./);
        return true;
      }
    );

    const invocationLog = readLines(sandbox.kickLogPath).map(line => JSON.parse(line));
    assert.equal(invocationLog.length, 2);
    assert.equal(invocationLog[0].provider, 'claude');
    assert.equal(invocationLog[0].attempt, 1);
    assert.equal(invocationLog[0].willRetry, true);
    assert.equal(invocationLog[0].retryDelayMs, 5000);
    assert.equal(invocationLog[1].provider, 'claude');
    assert.equal(invocationLog[1].attempt, 2);
    assert.equal(invocationLog[1].success, false);
    assert.equal(invocationLog[1].exitCode, 9);
    assert.equal(invocationLog[1].stderrPreview, 'broken');
  });

  it('uninstalls the launch agent and cancels pmset repeat', async t => {
    const sandbox = createCliSandbox(t);
    await runCli(sandbox, ['install', '--time', '07:00']);
    assert.equal(existsSync(sandbox.plistPath), true);

    const { stdout } = await runCli(sandbox, ['uninstall']);

    assert.equal(stdout.trim(), 'Uninstalled launchd and pmset schedules.');
    assert.equal(existsSync(sandbox.plistPath), false);

    const state = readJson(sandbox.pmsetStatePath);
    assert.deepEqual(state.repeats, [], 'pmset repeat should be cleared');
  });

  it('never checks for updates in launchd-only run', async t => {
    const sandbox = createCliSandbox(t);
    const dnsPatch = createDnsPatch(sandbox, 'success');

    const { stdout } = await runCli(sandbox, ['run', '--time', '07:00', '--jitter', '1'], {
      env: {
        NODE_OPTIONS: `--require ${dnsPatch}`,
        QUOTA_BEAT_FORCE_UPDATE_CHECK: '1',
        QUOTA_BEAT_AUTO_UPDATE: 'yes',
        QUOTA_BEAT_NPM_VIEW_VERSION: '99.0.0',
        QUOTA_BEAT_TEST_PRELAUNCH_DELAY_MS: '0',
        QUOTA_BEAT_TEST_SKIP_SLEEP: '1',
      },
    });

    assert.match(stdout, /Checking network\.\.\./);
    assert.deepEqual(readLines(sandbox.npmLogPath), []);
  });

  it('kicks both claude and codex when both are available', async t => {
    const sandbox = createCliSandbox(t);
    const dnsPatch = createDnsPatch(sandbox, 'success');

    const { stdout } = await runCli(sandbox, ['kick'], {
      env: {
        NODE_OPTIONS: `--require ${dnsPatch}`,
      },
    });

    assert.match(stdout, /Kicking Claude Code\.\.\./);
    assert.match(stdout, /Kicking Codex\.\.\./);
    assert.match(stdout, /Kick completed\./);

    const claudeCalls = readLines(sandbox.claudeLogPath).map(line => JSON.parse(line));
    assert.equal(claudeCalls.length, 1);
    assert.deepEqual(claudeCalls[0], [
      '-p', '--model', 'haiku', '--no-session-persistence',
      '--tools', '', '--no-chrome', 'Reply with exactly OK.',
    ]);

    const codexCalls = readLines(sandbox.codexLogPath).map(line => JSON.parse(line));
    assert.equal(codexCalls.length, 1);
    assert.deepEqual(codexCalls[0], ['exec', '-m', 'o3', 'Reply with exactly OK.']);

    const invocationLog = readLines(sandbox.kickLogPath).map(line => JSON.parse(line));
    assert.equal(invocationLog.length, 2);
    assert.equal(invocationLog[0].provider, 'claude');
    assert.equal(invocationLog[0].success, true);
    assert.equal(invocationLog[1].provider, 'codex');
    assert.equal(invocationLog[1].success, true);
  });

  it('skips codex when not found in PATH and only kicks claude', async t => {
    const sandbox = createCliSandbox(t);
    const dnsPatch = createDnsPatch(sandbox, 'success');

    rmSync(join(sandbox.root, 'bin', 'codex'));

    const { stdout, stderr } = await runCli(sandbox, ['kick'], {
      env: {
        NODE_OPTIONS: `--require ${dnsPatch}`,
        PATH: `${join(sandbox.root, 'bin')}:${nodeBinDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
      },
    });

    assert.match(stdout, /Kicking Claude Code\.\.\./);
    assert.doesNotMatch(stdout, /Kicking Codex\.\.\./);
    assert.match(stderr, /Warning: Codex not found in PATH/);
    assert.match(stdout, /Kick completed\./);

    const claudeCalls = readLines(sandbox.claudeLogPath).map(line => JSON.parse(line));
    assert.equal(claudeCalls.length, 1);

    const invocationLog = readLines(sandbox.kickLogPath).map(line => JSON.parse(line));
    assert.equal(invocationLog.length, 1);
    assert.equal(invocationLog[0].provider, 'claude');
  });

  it('kicks codex when claude is not found in PATH', async t => {
    const sandbox = createCliSandbox(t);
    const dnsPatch = createDnsPatch(sandbox, 'success');

    rmSync(join(sandbox.root, 'bin', 'claude'));

    const { stdout, stderr } = await runCli(sandbox, ['kick'], {
      env: {
        NODE_OPTIONS: `--require ${dnsPatch}`,
        PATH: `${join(sandbox.root, 'bin')}:${nodeBinDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
      },
    });

    assert.match(stdout, /Kicking Codex\.\.\./);
    assert.doesNotMatch(stdout, /Kicking Claude Code\.\.\./);
    assert.match(stderr, /Warning: Claude Code not found in PATH/);
    assert.match(stdout, /Kick completed\./);

    const codexCalls = readLines(sandbox.codexLogPath).map(line => JSON.parse(line));
    assert.equal(codexCalls.length, 1);
    assert.deepEqual(codexCalls[0], ['exec', '-m', 'o3', 'Reply with exactly OK.']);
  });

  it('install succeeds when codex is not in PATH', async t => {
    const sandbox = createCliSandbox(t);

    rmSync(join(sandbox.root, 'bin', 'codex'));

    const { stdout, stderr } = await runCli(sandbox, ['install', '--time', '08:30'], {
      env: {
        PATH: `${join(sandbox.root, 'bin')}:${nodeBinDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
      },
    });

    assert.match(stdout, /Installed: 08:30 \(jitter: 1m\)/);
    assert.match(stderr, /Warning: Codex not found in PATH/);

    const plist = readFileSync(sandbox.plistPath, 'utf8');
    assert.match(plist, /<key>PATH<\/key>/);
  });

  it('install fails when no providers are found in PATH', async t => {
    const sandbox = createCliSandbox(t);

    rmSync(join(sandbox.root, 'bin', 'claude'));
    rmSync(join(sandbox.root, 'bin', 'codex'));

    await assert.rejects(
      runCli(sandbox, ['install', '--time', '08:30'], {
        env: {
          PATH: `${join(sandbox.root, 'bin')}:${nodeBinDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
        },
      }),
      err => {
        assert.equal(err.code, 1);
        assert.match(err.stderr, /No kick providers found in PATH/);
        return true;
      }
    );
  });

  it('includes both claude and codex bin dirs in plist PATH', async t => {
    const sandbox = createCliSandbox(t);

    await runCli(sandbox, ['install', '--time', '09:00']);

    const plist = readFileSync(sandbox.plistPath, 'utf8');
    const binDir = join(sandbox.root, 'bin');
    assert.match(plist, new RegExp(binDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(plist, new RegExp(`<string>${process.execPath}</string>`));
  });

  it('network check succeeds when at least one provider DNS host resolves', async t => {
    const sandbox = createCliSandbox(t);
    const dnsPatch = createDnsPatch(sandbox, 'success');

    const { stdout } = await runCli(sandbox, ['kick'], {
      env: {
        NODE_OPTIONS: `--require ${dnsPatch}`,
      },
    });

    assert.match(stdout, /Kicking Claude Code\.\.\./);
    assert.match(stdout, /Kicking Codex\.\.\./);
    assert.match(stdout, /Kick completed\./);
  });
});
