import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageName } from '../apps/cli/src/runtime.mjs';
import { checkCcdt, nodeRuntimes, stageCcdt } from './package-desktop.mjs';

// The ccdt package of the system this runs on, a folder `ccdt` in a .zip (Windows) or .tar.gz (macOS, Linux): the
// Node it runs with, ccdt with what it imports bundled into ccdt.mjs, and what its SSH service for Claude's commands
// needs. On Windows that is the OpenSSH and PowerShell the desktop installer bundles, prepared by
// `npm run prepare:windows:package`; on macOS and Linux the service's own modules and the SSH library they load.
// It is started at the end as a check.
const root = fileURLToPath(new URL('..', import.meta.url));
const version = JSON.parse(readFileSync(join(root, 'apps/desktop/package.json'), 'utf8')).version;
const system = `${process.platform}-${process.arch}`;
if (!nodeRuntimes[system]) throw new Error(`No ccdt package for ${system}.`);
const windows = process.platform === 'win32';
// The system's own tar, which reads and writes .zip on Windows; a shell may put another one first on the PATH.
const tar = windows ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
const output = join(root, 'artifacts/cli');
const archive = join(output, packageName(version, system));
const vendor = join(root, 'apps/desktop/vendor');
if (windows)
  for (const file of ['openssh/sshd.exe', 'openssh/ssh-keygen.exe', 'pwsh/pwsh.exe'])
    if (!existsSync(join(vendor, file)))
      throw new Error(`Missing bundled component: ${file}. Run npm run prepare:windows:package.`);

const staging = join(root, '.local/cli-package');
const stage = join(staging, 'ccdt');
rmSync(staging, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
await stageCcdt(root, stage, { version });
if (windows) {
  for (const name of ['openssh', 'pwsh'])
    cpSync(join(vendor, name), join(stage, 'vendor', name), {
      recursive: true,
      filter: (path) => !path.endsWith('runtime.json'),
    });
  cpSync(join(root, 'apps/cli/install/install.ps1'), join(stage, 'install.ps1'));
} else {
  cpSync(join(root, 'apps/cli/install/install.sh'), join(stage, 'install.sh'));
  chmodSync(join(stage, 'install.sh'), 0o755);
}
cpSync(join(root, 'apps/cli/install/README.txt'), join(stage, 'README.txt'));

checkCcdt(windows ? join(stage, 'ccdt.cmd') : join(stage, 'bin', 'ccdt'), version);

mkdirSync(output, { recursive: true });
rmSync(archive, { force: true });
execFileSync(
  tar,
  windows
    ? ['-a', '-cf', archive, '-C', staging, 'ccdt']
    : ['-czf', archive, '-C', staging, 'ccdt'],
);
console.log(`${archive} (${Math.round(readFileSync(archive).length / 1048576)} MB)`);
