import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as electronBuild, Platform, Arch } from 'electron-builder';
import { posixService, stageDesktop } from './package-desktop.mjs';

// Builds the macOS package: a disk image to install from and a ZIP of the same application. It is not signed
// with a Developer ID and not notarized, so macOS asks the user to allow it on first start (see docs/macos.md),
// and it cannot upgrade itself. It carries no OpenSSH or shell of its own: the SSH service runs inside the
// program, with the user's shell and the system's sftp-server.
const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
if (
  args.some((arg) => !['--dir', '--arm64', '--x64'].includes(arg)) ||
  (args.includes('--arm64') && args.includes('--x64'))
)
  throw new Error('Usage: npm run package:macos -- [--arm64|--x64] [--dir]');
if (process.platform !== 'darwin') throw new Error('Build the macOS package on macOS.');
const architecture = args.includes('--arm64')
  ? 'arm64'
  : args.includes('--x64')
    ? 'x64'
    : process.arch;
const unpacked = args.includes('--dir');
const app = join(root, `.local/macos-package/${architecture}/app`);
const output = join(root, 'artifacts/macos');
const bundle = join(output, architecture === 'arm64' ? 'mac-arm64' : 'mac', 'CC Desk Tunnel.app');
await stageDesktop(root, app, {
  description: 'macOS client for a native remote Claude Code session',
  ...posixService,
});
// The system's icon format wants a source of 512 pixels or more; the artwork is the one of the Windows package.
const icon = join(app, 'macos-icon.png');
execFileSync(
  'sips',
  ['-z', '1024', '1024', join(root, 'apps/desktop/electron/icon.png'), '--out', icon],
  { stdio: 'ignore' },
);
const electron = JSON.parse(readFileSync(join(root, 'node_modules/electron/package.json'), 'utf8'));
const folder = (what) => `访问你选择的${what}项目，让 Claude 经执行通道读取和修改其中的文件。`;
// electron-builder leaves a pull request's build unsigned, lest a fork reach a certificate. The signature here is
// ad hoc and uses none, and a build left without it fails the check below: it is signed as any other.
process.env.CSC_FOR_PULL_REQUEST = 'true';
const results = await electronBuild({
  targets: Platform.MAC.createTarget(unpacked ? 'dir' : ['dmg', 'zip'], Arch[architecture]),
  publish: 'never',
  config: {
    appId: 'io.github.ccdesktunnel.desktop',
    productName: 'CC Desk Tunnel',
    electronVersion: electron.version,
    // The Electron installed here is of this machine's architecture; the other one is downloaded.
    ...(architecture === process.arch &&
    existsSync(join(root, 'node_modules/electron/dist/Electron.app'))
      ? { electronDist: join(root, 'node_modules/electron/dist') }
      : {}),
    directories: { app, output },
    npmRebuild: false,
    asar: true,
    files: ['package.json', 'electron/**', 'dist/**', 'node_modules/**'],
    mac: {
      category: 'public.app-category.developer-tools',
      minimumSystemVersion: '13.0',
      icon,
      artifactName: 'CC-Desk-Tunnel-${version}-mac-${arch}.${ext}',
      // Signed for this machine only ("ad hoc"), with no certificate. An application with no signature at
      // all is reported as damaged on Apple silicon once it has been downloaded; one signed this way is
      // reported as from an unidentified developer, which the user can allow.
      identity: '-',
      hardenedRuntime: false,
      notarize: false,
      extendInfo: {
        // The page talks to the bridge of its own main process over a loopback WebSocket.
        NSAppTransportSecurity: { NSAllowsLocalNetworking: true },
        // What the system shows when a command first reaches into one of these places.
        NSDesktopFolderUsageDescription: folder('桌面'),
        NSDocumentsFolderUsageDescription: folder('文稿'),
        NSDownloadsFolderUsageDescription: folder('下载'),
        NSRemovableVolumesUsageDescription: folder('外接磁盘'),
        NSNetworkVolumesUsageDescription: folder('网络磁盘'),
      },
    },
    dmg: { sign: false },
  },
});
execFileSync('codesign', ['--verify', '--deep', '--strict', bundle], { stdio: 'inherit' });
// A package of this machine's architecture is started, offline, before it counts as built.
if (architecture === process.arch)
  execFileSync(process.execPath, [join(root, 'scripts/smoke-posix-package.mjs'), bundle], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, NATIVE_TEST_CONFIG: '' },
  });
else console.log(`Not started: this machine is ${process.arch}, the package is ${architecture}.`);
for (const path of results.filter((path) => /\.(dmg|zip)$/.test(path)))
  console.log(
    `${createHash('sha256').update(readFileSync(path)).digest('hex')}  ${basename(path)}`,
  );
console.log(`macOS package (not notarized): ${bundle}`);
console.log(
  'No service token, OAuth data, local history, test fixtures or source repository included.',
);
