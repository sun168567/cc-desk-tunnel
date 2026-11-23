import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { builtinModules, createRequire } from 'node:module';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { build as viteBuild } from 'vite';

// A package the program loads by name while it runs, copied with what it depends on. Compiled add-ons are
// left out: they are optional speed-ups built for the Node of the machine that installed them, not for the
// Electron of the package, and the package falls back to its JavaScript.
export function copyDependency(root, app, name, copied = new Set()) {
  if (copied.has(name)) return;
  copied.add(name);
  const source = dirname(createRequire(join(root, 'package.json')).resolve(`${name}/package.json`));
  const destination = join(app, 'node_modules', name);
  cpSync(source, destination, {
    recursive: true,
    filter: (path) =>
      !/(?:^|[\\/])(?:node_modules|test|tests|examples|build)(?:[\\/]|$)/.test(
        path.slice(source.length),
      ) && !path.endsWith('.node'),
  });
  const manifest = JSON.parse(readFileSync(join(destination, 'package.json'), 'utf8'));
  delete manifest.optionalDependencies;
  delete manifest.scripts;
  writeFileSync(join(destination, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  for (const dependency of Object.keys(manifest.dependencies ?? {}))
    copyDependency(root, app, dependency, copied);
  return manifest.version;
}

// What a package for macOS or Linux takes beside the common part: the modules of the SSH service's own
// process, which it loads by path next to the bundled bridge, and the SSH library they use. The Windows
// package has neither: its SSH service is the bundled OpenSSH.
export const posixService = {
  files: [
    'posix-ssh-worker.mjs',
    'process-supervisor.mjs',
    'shell-environment.mjs',
    'ssh-keys.mjs',
    'ssh-channel-output.mjs',
    'ssh2-hardening.mjs',
  ],
  dependencies: ['ssh2'],
};

// Lays out what goes into the application archive, the same way for every system: the page, the connection
// bridge with what it imports bundled into one file, and the main process's own modules as written.
// `files` are the further files of apps/desktop/electron that this system's package needs; `dependencies`
// are packages a separately started process of the program loads, which no bundle holds. The SSH library is
// always one of them: the file panel's SFTP uses it in the main process (files.mjs), and it is not bundled for
// its optional native parts.
export async function stageDesktop(root, app, { description, files = [], dependencies: own = [] }) {
  const dependencies = [...new Set(['ssh2', ...own])];
  mkdirSync(app, { recursive: true });
  rmSync(join(app, 'node_modules'), { recursive: true, force: true });
  await viteBuild({
    root: join(root, 'apps/desktop'),
    build: { outDir: join(app, 'dist'), emptyOutDir: true },
  });
  await viteBuild({
    configFile: false,
    root,
    // A package is for one system, the one it is built on. With that written into the bridge, what it would
    // only do on another system falls out of the bundle: the Windows package holds nothing of the SSH
    // service of macOS and Linux, and theirs nothing of the one of Windows.
    define: { 'process.platform': JSON.stringify(process.platform) },
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
          ...dependencies,
        ],
        output: { format: 'es', entryFileNames: 'proxy-bridge.mjs', codeSplitting: false },
      },
    },
  });
  // All CommonJS modules ship as written, including helpers required by main/preload.
  // The ESM bridge and its dependencies are already in the bundle above; the release download and opening a
  // session in ccdt need only Node.
  const commonjs = readdirSync(join(root, 'apps/desktop/electron')).filter((file) =>
    file.endsWith('.cjs'),
  );
  for (const file of [...commonjs, 'release-download.mjs', 'ccdt.mjs', 'icon.png', ...files])
    cpSync(join(root, 'apps/desktop/electron', file), join(app, 'electron', file));
  // A file the main process loads by path is only missed when its feature is used, so each is looked for here.
  for (const file of commonjs)
    for (const [, name] of readFileSync(join(app, 'electron', file), 'utf8').matchAll(
      /path\.join\(__dirname, '([^']+)'\)/g,
    ))
      if (!name.startsWith('../vendor') && !existsSync(join(app, 'electron', name)))
        throw new Error(`${file} loads ${name}, which is not in the package.`);
  const versions = Object.fromEntries(
    dependencies.map((name) => [name, copyDependency(root, app, name)]),
  );
  // The staging manifest names only what was copied beside the bundle: the bridge and protocol are in it.
  writeFileSync(
    join(app, 'package.json'),
    JSON.stringify(
      {
        name: 'cc-desk-tunnel',
        productName: 'CC Desk Tunnel',
        // The desktop workspace manifest is the single source of the client version.
        version: JSON.parse(readFileSync(join(root, 'apps/desktop/package.json'), 'utf8')).version,
        description,
        author: 'CC Desk Tunnel contributors',
        private: true,
        main: 'electron/main.cjs',
        type: 'module',
        ...(dependencies.length ? { dependencies: versions } : {}),
      },
      null,
      2,
    ) + '\n',
  );
}

// ccdt, the terminal client, with what it imports bundled into one ccdt.mjs in `outDir`, and the scripts of its SSH
// service that it loads by path beside it. `desktop`: the ccdt the desktop package carries, run by the desktop's own
// program and updated with it rather than by itself.
export async function bundleCcdt(root, outDir, { version, desktop = false }) {
  const windows = process.platform === 'win32';
  await viteBuild({
    configFile: false,
    root,
    logLevel: 'warn',
    // As for the desktop bridge: a package is for the system it is built on, and holds only what that one runs.
    define: {
      'process.platform': JSON.stringify(process.platform),
      __CCDT_VERSION__: JSON.stringify(version),
      __CCDT_DESKTOP__: JSON.stringify(desktop),
    },
    ssr: { noExternal: true },
    build: {
      ssr: true,
      target: 'node24',
      outDir,
      emptyOutDir: false,
      rolldownOptions: {
        input: join(root, 'apps/cli/bin/ccdt.mjs'),
        external: [
          ...builtinModules,
          ...builtinModules.map((name) => `node:${name}`),
          'bufferutil',
          'utf-8-validate',
          // The file panel's SFTP client, which the bridge loads only when the panel is used; ccdt has no panel.
          'ssh2',
          ...(windows ? [] : posixService.dependencies),
        ],
        output: { format: 'es', entryFileNames: 'ccdt.mjs', codeSplitting: false },
      },
    },
  });
  const electron = join(root, 'apps/desktop/electron');
  for (const file of windows ? ['prepare-ssh.ps1', 'component-host.ps1'] : posixService.files)
    cpSync(join(electron, file), join(outDir, file));
}

// The check of a packaged ccdt: it starts, says its version, and fails a sign-in to nowhere with a message instead
// of an error of its own; that loads the bundled connection.
export function checkCcdt(launcher, version) {
  const windows = process.platform === 'win32';
  const run = (args, input) =>
    execFileSync(windows ? 'cmd.exe' : launcher, windows ? ['/d', '/c', launcher, ...args] : args, {
      input,
      encoding: 'utf8',
      env: { ...process.env, CCDT_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'ccdt-check-')) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  const reported = run(['--version']).trim();
  if (reported !== `ccdt ${version}`) throw new Error(`The package's ccdt reports "${reported}".`);
  try {
    run(['login', 'wss://127.0.0.1:9/ws', '--token-stdin'], 'x'.repeat(32));
    throw new Error('A sign-in to nowhere succeeded.');
  } catch (error) {
    if (error.status !== 1 || /Error:|at .+\(/.test(String(error.stderr)))
      throw new Error(`The packaged sign-in failed badly:\n${error.stderr ?? error.message}`);
  }
}

// What starts ccdt on Windows: its Node, beside it, running ccdt.mjs.
export const WINDOWS_LAUNCHER =
  '@echo off\r\n"%~dp0node.exe" "%~dp0ccdt.mjs" %*\r\nexit /b %errorlevel%\r\n';

// The Node ccdt runs with, of a pinned release, wherever ccdt is packaged: on its own and in the Windows desktop
// installer alike. From https://nodejs.org/dist/v24.22.2/SHASUMS256.txt.
const NODE = '24.22.2';
export const nodeRuntimes = {
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

// Puts that Node, checked against the hash above, into `directory` as node.exe or node; the download is kept in
// .tools for the next build.
export async function addNode(root, directory) {
  const windows = process.platform === 'win32';
  // The system's own tar, which reads .zip on Windows; a shell may put another one first on the PATH.
  const tar = windows
    ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar';
  const [suffix, sha256] = nodeRuntimes[`${process.platform}-${process.arch}`];
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
