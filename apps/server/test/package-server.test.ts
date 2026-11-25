import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const { packageServer } = await import(
  new URL('../../../scripts/package-server.mjs', import.meta.url).href
);
const root = fileURLToPath(new URL('../../..', import.meta.url));
const tar = process.platform === 'win32' ? 'tar.exe' : 'tar';

test('server archives contain a fresh Web build without local data or desktop development files', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'cc-server-package-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const path of [
    '.dockerignore',
    'package.json',
    'package-lock.json',
    'CHANGELOG.md',
    'apps/server/package.json',
    'apps/desktop/package.json',
    'packages/i18n/package.json',
    'packages/protocol/package.json',
    'scripts/install-linux.sh',
    'deploy',
  ]) {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    cpSync(join(root, path), join(directory, path), { recursive: true });
  }
  const put = (path: string, content: string) => {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), content);
  };
  put('apps/server/src/main.ts', 'export {};');
  put('packages/i18n/src/index.ts', 'export {};');
  put('packages/protocol/src/index.ts', 'export {};');
  put('apps/desktop/dist/index.html', 'desktop build stays unchanged');
  put('apps/desktop/src/private-test.ts', 'not runtime code');
  put('.env', 'local-secret');
  put(
    'node_modules/vite/bin/vite.js',
    `
    import {mkdirSync,writeFileSync} from 'node:fs';
    import {join} from 'node:path';
    const directory=process.argv[process.argv.indexOf('--outDir')+1];
    mkdirSync(join(directory,'assets'),{recursive:true});
    writeFileSync(join(directory,'index.html'),'<script src="./assets/current.js"></script>');
    writeFileSync(join(directory,'assets/current.js'),'fresh web build');
  `,
  );
  const output = join(directory, '.local/server.tar.gz');
  packageServer(directory, output);
  const entries = execFileSync(tar, ['-tzf', output], {
    encoding: 'utf8',
    windowsHide: true,
  }).split(/\r?\n/);
  assert.ok(entries.includes('apps/server/web/index.html'));
  assert.ok(entries.includes('apps/server/web/assets/current.js'));
  assert.ok(entries.includes('CHANGELOG.md'));
  assert.ok(entries.includes('deploy/install.sh'));
  assert.ok(entries.includes('packages/i18n/src/index.ts'));
  assert.ok(!entries.some((entry) => /node_modules|\.env|private-test|desktop\/dist/.test(entry)));
  assert.equal(
    readFileSync(join(directory, 'apps/desktop/dist/index.html'), 'utf8'),
    'desktop build stays unchanged',
  );
  assert.deepEqual(readdirSync(join(directory, '.local')), ['server.tar.gz']);
  const previous = readFileSync(output);
  put('node_modules/vite/bin/vite.js', 'process.exit(1);');
  assert.throws(() => packageServer(directory, output));
  assert.deepEqual(readFileSync(output), previous);
  assert.deepEqual(readdirSync(join(directory, '.local')), ['server.tar.gz']);
  assert.equal(existsSync(join(directory, 'apps/server/web')), false);
});
