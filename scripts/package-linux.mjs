import { builtinModules } from 'node:module';
import { chmodSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as viteBuild } from 'vite';
import { build as electronBuild, Platform, Arch } from 'electron-builder';

const root = fileURLToPath(new URL('..', import.meta.url));
const staging = join(root, '.local/linux-package');
const app = join(staging, 'app');
const cli = join(staging, 'cli');
const output = join(root, 'artifacts/linux');
const unpacked = process.argv.includes('--dir');
if (process.platform !== 'linux' || process.arch !== 'x64')
  throw new Error('Build the Linux x64 package on Linux x64.');
mkdirSync(app, { recursive: true });
await viteBuild({
  root: join(root, 'apps/desktop'),
  build: { outDir: join(app, 'dist'), emptyOutDir: true },
});
// One self-contained module per entry; ssh2 stays external because it resolves optional native bindings at runtime.
const bundle = (input, outDir, entryFileNames) =>
  viteBuild({
    configFile: false,
    root,
    ssr: { noExternal: true },
    build: {
      ssr: true,
      target: 'node24',
      outDir,
      emptyOutDir: true,
      rolldownOptions: {
        input,
        external: [
          ...builtinModules,
          ...builtinModules.map((name) => `node:${name}`),
          'ssh2',
          'bufferutil',
          'utf-8-validate',
        ],
        output: { format: 'es', entryFileNames, codeSplitting: false },
      },
    },
  });
await bundle(
  join(root, 'apps/desktop/electron/proxy-bridge.mjs'),
  join(app, 'electron'),
  'proxy-bridge.mjs',
);
// The terminal client ships beside the app, outside the asar archive, and runs on the bundled Electron as Node.
await bundle(join(root, 'apps/cli/bin/ccdt.mjs'), cli, 'ccdt.mjs');
const launcher = join(staging, 'ccdt');
writeFileSync(
  launcher,
  "#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec '/opt/CC Desk Tunnel/cc-desk-tunnel' '/opt/CC Desk Tunnel/resources/cli/ccdt.mjs' \"$@\"\n",
);
chmodSync(launcher, 0o755);
// The bridge and its tunnel module are already in the bundle above; the rest of the main process ships as written.
for (const file of ['main.cjs', 'preload.cjs', 'icon.png'])
  cpSync(join(root, 'apps/desktop/electron', file), join(app, 'electron', file));
// ssh2 stays external because it resolves optional native bindings at runtime.
writeFileSync(
  join(app, 'package.json'),
  JSON.stringify(
    {
      name: 'cc-desk-tunnel',
      productName: 'CC Desk Tunnel',
      // The desktop workspace manifest is the single source of the client version.
      version: JSON.parse(readFileSync(join(root, 'apps/desktop/package.json'), 'utf8')).version,
      description: 'Linux client for a native remote Claude Code session',
      dependencies: { ssh2: '1.17.0' },
      author: 'CC Desk Tunnel contributors',
      desktopName: 'cc-desk-tunnel.desktop',
      homepage: 'https://github.com/jiangan-code/cc-desk-tunnel',
      private: true,
      main: 'electron/main.cjs',
      type: 'module',
    },
    null,
    2,
  ) + '\n',
);
// Copy the pure-JS dependency closure from the workspace lockfile installation, for the app and the terminal client.
for (const target of [app, cli]) {
  rmSync(join(target, 'node_modules'), { recursive: true, force: true });
  for (const name of ['ssh2', 'asn1', 'bcrypt-pbkdf', 'safer-buffer', 'tweetnacl']) {
    cpSync(join(root, 'node_modules', name), join(target, 'node_modules', name), {
      recursive: true,
      filter: (source) => !source.endsWith('.node'),
    });
  }
}
const electron = JSON.parse(readFileSync(join(root, 'node_modules/electron/package.json'), 'utf8'));
const results = await electronBuild({
  targets: Platform.LINUX.createTarget(unpacked ? 'dir' : 'deb', Arch.x64),
  publish: 'never',
  config: {
    appId: 'io.github.ccdesktunnel.desktop',
    productName: 'CC Desk Tunnel',
    electronVersion: electron.version,
    electronDist: join(root, 'node_modules/electron/dist'),
    directories: { app, output },
    npmRebuild: false,
    asar: true,
    files: ['package.json', 'electron/**', 'dist/**'],
    extraResources: [{ from: cli, to: 'cli' }],
    // electron-builder leaves node_modules out of extra resources, so the client's dependencies follow here, before
    // the package is made.
    afterPack: async ({ appOutDir }) =>
      cpSync(join(cli, 'node_modules'), join(appOutDir, 'resources/cli/node_modules'), {
        recursive: true,
      }),
    linux: {
      syncDesktopName: true,
      executableName: 'cc-desk-tunnel',
      category: 'Development',
      icon: join(root, 'apps/desktop/electron/icon.png'),
      maintainer: 'CC Desk Tunnel contributors',
      artifactName: 'CC-Desk-Tunnel-${version}-${arch}.${ext}',
    },
    deb: {
      depends: ['libgtk-3-0', 'libnss3', 'libasound2t64', 'libgbm1', 'libsecret-1-0'],
      // fpm maps extra files into the package as source=destination.
      fpm: [`${launcher}=/usr/bin/ccdt`],
    },
  },
});
console.log(`Linux package: ${results.join(', ') || join(output, 'linux-unpacked')}`);
