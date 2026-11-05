import { test, expect, _electron } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { WebSocketServer } from 'ws';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import type { Session } from '@cc-desk-tunnel/protocol';
import { screenshots } from './helpers.ts';

const folder = resolve(screenshots, 'ccdt-open');
mkdirSync(folder, { recursive: true });

// A ccdt that says it is of the release in `version`, keeps what it was given in `log` and opens nothing.
const fake = `import { appendFileSync, readFileSync } from 'node:fs';
const here = import.meta.dirname;
const args = process.argv.slice(2);
if (args[0] === '--version') console.log('ccdt ' + readFileSync(here + '/version', 'utf8').trim());
else {
  let input = '';
  if (args[0] === 'login') for await (const chunk of process.stdin) input += chunk;
  appendFileSync(here + '/log', JSON.stringify({ args, cwd: process.cwd(), input }) + '\\n');
}
`;

test('a session opens in ccdt signed in as the window is, or the window says how to install it', async () => {
  test.skip(process.platform !== 'win32', 'Windows desktop test');
  test.slow();
  mkdirSync(resolve('.local/ccdt-open-test'), { recursive: true });
  const root = mkdtempSync(resolve('.local/ccdt-open-test/run-'));
  const bin = resolve(root, 'bin');
  const project = resolve(root, '项目');
  mkdirSync(bin);
  mkdirSync(project);
  const token = 'test-only-ccdt-token-with-enough-length';
  const session: Session = {
    id: randomUUID(),
    title: '终端里接着聊',
    autoTitle: false,
    projectPath: project,
    permissionMode: 'auto',
    model: null,
    effort: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    activeRun: null,
  };
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  server.on('connection', (socket) =>
    socket.on('message', (raw) => {
      const message = JSON.parse(String(raw));
      const send = (value: unknown) => socket.send(JSON.stringify(value));
      if (message.type === 'auth')
        return send({
          type: 'ready',
          protocolVersion: PROTOCOL_VERSION,
          version: '0.0.1',
          connectionId: randomUUID(),
          adapter: 'claude-code',
          sessions: [session],
        });
      if (!message.requestId) return;
      if (message.type === 'session.subscribe')
        send({
          type: 'session.snapshot',
          requestId: message.requestId,
          session,
          mode: 'replace',
          firstSequence: 0,
          lastSequence: 0,
          hasEarlier: false,
          events: [],
        });
      send({ type: 'response', requestId: message.requestId, ok: true });
    }),
  );
  await new Promise((done) => server.once('listening', done));
  const url = `ws://127.0.0.1:${(server.address() as { port: number }).port}/ws`;
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env))
    if (value !== undefined && name !== 'ELECTRON_RUN_AS_NODE') env[name] = value;
  // ccdt is looked for only here: on this PATH and in this install folder, which holds none.
  env.Path = `${bin};${process.env.SystemRoot}\\System32`;
  env.LOCALAPPDATA = resolve(root, 'local');
  const application = await _electron.launch({
    args: [resolve('apps/desktop'), '--smoke-test', `--user-data-dir=${resolve(root, 'profile')}`],
    env,
  });
  try {
    const page = await application.firstWindow();
    const version = await application.evaluate(({ app }) => app.getVersion());
    await page.getByRole('button', { name: '本地模拟', exact: true }).click();
    await page.getByLabel('服务地址', { exact: true }).fill(url);
    await page.getByLabel('服务凭据', { exact: true }).fill(token);
    await page.getByRole('button', { name: '连接', exact: true }).click();
    const row = page.locator('.session-row').filter({ hasText: session.title });
    const open = async () => {
      await row.click({ button: 'right' });
      await page.getByRole('menuitem', { name: '在 ccdt 中打开', exact: true }).click();
    };
    const dialog = page.getByRole('dialog');

    // Not installed: the line that installs the service's release, and where it is explained.
    await open();
    await expect(dialog.getByRole('heading')).toHaveText('安装 ccdt');
    await expect(dialog.locator('pre')).toHaveText(
      `$env:CCDT_VERSION = '${version}'; irm https://raw.githubusercontent.com/sun168567/cc-desk-tunnel/main/deploy/install-ccdt.ps1 | iex`,
    );
    await expect(dialog.getByRole('button', { name: '安装说明' })).toBeVisible();
    await page.screenshot({ path: resolve(folder, '01-未安装.png') });
    await dialog.getByRole('button', { name: '知道了' }).click();

    // Another release: the same line, as an update.
    writeFileSync(resolve(bin, 'fake.mjs'), fake);
    writeFileSync(resolve(bin, 'ccdt.cmd'), `@"${process.execPath}" "%~dp0fake.mjs" %*\r\n`);
    writeFileSync(resolve(bin, 'version'), '0.0.1');
    await open();
    await expect(dialog.getByRole('heading')).toHaveText('更新 ccdt');
    await expect(dialog).toContainText(`这台电脑上的 ccdt 是 0.0.1，要与服务端同为 ${version}`);
    await page.screenshot({ path: resolve(folder, '02-版本不同.png') });
    await dialog.getByRole('button', { name: '知道了' }).click();

    // Of the release: signed in with the window's token on its input, then the session opened in a window of its own.
    writeFileSync(resolve(bin, 'version'), version);
    await open();
    await expect
      .poll(
        () =>
          existsSync(resolve(bin, 'log')) &&
          readFileSync(resolve(bin, 'log'), 'utf8').split('\n').filter(Boolean).length,
        { timeout: 15_000 },
      )
      .toBe(2);
    const [login, opened] = readFileSync(resolve(bin, 'log'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(login).toEqual({
      args: ['login', url, '--token-stdin'],
      cwd: expect.any(String),
      input: token,
    });
    expect(opened).toEqual({
      args: ['open', session.id, '--server', url],
      cwd: project,
      input: '',
    });
    await expect(dialog).toHaveCount(0);
  } finally {
    await application.close();
    server.close();
  }
});
