import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { locate, openSession, terminalCommand } from '../electron/ccdt.mjs';

test('ccdt is looked for on the PATH first, then where its install script puts it', () => {
  const windows = {
    platform: 'win32',
    env: { Path: 'C:\\tools;C:\\other', LOCALAPPDATA: 'C:\\L' },
  };
  const found =
    (...files) =>
    (file) =>
      files.includes(file);
  assert.equal(
    locate(
      windows,
      found(join('C:\\other', 'ccdt.cmd'), join('C:\\L', 'Programs', 'ccdt', 'ccdt.cmd')),
    ),
    join('C:\\other', 'ccdt.cmd'),
  );
  assert.equal(
    locate(windows, found(join('C:\\L', 'Programs', 'ccdt', 'ccdt.cmd'))),
    join('C:\\L', 'Programs', 'ccdt', 'ccdt.cmd'),
  );
  // A Mac's programs started from the Dock do not have ~/.local/bin on their PATH.
  const mac = { platform: 'darwin', env: { PATH: '/usr/bin:/bin' }, home: '/Users/me' };
  assert.equal(
    locate(mac, found(join('/Users/me', '.local', 'bin', 'ccdt'))),
    join('/Users/me', '.local', 'bin', 'ccdt'),
  );
  assert.equal(locate(mac, found()), undefined);
});

test('the terminal window runs ccdt quoted for the shell that reads it, and waits on an error', () => {
  const args = ['open', '11111111-2222-4333-8444-555555555555', '--server', 'wss://a.test/ws'];
  const windows = terminalCommand(
    { platform: 'win32', env: { ComSpec: 'C:\\cmd.exe' } },
    'C:\\P F\\ccdt.cmd',
    args,
    'D:\\项目',
  );
  assert.equal(windows.file, 'C:\\cmd.exe');
  assert.deepEqual(windows.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.equal(
    windows.args[3],
    `""C:\\P F\\ccdt.cmd" "open" "${args[1]}" "--server" "wss://a.test/ws" || pause"`,
  );
  assert.equal(windows.options.windowsVerbatimArguments, true);
  const mac = terminalCommand(
    { platform: 'darwin', env: {} },
    "/Users/o'neil/.local/bin/ccdt",
    args,
    '/Users/o\'neil/项目 "x"',
  );
  assert.equal(mac.file, 'osascript');
  assert.equal(
    mac.args[1],
    `tell application "Terminal" to do script "cd '/Users/o'\\\\''neil/项目 \\"x\\"' && '/Users/o'\\\\''neil/.local/bin/ccdt' 'open' '${args[1]}' '--server' 'wss://a.test/ws' || read -r _"`,
  );
  const linux = terminalCommand(
    { platform: 'linux', env: { PATH: '/usr/bin' } },
    '/home/me/.local/bin/ccdt',
    args,
    '/home/me',
    (file) => file === join('/usr/bin', 'konsole'),
  );
  assert.equal(linux.file, join('/usr/bin', 'konsole'));
  assert.deepEqual(linux.args.slice(0, 3), ['-e', 'sh', '-c']);
  assert.throws(
    () =>
      terminalCommand(
        { platform: 'linux', env: { PATH: '/usr/bin' } },
        'ccdt',
        args,
        '/',
        () => false,
      ),
    /没有找到可以打开的终端程序/,
  );
});

test('an address, session or fingerprint that would mean more to a shell is never passed on', async () => {
  const request = {
    url: 'wss://a.test/ws',
    fingerprint: 'AB:CD',
    token: 't',
    sessionId: '11111111-2222-4333-8444-555555555555',
  };
  const system = { version: '0.3.9', platform: 'linux', env: { PATH: '' }, home: '/nowhere' };
  for (const bad of [
    { url: 'wss://a.test/ws" & calc' },
    { url: 'wss://a.test/%PATH%' },
    { url: 'https://a.test/' },
    { sessionId: '1 && calc' },
    { fingerprint: 'AB;rm' },
  ])
    await assert.rejects(openSession({ ...request, ...bad }, system), /不能交给 ccdt/);
  assert.deepEqual(await openSession(request, system), { status: 'missing' });
});
