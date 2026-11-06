import type { DevicePlatform, DeviceShell } from '@cc-desk-tunnel/protocol';

// How Claude's commands run on a device: its system, the shells it runs scripts in, and the one of them the user
// prefers, if any.
export type Execution = { platform: DevicePlatform; shells: DeviceShell[]; shell?: DeviceShell };

// The shell a device has when it has said nothing of its shells: the one its system always has.
export const systemShell = (platform: DevicePlatform): DeviceShell =>
  platform === 'win32' ? 'pwsh' : platform === 'darwin' ? 'zsh' : 'bash';

// A Windows path as Git Bash writes it: C:\x is /c/x, \\server\share is //server/share.
const msysPath = (path: string) =>
  path
    .replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`)
    .replaceAll('\\', '/');
const quoted = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

// What Claude is told that depends on the device: in the system prompt, and again with a message when a session goes
// on from a device of another system or with other shells, or the user prefers another of them. Everything else reads
// the same for all, and is worded to hold on every system: what becomes of a process when its command ends differs
// between them, so Claude is told to count on neither outcome. Each shell's host is written as Claude writes an SSH
// alias for any host, and each script as a here-document in that shell's own language.
export function deviceTerms({ platform, shells, shell }: Execution, projectPath: string) {
  const text =
    'as plain text: any length, UTF-8, nothing to escape or encode. The exit code is kept; standard input is the script, so it cannot read more.';
  if (platform === 'win32') {
    const pwsh = `Set-Location -LiteralPath '${projectPath.replaceAll("'", "''")}'`;
    // sftp reads C:/x as a path under the user's home; /C:/x is the drive's for it and for scp alike.
    const remote = projectPath.replaceAll('\\', '/').replace(/^(?=[A-Za-z]:)/, '/');
    const scp = `The host device runs a command line as it is, parsed by cmd.exe, and is the one for scp or sftp, where a Windows path takes forward slashes and one before its drive: the project directory is ${JSON.stringify(`device:${remote}`)}.`;
    const script = shells.includes('bash')
      ? [
          `Send a script on standard input, as a quoted Bash here-document, to the host of the shell it is written for: ssh device-pwsh <<'PS' ... PS runs it in PowerShell 7, ssh device-bash <<'SH' ... SH in Git Bash, the bash of Git for Windows with its usual Unix tools; either ${text}`,
          `Begin a PowerShell script with ${pwsh}, whose errors come back as plain text; begin a Git Bash script with cd ${quoted(msysPath(projectPath))}, where Windows programs get arguments that look like Unix paths turned into Windows ones, so a switch such as /c is written //c. Git Bash is still Windows: there is no apt, and its ps, kill and /proc see only its own processes, so other Windows processes are found and stopped in PowerShell.`,
          shell === 'bash'
            ? 'The user prefers Git Bash: use it unless a task is better done in PowerShell.'
            : shell === 'pwsh'
              ? 'The user prefers PowerShell: use it unless a task is better done in Git Bash.'
              : 'Use whichever suits the task.',
        ].join(' ')
      : `Send a script on standard input, as a quoted Bash here-document: ssh device-pwsh <<'PS' ... PS. It runs in PowerShell 7, ${text} Errors come back as plain text. Begin it with ${pwsh}.`;
    return { name: 'Windows', script, command: scp };
  }
  const own = shells[0] ?? systemShell(platform);
  return {
    name: platform === 'darwin' ? 'macOS' : 'Linux',
    script: `Send a script on standard input, as a quoted Bash here-document: ssh device-${own} <<'SH' ... SH. It runs in the user's own shell, ${own}, with the environment of their terminal, ${text} Begin it with cd -- ${quoted(projectPath)}.`,
    command: `The host device runs a command line as it is, parsed by that same shell, and is the one for scp or sftp: the project directory is ${JSON.stringify(`device:${projectPath}`)}.`,
  };
}
