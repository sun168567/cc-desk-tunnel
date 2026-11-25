import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { FileMatcher, copyFiles } from 'app-builder-lib/out/fileMatcher.js';
import { ccdtResource } from '../../../scripts/ccdt-resources.mjs';
import { copyDependency } from '../../../scripts/package-desktop.mjs';

test('the desktop’s ccdt resources retain SSH dependencies without copying the sibling app', async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ccdt-resources-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ccdt = join(root, 'stage', 'ccdt');
  const resources = join(root, 'resources');
  mkdirSync(join(ccdt, 'bin'), { recursive: true });
  writeFileSync(join(ccdt, 'bin', 'ccdt'), '#!/bin/sh\n');
  writeFileSync(join(ccdt, 'posix-ssh-worker.mjs'), "import ssh2 from 'ssh2';\n");
  copyDependency(fileURLToPath(new URL('../../../', import.meta.url)), ccdt, 'ssh2');
  mkdirSync(join(root, 'stage', 'app'));
  writeFileSync(join(root, 'stage', 'app', 'private.txt'), 'not a ccdt resource');

  const resource = ccdtResource(ccdt);
  await copyFiles([
    new FileMatcher(
      resource.from,
      resolve(resources, resource.to),
      (value) => value,
      resource.filter,
    ),
  ]);

  assert.equal(existsSync(join(resources, 'ccdt', 'bin', 'ccdt')), true);
  assert.equal(
    existsSync(join(resources, 'ccdt', 'node_modules', 'ssh2', 'lib', 'index.js')),
    true,
  );
  const require = createRequire(join(resources, 'ccdt', 'posix-ssh-worker.mjs'));
  assert.equal(
    require.resolve('ssh2'),
    join(resources, 'ccdt', 'node_modules', 'ssh2', 'lib', 'index.js'),
  );
  assert.equal(typeof require('ssh2').Server, 'function');
  assert.equal(existsSync(join(resources, 'app')), false);
});
