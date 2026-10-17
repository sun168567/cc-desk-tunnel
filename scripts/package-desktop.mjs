import { builtinModules, createRequire } from 'node:module';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { build as viteBuild } from 'vite';

// A package the program loads by name while it runs, copied with what it depends on. Compiled add-ons are
// left out: they are optional speed-ups built for the Node of the machine that installed them, not for the
// Electron of the package, and the package falls back to its JavaScript.
function copyDependency(root, app, name, copied = new Set()) {
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
  ],
  dependencies: ['ssh2'],
};

// Lays out what goes into the application archive, the same way for every system: the page, the connection
// bridge with what it imports bundled into one file, and the main process's own modules as written.
// `files` are the further files of apps/desktop/electron that this system's package needs; `dependencies`
// are packages a separately started process of the program loads, which no bundle holds.
export async function stageDesktop(root, app, { description, files = [], dependencies = [] }) {
  mkdirSync(app, { recursive: true });
  rmSync(join(app, 'node_modules'), { recursive: true, force: true });
  await viteBuild({
    root: join(root, 'apps/desktop'),
    build: { outDir: join(app, 'dist'), emptyOutDir: true },
  });
  // Main's optional Web control runtime imports ws and the protocol as well. Bundle both entrypoints;
  // copying the Web modules alone would work in this checkout but fail in an installed application.
  for (const [index, entry] of ['proxy-bridge.mjs', 'desktop-web.mjs'].entries())
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
        emptyOutDir: index === 0,
        rolldownOptions: {
          input: join(root, 'apps/desktop/electron', entry),
          external: [
            ...builtinModules,
            ...builtinModules.map((name) => `node:${name}`),
            'bufferutil',
            'utf-8-validate',
            ...dependencies,
          ],
          output: { format: 'es', entryFileNames: entry, codeSplitting: false },
        },
      },
    });
  // All CommonJS modules ship as written, including helpers required by main/preload.
  // The ESM bridge and its dependencies are already in the bundle above; the release download needs only Node.
  const commonjs = readdirSync(join(root, 'apps/desktop/electron')).filter((file) =>
    file.endsWith('.cjs'),
  );
  for (const file of [...commonjs, 'release-download.mjs', 'icon.png', ...files])
    cpSync(join(root, 'apps/desktop/electron', file), join(app, 'electron', file));
  // A file the main process loads by path is only missed when its feature is used, so each is looked for here.
  for (const file of commonjs) {
    const source = readFileSync(join(app, 'electron', file), 'utf8');
    const references = [
      ...source.matchAll(/path\.join\(__dirname, '([^']+)'\)/g),
      ...source.matchAll(/import\(['"]\.\/([^'"]+)['"]\)/g),
      ...source.matchAll(/require\(['"]\.\/([^'"]+)['"]\)/g),
    ];
    for (const [, name] of references)
      if (!name.startsWith('../vendor') && !existsSync(join(app, 'electron', name)))
        throw new Error(`${file} loads ${name}, which is not in the package.`);
  }
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
