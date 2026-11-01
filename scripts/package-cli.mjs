import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { builtinModules } from 'node:module';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as viteBuild } from 'vite';
import { copyDependency, posixService } from './package-desktop.mjs';

// The ccdt package of the system this runs on, a folder `ccdt` in a .zip (Windows) or .tar.gz (macOS, Linux): the
// Node it runs with, ccdt with what it imports bundled into ccdt.mjs, and what its SSH service for Claude's commands
// needs. On Windows that is the OpenSSH and PowerShell the desktop installer bundles, prepared by
// `npm run prepare:windows:package`; on macOS and Linux the service's own modules and the SSH library they load.
// It is started at the end as a check.
const root = fileURLToPath(new URL('..', import.meta.url));
const version = JSON.parse(readFileSync(join(root, 'apps/desktop/package.json'), 'utf8')).version;
const NODE = '24.22.2';
// From https://nodejs.org/dist/v24.22.2/SHASUMS256.txt.
const runtimes = {
  'win32-x64': ['win-x64.zip', 'ca1bff5d8ead13c9f2ea404a176db46bd430704d5b5113734049fa365e7799e2'],
  'darwin-arm64': [
    'darwin-arm64.tar.gz',
    'aa9549349e47dffaa42dcf95d6e06ade8c4bdafc980979883b88767670df385a',
  ],
  'darwin-x64': [
    'darwin-x64.tar.gz',
    'd5e336d588c45be0c37dbd52cc29895593009ca4997a77a1fd02815131ed0e52',
  ],
  'linux-x64': [
    'linux-x64.tar.gz',
    '361718c444e49af2ca5a110c83ba6a8901143f23ab285ebbef0341f391f482a9',
  ],
  'linux-arm64': [
    'linux-arm64.tar.gz',
    '95c264150aceb7f3437a29fd6984924f5f8d1511ea3cbd6c508b83f6c555dae2',
  ],
};
const system = `${process.platform}-${process.arch}`;
if (!runtimes[system]) throw new Error(`No ccdt package for ${system}.`);
const windows = process.platform === 'win32';
// The system's own tar, which reads and writes .zip on Windows; a shell may put another one first on the PATH.
const tar = windows ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
const names = {
  'win32-x64': 'windows-x64',
  'darwin-arm64': 'mac-arm64',
  'darwin-x64': 'mac-x64',
  'linux-x64': 'linux-x64',
  'linux-arm64': 'linux-arm64',
};
export const packageName = (release, name) =>
  `ccdt-${release}-${name}.${name.startsWith('windows') ? 'zip' : 'tar.gz'}`;
const output = join(root, 'artifacts/cli');
const archive = join(output, packageName(version, names[system]));
const vendor = join(root, 'apps/desktop/vendor');
if (windows)
  for (const file of ['openssh/sshd.exe', 'openssh/ssh-keygen.exe', 'pwsh/pwsh.exe'])
    if (!existsSync(join(vendor, file)))
      throw new Error(`Missing bundled component: ${file}. Run npm run prepare:windows:package.`);

// Node of the pinned release, checked against the hash above; kept in .tools for the next build.
async function runtime(directory) {
  const [suffix, sha256] = runtimes[system];
  const name = `node-v${NODE}-${suffix}`;
  const cached = join(root, '.tools', name);
  if (!existsSync(cached)) {
    const response = await fetch(`https://nodejs.org/dist/v${NODE}/${name}`);
    if (!response.ok) throw new Error(`Node download failed: ${response.status}`);
    mkdirSync(join(root, '.tools'), { recursive: true });
    writeFileSync(cached, Buffer.from(await response.arrayBuffer()));
  }
  if (createHash('sha256').update(readFileSync(cached)).digest('hex') !== sha256)
    throw new Error(`Checksum mismatch for ${name}`);
  const extracted = mkdtempSync(join(tmpdir(), 'ccdt-node-'));
  const inside = `${name.replace(/\.(zip|tar\.gz)$/, '')}/${windows ? 'node.exe' : 'bin/node'}`;
  execFileSync(tar, ['-xf', cached, '-C', extracted, inside]);
  cpSync(join(extracted, inside), join(directory, windows ? 'node.exe' : 'node'));
  rmSync(extracted, { recursive: true, force: true });
}

const staging = join(root, '.local/cli-package');
const stage = join(staging, 'ccdt');
rmSync(staging, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
await viteBuild({
  configFile: false,
  root,
  logLevel: 'warn',
  // As for the desktop bridge: a package is for the system it is built on, and holds only what that one runs.
  define: {
    'process.platform': JSON.stringify(process.platform),
    __CCDT_VERSION__: JSON.stringify(version),
  },
  ssr: { noExternal: true },
  build: {
    ssr: true,
    target: 'node24',
    outDir: stage,
    emptyOutDir: false,
    rolldownOptions: {
      input: join(root, 'apps/cli/bin/ccdt.mjs'),
      external: [
        ...builtinModules,
        ...builtinModules.map((name) => `node:${name}`),
        'bufferutil',
        'utf-8-validate',
        ...(windows ? [] : posixService.dependencies),
      ],
      output: { format: 'es', entryFileNames: 'ccdt.mjs', codeSplitting: false },
    },
  },
});
// What the bundle loads by path beside itself: the scripts of the Windows SSH service, or the modules of the
// POSIX one's own process with the library they import.
const electron = join(root, 'apps/desktop/electron');
for (const file of windows ? ['prepare-ssh.ps1', 'component-host.ps1'] : posixService.files)
  cpSync(join(electron, file), join(stage, file));
if (windows) {
  for (const name of ['openssh', 'pwsh'])
    cpSync(join(vendor, name), join(stage, 'vendor', name), {
      recursive: true,
      filter: (path) => !path.endsWith('runtime.json'),
    });
  writeFileSync(
    join(stage, 'ccdt.cmd'),
    '@echo off\r\n"%~dp0node.exe" "%~dp0ccdt.mjs" %*\r\nexit /b %errorlevel%\r\n',
  );
  cpSync(join(root, 'apps/cli/install/install.ps1'), join(stage, 'install.ps1'));
} else {
  for (const name of posixService.dependencies) copyDependency(root, stage, name);
  mkdirSync(join(stage, 'bin'));
  writeFileSync(
    join(stage, 'bin', 'ccdt'),
    '#!/bin/sh\n# ccdt with the Node it was packaged with, wherever the command is linked from.\nself=$(readlink -f "$0" 2>/dev/null || realpath "$0")\ndir=$(dirname "$(dirname "$self")")\nexec "$dir/node" "$dir/ccdt.mjs" "$@"\n',
  );
  chmodSync(join(stage, 'bin', 'ccdt'), 0o755);
  cpSync(join(root, 'apps/cli/install/install.sh'), join(stage, 'install.sh'));
  chmodSync(join(stage, 'install.sh'), 0o755);
}
await runtime(stage);
cpSync(join(root, 'apps/cli/install/README.txt'), join(stage, 'README.txt'));

// The check: the packaged program starts, says its version, and fails a sign-in to nowhere with a message instead
// of an error of its own; that loads the bundled connection.
const launcher = windows ? join(stage, 'ccdt.cmd') : join(stage, 'bin', 'ccdt');
const run = (args, input) =>
  execFileSync(windows ? 'cmd.exe' : launcher, windows ? ['/d', '/c', launcher, ...args] : args, {
    input,
    encoding: 'utf8',
    env: { ...process.env, CCDT_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'ccdt-check-')) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
const reported = run(['--version']).trim();
if (reported !== `ccdt ${version}`) throw new Error(`The package reports "${reported}".`);
try {
  run(['login', 'wss://127.0.0.1:9/ws', '--token-stdin'], 'x'.repeat(32));
  throw new Error('A sign-in to nowhere succeeded.');
} catch (error) {
  if (error.status !== 1 || /Error:|at .+\(/.test(String(error.stderr)))
    throw new Error(`The packaged sign-in failed badly:\n${error.stderr ?? error.message}`);
}

mkdirSync(output, { recursive: true });
rmSync(archive, { force: true });
execFileSync(
  tar,
  windows
    ? ['-a', '-cf', archive, '-C', staging, 'ccdt']
    : ['-czf', archive, '-C', staging, 'ccdt'],
);
console.log(`${archive} (${Math.round(readFileSync(archive).length / 1048576)} MB)`);
