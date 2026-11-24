import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { linkCcdt, locate, openSession, terminalCommand } from '../electron/ccdt.mjs';

test('ccdt is the client’s own, else looked for on the PATH, then where its install script puts it', () => {
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
  // The one the client carries comes first: it is of the client's release, whatever else is installed.
  const own = join('C:\\Program Files\\CC Desk Tunnel', 'resources', 'ccdt', 'ccdt.cmd');
  assert.equal(locate({ ...windows, own }, found(own, join('C:\\other', 'ccdt.cmd'))), own);
  // A client that carries none, run from the source tree, looks further.
  assert.equal(
    locate({ ...windows, own }, found(join('C:\\other', 'ccdt.cmd'))),
    join('C:\\other', 'ccdt.cmd'),
  );
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
  assert.equal(mac.file, 'open');
  assert.deepEqual(mac.args.slice(0, 2), ['-a', 'Terminal']);
  assert.equal(mac.args[2], mac.script.path);
  assert.match(mac.script.path, /\.command$/);
  assert.equal(
    mac.script.text,
    `#!/bin/sh\nrm -f "$0"\ncd '/Users/o'\\''neil/项目 "x"' && '/Users/o'\\''neil/.local/bin/ccdt' 'open' '${args[1]}' '--server' 'wss://a.test/ws' || read -r _\n`,
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

// A terminal window of the system's really opened, on GitHub's macOS machine and on its Linux one under xvfb with
// xterm: what the strings above only describe. Not run on a developer's computer, to open no window there.
test(
  'on macOS and Linux a window of the terminal runs ccdt in the project, after ccdt was signed in',
  {
    skip:
      process.platform === 'win32' ||
      !process.env.CI ||
      (process.platform === 'linux' && !process.env.DISPLAY),
  },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'ccdt-open-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const bin = join(root, 'bin');
    const project = join(root, "项目 'x'");
    mkdirSync(bin);
    mkdirSync(project);
    const log = join(root, 'log');
    // A ccdt of this release that keeps what it was asked, and what it read for a login.
    writeFileSync(
      join(bin, 'ccdt'),
      `#!/bin/sh
case "$1" in
  --version) echo 'ccdt 9.9.9' ;;
  login) printf '%s|%s\\n' "$*" "$(cat)" >> '${log}' ;;
  *) printf '%s|%s\\n' "$*" "$(pwd)" >> '${log}' ;;
esac
`,
      { mode: 0o755 },
    );
    const sessionId = '11111111-2222-4333-8444-555555555555';
    const opened = await openSession(
      { url: 'wss://a.test/ws', fingerprint: '', token: 'secret', sessionId, projectPath: project },
      { version: '9.9.9', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, home: root },
    );
    assert.deepEqual(opened, { status: 'opened' });
    const lines = async () => {
      for (let i = 0; i < 300; i++) {
        const text = (() => {
          try {
            return readFileSync(log, 'utf8');
          } catch {
            return '';
          }
        })();
        if (text.split('\n').filter(Boolean).length >= 2) return text.split('\n').filter(Boolean);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.fail(`the terminal ran no ccdt open: ${readFileSync(log, 'utf8')}`);
    };
    const [login, open] = await lines();
    assert.equal(login, 'login wss://a.test/ws --token-stdin --no-verify|secret');
    const [words, folder] = open.split('|');
    assert.equal(words, `open ${sessionId} --server wss://a.test/ws`);
    assert.equal(realpathSync(folder), realpathSync(project));
  },
);

test(
  'the ccdt a macOS or Linux client carries becomes the user’s ccdt, in place of one installed on its own',
  { skip: process.platform === 'win32' && 'links of a POSIX home' },
  (t) => {
    const home = mkdtempSync(join(tmpdir(), 'ccdt-home-'));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const own = join(home, 'opt', 'CC Desk Tunnel', 'resources', 'ccdt', 'bin', 'ccdt');
    mkdirSync(dirname(own), { recursive: true });
    writeFileSync(own, '#!/bin/sh\n');
    const link = join(home, '.local', 'bin', 'ccdt');
    const linux = { platform: 'linux', home, own, env: { PATH: '/usr/bin' }, shell: '/bin/bash' };
    // None yet: made, and ~/.local/bin goes on the PATH of the shells started from now on, once.
    assert.deepEqual(linkCcdt(linux), { linked: true, path: link });
    assert.equal(readlinkSync(link), own);
    linkCcdt(linux);
    assert.equal(
      readFileSync(join(home, '.bashrc'), 'utf8'),
      '\n# ccdt\nexport PATH="$HOME/.local/bin:$PATH"\n',
    );
    // Where the session already has it on the PATH, nothing is written.
    rmSync(join(home, '.bashrc'));
    linkCcdt({ ...linux, env: { PATH: `${join(home, '.local', 'bin')}:/usr/bin` } });
    assert.equal(existsSync(join(home, '.bashrc')), false);
    // A ccdt installed on its own, or a link to one that is gone: taken over.
    const alone = join(home, '.local', 'share', 'ccdt', 'bin', 'ccdt');
    mkdirSync(dirname(alone), { recursive: true });
    writeFileSync(alone, '#!/bin/sh\n');
    for (const target of [alone, join(home, 'gone', 'ccdt')]) {
      rmSync(link);
      symlinkSync(target, link);
      assert.equal(linkCcdt(linux).linked, true);
      assert.equal(readlinkSync(link), own);
    }
    // The user's own: a link elsewhere, or a file, is left alone.
    const mine = join(home, 'src', 'ccdt');
    mkdirSync(dirname(mine), { recursive: true });
    writeFileSync(mine, '#!/bin/sh\n');
    rmSync(link);
    symlinkSync(mine, link);
    assert.deepEqual(linkCcdt(linux), { linked: false, reason: 'taken', path: link });
    assert.equal(readlinkSync(link), mine);
    rmSync(link);
    writeFileSync(link, '#!/bin/sh\n');
    assert.equal(linkCcdt(linux).reason, 'taken');
    // A Mac client links only from the Applications folder, and writes the PATH for the user's shell.
    rmSync(link);
    const mac = { ...linux, platform: 'darwin', shell: '/bin/zsh' };
    for (const application of [
      undefined,
      '/Volumes/CC Desk Tunnel/CC Desk Tunnel.app',
      '/private/var/folders/x/AppTranslocation/1/d/CC Desk Tunnel.app',
    ])
      assert.equal(linkCcdt({ ...mac, application }).reason, 'not-in-applications');
    assert.equal(existsSync(link), false);
    assert.equal(
      linkCcdt({ ...mac, application: join(home, 'Applications', 'CC Desk Tunnel.app') }).linked,
      true,
    );
    assert.match(readFileSync(join(home, '.zshrc'), 'utf8'), /export PATH="\$HOME\/\.local\/bin/);
    // Windows, or a package without ccdt: nothing.
    assert.equal(linkCcdt({ ...linux, platform: 'win32' }).linked, false);
    assert.equal(linkCcdt({ ...linux, own: join(home, 'none') }).linked, false);
  },
);
