import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProcessSupervisor } from '../electron/process-supervisor.mjs';
import { captureShellEnvironment, resolvePosixShell } from '../electron/shell-environment.mjs';

const posix = { skip: process.platform === 'win32', timeout: 10000 };
// A failure says what went wrong as a phrase of the catalogs, which the window puts in its language.
const says = (key, params) => ({
  phrase: params ? { key: `desktop:shell.${key}`, params } : { key: `desktop:shell.${key}` },
});
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'cc-desk-shell-env-'));
  const supervisor = new ProcessSupervisor({ graceMs: 100 });
  t.after(async () => {
    await supervisor.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, supervisor, env: { ...process.env, HOME: directory, ZDOTDIR: directory } };
}

test(
  'login shell noise cannot corrupt the isolated environment JSON',
  { ...posix, skip: process.platform !== 'darwin' },
  async (t) => {
    const f = await fixture(t);
    await writeFile(join(f.directory, '.zprofile'), 'export CC_DESK_LOGIN="登录值"\n');
    await writeFile(
      join(f.directory, '.zshrc'),
      'printf "{profile noise}\\n"; printf "stderr noise\\n" >&2; export CC_DESK_INTERACTIVE="交互值"; echo yes >> "$HOME/initialized"\n',
    );
    const env = await captureShellEnvironment('/bin/zsh', f.supervisor, {
      env: f.env,
      cwd: f.directory,
    });
    assert.equal(env.CC_DESK_LOGIN, '登录值');
    assert.equal(env.CC_DESK_INTERACTIVE, '交互值');
    assert.equal((await readFile(join(f.directory, 'initialized'), 'utf8')).trim(), 'yes');
    assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
  },
);

test(
  'bash login and interactive initialization are captured from the helper descriptor',
  posix,
  async (t) => {
    const f = await fixture(t);
    await writeFile(
      join(f.directory, '.bash_profile'),
      'export CC_DESK_BASH="captured"; printf "profile noise\\n"\n',
    );
    const env = await captureShellEnvironment('/bin/bash', f.supervisor, {
      env: f.env,
      cwd: f.directory,
    });
    assert.equal(env.CC_DESK_BASH, 'captured');
  },
);

test(
  'shell initialization has bounded timeout, output and cancellation',
  { ...posix, skip: process.platform !== 'darwin' },
  async (t) => {
    const f = await fixture(t);
    await writeFile(join(f.directory, '.zshrc'), '/bin/sleep 120\n');
    await assert.rejects(
      captureShellEnvironment('/bin/zsh', f.supervisor, { env: f.env, timeoutMs: 50 }),
      says('timeout'),
    );
    const controller = new AbortController();
    const capturing = captureShellEnvironment('/bin/zsh', f.supervisor, {
      env: f.env,
      signal: controller.signal,
    });
    controller.abort();
    await assert.rejects(capturing, /cancelled/);
    await writeFile(join(f.directory, '.zshrc'), 'printf "%01000d" 1\n');
    await assert.rejects(
      captureShellEnvironment('/bin/zsh', f.supervisor, { env: f.env, maxBytes: 128 }),
      says('outputTooLarge'),
    );
  },
);

test('shell selection rejects relative paths and unsupported shell kinds', posix, async () => {
  await assert.rejects(resolvePosixShell({ shellPath: 'zsh' }), says('unsupported'));
  await assert.rejects(resolvePosixShell({ shellPath: '/bin/sh' }), says('unsupported'));
  await assert.rejects(resolvePosixShell({ shellPath: '/bin/zsh\n' }), says('unsupported'));
});

test('a login shell of another kind gives way to the one of the system', posix, async (t) => {
  const saved = process.env.SHELL;
  t.after(() => (saved === undefined ? delete process.env.SHELL : (process.env.SHELL = saved)));
  process.env.SHELL = '/usr/local/bin/fish';
  const shell = await resolvePosixShell();
  assert.match(shell, /^\/.*\/(zsh|bash)$/);
  assert.notEqual(shell, '/usr/local/bin/fish');
});

test(
  'shell selection preserves a bash alias pointing to a versioned executable',
  posix,
  async (t) => {
    const f = await fixture(t);
    const executable = join(f.directory, 'bash-versioned');
    const alias = join(f.directory, 'bash');
    await writeFile(executable, '#!/bin/bash\nexec /bin/bash "$@"\n', { mode: 0o700 });
    await symlink('bash-versioned', alias);
    assert.equal(await realpath(alias), await realpath(executable));
    assert.equal(await resolvePosixShell({ shellPath: alias }), alias);
  },
);

test('shell selection rejects dangling and non-executable aliases', posix, async (t) => {
  const f = await fixture(t);
  const alias = join(f.directory, 'bash');
  await symlink('missing-version', alias);
  await assert.rejects(resolvePosixShell({ shellPath: alias }), says('missing'));
  await rm(alias);
  await writeFile(join(f.directory, 'bash-versioned'), '#!/bin/bash\n', { mode: 0o600 });
  await symlink('bash-versioned', alias);
  await assert.rejects(resolvePosixShell({ shellPath: alias }), says('notExecutable'));
});

test(
  'shell initialization preserves spawn errors, exit codes and termination signals',
  posix,
  async (t) => {
    const f = await fixture(t);
    const shell = join(f.directory, 'broken-shell');
    await assert.rejects(
      captureShellEnvironment(shell, f.supervisor, { env: f.env }),
      says('cannotStart', { code: 'ENOENT' }),
    );
    await writeFile(shell, '#!/bin/sh\nexit 7\n', { mode: 0o700 });
    await assert.rejects(
      captureShellEnvironment(shell, f.supervisor, { env: f.env }),
      says('exited', { code: 7 }),
    );
    await writeFile(shell, '#!/bin/sh\nkill -TERM $$\n');
    await assert.rejects(
      captureShellEnvironment(shell, f.supervisor, { env: f.env }),
      says('signalled', { signal: 'SIGTERM' }),
    );
  },
);
