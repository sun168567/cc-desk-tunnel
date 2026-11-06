import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { win32 } from 'node:path';

// Where the installer of Git for Windows says it put Git, for the computer and for the user.
function installed() {
  const query = (key) =>
    new Promise((resolve) =>
      execFile(
        'reg.exe',
        ['query', key, '/v', 'InstallPath'],
        { windowsHide: true, timeout: 5000 },
        (error, stdout) =>
          resolve(error ? undefined : /InstallPath\s+REG_\w+\s+(.+)/.exec(stdout)?.[1]?.trim()),
      ),
    );
  return Promise.all(
    ['HKLM', 'HKCU'].map((root) => query(`${root}\\SOFTWARE\\GitForWindows`)),
  ).then((roots) => roots.filter(Boolean));
}

// Git Bash, the bash of Git for Windows: where its installer put it, else beside a git on the PATH, as a copy unpacked
// by hand has it, else where the installer or Scoop puts it by default. It is the launcher in bin\, which gives the
// bash it starts the PATH of Git's Unix tools; never the bash.exe of WindowsApps or System32, which starts WSL.
export async function findGitBash({
  env = process.env,
  roots = installed,
  exists = existsSync,
} = {}) {
  const { join } = win32;
  const candidates = (await roots()).map((root) => join(root, 'bin', 'bash.exe'));
  for (const directory of String(env.PATH ?? env.Path ?? '').split(';'))
    if (directory && exists(join(directory, 'git.exe')))
      // git.exe is in cmd\, bin\ and mingw64\bin\ of Git's folder.
      candidates.push(
        join(directory, '..', 'bin', 'bash.exe'),
        join(directory, '..', '..', 'bin', 'bash.exe'),
      );
  for (const base of [env.ProgramFiles, env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs')])
    if (base) candidates.push(join(base, 'Git', 'bin', 'bash.exe'));
  // Scoop's git puts only a shim of git.exe on the PATH.
  const scoop = env.SCOOP ?? (env.USERPROFILE && join(env.USERPROFILE, 'scoop'));
  if (scoop) candidates.push(join(scoop, 'apps', 'git', 'current', 'bin', 'bash.exe'));
  return candidates.find((path) => exists(path));
}
