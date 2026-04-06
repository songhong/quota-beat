import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
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
import { PACKAGE_VERSION } from '../src/meta.mjs';

describe('qbeat CLI', () => {
  it('shows root help with command summary and examples', async t => {
    const sandbox = createCliSandbox(t);

    const { stdout } = await runCli(sandbox, ['--help']);

    assert.match(stdout, /Usage: qbeat <command> \[options\]/);
    assert.match(stdout, /Aliases: qbeat, quotabeat/);
    assert.match(stdout, /-v, --version\s+Show the installed qbeat version/);
    assert.match(stdout, /Keep Claude Code on a fixed daily wake \+ kick schedule on macOS\./);
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

    assert.match(stdout, /Usage: qbeat install \[--time HH:MM\]/);
    assert.match(stdout, /--time HH:MM\s+Daily kick time in 24-hour format \(default: 07:00\)/);
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

  it('installs the launch agent and schedules pmset repeat wake', async t => {
    const sandbox = createCliSandbox(t);

    const { stdout } = await runCli(sandbox, ['install', '--time', '08:30']);

    assert.match(stdout, /Installed: 08:30/);
    assert.match(stdout, /Daily wake \+ kick scheduled\./);

    const plist = readFileSync(sandbox.plistPath, 'utf8');
    assert.match(plist, new RegExp(`<string>${process.execPath}</string>`));
    assert.match(plist, /<string>run<\/string>/);
    assert.match(plist, /<string>--time<\/string>/);
    assert.match(plist, /<string>08:30<\/string>/);
    assert.doesNotMatch(plist, /<key>RunAtLoad<\/key>/);
    assert.match(plist, /<key>PATH<\/key>/,
      'plist must include PATH so launchd can find the claude binary');

    const launchctlCalls = readLines(sandbox.launchctlLogPath).map(line => JSON.parse(line));
    assert.deepEqual(launchctlCalls[0].slice(0, 2), ['bootout', `gui/${process.getuid()}`]);
    assert.deepEqual(launchctlCalls[1].slice(0, 2), ['bootstrap', `gui/${process.getuid()}`]);

    const state = readJson(sandbox.pmsetStatePath);
    assert.equal(state.repeat, '08:28:00',
      'pmset repeat should be set to 2 minutes before kick time');
  });

  it('rolls back pmset and launchd changes when launchctl bootstrap fails', async t => {
    const sandbox = createCliSandbox(t, { initialRepeat: '06:58:00' });
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

    const state = readJson(sandbox.pmsetStatePath);
    assert.equal(state.repeat, '06:58:00',
      'failed installs should restore the previous wake rule');
  });

  it('uses the plist as the only source of truth for status', async t => {
    const sandbox = createCliSandbox(t);
    await runCli(sandbox, ['install', '--time', '09:10']);

    const { stdout } = await runCli(sandbox, ['status']);

    assert.match(stdout, /Installed: yes/);
    assert.match(stdout, /Time: 09:10/);
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
          QUOTA_BEAT_NPM_VIEW_VERSION: '0.2.0',
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
        QUOTA_BEAT_NPM_VIEW_VERSION: '0.2.0',
      },
    });

    assert.match(stdout, /Updating quota-beat to 0.2.0/);
    assert.match(stdout, /Update completed\. Re-run qbeat to use 0.2.0\./);
    assert.doesNotMatch(stdout, /Not installed\./);

    const npmCalls = readLines(sandbox.npmLogPath).map(line => JSON.parse(line));
    assert.deepEqual(npmCalls, [['install', '-g', 'quota-beat@latest']]);
  });

  it('continues the requested command when the update is declined', async t => {
    const sandbox = createCliSandbox(t);

    const { stdout } = await runCli(sandbox, ['status'], {
      env: {
        QUOTA_BEAT_FORCE_UPDATE_CHECK: '1',
        QUOTA_BEAT_AUTO_UPDATE: 'no',
        QUOTA_BEAT_NPM_VIEW_VERSION: '0.2.0',
      },
    });

    assert.match(stdout, /Not installed\./);
    assert.deepEqual(readLines(sandbox.npmLogPath), []);
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
    const dnsPatch = createDnsPatch(sandbox, 'success');

    const { stdout } = await runCli(sandbox, ['kick'], {
      env: {
        NODE_OPTIONS: `--require ${dnsPatch}`,
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

    const invocationLog = readLines(sandbox.claudeInvocationLogPath).map(line => JSON.parse(line));
    assert.equal(invocationLog.length, 1);
    assert.equal(invocationLog[0].attempt, 1);
    assert.equal(invocationLog[0].success, true);
    assert.equal(invocationLog[0].exitCode, 0);
    assert.equal(invocationLog[0].stdoutPreview, 'OK');
    assert.equal(invocationLog[0].stderrPreview, '');
    assert.equal('preLaunchDelayMs' in invocationLog[0], false);
  });

  it('closes claude stdin so non-interactive invocations can complete', async t => {
    const sandbox = createCliSandbox(t);
    const dnsPatch = createDnsPatch(sandbox, 'success');

    const { stdout } = await runCli(sandbox, ['kick'], {
      env: {
        NODE_OPTIONS: `--require ${dnsPatch}`,
        QUOTA_BEAT_CLAUDE_REQUIRE_STDIN_EOF: '1',
      },
    });

    assert.match(stdout, /Kick completed\./);

    const invocationLog = readLines(sandbox.claudeInvocationLogPath).map(line => JSON.parse(line));
    assert.equal(invocationLog.length, 1);
    assert.equal(invocationLog[0].success, true);
    assert.equal(invocationLog[0].stdoutPreview, 'OK');
  });

  it('adds a randomized launch delay for scheduled runs after network is ready', async t => {
    const sandbox = createCliSandbox(t);
    const dnsPatch = createDnsPatch(sandbox, 'success');

    const { stdout } = await runCli(sandbox, ['run', '--time', '08:30'], {
      env: {
        NODE_OPTIONS: `--require ${dnsPatch}`,
        QUOTA_BEAT_TEST_PRELAUNCH_DELAY_MS: '0',
        QUOTA_BEAT_TEST_SKIP_SLEEP: '1',
      },
    });

    assert.match(stdout, /Checking network\.\.\./);
    assert.match(stdout, /Network ready\. Delaying Claude launch for 0s\./);
    assert.match(stdout, /Kicking Claude Code\.\.\./);
    assert.match(stdout, /Scheduled kick completed\./);

    const invocationLog = readLines(sandbox.claudeInvocationLogPath).map(line => JSON.parse(line));
    assert.equal(invocationLog.length, 1);
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
    const dnsPatch = createDnsPatch(sandbox, 'success');

    await assert.rejects(
      runCli(sandbox, ['kick'], {
        env: {
          NODE_OPTIONS: `--require ${dnsPatch}`,
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

    const invocationLog = readLines(sandbox.claudeInvocationLogPath).map(line => JSON.parse(line));
    assert.equal(invocationLog.length, 2);
    assert.equal(invocationLog[0].attempt, 1);
    assert.equal(invocationLog[0].willRetry, true);
    assert.equal(invocationLog[0].retryDelayMs, 5000);
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
    assert.equal(state.repeat, null, 'pmset repeat should be cleared');
  });

  it('never checks for updates in launchd-only run', async t => {
    const sandbox = createCliSandbox(t);
    const dnsPatch = createDnsPatch(sandbox, 'success');

    const { stdout } = await runCli(sandbox, ['run', '--time', '07:00'], {
      env: {
        NODE_OPTIONS: `--require ${dnsPatch}`,
        QUOTA_BEAT_FORCE_UPDATE_CHECK: '1',
        QUOTA_BEAT_AUTO_UPDATE: 'yes',
        QUOTA_BEAT_NPM_VIEW_VERSION: '0.2.0',
        QUOTA_BEAT_TEST_PRELAUNCH_DELAY_MS: '0',
        QUOTA_BEAT_TEST_SKIP_SLEEP: '1',
      },
    });

    assert.match(stdout, /Checking network\.\.\./);
    assert.deepEqual(readLines(sandbox.npmLogPath), []);
  });
});
