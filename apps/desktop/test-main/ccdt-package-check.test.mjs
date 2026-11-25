import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { bundleCcdt, checkCcdt, copyDependency } from '../../../scripts/package-desktop.mjs';

test(
  'the package check rejects missing SSH dependencies even inside a source checkout',
  { skip: process.platform === 'win32', timeout: 30000 },
  async (t) => {
    const root = fileURLToPath(new URL('../../..', import.meta.url));
    mkdirSync(join(root, '.local'), { recursive: true });
    const directory = mkdtempSync(join(root, '.local', 'ccdt-worker-check-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    await bundleCcdt(root, directory, { version: '0.0.0' });
    symlinkSync(process.execPath, join(directory, 'node'));
    mkdirSync(join(directory, 'bin'));
    const launcher = join(directory, 'bin/ccdt');
    writeFileSync(
      launcher,
      '#!/bin/sh\ndir=$(dirname "$(dirname "$0")")\nexec "$dir/node" "$dir/ccdt.mjs" "$@"\n',
      { mode: 0o755 },
    );

    assert.throws(() => checkCcdt(launcher, '0.0.0'), /ssh2/);
    copyDependency(root, directory, 'ssh2');
    assert.doesNotThrow(() => checkCcdt(launcher, '0.0.0'));
  },
);
