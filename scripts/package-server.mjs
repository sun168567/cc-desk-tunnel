import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = resolve(process.argv[2] ?? '.local/cc-desk-tunnel-server.tar.gz');
mkdirSync(join(root, '.local'), { recursive: true });
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
    'apps/server/package.json',
    'apps/server/src',
    'apps/desktop/package.json',
    'packages/protocol/package.json',
    'packages/protocol/src',
    'scripts/install-linux.sh',
    'deploy',
  ],
  { windowsHide: true },
);
console.log(`Server source bundle created: ${output}`);
console.log('Contains no local credentials, histories, dependencies or desktop UI build.');
