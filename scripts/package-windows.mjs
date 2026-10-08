import { builtinModules } from 'node:module';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import files from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { build as viteBuild } from 'vite';
import { build as electronBuild, Platform, Arch } from 'electron-builder';

const root = fileURLToPath(new URL('..', import.meta.url));
const app = join(root, '.local/windows-package/app');
const vendor = join(root, 'apps/desktop/vendor');
const output = join(root, 'artifacts/windows');
const unpacked = process.argv.includes('--dir');
if (process.platform !== 'win32' || process.arch !== 'x64')
  throw new Error('Build the Windows x64 package on Windows x64.');
for (const file of ['frpc.exe', 'openssh/sshd.exe', 'openssh/ssh-keygen.exe', 'pwsh/pwsh.exe']) {
  if (!existsSync(join(vendor, file)))
    throw new Error(`Missing bundled component: ${file}. Run npm run prepare:windows:package.`);
}
mkdirSync(app, { recursive: true });
await viteBuild({
  root: join(root, 'apps/desktop'),
  build: { outDir: join(app, 'dist'), emptyOutDir: true },
});
await viteBuild({
  configFile: false,
  root,
  ssr: { noExternal: true },
  build: {
    ssr: true,
    target: 'node24',
    outDir: join(app, 'electron'),
    emptyOutDir: true,
    rolldownOptions: {
      input: join(root, 'apps/desktop/electron/proxy-bridge.mjs'),
      external: [
        ...builtinModules,
        ...builtinModules.map((name) => `node:${name}`),
        'bufferutil',
        'utf-8-validate',
      ],
      output: { format: 'es', entryFileNames: 'proxy-bridge.mjs', codeSplitting: false },
    },
  },
});
// All CommonJS modules ship as written, including helpers required by main/preload.
// The ESM bridge and its dependencies are already in the bundle above.
const commonjs = readdirSync(join(root, 'apps/desktop/electron')).filter((file) =>
  file.endsWith('.cjs'),
);
for (const file of [...commonjs, 'icon.png', 'prepare-ssh.ps1', 'component-host.ps1'])
  cpSync(join(root, 'apps/desktop/electron', file), join(app, 'electron', file));
// The staging manifest has no dependencies: the Node bridge and protocol are bundled.
writeFileSync(
  join(app, 'package.json'),
  JSON.stringify(
    {
      name: 'cc-desk-tunnel',
      productName: 'CC Desk Tunnel',
      // The desktop workspace manifest is the single source of the client version.
      version: JSON.parse(readFileSync(join(root, 'apps/desktop/package.json'), 'utf8')).version,
      description: 'Windows client for a native remote Claude Code session',
      author: 'CC Desk Tunnel contributors',
      private: true,
      main: 'electron/main.cjs',
      type: 'module',
    },
    null,
    2,
  ) + '\n',
);
const electron = JSON.parse(readFileSync(join(root, 'node_modules/electron/package.json'), 'utf8'));
// Security software may hold an executable for some seconds after it is copied, while it scans it; electron-builder
// writes the executable's resources right after copying it and fails. Its writes wait for the file instead.
const writeFile = files.writeFile;
files.writeFile = async (...args) => {
  for (let attempt = 1; ; attempt++) {
    try {
      return await writeFile(...args);
    } catch (error) {
      if (attempt === 30 || !['UNKNOWN', 'EBUSY', 'EPERM', 'EACCES'].includes(error.code))
        throw error;
      if (attempt === 1) console.log(`Waiting for ${args[0]}, which another program holds.`);
      await delay(2000);
    }
  }
};
const results = await electronBuild({
  targets: Platform.WINDOWS.createTarget(unpacked ? 'dir' : 'nsis', Arch.x64),
  publish: 'never',
  config: {
    appId: 'io.github.ccdesktunnel.desktop',
    productName: 'CC Desk Tunnel',
    electronVersion: electron.version,
    electronDist: join(root, 'node_modules/electron/dist'),
    directories: { app, output },
    npmRebuild: false,
    asar: true,
    asarUnpack: ['electron/*.ps1'],
    files: ['package.json', 'electron/**', 'dist/**'],
    extraResources: [
      {
        from: vendor,
        to: 'vendor',
        filter: ['frpc.exe', 'frp-LICENSE', 'openssh/**', 'pwsh/**', '!**/runtime.json'],
      },
    ],
    win: {
      target: 'nsis',
      signExecutable: false,
      icon: join(root, 'apps/desktop/electron/icon.png'),
    },
    nsis: {
      oneClick: false,
      perMachine: false,
      allowElevation: true,
      allowToChangeInstallationDirectory: true,
      createDesktopShortcut: true,
      createStartMenuShortcut: true,
      shortcutName: 'CC Desk Tunnel',
      runAfterFinish: false,
      deleteAppDataOnUninstall: false,
      artifactName: 'CC-Desk-Tunnel-Setup-${version}-${arch}.${ext}',
    },
  },
});
// Exercise the actual packaged main process and preload before a release can upload this installer.
// Always use an isolated profile and stay offline, even if the caller configured native testing.
execFileSync(
  process.execPath,
  [join(root, 'node_modules/@playwright/test/cli.js'), 'test', 'package.spec.ts'],
  {
    cwd: root,
    windowsHide: true,
    stdio: 'inherit',
    env: {
      ...process.env,
      WINDOWS_PACKAGE_EXE: join(output, 'win-unpacked/CC Desk Tunnel.exe'),
      NATIVE_TEST_CONFIG: '',
    },
  },
);
execFileSync(
  'pwsh.exe',
  [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Get-ChildItem -LiteralPath '${output.replaceAll("'", "''")}' -File -Filter '*.exe' | Get-FileHash -Algorithm SHA256 | Select-Object Path,Hash`,
  ],
  { windowsHide: true, stdio: 'inherit' },
);
console.log(
  `Windows package: ${results.join(', ') || join(output, 'win-unpacked/CC Desk Tunnel.exe')}`,
);
console.log(
  'No service token, OAuth data, local history, test fixtures or source repository included.',
);
