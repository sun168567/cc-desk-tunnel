import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron } from '@playwright/test';

// Starts a packaged macOS or Linux application offline, with a profile of its own: the main process, the
// preload and the page have to come up, and the SSH service has to start from the packaged files alone and
// run a script the way the service sends one. The package's own program serves as the Node that checks the
// latter. Takes the application (the .app of macOS, the program file of Linux) and further arguments for it.
const mac = process.platform === 'darwin';
if (process.platform === 'win32' || !process.argv[2] || mac !== process.argv[2].endsWith('.app'))
  throw new Error('Usage: node scripts/smoke-posix-package.mjs <application> [arguments]');
const executable = mac
  ? join(resolve(process.argv[2]), 'Contents/MacOS/CC Desk Tunnel')
  : resolve(process.argv[2]);
const archive = join(dirname(executable), mac ? '../Resources/app.asar' : 'resources/app.asar');
// The shell each system gives its users: the script host has to work with both.
const shell = mac ? '/bin/zsh' : '/bin/bash';
const root = resolve('.local/package-smoke');
mkdirSync(root, { recursive: true });
const directory = mkdtempSync(join(root, 'run-'));
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => key !== 'ELECTRON_RUN_AS_NODE' && !key.startsWith('PROXY_'),
  ),
);
env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
const args = [
  ...process.argv.slice(3),
  '--smoke-test',
  `--user-data-dir=${join(directory, 'profile')}`,
];
const application = await _electron.launch({
  executablePath: executable,
  args,
  cwd: directory,
  env,
  timeout: 30_000,
});
try {
  const errors = [];
  const page = await application.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.getByRole('heading', { name: '连接代理服务', exact: true }).waitFor();
  assert.equal(await application.evaluate(({ app }) => app.isPackaged), true);
  assert.equal(await page.evaluate(() => window.desktop.platform), process.platform);
  execFileSync(
    executable,
    [
      '--input-type=module',
      '-e',
      String.raw`
    import assert from 'node:assert/strict';
    import { execFile } from 'node:child_process';
    import { randomUUID } from 'node:crypto';
    import { writeFile } from 'node:fs/promises';
    import { join } from 'node:path';
    import { pathToFileURL } from 'node:url';
    const root = process.env.CC_PACKAGE_ROOT;
    const directory = process.cwd();
    // The bridge as it is packaged: one file, which starts the SSH service's process from the files beside it.
    const bridge = await import(pathToFileURL(join(root, 'electron/proxy-bridge.mjs')));
    assert.equal(typeof bridge.openProxyBridge, 'function');
    const service = await bridge.startLocalSsh(randomUUID(), {
      shellPath: process.env.CC_PACKAGE_SHELL,
      env: { HOME: directory, ZDOTDIR: directory, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
      environment: { CC_DESK_TUNNEL_SCHEDULES: join(directory, 'schedules.json') },
      cwd: directory,
    }, new AbortController().signal, (message) => { throw new Error(message); });
    try {
      const identity = join(directory, 'identity');
      const known = join(directory, 'known_hosts');
      await writeFile(identity, service.credentials.privateKey, { mode: 0o600 });
      await writeFile(known, '[127.0.0.1]:' + service.port + ' ' + service.credentials.hostPublicKey + '\n');
      // What the service's SSH configuration has for the host device-script: see scriptCommand in tunnel.ts.
      const output = await new Promise((done, fail) => {
        const child = execFile('/usr/bin/ssh', [
          '-p', String(service.port), '-i', identity, '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes',
          '-o', 'StrictHostKeyChecking=yes', '-o', 'UserKnownHostsFile=' + known,
          service.credentials.username + '@127.0.0.1', 'exec "$CC_DESK_TUNNEL_SHELL" -s',
        ], { timeout: 15000 }, (error, stdout) => (error && error.code !== 7 ? fail(error) : done({ stdout, code: error?.code ?? 0 })));
        child.stdin.end('echo "packaged $CC_DESK_TUNNEL_SCHEDULES"\nexit 7\n');
      });
      assert.equal(output.stdout, 'packaged ' + join(directory, 'schedules.json') + '\n');
      assert.equal(output.code, 7);
    } finally { await service.close(); }
  `,
    ],
    {
      cwd: directory,
      timeout: 30_000,
      stdio: 'inherit',
      env: {
        ...env,
        ELECTRON_RUN_AS_NODE: '1',
        CC_PACKAGE_ROOT: archive,
        CC_PACKAGE_SHELL: shell,
      },
    },
  );
  // A second connection is a process of its own: the packaged program has to start itself once more under
  // another profile, tell that it runs, and go when a command line asks it to.
  const { id } = (await page.evaluate(() => window.desktop.createConnection('另一个'))).find(
    (entry) => entry.id,
  );
  const until = async (open) => {
    for (let waited = 0; ; waited += 500) {
      const listed = await page.evaluate(() => window.desktop.connections());
      if (listed.find((entry) => entry.id === id).open === open) return;
      assert.ok(waited < 30_000, `The second connection is ${open ? 'not open' : 'still open'}.`);
      await delay(500);
    }
  };
  const dismiss = () =>
    execFileSync(executable, [...args, `--connection=${id}`, '--quit-connection'], {
      cwd: directory,
      env,
      timeout: 30_000,
    });
  try {
    await until(true);
  } finally {
    dismiss();
  }
  await until(false);
  await page.evaluate((connection) => window.desktop.removeConnection(connection), id);
  assert.deepEqual(errors, []);
  // A picture of the window as the system draws it, for whoever reviews a build without a Mac at hand.
  if (process.env.SMOKE_SCREENSHOT) {
    await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.show();
      window.moveTop();
      window.focus();
    });
    // A window shown for the first time takes a moment to be drawn, longer without a graphics card.
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => done())));
    await delay(4000);
    mkdirSync(dirname(resolve(process.env.SMOKE_SCREENSHOT)), { recursive: true });
    try {
      // The whole screen: the window's buttons are the system's on macOS and Chromium's own on Linux, and
      // neither is part of the page.
      if (mac) execFileSync('screencapture', ['-x', resolve(process.env.SMOKE_SCREENSHOT)]);
      else execFileSync('import', ['-window', 'root', resolve(process.env.SMOKE_SCREENSHOT)]);
    } catch (error) {
      console.log(`No screenshot: ${error.message}`);
    }
    // And the page alone, as the program itself renders it, should the screen have shown nothing.
    await page.screenshot({
      path: resolve(process.env.SMOKE_SCREENSHOT).replace(/\.png$/, '-page.png'),
    });
  }
  console.log(
    'PASS: the packaged client starts offline, its SSH service runs a script and a second connection opens.',
  );
} finally {
  await application.close();
  rmSync(directory, { recursive: true, force: true });
}
