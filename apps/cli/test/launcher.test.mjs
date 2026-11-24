import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { GIT_BASH_LAUNCHER } from '../../../scripts/package-desktop.mjs';
import { argumentsAsWritten } from '../src/runtime.mjs';

const bash = join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe');

test(
  'from Git Bash, ccdt is found by its name and gets its arguments as written, a task like "/review" among them',
  { skip: (process.platform !== 'win32' || !existsSync(bash)) && 'Git Bash on Windows' },
  (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'ccdt-launcher-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    writeFileSync(join(directory, 'ccdt'), GIT_BASH_LAUNCHER);
    copyFileSync(process.execPath, join(directory, 'node.exe'));
    writeFileSync(
      join(directory, 'ccdt.mjs'),
      'console.log(JSON.stringify(process.argv.slice(2))); process.exitCode = 3;',
    );
    const folder = execFileSync(bash, ['-c', 'cygpath -u "$1"', '_', directory], {
      encoding: 'utf8',
    }).trim();
    const args = ['-p', '/review the diff', '/c/Users', 'C:\\x y', 'a"b', ''];
    let said;
    try {
      execFileSync(bash, ['-c', 'PATH="$1:$PATH"; shift; ccdt "$@"', '_', folder, ...args], {
        encoding: 'utf8',
      });
    } catch (error) {
      said = error;
    }
    assert.equal(said?.status, 3, 'its exit status is ccdt’s');
    assert.deepEqual(JSON.parse(said.stdout), args);
  },
);

test('the variables that kept the arguments as written are gone before ccdt starts anything', () => {
  const env = {
    CCDT_ARGUMENTS_AS_WRITTEN: '1',
    MSYS_NO_PATHCONV: '1',
    MSYS2_ARG_CONV_EXCL: '*',
    PATH: 'x',
  };
  argumentsAsWritten(env);
  assert.deepEqual(env, { PATH: 'x' });
  // Set by the user rather than by the launcher, they stay.
  const own = { MSYS_NO_PATHCONV: '1' };
  argumentsAsWritten(own);
  assert.deepEqual(own, { MSYS_NO_PATHCONV: '1' });
});
