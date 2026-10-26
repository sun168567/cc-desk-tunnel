import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { WebSocket } from 'ws';
import { PROTOCOL_VERSION, serverMessageSchema } from '@cc-desk-tunnel/protocol';
import type { ServerMessage } from '@cc-desk-tunnel/protocol';
import { createProxyServer } from '../../server/src/server.ts';
import { defaultCertificate } from '../../server/test/fixtures/web-certificates.ts';
import { screenshots } from './helpers.ts';

const webScreenshots = resolve(screenshots, 'web');
mkdirSync(webScreenshots, { recursive: true });

test('Passkey registration, login and proof recovery use the real HTTPS service', async ({
  browser,
}, testInfo) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'cc-web-passkey-'));
  const token = `passkey-live-test-${randomUUID()}`;
  const service = createProxyServer({
    token,
    dataDir,
    host: '127.0.0.1',
    tls: { cert: Buffer.from(defaultCertificate.cert), key: Buffer.from(defaultCertificate.key) },
    webDirectory: resolve('apps/desktop/dist'),
  });
  // This fixture exercises TLS transport, not public certificate trust or a reverse-proxy deployment.
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  let desktop: WebSocket | undefined;
  try {
    const url = await service.listen(0);
    desktop = new WebSocket(`${url.replace('https:', 'wss:')}/ws`, { rejectUnauthorized: false });
    const messages: ServerMessage[] = [];
    desktop.on('message', (raw) =>
      messages.push(serverMessageSchema.parse(JSON.parse(raw.toString()))),
    );
    await once(desktop, 'open');
    desktop.send(
      JSON.stringify({
        type: 'auth',
        token,
        protocolVersion: PROTOCOL_VERSION,
        deviceName: '测试桌面',
      }),
    );
    desktop.send(JSON.stringify({ type: 'device', id: randomUUID() }));
    await expect.poll(() => messages.some((message) => message.type === 'ready')).toBe(true);
    const requestId = randomUUID();
    desktop.send(
      JSON.stringify({
        type: 'web.settings.update',
        requestId,
        values: { enabled: true, domain: 'web.localhost', path: 'passkey' },
      }),
    );
    await expect
      .poll(() =>
        messages.find((message) => message.type === 'response' && message.requestId === requestId),
      )
      .toMatchObject({ ok: true });
    const entry = new URL('/passkey/', url);
    entry.hostname = 'web.localhost';
    const page = await context.newPage();
    const frames: Record<string, unknown>[] = [];
    page.on('websocket', (socket) =>
      socket.on('framesent', ({ payload }) => frames.push(JSON.parse(String(payload)))),
    );
    const cdp = await context.newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: {
        protocol: 'ctap2',
        transport: 'internal',
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    });
    await page.goto(`${entry.href}#passkeys`);
    await page.getByLabel('服务凭据', { exact: true }).fill(token);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByLabel('名称', { exact: true }).fill('真实链路');
    await page.getByRole('button', { name: '下一步', exact: true }).click();
    await page.getByRole('button', { name: '创建通行密钥', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const key = service.store.database.prepare('SELECT id, name FROM passkeys').get()!;
    expect(key.name).toBe('真实链路');
    await page.getByRole('button', { name: '设置与账号', exact: true }).click();
    await page.getByRole('menuitem', { name: '退出登录', exact: true }).click();
    await page.getByRole('button', { name: '使用通行密钥登录', exact: true }).click();
    await expect(page.locator('.connection-status')).toContainText('已连接');
    expect(
      (await context.cookies(entry.href)).find((cookie) => cookie.name.startsWith('cc_web_')),
    ).toMatchObject({ secure: true, httpOnly: true, sameSite: 'Strict', path: '/passkey/' });
    expect(service.store.database.prepare('SELECT passkey_id FROM web_sessions').all()).toEqual([
      { passkey_id: key.id },
    ]);
    await page.goto(`${entry.href}#passkeys`);
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await page.getByRole('button', { name: '重命名 真实链路', exact: true }).click();
    await page.getByLabel('名称', { exact: true }).fill('已验证链路');
    await page.getByRole('button', { name: '改用通行密钥验证', exact: true }).click();
    await page.getByRole('button', { name: '验证通行密钥', exact: true }).click();
    await expect(page.getByText('已通过通行密钥验证', { exact: true })).toBeVisible();
    const renames = () => frames.filter((frame) => frame.type === 'web.passkeys.rename');
    const name = page.getByLabel('名称', { exact: true });
    await name.fill('');
    await page.getByRole('button', { name: '确认', exact: true }).click();
    await expect(name).toBeFocused();
    await expect(page.getByText('已通过通行密钥验证', { exact: true })).toBeVisible();
    expect(renames()).toHaveLength(0);
    await name.fill('已验证链路');
    service.store.database.exec(`CREATE TRIGGER reject_rename BEFORE UPDATE OF name ON passkeys
      BEGIN SELECT RAISE(FAIL, 'test rename failure'); END;`);
    await page.getByRole('button', { name: '确认', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('服务处理失败');
    await expect(page.getByText('已通过通行密钥验证', { exact: true })).toHaveCount(0);
    expect(renames()).toHaveLength(1);
    expect(
      service.store.database.prepare('SELECT name FROM passkeys WHERE id = ?').get(key.id),
    ).toMatchObject({ name: '真实链路' });
    service.store.database.exec('DROP TRIGGER reject_rename');
    await page
      .getByRole('dialog')
      .screenshot({ path: testInfo.outputPath('proof-retry-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: testInfo.outputPath('proof-retry-mobile.png') });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole('button', { name: '确认', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('请先完成通行密钥验证');
    expect(renames()).toHaveLength(1);
    await page.getByRole('button', { name: '验证通行密钥', exact: true }).click();
    await expect(page.getByText('已通过通行密钥验证', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '确认', exact: true }).click();
    await expect(
      page.getByRole('button', { name: '重命名 已验证链路', exact: true }),
    ).toBeVisible();
    expect(
      service.store.database.prepare('SELECT name FROM passkeys WHERE id = ?').get(key.id),
    ).toMatchObject({ name: '已验证链路' });
    expect(frames.find((frame) => frame.type === 'web.passkeys.rename')).toMatchObject({
      proof: { passkey: expect.any(String) },
    });
    expect(renames()).toHaveLength(2);
    expect(frames.some((frame) => ['auth', 'device'].includes(String(frame.type)))).toBe(false);
  } finally {
    await context.close();
    desktop?.terminate();
    await service.close();
    expect(dirname(dataDir)).toBe(resolve(tmpdir()));
    expect(basename(dataDir)).toMatch(/^cc-web-passkey-/);
    rmSync(dataDir, { recursive: true, force: true });
  }
});

for (const path of ['', 'private-access'])
  test(`production workbench at ${path || 'root'} uses real HTTPS, protected cookies and WSS alongside desktop`, async ({
    browser,
  }) => {
    const dataDir = mkdtempSync(join(tmpdir(), 'cc-web-live-'));
    const token = `web-live-test-${randomUUID()}`;
    const service = createProxyServer({
      token,
      dataDir,
      host: '127.0.0.1',
      tls: { cert: Buffer.from(defaultCertificate.cert), key: Buffer.from(defaultCertificate.key) },
      webDirectory: resolve('apps/desktop/dist'),
      stepMs: 2,
    });
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    let desktop: WebSocket | undefined;
    try {
      const url = await service.listen(0);
      const entry = `${url}/${path ? `${path}/` : ''}`;
      const prefix = path ? `/${path}` : '';
      let currentPrefix = prefix;
      expect((await context.request.get(entry)).status()).toBe(404);

      // A normal desktop control connection turns on Web; no execution tunnel or HTTP route is mocked.
      desktop = new WebSocket(`${url.replace('https:', 'wss:')}/ws`, { rejectUnauthorized: false });
      const messages: ServerMessage[] = [];
      desktop.on('message', (raw) =>
        messages.push(serverMessageSchema.parse(JSON.parse(raw.toString()))),
      );
      await once(desktop, 'open');
      desktop.send(
        JSON.stringify({
          type: 'auth',
          token,
          protocolVersion: PROTOCOL_VERSION,
          deviceName: '端到端测试桌面',
        }),
      );
      desktop.send(JSON.stringify({ type: 'device', id: randomUUID() }));
      await expect.poll(() => messages.some((message) => message.type === 'ready')).toBe(true);
      async function command(value: object) {
        const requestId = randomUUID();
        desktop!.send(JSON.stringify({ ...value, requestId }));
        await expect
          .poll(() =>
            messages.some(
              (message) => message.type === 'response' && message.requestId === requestId,
            ),
          )
          .toBe(true);
        const response = messages.find(
          (message): message is Extract<ServerMessage, { type: 'response' }> =>
            message.type === 'response' && message.requestId === requestId,
        )!;
        expect(response.ok, response.message).toBe(true);
        return requestId;
      }
      await command({
        type: 'web.settings.update',
        values: { enabled: true, path },
        proof: { password: token },
      });

      const page = await context.newPage();
      const errors: string[] = [];
      const frames: Record<string, unknown>[] = [];
      const received: ServerMessage[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('console', (entry) => {
        if (entry.type() === 'error' && /Content Security Policy/i.test(entry.text()))
          errors.push(entry.text());
      });
      page.on('websocket', (socket) => {
        expect(socket.url()).toBe(`${url.replace('https:', 'wss:')}${currentPrefix}/api/ws`);
        socket.on('framesent', ({ payload }) => frames.push(JSON.parse(String(payload))));
        socket.on('framereceived', ({ payload }) =>
          received.push(serverMessageSchema.parse(JSON.parse(String(payload)))),
        );
      });
      const documentResponse = await page.goto(entry);
      expect(documentResponse?.status()).toBe(200);
      expect(documentResponse?.headers()['content-security-policy']).toContain(
        "frame-ancestors 'none'",
      );
      await expect(page.getByRole('note')).toContainText('自签名证书');
      await page.getByLabel('服务凭据', { exact: true }).fill(token);
      await page.getByRole('button', { name: '登录', exact: true }).click();
      await expect(page.locator('.shell')).toBeVisible();
      await expect(page.locator('.connection-status')).toContainText('已连接');
      const cookie = (await context.cookies(entry)).find((entry) =>
        entry.name.startsWith('cc_web_'),
      );
      expect(cookie).toMatchObject({
        secure: true,
        httpOnly: true,
        sameSite: 'Strict',
        path: `${prefix}/`,
      });
      expect(await page.evaluate(() => document.cookie)).toBe('');
      expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(token);
      expect(frames[0]).toEqual({ type: 'web.auth', protocolVersion: PROTOCOL_VERSION });
      expect(frames.some((frame) => ['auth', 'device'].includes(String(frame.type)))).toBe(false);
      await expect(page.getByText('还没有项目', { exact: true })).toHaveCount(0);

      await page.locator('.sidebar').getByRole('button', { name: '新建会话', exact: true }).click();
      await expect
        .poll(() =>
          messages.some(
            (message) =>
              message.type === 'session.updated' && message.session.device?.name === '服务端',
          ),
        )
        .toBe(true);
      const created = messages.find(
        (message): message is Extract<ServerMessage, { type: 'session.updated' }> =>
          message.type === 'session.updated' && message.session.device?.name === '服务端',
      )!.session;
      expect(created.device?.platform).toBe('linux');
      // The service is listed once it holds a session; the list follows that session.
      await expect
        .poll(() =>
          received
            .filter((message) => message.type === 'devices')
            .flatMap((message) => message.devices)
            .find((device) => device.id === created.device?.id),
        )
        .toMatchObject({ server: true, ready: true });
      await page.getByRole('button', { name: '展开其他设备的会话', exact: true }).click();
      await expect(
        page.getByRole('button', { name: '收起设备 · 服务端', exact: true }),
      ).toBeVisible();
      await expect(page.locator('.sidebar .session-row')).toContainText(created.title);
      // Server workspaces are internal directories, not projects the user created.
      await expect(page.locator('.sidebar .elsewhere-project')).toHaveCount(0);
      await expect(page.getByRole('button', { name: '会话所在的项目', exact: true })).toHaveText(
        '普通会话',
      );
      await command({ type: 'session.subscribe', sessionId: created.id });
      await expect(page.getByRole('textbox', { name: '消息', exact: true })).toBeEnabled();
      await page.getByLabel('模拟场景').selectOption('chat');
      const text = '真实 HTTPS 与 Cookie 的端到端消息';
      await page.getByRole('textbox', { name: '消息', exact: true }).fill(text);
      await page.getByRole('button', { name: '发送消息', exact: true }).click();
      await expect(page.locator('.message.user')).toContainText(text);
      await expect(page.locator('.message.assistant strong')).toContainText('离线模拟回复');
      await expect(page.getByRole('button', { name: '停止运行', exact: true })).toHaveCount(0);
      await expect
        .poll(() =>
          messages.some(
            (message) =>
              message.type === 'session.event' &&
              message.event.sessionId === created.id &&
              message.event.payload.type === 'run.status' &&
              message.event.payload.status === 'completed',
          ),
        )
        .toBe(true);

      await page.screenshot({
        path: join(webScreenshots, `live-workbench-${path || 'root'}-desktop.png`),
      });
      await page.setViewportSize({ width: 390, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({
        path: join(webScreenshots, `live-workbench-${path || 'root'}-mobile.png`),
      });
      await page.setViewportSize({ width: 1280, height: 900 });

      // Tabs share the protected login session. Signing out revokes every socket for that session.
      const other = await context.newPage();
      await other.goto(entry);
      await expect(other.locator('.shell')).toBeVisible();
      await page.getByRole('button', { name: '设置与账号', exact: true }).click();
      await page.getByRole('menuitem', { name: '退出登录', exact: true }).click();
      await expect(page.getByRole('button', { name: '登录', exact: true })).toBeVisible();
      await expect(other.getByRole('button', { name: '登录', exact: true })).toBeVisible();
      expect((await context.cookies(entry)).some((entry) => entry.name.startsWith('cc_web_'))).toBe(
        false,
      );

      await page.getByLabel('服务凭据', { exact: true }).fill(token);
      await page.getByRole('button', { name: '登录', exact: true }).click();
      await expect(page.locator('.shell')).toBeVisible();

      // Chromium retains cookies at old paths. Changing the entry must not let them shadow the new login.
      let currentCookie = (await context.cookies(page.url())).find(
        (cookie) => cookie.name.startsWith('cc_web_') && cookie.path === `${currentPrefix}/`,
      )!;
      for (const nextPath of path ? ['', 'changed-entry', ''] : ['changed-entry', '']) {
        await page.getByRole('button', { name: '设置与账号', exact: true }).click();
        await page.getByRole('menuitem', { name: '设置', exact: true }).click();
        await page
          .locator('.setting-row')
          .filter({ hasText: '访问设置' })
          .getByRole('button', { name: '设置', exact: true })
          .click();
        await page.getByLabel('服务端访问路径', { exact: false }).fill(nextPath);
        await page.getByLabel('服务凭据', { exact: true }).fill(token);
        currentPrefix = nextPath ? `/${nextPath}` : '';
        const nextEntry = `${url}${currentPrefix}/`;
        await page.getByRole('button', { name: '确认', exact: true }).click();
        await expect(page).toHaveURL(nextEntry);
        await expect(page.getByRole('button', { name: '登录', exact: true })).toBeVisible();
        await page.getByLabel('服务凭据', { exact: true }).fill(token);
        await page.getByRole('button', { name: '登录', exact: true }).click();
        await expect(page.locator('.shell')).toBeVisible();
        await expect(page.locator('.connection-status')).toContainText('已连接');
        const nextCookie = (await context.cookies(nextEntry)).find(
          (cookie) => cookie.name.startsWith('cc_web_') && cookie.path === `${currentPrefix}/`,
        )!;
        expect(nextCookie).toMatchObject({ secure: true, httpOnly: true, sameSite: 'Strict' });
        expect(nextCookie.name).not.toBe(currentCookie.name);
        expect(await (await context.request.get(`${nextEntry}api/session`)).json()).toMatchObject({
          authenticated: true,
        });
        currentCookie = nextCookie;
        await page.reload();
        await expect(page.locator('.shell')).toBeVisible();
      }
      await page.getByRole('button', { name: '设置与账号', exact: true }).click();
      await page.getByRole('menuitem', { name: '退出登录', exact: true }).click();
      await expect(page.getByRole('button', { name: '登录', exact: true })).toBeVisible();
      expect(
        (await context.cookies(`${url}/`)).some((cookie) => cookie.name === currentCookie.name),
      ).toBe(false);
      expect(await (await context.request.get(`${url}/api/session`)).json()).toMatchObject({
        authenticated: false,
      });
      await page.getByLabel('服务凭据', { exact: true }).fill(token);
      await page.getByRole('button', { name: '登录', exact: true }).click();
      await expect(page.locator('.shell')).toBeVisible();
      await command({ type: 'web.settings.update', values: { enabled: false } });
      await expect(page.locator('.shell')).toHaveCount(0);
      expect((await context.request.get(entry)).status()).toBe(404);
      expect((await context.request.get(`${entry}api/session`)).status()).toBe(404);
      const read = await command({ type: 'web.settings.get' });
      expect(
        messages.find(
          (message) => message.type === 'web.settings.state' && message.requestId === read,
        ),
      ).toMatchObject({ values: { enabled: false } });
      expect(errors).toEqual([]);
    } finally {
      await context.close();
      desktop?.terminate();
      await service.close();
      // Only remove the temporary directory created by this test, never a configured deployment directory.
      expect(dirname(dataDir)).toBe(resolve(tmpdir()));
      expect(basename(dataDir)).toMatch(/^cc-web-live-/);
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
