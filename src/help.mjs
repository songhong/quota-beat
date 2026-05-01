export const DEFAULT_INSTALL_TIME = '07:00';
export const HELP_COMMANDS = new Set(['install', 'status', 'kick', 'uninstall']);
export const RECOMMENDED_COMMAND = 'qbeat';
const COMMAND_ALIASES = ['qbeat', 'quotabeat'];

export function printUsage() {
  console.log(`Usage: ${RECOMMENDED_COMMAND} <command> [options]

Keep Claude Code and Codex on a fixed daily wake + kick schedule on macOS.
Aliases: ${COMMAND_ALIASES.join(', ')}

Global options:
  -h, --help       Show root help
  -v, --version    Show the installed ${RECOMMENDED_COMMAND} version

Commands:
  install     Register launchd + pmset wake at a fixed time
  status      Show the installed daily schedule
  kick        Kick Claude Code now
  uninstall   Remove launchd + pmset schedules

Examples:
  ${RECOMMENDED_COMMAND} install --time ${DEFAULT_INSTALL_TIME}
  ${RECOMMENDED_COMMAND} status
  ${RECOMMENDED_COMMAND} kick

Run \`${RECOMMENDED_COMMAND} <command> -h\` for command-specific help.`);
}

export function printCommandHelp(command) {
  switch (command) {
    case 'install':
      console.log(`Usage: ${RECOMMENDED_COMMAND} install [--time HH:MM] [--jitter <minutes>]

Register or replace the daily launchd + pmset schedule.

Options:
  -h, --help           Show this help message
  --time HH:MM         First daily kick time in 24-hour format (default: ${DEFAULT_INSTALL_TIME})
  --jitter <minutes>   Max random delay before each kick, 1-30 (default: 1)

Notes:
  Schedules 3 kicks per day: at --time, +5h, and +10h.
  A single pmset repeat wake fires 1 minute before the first kick.
  The 2nd and 3rd kicks only fire if the Mac is already awake.
  install overwrites the existing ${RECOMMENDED_COMMAND} schedule.
  Run ${RECOMMENDED_COMMAND} as your normal user. It will use sudo only for pmset.
  If your node or claude path changes later, run install again.
  ${RECOMMENDED_COMMAND} is the recommended command name. Aliases: ${COMMAND_ALIASES.join(', ')}.
  Both claude and codex paths are resolved and stored in the plist PATH.
  If a provider is missing, install still succeeds (it will be skipped at kick time).

Example:
  ${RECOMMENDED_COMMAND} install --time 08:30
  ${RECOMMENDED_COMMAND} install --time 08:30 --jitter 2`);
      return;
    case 'status':
      console.log(`Usage: ${RECOMMENDED_COMMAND} status

Show the installed daily schedule from the launchd plist.

Options:
  -h, --help        Show this help message

If ${RECOMMENDED_COMMAND} is not installed yet:
  ${RECOMMENDED_COMMAND} install --time ${DEFAULT_INSTALL_TIME}`);
      return;
    case 'kick':
      console.log(`Usage: ${RECOMMENDED_COMMAND} kick

Kick Claude Code immediately without changing the installed schedule.

Options:
  -h, --help        Show this help message

Behavior:
  Waits up to 30 seconds for network readiness.
  Kicks all installed providers (Claude Code, Codex).
  Missing providers are skipped with a warning.
  For each provider, attempts once, then retries at most once after a short delay.`);
      return;
    case 'uninstall':
      console.log(`Usage: ${RECOMMENDED_COMMAND} uninstall

Remove the ${RECOMMENDED_COMMAND} launchd agent and ${RECOMMENDED_COMMAND}-owned pmset repeat wake.

Options:
  -h, --help        Show this help message

Note:
  This does not uninstall the globally installed ${RECOMMENDED_COMMAND} binaries.`);
      return;
    default:
      printUsage();
  }
}

export function usageHint(command) {
  if (command === 'run') {
    return `Run \`${RECOMMENDED_COMMAND} --help\` to see available commands.`;
  }

  return `See \`${RECOMMENDED_COMMAND} ${command} -h\` for usage.`;
}

export function showInstallNextStep() {
  console.log(`Next step: ${RECOMMENDED_COMMAND} install --time ${DEFAULT_INSTALL_TIME}`);
  console.log(`See \`${RECOMMENDED_COMMAND} install -h\` for details.`);
}
