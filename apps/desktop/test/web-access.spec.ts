import { expect, test } from '@playwright/test';
import type { Page, WebSocketRoute } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import type { Session } from '@cc-desk-tunnel/protocol';
import { screenshots } from './helpers.ts';

const webScreenshots = resolve(screenshots, 'web');
mkdirSync(webScreenshots, { recursive: true });

async function browserFixture(page: Page, authenticated = false, withHistory = false) {
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
    selfSigned: true,
    url: 'https://work.example.com/web-fixture/',
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
          selfSigned: true,
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
            browser: { sessionId, serverDeviceId, selfSigned: true },
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
          values.url = `${new URL(page.url()).origin}/${values.path ? `${values.path}/` : ''}`;
        }
        if (command.type === 'web.settings.get' || command.type === 'web.settings.update')
          socket.send(
            JSON.stringify({ type: 'web.settings.state', requestId: command.requestId, values }),
          );
        socket.send(JSON.stringify({ type: 'response', requestId: command.requestId, ok: true }));
      }
    });
  });
  await page.goto('/web-fixture/');
  return {
    commands,
    sockets,
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
  await expect(page.getByRole('note')).toContainText('自签名证书');
  await page.getByLabel('服务凭据', { exact: true }).fill('test-password');
  await page.getByLabel('验证器动态码', { exact: true }).fill('000000');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('凭据或动态码不正确');
  await page.getByLabel('验证器动态码', { exact: true }).fill('123456');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('.shell')).toBeVisible();
  await expect(page.getByRole('note')).toContainText('正规证书');
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
  await expect(page.getByLabel('访问域名', { exact: false })).toHaveCount(0);
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
  await expect(page.getByRole('note')).toHaveCSS('background-color', 'rgb(42, 44, 49)');
  await expect(page.getByRole('note')).toHaveCSS('color', 'rgb(228, 230, 234)');
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
) {
  await page.goto('/');
  await page.evaluate(
    async ({ enabled, custom, browser, totp }) => {
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
        path: 'entry',
        idleMinutes: 120,
        proxyEnabled: false,
        trustedProxies: [],
        totpEnabled: totp,
        passkeyAvailable: true,
        passkeys: [],
        sessions: [],
        selfSigned: true,
        url: 'https://web.example.com/entry/',
      };
      let certificate = { mode: custom ? 'custom' : 'default', selfSigned: !custom };
      const calls: Record<string, unknown>[] = [];
      let failReset = false;
      let failGet = false;
      let failSetup = false;
      let setupCount = 0;
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
        if (command.type === 'web.settings.update')
          settings = { ...settings, ...(command.values as object) };
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
    { enabled, custom, browser, totp },
  );
  if (browser)
    await expect(page.locator('.web-sessions:not(.web-passkeys) > summary')).toHaveText(
      '已登录浏览器 0',
    );
  else await expect(page.getByRole('switch', { name: '启用 Web 访问' })).toBeVisible();
}

test('desktop Passkey entry opens the browser add link without a desktop registration or credentials', async ({
  page,
}) => {
  await settingsFixture(page);
  await page.evaluate(() => {
    Object.assign(window, {
      openedWebAddress: '',
      desktop: {
        openWeb: async (url: string) => Object.assign(window, { openedWebAddress: url }),
        saveDrafts: async () => {},
      },
    });
  });
  await page.locator('.web-passkeys > summary').click();
  await page.getByRole('button', { name: '添加通行密钥', exact: true }).click();
  const result = await page.evaluate(() => {
    const state = window as unknown as {
      openedWebAddress: string;
      settingsFixture: { calls: { type: string }[] };
    };
    return { url: state.openedWebAddress, calls: state.settingsFixture.calls };
  });
  expect(result.url).toBe('https://web.example.com/entry/#passkeys');
  expect(result.calls.some((command) => command.type.startsWith('web.passkeys.'))).toBe(false);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('disabled Web keeps only custom-certificate recovery, confirms reset, and retries a failed reset', async ({
  page,
}) => {
  await settingsFixture(page, false, true);
  await expect(page.getByRole('button', { name: '导入证书' })).toHaveCount(0);
  await page.getByRole('button', { name: '恢复默认证书' }).click();
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
  await expect(page.getByRole('button', { name: '导入证书' })).toBeVisible();
});

test('certificate binding locks domain, and disconnect destroys certificate secrets and pending dialogs', async ({
  page,
}) => {
  await settingsFixture(page);
  await page
    .locator('.setting-row')
    .filter({ hasText: '访问设置' })
    .getByRole('button', { name: '设置', exact: true })
    .click();
  await expect(page.getByLabel('访问域名', { exact: false })).toBeDisabled();
  await page.getByRole('button', { name: '取消', exact: true }).click();
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
            saveDrafts: async () => {},
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

test('browser path changes submit only the path with fresh proof and navigate only after the reply', async ({
  page,
}) => {
  const fixture = await browserFixture(page, true);
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
  expect(fixture.commands.filter((command) => command.type === 'web.settings.update')).toHaveLength(
    1,
  );
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
  await expect(page.locator('.web-proxy-help')).toHaveCount(0);
  await page.getByRole('switch', { name: '信任反向代理' }).click();
  await expect(page.locator('.web-proxy-help')).not.toHaveAttribute('open', '');
  await page.getByText('反向代理配置示例', { exact: true }).click();
  await expect(page.getByLabel('上游 HTTPS 地址', { exact: false })).toHaveValue(
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
  await page
    .getByLabel('上游 HTTPS 地址', { exact: false })
    .fill('https://192.0.2.42:8787/invalid');
  await expect(page.getByRole('button', { name: '复制反代配置', exact: true })).toBeDisabled();
  await expect(page.getByLabel('反代配置', { exact: true })).toHaveCount(0);
  await page.getByLabel('上游 HTTPS 地址', { exact: false }).fill('https://127.0.0.1:9443');
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
    domain: 'web.example.com',
    path: 'entry',
    idleMinutes: 120,
    proxyEnabled: true,
    trustedProxies: ['127.0.0.1'],
  });
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
  await page.getByRole('switch', { name: '信任反向代理' }).click();
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
