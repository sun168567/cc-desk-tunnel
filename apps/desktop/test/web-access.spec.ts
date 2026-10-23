import { expect, test } from '@playwright/test';
import type { Page, WebSocketRoute } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import type { Session } from '@cc-desk-tunnel/protocol';
import { login, screenshots } from './helpers.ts';

const webScreenshots = resolve(screenshots, 'web');
mkdirSync(webScreenshots, { recursive: true });

async function browserFixture(
  page: Page,
  authenticated = false,
  withHistory = false,
  configuredOrigin = true,
  entryOrigin = '',
) {
  let loggedIn = authenticated;
  let offline = false;
  const commands: Record<string, unknown>[] = [];
  const sockets: WebSocketRoute[] = [];
  const sessionId = randomUUID();
  const serverDeviceId = randomUUID();
  const now = new Date().toISOString();
  const sessions: Session[] = withHistory
    ? [
        {
          id: randomUUID(),
          title: '阅读测试',
          autoTitle: false,
          projectPath: '/work/reading',
          permissionMode: 'auto',
          model: null,
          effort: null,
          createdAt: now,
          updatedAt: now,
          activeRun: null,
          device: { id: serverDeviceId, name: '服务端', platform: 'linux' },
        },
      ]
    : [];
  const values = {
    enabled: true,
    domain: '',
    publicOrigin: configuredOrigin ? 'https://work.example.com' : '',
    path: 'web-fixture',
    idleMinutes: 120,
    proxyEnabled: false,
    trustedProxies: [],
    totpEnabled: true,
    passkeyAvailable: false,
    passkeys: [],
    sessions: [
      {
        id: sessionId,
        name: '本次测试',
        createdAt: now,
        lastActiveAt: now,
        expiresAt: new Date(Date.now() + 7200000).toISOString(),
      },
    ],
    url: configuredOrigin ? 'https://work.example.com/web-fixture/' : undefined,
  };
  await page.route('**/web-fixture/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.slice('/web-fixture/'.length);
    if (path.startsWith('api/')) {
      if (offline) return route.abort();
      if (path === 'api/login') {
        const body = route.request().postDataJSON();
        if (body.password !== 'test-password' || body.code !== '123456')
          return route.fulfill({ status: 401, json: { error: '凭据或动态码不正确。' } });
        loggedIn = true;
      }
      if (path === 'api/logout') loggedIn = false;
      return route.fulfill({
        json: {
          authenticated: loggedIn,
          totpEnabled: true,
          passkeyAvailable: false,
          ...(loggedIn ? { session: values.sessions[0] } : {}),
        },
      });
    }
    return route.fulfill({ path: resolve('apps/desktop/dist', path || 'index.html') });
  });
  await page.routeWebSocket('**/web-fixture/api/ws', (socket) => {
    sockets.push(socket);
    socket.onMessage((raw) => {
      const command = JSON.parse(String(raw));
      commands.push(command);
      if (command.type === 'web.auth') {
        socket.send(
          JSON.stringify({
            type: 'ready',
            protocolVersion: PROTOCOL_VERSION,
            version: '0.3.4',
            connectionId: randomUUID(),
            adapter: 'claude-code',
            sessions,
            browser: { sessionId, serverDeviceId },
          }),
        );
        socket.send(
          JSON.stringify({
            type: 'devices',
            devices: [{ id: serverDeviceId, name: '服务端', ready: true, platform: 'linux' }],
          }),
        );
      } else if (command.requestId) {
        if (command.type === 'session.subscribe' || command.type === 'session.history')
          socket.send(
            JSON.stringify({
              type: 'session.snapshot',
              requestId: command.requestId,
              session: sessions[0],
              mode: command.type === 'session.history' ? 'prepend' : 'replace',
              firstSequence: 2,
              lastSequence: 2,
              hasEarlier: true,
              events:
                command.type === 'session.history'
                  ? []
                  : [
                      {
                        sessionId: sessions[0].id,
                        runId: randomUUID(),
                        sequence: 2,
                        createdAt: now,
                        payload: {
                          type: 'message.user',
                          messageId: randomUUID(),
                          text: '阅读记录\n'.repeat(120),
                          scenario: 'chat',
                        },
                      },
                    ],
            }),
          );
        if (command.type === 'web.settings.update') {
          Object.assign(values, command.values);
          values.url = configuredOrigin
            ? `${new URL(page.url()).origin}/${values.path ? `${values.path}/` : ''}`
            : undefined;
        }
        if (command.type === 'web.sessions.revoke')
          values.sessions = values.sessions.filter((session) => session.id !== command.sessionId);
        if (
          command.type === 'web.settings.get' ||
          command.type === 'web.settings.update' ||
          command.type === 'web.sessions.revoke'
        )
          socket.send(
            JSON.stringify({ type: 'web.settings.state', requestId: command.requestId, values }),
          );
        socket.send(JSON.stringify({ type: 'response', requestId: command.requestId, ok: true }));
      }
    });
  });
  await page.goto(`${entryOrigin}/web-fixture/`);
  return {
    commands,
    sockets,
    values,
    expire: () => {
      loggedIn = false;
    },
    network: (enabled: boolean) => {
      offline = !enabled;
    },
  };
}

test('production browser logs in with TOTP, sends no desktop identity, and exposes only browser capabilities', async ({
  page,
}) => {
  const fixture = await browserFixture(page);
  expect(await page.evaluate(() => window.isSecureContext)).toBe(true);
  await expect(page.locator('.web-context-warning')).toHaveCount(0);
  await page.getByLabel('服务凭据', { exact: true }).fill('test-password');
  await page.getByLabel('验证器动态码', { exact: true }).fill('000000');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('凭据或动态码不正确');
  await page.getByLabel('验证器动态码', { exact: true }).fill('123456');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('.shell')).toBeVisible();
  await expect(page.locator('.web-context-warning')).toHaveCount(0);
  await expect(page.locator('.shell')).not.toHaveClass(/web-insecure-context/);
  await expect(page.getByRole('button', { name: '定时任务', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '添加项目', exact: true })).toHaveCount(0);
  await page.locator('.sidebar').getByRole('button', { name: '新建会话', exact: true }).click();
  await expect
    .poll(() => fixture.commands.some((value) => value.type === 'server.session.create'))
    .toBe(true);
  expect(
    fixture.commands.some((value) =>
      ['auth', 'device', 'session.create'].includes(String(value.type)),
    ),
  ).toBe(false);
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('test-password');
  await page.getByRole('button', { name: '设置与账号', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: /^账号/ })).toHaveCount(0);
  await page.getByRole('menuitem', { name: '设置', exact: true }).click();
  await expect(page.getByRole('switch', { name: '启用 Web 访问' })).toHaveCount(0);
  await expect(page.getByText('已登录浏览器')).toBeVisible();
  await page.getByText('已登录浏览器').click();
  await expect(page.getByText('本次测试（当前浏览器）')).toBeVisible();
  await page
    .locator('.setting-row')
    .filter({ hasText: '访问设置' })
    .getByRole('button', { name: '设置', exact: true })
    .click();
  await expect(page.getByLabel('服务端访问路径', { exact: false })).toBeVisible();
  await expect(page.getByLabel('Web 对外地址', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('登录空闲有效期（分钟）')).toHaveCount(0);
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.screenshot({
    path: resolve(webScreenshots, 'browser-settings-desktop.png'),
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: resolve(webScreenshots, 'browser-settings-mobile.png'),
  });
});

test('browser revocation uses its connection session and only proves another browser logout', async ({
  page,
}) => {
  const fixture = await browserFixture(page, true);
  const own = fixture.values.sessions[0];
  const other = { ...own, id: randomUUID(), name: '另一浏览器' };
  fixture.values.sessions.push(other);
  await expect(page.locator('.shell')).toBeVisible();
  await page.getByRole('button', { name: '设置与账号', exact: true }).click();
  await page.getByRole('menuitem', { name: '设置', exact: true }).click();
  await page.locator('.web-sessions > summary').filter({ hasText: '已登录浏览器' }).click();
  await expect(page.getByText('本次测试（当前浏览器）', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '退出 本次测试', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('退出当前浏览器的登录？');
  await expect(dialog.getByLabel('服务凭据', { exact: true })).toHaveCount(0);
  await expect(dialog.getByLabel('当前验证器动态码', { exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '退出 另一浏览器', exact: true }).click();
  await dialog.getByLabel('服务凭据', { exact: true }).fill('test-password');
  await dialog.getByLabel('当前验证器动态码', { exact: true }).fill('123456');
  await dialog.getByRole('button', { name: '确认', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(fixture.commands.filter((command) => command.type === 'web.sessions.revoke')).toEqual([
    expect.objectContaining({
      sessionId: other.id,
      proof: { password: 'test-password', code: '123456' },
    }),
  ]);
  await page.getByRole('button', { name: '退出 本次测试', exact: true }).click();
  await dialog.getByRole('button', { name: '确认', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const request = fixture.commands
    .filter((command) => command.type === 'web.sessions.revoke')
    .at(-1);
  expect(request?.sessionId).toBe(own.id);
  expect(request).not.toHaveProperty('proof');
});

for (const secure of [true, false])
  test(`browser warning follows the actual security context on login and workbench (secure ${secure})`, async ({
    page,
  }) => {
    const origin = `${secure ? 'https' : 'http'}://web.example.test`;
    await browserFixture(page, false, false, true, origin);
    expect(await page.evaluate(() => window.isSecureContext)).toBe(secure);
    const warning = page.locator('.web-context-warning');
    const label = secure ? 'secure' : 'insecure';
    async function checkWarning() {
      if (secure) await expect(warning).toHaveCount(0);
      else await expect(warning).toHaveText('当前页面未处于安全上下文，通行密钥等功能可能受限。');
      await expect(page.getByText(/服务端直连使用自签名证书/)).toHaveCount(0);
    }
    async function capture(stage: string) {
      for (const [device, viewport] of [
        ['desktop', { width: 1280, height: 900 }],
        ['mobile', { width: 390, height: 844 }],
      ] as const) {
        await page.setViewportSize(viewport);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
        await page.screenshot({
          path: resolve(webScreenshots, `security-context-${label}-${stage}-${device}.png`),
        });
      }
    }
    await expect(page.getByLabel('服务凭据', { exact: true })).toBeVisible();
    await checkWarning();
    await capture('login');
    await page.getByLabel('服务凭据', { exact: true }).fill('test-password');
    await page.getByLabel('验证器动态码', { exact: true }).fill('123456');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.locator('.shell')).toBeVisible();
    if (secure) await expect(page.locator('.shell')).not.toHaveClass(/web-insecure-context/);
    else await expect(page.locator('.shell')).toHaveClass(/web-insecure-context/);
    await checkWarning();
    await capture('workbench');
  });

test('browser retries an offline connection but returns to login after an expired cookie on reconnect', async ({
  page,
}) => {
  const fixture = await browserFixture(page, true);
  await expect(page.locator('.shell')).toBeVisible();
  fixture.network(false);
  fixture.sockets.at(-1)!.close({ code: 1011, reason: 'network' });
  await expect(
    page.getByText('与服务端的连接断开了，正在重新连接。', { exact: false }),
  ).toBeVisible();
  await expect
    .poll(() => fixture.commands.filter((value) => value.type === 'web.auth').length)
    .toBe(1);
  await expect(page.locator('.shell')).toBeVisible();
  fixture.expire();
  fixture.network(true);
  await expect(page.getByRole('button', { name: '登录', exact: true })).toBeVisible();
  await expect(page.getByLabel('验证器动态码', { exact: true })).toBeVisible();
  await expect(page.locator('.shell')).toHaveCount(0);
});

test('mainline themes and browser access settings coexist and retain the chosen theme after reload', async ({
  page,
}) => {
  await browserFixture(page, true);
  async function openSettings() {
    await expect(page.locator('.shell')).toBeVisible();
    await page.getByRole('button', { name: '设置与账号', exact: true }).click();
    await page.getByRole('menuitem', { name: '设置', exact: true }).click();
    await expect(page.getByRole('radiogroup', { name: '主题', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: '浏览器访问', exact: true })).toBeVisible();
  }
  await openSettings();
  await page.getByRole('radio', { name: '浅色', exact: true }).click();
  await expect(page.locator('.web-access-settings')).toHaveCSS(
    'background-color',
    'rgb(255, 255, 255)',
  );
  await page.getByRole('radio', { name: '深色', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('.web-access-settings')).toHaveCSS(
    'background-color',
    'rgb(30, 31, 35)',
  );
  await expect(page.locator('.web-context-warning')).toHaveCount(0);
  await page
    .locator('.setting-row')
    .filter({ hasText: '访问设置' })
    .getByRole('button', { name: '设置', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toHaveCSS('background-color', 'rgb(38, 40, 45)');
  await expect(page.getByLabel('服务端访问路径', { exact: false })).toHaveValue('web-fixture');
  await page.screenshot({ path: resolve(webScreenshots, 'browser-settings-dark-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: resolve(webScreenshots, 'browser-settings-dark-mobile.png') });
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.reload();
  await openSettings();
  await expect(page.getByRole('radio', { name: '深色', exact: true })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(page.locator('.web-access-settings')).toHaveCSS(
    'background-color',
    'rgb(30, 31, 35)',
  );
  await page.getByRole('radio', { name: '跟随系统', exact: true }).click();
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('.web-access-settings')).toHaveCSS(
    'background-color',
    'rgb(255, 255, 255)',
  );
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('.web-access-settings')).toHaveCSS(
    'background-color',
    'rgb(30, 31, 35)',
  );
});

// Mount the same settings component with an isolated request fixture; no production switch or second UI.
async function settingsFixture(
  page: Page,
  enabled = true,
  custom = true,
  browser = false,
  totp = false,
  passkeys = false,
  publicOrigin = 'https://web.example.com',
) {
  await page.route('**/__settings-fixture', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<html><head><script type="module">
      import RefreshRuntime from '/@react-refresh';
      RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$ = () => {};
      window.$RefreshSig$ = () => (type) => type;
      window.__vite_plugin_react_preamble_installed__ = true;
    </script><link rel="stylesheet" href="/src/style.css"></head><body></body></html>`,
    }),
  );
  await page.goto('/__settings-fixture');
  await page.waitForFunction(() => '__vite_plugin_react_preamble_installed__' in window);
  await page.evaluate(
    async ({ enabled, custom, browser, totp, passkeys, publicOrigin }) => {
      const reactPath = '/node_modules/.vite/deps/react.js';
      const domPath = '/node_modules/.vite/deps/react-dom_client.js';
      const componentPath = '/src/WebAccessSettings.tsx';
      const clientPath = '/src/client.ts';
      const React = (await import(reactPath)).default;
      const { createRoot } = (await import(domPath)).default;
      const { default: Settings } = await import(componentPath);
      const { ProxyClient } = await import(clientPath);
      const client = new ProxyClient();
      client.update({ status: 'connected', connectionId: crypto.randomUUID() });
      let settings = {
        enabled,
        domain: 'web.example.com',
        publicOrigin,
        path: 'entry',
        idleMinutes: 120,
        proxyEnabled: false,
        trustedProxies: [],
        totpEnabled: totp,
        passkeyAvailable: passkeys && enabled,
        passkeys: passkeys
          ? [
              {
                id: crypto.randomUUID(),
                name: '日常使用',
                rpId: 'web.example.com',
                available: true,
                createdAt: new Date().toISOString(),
              },
            ]
          : [],
        sessions: [],
        url: publicOrigin ? `${publicOrigin}/entry/` : undefined,
      };
      let certificate = { mode: custom ? 'custom' : 'default', selfSigned: !custom };
      const calls: Record<string, unknown>[] = [];
      let failReset = false;
      let failGet = false;
      let failSetup = false;
      let setupCount = 0;
      let registrationStatus = 'pending';
      const registrationId = crypto.randomUUID();
      const opened: string[] = [];
      if (passkeys && !browser)
        Object.defineProperty(window, 'desktop', {
          configurable: true,
          value: { openWeb: async (url: string) => opened.push(url) },
        });
      let setupReady: Promise<void> = Promise.resolve();
      let releaseSetup = () => {};
      client.fetch = async (command: Record<string, unknown>) => {
        calls.push(command);
        if (command.type === 'web.settings.get' && failGet) {
          failGet = false;
          throw new Error('读取失败，请重试。');
        }
        if (command.type === 'web.certificate.get') return certificate;
        if (command.type === 'web.certificate.reset') {
          if (failReset) {
            failReset = false;
            throw new Error('保存失败，请重试。');
          }
          return (certificate = { mode: 'default', selfSigned: true });
        }
        if (command.type === 'web.certificate.set')
          return (certificate = { mode: 'custom', selfSigned: false });
        if (command.type === 'web.settings.update') {
          settings = { ...settings, ...(command.values as object) };
          if (Object.hasOwn(command.values as object, 'publicOrigin'))
            settings.domain = settings.publicOrigin ? new URL(settings.publicOrigin).hostname : '';
          settings.url = settings.publicOrigin
            ? `${settings.publicOrigin}/${settings.path ? `${settings.path}/` : ''}`
            : undefined;
        }
        if (command.type === 'web.totp.setup') {
          await setupReady;
          if (failSetup) {
            failSetup = false;
            throw new Error('生成失败，请重试。');
          }
          const secret =
            ++setupCount === 1
              ? 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'
              : 'KRUGS4ZANFZSAYJAKRUGS4ZANFZSAYJA';
          return {
            secret,
            uri: `otpauth://totp/CC%20Desk%20Tunnel:test?secret=${secret}&issuer=CC%20Desk%20Tunnel`,
            expiresAt: new Date(Date.now() + 600000).toISOString(),
          };
        }
        if (command.type === 'web.totp.enable') settings = { ...settings, totpEnabled: true };
        if (command.type === 'web.passkeys.rename')
          settings.passkeys = settings.passkeys.map((key) =>
            key.id === command.passkeyId ? { ...key, name: String(command.name) } : key,
          );
        if (command.type === 'web.passkeys.remove')
          settings.passkeys = settings.passkeys.filter((key) => key.id !== command.passkeyId);
        if (command.type === 'web.passkeys.start' || command.type === 'web.passkeys.status')
          return {
            registrationId,
            status: registrationStatus,
            url: 'https://web.example.com/entry/#passkey-register=one-time-grant',
            expiresAt: new Date(Date.now() + 600000).toISOString(),
          };
        return { values: settings };
      };
      const root = document.createElement('div');
      root.className = 'page-body';
      document.body.replaceChildren(root);
      createRoot(root).render(
        React.createElement(
          React.StrictMode,
          null,
          React.createElement(Settings, {
            client,
            browser,
            connectionUrl: 'wss://192.0.2.42:8787/ws',
          }),
        ),
      );
      Object.assign(window, {
        settingsFixture: {
          calls,
          opened,
          completeRegistration: () => {
            registrationStatus = 'complete';
            settings.passkeys.push({
              id: crypto.randomUUID(),
              name: '备用密钥',
              rpId: 'web.example.com',
              available: true,
              createdAt: new Date().toISOString(),
            });
          },
          expireRegistration: () => {
            registrationStatus = 'expired';
          },
          disconnect: () => client.update({ status: 'disconnected', connectionId: null }),
          reconnect: () =>
            client.update({ status: 'connected', connectionId: crypto.randomUUID() }),
          failReset: () => {
            failReset = true;
          },
          failGet: () => {
            failGet = true;
          },
          failSetup: () => {
            failSetup = true;
          },
          holdSetup: () => {
            setupReady = new Promise<void>((resolve) => {
              releaseSetup = resolve;
            });
          },
          releaseSetup: () => releaseSetup(),
        },
      });
    },
    { enabled, custom, browser, totp, passkeys, publicOrigin },
  );
  if (browser)
    await expect(
      page.locator('.web-sessions > summary').filter({ hasText: '已登录浏览器' }),
    ).toHaveText('已登录浏览器 0');
  else await expect(page.getByRole('switch', { name: '启用 Web 访问' })).toBeVisible();
}

test('disabled Web keeps only custom-certificate recovery, confirms reset, and retries a failed reset', async ({
  page,
}) => {
  await settingsFixture(page, false, true);
  await expect(page.getByRole('button', { name: '导入证书' })).toHaveCount(0);
  await expect(page.getByText('服务端直连证书', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '恢复默认证书' }).click();
  await expect(page.getByRole('dialog')).toContainText('直连');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByRole('button', { name: '恢复默认证书' })).toBeVisible();
  await page.evaluate(() =>
    (
      window as unknown as { settingsFixture: { failReset: () => void } }
    ).settingsFixture.failReset(),
  );
  await page.getByRole('button', { name: '恢复默认证书' }).click();
  await page.getByRole('button', { name: '确认', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('保存失败');
  await page.getByRole('button', { name: '确认', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '恢复默认证书' })).toHaveCount(0);
  await page.getByRole('switch', { name: '启用 Web 访问' }).click();
  await expect(page.getByText('默认自签名证书', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '导入证书' })).toBeVisible();
});

test('certificate binding explains hostname protection without blocking port edits, and disconnect clears secrets', async ({
  page,
}) => {
  await settingsFixture(page);
  await page
    .locator('.setting-row')
    .filter({ hasText: '访问设置' })
    .getByRole('button', { name: '设置', exact: true })
    .click();
  await expect(page.getByLabel('Web 对外地址', { exact: true })).toBeEnabled();
  await expect(page.getByRole('dialog')).toContainText('端口可修改');
  await expect(page.getByRole('dialog')).toContainText('请先恢复默认证书');
  await page.getByLabel('Web 对外地址', { exact: true }).fill('web.example.com:1443');
  await page.getByRole('button', { name: '确认', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.web-access-address')).toHaveAttribute(
    'title',
    'https://web.example.com:1443/entry/',
  );
  await page.getByRole('button', { name: '导入证书' }).click();
  await page.getByRole('textbox', { name: '私钥 PEM' }).fill('TEST PRIVATE KEY');
  await page.evaluate(() =>
    (
      window as unknown as { settingsFixture: { disconnect: () => void } }
    ).settingsFixture.disconnect(),
  );
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.evaluate(() =>
    (
      window as unknown as { settingsFixture: { reconnect: () => void } }
    ).settingsFixture.reconnect(),
  );
  await page.getByRole('button', { name: '导入证书' }).click();
  await expect(page.getByRole('textbox', { name: '私钥 PEM' })).toHaveValue('');
  await page.getByLabel('选择私钥文件').setInputFiles({
    name: 'oversize.key',
    mimeType: 'text/plain',
    buffer: Buffer.alloc(16385, 'a'),
  });
  await expect(page.getByRole('alert')).toContainText('16 KB');
});

for (const browser of [false, true])
  test(`TOTP setup copies the full secret, verifies the new code, and clears secrets (browser ${browser})`, async ({
    page,
  }) => {
    await settingsFixture(page, true, false, browser);
    await page
      .locator('.setting-row')
      .filter({ hasText: '两步验证' })
      .getByRole('button', { name: '设置', exact: true })
      .click();
    if (browser) {
      await expect(page.getByRole('img', { name: '验证器二维码' })).toHaveCount(0);
      await page.getByLabel('服务凭据', { exact: true }).fill('test-password');
      await page.getByRole('button', { name: '下一步', exact: true }).click();
    } else {
      await expect(page.getByLabel('服务凭据', { exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: '下一步', exact: true })).toHaveCount(0);
    }
    await expect(page.getByRole('img', { name: '验证器二维码' })).toBeVisible();
    await expect(page.locator('.web-totp-secret')).toContainText('JBSWY3DPEHPK3PXP');
    await page.evaluate((browser) => {
      const clipboard = { fail: true, values: [] as string[], browserCalls: 0, desktopCalls: 0 };
      const write = async (text: string) => {
        if (clipboard.fail) throw new Error('Clipboard denied');
        clipboard.values.push(text);
      };
      Object.assign(window, { totpClipboard: clipboard });
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async (text: string) => {
            clipboard.browserCalls++;
            if (!browser) throw new Error('Use desktop bridge');
            await write(text);
          },
        },
      });
      if (!browser)
        Object.defineProperty(window, 'desktop', {
          configurable: true,
          value: {
            copyText: async (text: string) => {
              clipboard.desktopCalls++;
              await write(text);
            },
          },
        });
    }, browser);
    await page.getByLabel('验证新动态码').fill('123456');
    await page.getByRole('button', { name: '复制密钥', exact: true }).click();
    await expect(page.getByRole('button', { name: '复制失败，请重试', exact: true })).toBeVisible();
    await page.evaluate(() => {
      (window as unknown as { totpClipboard: { fail: boolean } }).totpClipboard.fail = false;
    });
    await page.getByRole('button', { name: '复制失败，请重试', exact: true }).press('Enter');
    await expect(page.getByRole('button', { name: '已复制', exact: true })).toBeVisible();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByLabel('验证新动态码')).toHaveValue('123456');
    const copied = await page.evaluate(
      () =>
        (
          window as unknown as {
            totpClipboard: {
              values: string[];
              browserCalls: number;
              desktopCalls: number;
            };
          }
        ).totpClipboard,
    );
    expect(copied.values).toEqual(['JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP']);
    expect(copied.browserCalls).toBe(browser ? 2 : 0);
    expect(copied.desktopCalls).toBe(browser ? 0 : 2);
    expect(
      await page.evaluate(
        () =>
          (
            window as unknown as { settingsFixture: { calls: { type: string }[] } }
          ).settingsFixture.calls.filter((call) => call.type === 'web.totp.enable').length,
      ),
    ).toBe(0);
    await page.getByLabel('验证新动态码').fill('');
    await page.getByRole('button', { name: '确认', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.screenshot({ path: resolve(webScreenshots, `totp-setup-browser-${browser}.png`) });
    if (browser) {
      await page.setViewportSize({ width: 390, height: 844 });
      await expect
        .poll(() =>
          page.evaluate(() => {
            const dialog = document.querySelector('dialog')!;
            return dialog.scrollWidth <= dialog.clientWidth;
          }),
        )
        .toBe(true);
      await page.screenshot({ path: resolve(webScreenshots, 'totp-copy-mobile.png') });
    }
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await expect(page.locator('.web-totp-secret')).toHaveCount(0);
    await page
      .locator('.setting-row')
      .filter({ hasText: '两步验证' })
      .getByRole('button', { name: '设置', exact: true })
      .click();
    if (browser) {
      await expect(page.getByLabel('服务凭据', { exact: true })).toHaveValue('');
      await page.getByLabel('服务凭据', { exact: true }).fill('test-password');
      await page.getByRole('button', { name: '下一步', exact: true }).click();
    } else {
      await expect(page.getByLabel('服务凭据', { exact: true })).toHaveCount(0);
    }
    await expect(page.getByLabel('验证新动态码')).toHaveValue('');
    await expect(page.getByRole('button', { name: '复制密钥', exact: true })).toBeVisible();
    await page.getByLabel('验证新动态码').fill('123456');
    await page.getByRole('button', { name: '确认', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(
      page
        .locator('.setting-row')
        .filter({ hasText: '两步验证' })
        .getByRole('button', { name: '关闭', exact: true }),
    ).toBeVisible();
    const calls = await page.evaluate(() =>
      (
        window as unknown as { settingsFixture: { calls: Record<string, unknown>[] } }
      ).settingsFixture.calls.filter((call) => String(call.type).startsWith('web.totp.')),
    );
    expect(calls.map((call) => call.type)).toEqual([
      'web.totp.setup',
      'web.totp.setup',
      'web.totp.enable',
    ]);
    // The browser proves itself to see a secret; the new code alone then turns it on.
    for (const call of calls) {
      if (browser && call.type === 'web.totp.setup')
        expect(call.proof).toEqual({ password: 'test-password' });
      else expect(call).not.toHaveProperty('proof');
    }
  });

test('desktop TOTP setup retries errors and discards a pending result on disconnect', async ({
  page,
}) => {
  await settingsFixture(page, true, false);
  await page.evaluate(() =>
    (
      window as unknown as { settingsFixture: { failSetup: () => void } }
    ).settingsFixture.failSetup(),
  );
  const open = () =>
    page
      .locator('.setting-row')
      .filter({ hasText: '两步验证' })
      .getByRole('button', { name: '设置', exact: true })
      .click();
  await open();
  await expect(page.getByRole('alert')).toContainText('生成失败');
  await expect(page.getByLabel('服务凭据', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect(page.getByRole('img', { name: '验证器二维码' })).toBeVisible();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.evaluate(() =>
    (
      window as unknown as { settingsFixture: { holdSetup: () => void } }
    ).settingsFixture.holdSetup(),
  );
  await open();
  await expect(page.getByRole('status')).toHaveText('正在生成验证器密钥…');
  await expect(page.getByRole('button', { name: '正在准备…', exact: true })).toBeDisabled();
  await page.evaluate(() => {
    const fixture = (
      window as unknown as {
        settingsFixture: {
          disconnect: () => void;
          releaseSetup: () => void;
        };
      }
    ).settingsFixture;
    fixture.disconnect();
    fixture.releaseSetup();
  });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.web-totp-secret')).toHaveCount(0);
  await page.evaluate(() =>
    (
      window as unknown as { settingsFixture: { reconnect: () => void } }
    ).settingsFixture.reconnect(),
  );
  await open();
  await expect(page.getByRole('img', { name: '验证器二维码' })).toBeVisible();
  await expect(page.getByLabel('验证新动态码')).toHaveValue('');
  const calls = await page.evaluate(
    () =>
      (
        window as unknown as { settingsFixture: { calls: { type: string }[] } }
      ).settingsFixture.calls.filter((call) => call.type === 'web.totp.setup').length,
  );
  expect(calls).toBe(4);
});

for (const configuredOrigin of [false, true])
  test(`browser path changes submit only the path and navigate after the reply (public origin ${configuredOrigin})`, async ({
    page,
  }) => {
    const fixture = await browserFixture(page, true, false, configuredOrigin);
    await expect(page.locator('.shell')).toBeVisible();
    await page.getByRole('button', { name: '设置与账号', exact: true }).click();
    await page.getByRole('menuitem', { name: '设置', exact: true }).click();
    await page
      .locator('.setting-row')
      .filter({ hasText: '访问设置' })
      .getByRole('button', { name: '设置', exact: true })
      .click();
    await page.getByLabel('服务端访问路径', { exact: false }).fill('changed-entry');
    await page.getByLabel('服务凭据', { exact: true }).fill('test-password');
    await page.getByLabel('当前验证器动态码').fill('123456');
    await page.route('**/changed-entry/', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<h1>新入口</h1>' }),
    );
    await page.getByRole('button', { name: '确认', exact: true }).click();
    await expect(page).toHaveURL(/\/changed-entry\/$/);
    expect(
      fixture.commands.find((command) => command.type === 'web.settings.update')?.values,
    ).toEqual({ path: 'changed-entry' });
    expect(
      fixture.commands.filter((command) => command.type === 'web.settings.update'),
    ).toHaveLength(1);
  });

for (const totp of [false, true])
  test(`desktop access settings save without credentials or dynamic codes (TOTP ${totp})`, async ({
    page,
  }) => {
    await settingsFixture(page, true, false, false, totp);
    await page
      .locator('.setting-row')
      .filter({ hasText: '访问设置' })
      .getByRole('button', { name: '设置', exact: true })
      .click();
    await expect(page.getByLabel('服务凭据', { exact: true })).toHaveCount(0);
    await expect(page.getByLabel('当前验证器动态码')).toHaveCount(0);
    await page.getByLabel('服务端访问路径', { exact: false }).fill('desktop-entry');
    await page.getByLabel('登录空闲有效期（分钟）').fill('60');
    await page.screenshot({ path: resolve(webScreenshots, `access-desktop-totp-${totp}.png`) });
    await page.getByRole('button', { name: '确认', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const sent = await page.evaluate(() =>
      (
        window as unknown as { settingsFixture: { calls: Record<string, unknown>[] } }
      ).settingsFixture.calls.find((call) => call.type === 'web.settings.update'),
    );
    expect(sent).not.toHaveProperty('proof');
    expect(sent?.values).toMatchObject({ path: 'desktop-entry', idleMinutes: 60 });
  });

test('reverse proxy help stays folded, copies verified TLS configuration, and never saves helper fields', async ({
  page,
}) => {
  await settingsFixture(page, true, false);
  await page
    .locator('.setting-row')
    .filter({ hasText: '访问设置' })
    .getByRole('button', { name: '设置', exact: true })
    .click();
  await expect(page.locator('.web-proxy-help')).not.toHaveAttribute('open', '');
  await expect(page.getByRole('button', { name: '自动检测', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('可信反向代理 IP', { exact: false })).toHaveCount(0);
  await page.getByRole('switch', { name: '识别真实访客 IP' }).click();
  await expect(page.getByRole('button', { name: '自动检测', exact: true })).toBeVisible();
  await expect(page.getByLabel('可信反向代理 IP', { exact: false })).toBeVisible();
  await expect(page.locator('.web-proxy-help')).not.toHaveAttribute('open', '');
  await page.getByText('反向代理配置示例', { exact: true }).click();
  await expect(page.getByLabel('上游地址', { exact: false })).toHaveValue(
    'https://192.0.2.42:8787',
  );
  await expect(page.getByLabel('上游证书校验名', { exact: false })).toHaveValue(
    'cc-desk-tunnel.local',
  );
  await expect(page.getByLabel('反代配置', { exact: true })).toContainText('proxy_ssl_verify on;');
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          Object.assign(window, { copiedProxy: value });
        },
      },
    });
  });
  await page.getByRole('button', { name: '复制反代配置', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('配置已复制');
  expect(
    await page.evaluate(() => (window as unknown as { copiedProxy: string }).copiedProxy),
  ).toContain('proxy_set_header Host $http_host;');
  await page.getByRole('button', { name: 'Caddy', exact: true }).click();
  await expect(page.getByLabel('反代配置', { exact: true })).toContainText('tls_trust_pool file');
  await expect(page.getByRole('status')).toHaveCount(0);
  await page.getByLabel('上游地址', { exact: false }).fill('https://192.0.2.42:8787/invalid');
  await expect(page.getByRole('button', { name: '复制反代配置', exact: true })).toBeDisabled();
  await expect(page.getByLabel('反代配置', { exact: true })).toHaveCount(0);
  await page.getByLabel('上游地址', { exact: false }).fill('https://127.0.0.1:9443');
  await page.screenshot({ path: resolve(webScreenshots, 'proxy-help-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() =>
      page.evaluate(() => {
        const dialog = document.querySelector('dialog')!;
        return dialog.scrollWidth <= dialog.clientWidth;
      }),
    )
    .toBe(true);
  await page.screenshot({ path: resolve(webScreenshots, 'proxy-help-mobile.png') });
  await page.getByLabel('反向代理 IP', { exact: false }).fill('127.0.0.1');
  await expect(page.getByLabel('服务凭据', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '确认', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const sent = await page.evaluate(
    () =>
      (
        window as unknown as { settingsFixture: { calls: { type: string; values: object }[] } }
      ).settingsFixture.calls.find((call) => call.type === 'web.settings.update')?.values,
  );
  expect(sent).toEqual({
    path: 'entry',
    idleMinutes: 120,
    proxyEnabled: true,
    trustedProxies: ['127.0.0.1'],
  });
});

for (const scenario of [
  {
    name: 'non-standard port and custom path',
    input: 'web.example.com:1443',
    origin: 'https://web.example.com:1443',
    path: 'long-entry',
    display: 'https://web.example.com:1443/long-…',
  },
  {
    name: 'standard port and root',
    input: 'WEB.EXAMPLE.COM:443',
    origin: 'https://web.example.com',
    path: '',
    display: 'https://web.example.com/',
  },
  { name: 'empty origin', input: '', origin: '', path: '', display: '' },
])
  test(`Web public origin saves independently of desktop connection: ${scenario.name}`, async ({
    page,
  }) => {
    await settingsFixture(page, true, false);
    await page
      .locator('.setting-row')
      .filter({ hasText: '访问设置' })
      .getByRole('button', { name: '设置', exact: true })
      .click();
    await expect(page.getByLabel('Web 对外地址', { exact: true })).toHaveValue('web.example.com');
    await expect(page.locator('.web-origin-input > span')).toHaveText('https://');
    await expect(page.getByRole('dialog')).toContainText('与桌面连接地址无关');
    await expect(page.getByRole('dialog')).toContainText('修改对外地址或路径后');
    await page.getByLabel('Web 对外地址', { exact: true }).fill(scenario.input);
    await page.getByLabel('服务端访问路径', { exact: false }).fill(scenario.path);
    if (scenario.name === 'non-standard port and custom path') {
      await page.screenshot({ path: resolve(webScreenshots, 'public-origin-desktop.png') });
      await page.setViewportSize({ width: 390, height: 844 });
      expect(
        await page.evaluate(() => {
          const dialog = document.querySelector('dialog')!;
          return dialog.scrollWidth <= dialog.clientWidth;
        }),
      ).toBe(true);
      await page.screenshot({ path: resolve(webScreenshots, 'public-origin-mobile.png') });
    }
    await page.getByRole('button', { name: '确认', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const sent = await page.evaluate(
      () =>
        (
          window as unknown as { settingsFixture: { calls: { type: string; values: object }[] } }
        ).settingsFixture.calls.find((call) => call.type === 'web.settings.update')?.values,
    );
    expect(sent).toMatchObject({ publicOrigin: scenario.origin, path: scenario.path });
    expect(sent).not.toHaveProperty('domain');
    if (scenario.origin) {
      const full = `${scenario.origin}/${scenario.path ? `${scenario.path}/` : ''}`;
      await expect(page.locator('.web-access-address')).toHaveText(scenario.display);
      await expect(page.locator('.web-access-address')).toHaveAttribute('title', full);
      await page.evaluate(() => {
        Object.defineProperty(window, 'desktop', {
          configurable: true,
          value: {
            copyText: async (value: string) => Object.assign(window, { copiedWebAddress: value }),
            openWeb: async (value: string) => Object.assign(window, { openedWebAddress: value }),
          },
        });
      });
      await page.getByRole('button', { name: '复制服务端访问地址', exact: true }).click();
      await page.getByRole('button', { name: '打开服务端访问地址', exact: true }).click();
      expect(await page.evaluate('window.copiedWebAddress')).toBe(full);
      expect(await page.evaluate('window.openedWebAddress')).toBe(full);
    } else {
      await expect(page.locator('.web-access-address')).toHaveCount(0);
      await expect(
        page.getByRole('button', { name: '打开服务端访问地址', exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByText('请在访问设置中填写 Web 对外地址', { exact: true }),
      ).toBeVisible();
    }
  });

test('Web public origin rejects protocols, paths, credentials and invalid ports before saving', async ({
  page,
}) => {
  await settingsFixture(page, true, false);
  await page
    .locator('.setting-row')
    .filter({ hasText: '访问设置' })
    .getByRole('button', { name: '设置', exact: true })
    .click();
  for (const input of [
    'https://web.example.com:1443',
    'web.example.com/path',
    'web.example.com?token=secret',
    'web.example.com#fragment',
    'user:secret@web.example.com',
    'web.example.com:65536',
  ]) {
    await page.getByLabel('Web 对外地址', { exact: true }).fill(input);
    await page.getByRole('button', { name: '确认', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('不要包含协议、路径或参数');
  }
  expect(
    await page.evaluate(
      () =>
        (
          window as unknown as { settingsFixture: { calls: { type: string }[] } }
        ).settingsFixture.calls.filter((call) => call.type === 'web.settings.update').length,
    ),
  ).toBe(0);
});

test('an unrelated setting preserves an existing domain restriction until the public origin is edited', async ({
  page,
}) => {
  await settingsFixture(page, true, true, false, false, false, '');
  await page
    .locator('.setting-row')
    .filter({ hasText: '访问设置' })
    .getByRole('button', { name: '设置', exact: true })
    .click();
  await expect(page.getByLabel('Web 对外地址', { exact: true })).toHaveValue('');
  await expect(page.getByRole('dialog')).toContainText('当前仍限制域名 web.example.com');
  await page.getByLabel('登录空闲有效期（分钟）').fill('60');
  await page.getByRole('button', { name: '确认', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const sent = await page.evaluate(
    () =>
      (
        window as unknown as { settingsFixture: { calls: { type: string; values: object }[] } }
      ).settingsFixture.calls.find((call) => call.type === 'web.settings.update')?.values,
  );
  expect(sent).toMatchObject({ idleMinutes: 60 });
  expect(sent).not.toHaveProperty('publicOrigin');
  expect(sent).not.toHaveProperty('domain');
});

test('reverse proxy HTTP upstream hides TLS inputs and switching back restores required certificate validation', async ({
  page,
}) => {
  await settingsFixture(page, true, false);
  await page
    .locator('.setting-row')
    .filter({ hasText: '访问设置' })
    .getByRole('button', { name: '设置', exact: true })
    .click();
  await page.getByRole('switch', { name: '识别真实访客 IP' }).click();
  await page.getByText('反向代理配置示例', { exact: true }).click();
  await page.getByLabel('上游证书校验名', { exact: false }).fill('');
  await page.getByLabel('受信任 PEM 文件', { exact: false }).fill('');
  await expect(page.getByRole('button', { name: '复制反代配置', exact: true })).toBeDisabled();
  await page.getByLabel('上游地址', { exact: false }).fill('http://127.0.0.1:8787');
  await expect(page.getByLabel('上游证书校验名', { exact: false })).toHaveCount(0);
  await expect(page.getByLabel('受信任 PEM 文件', { exact: false })).toHaveCount(0);
  await expect(page.getByText('如何准备信任文件', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '复制反代配置', exact: true })).toBeEnabled();
  const config = page.getByLabel('反代配置', { exact: true });
  await expect(config).toContainText('location = /ws { proxy_pass http://127.0.0.1:8787; }');
  await expect(config).toContainText(
    'location = /client/installer { proxy_pass http://127.0.0.1:8787; }',
  );
  await expect(config).toContainText('proxy_set_header Host $http_host;');
  await expect(config).not.toContainText('proxy_ssl_');
  await expect(page.locator('.web-proxy-help')).toContainText('公网入口仍使用 HTTPS');
  await page.screenshot({ path: resolve(webScreenshots, 'proxy-http-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() =>
      page.evaluate(() => {
        const dialog = document.querySelector('dialog')!;
        return dialog.scrollWidth <= dialog.clientWidth;
      }),
    )
    .toBe(true);
  await page.screenshot({ path: resolve(webScreenshots, 'proxy-http-mobile.png') });
  await page.getByRole('button', { name: 'Caddy', exact: true }).click();
  await expect(config).toContainText('@web path /entry/* /ws /client/installer');
  await expect(config).toContainText('header_up Host {hostport}');
  await expect(config).not.toContainText('tls_');
  await page.getByLabel('上游地址', { exact: false }).fill('https://127.0.0.1:8787');
  await expect(page.getByLabel('上游证书校验名', { exact: false })).toHaveValue('');
  await expect(page.getByLabel('受信任 PEM 文件', { exact: false })).toHaveValue('');
  await expect(page.getByRole('button', { name: '复制反代配置', exact: true })).toBeDisabled();
  await page.getByLabel('上游证书校验名', { exact: false }).fill('cc-desk-tunnel.local');
  await page
    .getByLabel('受信任 PEM 文件', { exact: false })
    .fill('/etc/cc-desk-tunnel/upstream.pem');
  await expect(config).toContainText('tls_server_name cc-desk-tunnel.local');
  await expect(config).toContainText('tls_trust_pool file /etc/cc-desk-tunnel/upstream.pem');
  await expect(page.getByRole('button', { name: '复制反代配置', exact: true })).toBeEnabled();
});

test('reverse proxy copy uses the desktop clipboard bridge when browser clipboard permission is denied', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await settingsFixture(page, true, false);
  await page
    .locator('.setting-row')
    .filter({ hasText: '访问设置' })
    .getByRole('button', { name: '设置', exact: true })
    .click();
  await page.getByRole('switch', { name: '识别真实访客 IP' }).click();
  await page.getByText('反向代理配置示例', { exact: true }).click();
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async () => {
          throw new DOMException('Permission denied', 'NotAllowedError');
        },
      },
    });
    Object.defineProperty(window, 'desktop', {
      configurable: true,
      value: {
        saveDrafts: async () => {},
        copyText: async (value: string) => {
          Object.assign(window, { desktopCopiedProxy: value });
        },
      },
    });
  });
  await page.getByRole('button', { name: '复制反代配置', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('配置已复制');
  expect(
    await page.evaluate(
      () => (window as unknown as { desktopCopiedProxy: string }).desktopCopiedProxy,
    ),
  ).toContain('proxy_ssl_verify on;');
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  expect(errors).toEqual([]);
});

test('user input in the browser reports activity at most once a minute; pushed updates report none', async ({
  page,
}) => {
  await page.clock.install();
  const fixture = await browserFixture(page, true, true);
  await expect(page.locator('.shell')).toBeVisible();
  const activity = () => fixture.commands.filter((command) => command.type === 'web.activity');
  await page.clock.runFor(5 * 60_000);
  expect(activity()).toHaveLength(0);
  await page.mouse.wheel(0, -200);
  await expect.poll(() => activity().length).toBe(1);
  await page.keyboard.press('ArrowUp');
  await page.mouse.click(400, 300);
  expect(activity()).toHaveLength(1);
  await page.clock.runFor(61_000);
  await page.keyboard.press('ArrowUp');
  await expect.poll(() => activity().length).toBe(2);
});

test('desktop manages Web Passkeys without repeating its existing authentication', async ({
  page,
}) => {
  await settingsFixture(page, true, false, false, true, true);
  await expect(page.getByRole('button', { name: '添加', exact: true })).toBeEnabled();
  await expect(
    page.locator('.web-sessions summary').filter({ hasText: '已登录浏览器' }),
  ).toBeVisible();
  await page.locator('.web-passkeys summary').click();
  await page.getByRole('button', { name: '重命名 日常使用' }).click();
  await expect(page.getByLabel('服务凭据', { exact: true })).toHaveCount(0);
  await page.getByLabel('名称', { exact: true }).fill('旅行备用');
  await page.getByRole('button', { name: '确认', exact: true }).click();
  await page.getByRole('button', { name: '删除 旅行备用' }).click();
  await expect(page.getByRole('dialog')).toContainText('通过它登录的浏览器也将退出');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByRole('button', { name: '删除 旅行备用' })).toBeVisible();
  await page.getByRole('button', { name: '删除 旅行备用' }).click();
  await page.getByRole('button', { name: '确认', exact: true }).click();
  await expect(page.getByText('尚未添加通行密钥')).toBeVisible();
});

test('Web Passkey registration from desktop settings waits for completion and cancellation revokes its grant', async ({
  page,
}) => {
  await settingsFixture(page, true, true, false, false, true);
  await page.getByRole('button', { name: '添加', exact: true }).click();
  await page.getByLabel('名称', { exact: true }).fill('备用密钥');
  await page.getByRole('button', { name: '前往浏览器设置' }).click();
  await expect(page.getByRole('status')).toContainText('等待浏览器');
  expect(
    await page.evaluate(
      () => (window as unknown as { settingsFixture: { opened: string[] } }).settingsFixture.opened,
    ),
  ).toEqual(['https://web.example.com/entry/#passkey-register=one-time-grant']);
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as { settingsFixture: { calls: { type: string }[] } }
          ).settingsFixture.calls.filter((call) => call.type === 'web.passkeys.cancel').length,
      ),
    )
    .toBe(1);
  await page.getByRole('button', { name: '添加', exact: true }).click();
  await page.getByRole('button', { name: '前往浏览器设置' }).click();
  await page.evaluate(() =>
    (
      window as unknown as { settingsFixture: { completeRegistration: () => void } }
    ).settingsFixture.completeRegistration(),
  );
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.locator('.web-passkeys summary').click();
  await expect(page.getByRole('button', { name: '删除 备用密钥' })).toBeVisible();
  await page.screenshot({ path: resolve(webScreenshots, 'passkey-settings-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: resolve(webScreenshots, 'passkey-settings-mobile.png'),
    fullPage: true,
  });
});

test('Web Passkey registration expires without reporting success and disconnect closes its settings dialog', async ({
  page,
}) => {
  await settingsFixture(page, true, true, false, false, true);
  await page.getByRole('button', { name: '添加', exact: true }).click();
  await page.getByRole('button', { name: '前往浏览器设置' }).click();
  await page.evaluate(() =>
    (
      window as unknown as { settingsFixture: { expireRegistration: () => void } }
    ).settingsFixture.expireRegistration(),
  );
  await expect(page.getByRole('status')).toContainText('已过期');
  await expect(page.getByRole('button', { name: '重新设置' })).toBeVisible();
  await page.evaluate(() =>
    (
      window as unknown as { settingsFixture: { disconnect: () => void } }
    ).settingsFixture.disconnect(),
  );
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('连接服务端后管理浏览器访问。')).toBeVisible();
});

test('desktop login uses its service credentials', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByLabel('服务凭据', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '使用通行密钥登录', exact: true })).toHaveCount(0);
  await login(page);
  await expect(page.locator('.connection-status')).toContainText('已连接');
});

test('Web off hides optional settings and Web Passkey management until the entry is enabled', async ({
  page,
}) => {
  await settingsFixture(page, false, false, false, true, true);
  await expect(page.getByRole('heading', { name: '浏览器访问', exact: true })).toBeVisible();
  await expect(page.locator('.web-access-settings .setting-row')).toHaveCount(1);
  await expect(page.getByRole('heading', { name: '通行密钥', exact: true })).toHaveCount(0);
  await expect(page.locator('.web-access-settings .web-sessions')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '添加', exact: true })).toHaveCount(0);
  await page.getByRole('switch', { name: '启用 Web 访问' }).click();
  await expect(page.getByRole('button', { name: '添加', exact: true })).toBeVisible();
  await expect(
    page.locator('.web-access-settings > .web-sessions:not(.web-passkeys) > summary'),
  ).toHaveText('已登录浏览器 0');
  await page.getByRole('switch', { name: '启用 Web 访问' }).click();
  await expect(page.locator('.web-access-settings .web-sessions')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '添加', exact: true })).toHaveCount(0);
});

test('Web Passkeys stay inside browser access with an in-flow action and a nested list on narrow screens', async ({
  page,
}) => {
  await settingsFixture(page, true, false, false, false, true);
  await expect(page.locator('.page-heading')).toHaveText(['浏览器访问']);
  const card = page.locator('.web-access-settings');
  await expect(page.locator('.card')).toHaveCount(1);
  await expect(card.locator('.card')).toHaveCount(0);
  const passkeys = card.locator(':scope > .web-passkeys');
  await expect(passkeys).toHaveCount(1);
  expect(
    await passkeys.evaluate(
      (element) => element.previousElementSibling?.querySelector('strong')?.textContent,
    ),
  ).toBe('添加通行密钥');
  await expect(passkeys.locator('summary')).toContainText('已添加的通行密钥');
  await passkeys.locator('summary').click();
  await page.getByRole('button', { name: '重命名 日常使用' }).click();
  const name = '长期使用的浏览器通行密钥'.repeat(4);
  await page.getByLabel('名称', { exact: true }).fill(name);
  await page.getByRole('button', { name: '确认', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(card.getByRole('button', { name: '添加', exact: true })).toBeVisible();
  const layout = await card.evaluate((element) => {
    const row = element.querySelector('.setting-row:has(+ .web-passkeys)')!;
    const button = row.querySelector('button')!;
    const list = element.querySelector('.web-passkeys ul')!;
    const r = row.getBoundingClientRect();
    const b = button.getBoundingClientRect();
    return {
      position: getComputedStyle(button).position,
      actionInRow: b.top >= r.top && b.bottom <= r.bottom,
      listIndented: list.getBoundingClientRect().left > element.getBoundingClientRect().left,
      overflow: document.documentElement.scrollWidth > innerWidth,
    };
  });
  expect(layout).toEqual({
    position: 'static',
    actionInRow: true,
    listIndented: true,
    overflow: false,
  });
  await expect(page.getByRole('button', { name: `删除 ${name}`, exact: true })).toBeVisible();
  await page.screenshot({
    path: resolve(webScreenshots, 'passkey-settings-mobile.png'),
    fullPage: true,
  });
});
