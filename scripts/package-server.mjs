import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export function packageServer(root, output) {
  const local = join(root, '.local');
  mkdirSync(local, { recursive: true });
  mkdirSync(dirname(output), { recursive: true });
  const staging = mkdtempSync(join(local, 'server-package-'));
  try {
    const web = join(staging, 'apps/server/web');
    execFileSync(
      process.execPath,
      [
        join(root, 'node_modules/vite/bin/vite.js'),
        'build',
        '--config',
        join(root, 'apps/desktop/vite.config.ts'),
        '--outDir',
        web,
        '--emptyOutDir',
      ],
      { cwd: root, windowsHide: true, stdio: 'inherit' },
    );
    if (!existsSync(join(web, 'index.html'))) throw new Error('Missing Web client build.');
    execFileSync(
      process.platform === 'win32' ? 'tar.exe' : 'tar',
      [
        '-czf',
        output,
        '-C',
        root,
        '.dockerignore',
        'package.json',
        'package-lock.json',
        'CHANGELOG.md',
        'apps/server/package.json',
        'apps/server/src',
        'apps/desktop/package.json',
        'packages/i18n/package.json',
        'packages/i18n/src',
        'packages/protocol/package.json',
        'packages/protocol/src',
        'scripts/install-linux.sh',
        'deploy',
        '-C',
        staging,
        'apps/server/web',
      ],
      { cwd: root, windowsHide: true },
    );
  } finally {
    // Only this invocation's temporary build is removed, never the desktop dist directory.
    if (dirname(staging) !== local) throw new Error('Unexpected packaging directory.');
    rmSync(staging, { recursive: true, force: true });
  }
  console.log(`Server source bundle created: ${output}`);
  console.log(
    'Includes the matching Web client, without credentials, histories or development dependencies.',
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  packageServer(root, resolve(process.argv[2] ?? '.local/cc-desk-tunnel-server.tar.gz'));
}
