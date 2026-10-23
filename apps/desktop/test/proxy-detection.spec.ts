import { expect, test } from '@playwright/test';
import type { Page, WebSocketRoute } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';

const address = 'ws://127.0.0.1:18899/ws';
const detectedAddress = '172.26.0.1';
const explanation = '让反代后的访客分别计算登录尝试次数。关闭不影响正常访问。';
const detectionExplanation = '不知道代理 IP？可通过已保存的 Web 地址检测。';
const detectedMessage = '已填入检测到的地址，确认是你的反向代理后保存。';
const screenshotDirectory = resolve('.local/screenshots/proxy-detection');

// Exercise the shared settings and request/reply client; only the WebSocket transport is isolated.
async function proxyFixture(
  page: Page,
  options: { browser?: boolean; publicOrigin?: string; trustedProxies?: string[] } = {},
) {
  const values = {
    enabled: true,
    domain: 'web.example.com',
    publicOrigin: options.publicOrigin ?? 'https://web.example.com:1443',
    path: 'entry',
    idleMinutes: 120,
    proxyEnabled: false,
    trustedProxies: options.trustedProxies ?? [],
    totpEnabled: false,
    passkeyAvailable: false,
    passkeys: [],
    sessions: [],
  };
  const commands: { type: string; requestId?: string; values?: Record<string, unknown> }[] = [];
  const pending: string[] = [];
  const targets = new Map<string, { publicOrigin: string; path: string }>();
  let socket: WebSocketRoute;
  const send = (message: unknown) => socket.send(JSON.stringify(message));
  await page.routeWebSocket(address, (route) => {
    socket = route;
    route.onMessage((raw) => {
      const command = JSON.parse(String(raw));
      commands.push(command);
      if (command.type === 'auth') {
        send({
          type: 'ready',
          protocolVersion: PROTOCOL_VERSION,
          version: '0.3.7',
          connectionId: randomUUID(),
          adapter: 'claude-code',
          sessions: [],
        });
        return;
      }
      if (!command.requestId) return;
      if (command.type === 'web.proxy.detect') {
        pending.push(command.requestId);
        targets.set(command.requestId, { publicOrigin: values.publicOrigin, path: values.path });
        return;
      }
      if (command.type === 'web.settings.update') Object.assign(values, command.values);
      if (command.type === 'web.settings.get' || command.type === 'web.settings.update')
        send({ type: 'web.settings.state', requestId: command.requestId, values });
      if (command.type === 'web.certificate.get')
        send({
          type: 'web.certificate.state',
          requestId: command.requestId,
          mode: 'default',
          selfSigned: true,
        });
      send({ type: 'response', requestId: command.requestId, ok: true });
    });
  });
  await page.route('**/__proxy-fixture', (route) =>
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
  await page.goto('/__proxy-fixture');
  await page.waitForFunction(() => '__vite_plugin_react_preamble_installed__' in window);
  await page.evaluate(
    async ({ address, browser }) => {
      const reactPath = '/node_modules/.vite/deps/react.js';
      const domPath = '/node_modules/.vite/deps/react-dom_client.js';
      const componentPath = '/src/WebAccessSettings.tsx';
      const clientPath = '/src/client.ts';
      const React = (await import(reactPath)).default;
      const { createRoot } = (await import(domPath)).default;
      const { default: Settings } = await import(componentPath);
      const { ProxyClient } = await import(clientPath);
      const client = new ProxyClient();
      const connect = () =>
        client.connect(address, 'test-only-proxy-detection-token-long-enough', {
          id: crypto.randomUUID(),
          name: '测试客户端',
        });
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
        proxyFixture: { disconnect: () => client.disconnect(), reconnect: connect },
      });
      connect();
    },
    { address, browser: !!options.browser },
  );
  await expect(page.getByText('访问设置', { exact: true })).toBeVisible();
  return {
    commands,
    values,
    pending,
    reply: (
      failure?: string,
      requestId = pending.shift(),
      target?: { publicOrigin: string; path: string },
    ) => {
      expect(requestId).toBeDefined();
      if (!failure)
        send({
          type: 'web.proxy.detected',
          requestId,
          address: detectedAddress,
          ...(target ?? targets.get(requestId!)),
        });
      send({ type: 'response', requestId, ok: !failure, ...(failure ? { message: failure } : {}) });
    },
  };
}

async function openAccess(page: Page) {
  await page
    .locator('.setting-row')
    .filter({ hasText: '访问设置' })
    .getByRole('button', { name: '设置', exact: true })
    .click();
  return page.getByRole('dialog');
}

test('proxy detection expands only with recognition enabled and retains its unsaved draft when hidden', async ({
  page,
}) => {
  const fixture = await proxyFixture(page);
  const dialog = await openAccess(page);
  const enabled = dialog.getByRole('switch', { name: '识别真实访客 IP', exact: true });
  const detect = dialog.getByRole('button', { name: '自动检测', exact: true });
  const hint = dialog.getByText(detectionExplanation, { exact: true });
  const input = dialog.getByLabel('可信反向代理 IP', { exact: false });
  await expect(enabled).not.toBeChecked();
  await expect(hint).toHaveCount(0);
  await expect(detect).toHaveCount(0);
  await expect(input).toHaveCount(0);
  expect(fixture.commands.some((command) => command.type === 'web.proxy.detect')).toBe(false);
  await enabled.click();
  await expect(hint).toBeVisible();
  await expect(detect).toBeEnabled();
  await input.fill('192.0.2.4');
  await detect.click();
  await expect.poll(() => fixture.pending.length).toBe(1);
  fixture.reply();
  await expect(input).toHaveValue(`192.0.2.4\n${detectedAddress}`);
  await expect(input).toBeEnabled();
  await expect(enabled).toBeChecked();
  await expect(dialog.getByRole('status')).toHaveText(detectedMessage);
  await enabled.click();
  await expect(enabled).not.toBeChecked();
  await expect(hint).toHaveCount(0);
  await expect(detect).toHaveCount(0);
  await expect(input).toHaveCount(0);
  await expect(dialog.getByRole('status')).toHaveCount(0);
  await enabled.click();
  await expect(hint).toBeVisible();
  await expect(detect).toBeEnabled();
  await expect(input).toHaveValue(`192.0.2.4\n${detectedAddress}`);
  expect(fixture.values.proxyEnabled).toBe(false);
  expect(fixture.values.trustedProxies).toEqual([]);
  expect(fixture.commands.some((command) => command.type === 'web.settings.update')).toBe(false);
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await openAccess(page);
  await expect(enabled).not.toBeChecked();
  await expect(hint).toHaveCount(0);
  await expect(detect).toHaveCount(0);
  await expect(input).toHaveCount(0);
  await enabled.click();
  await expect(input).toHaveValue('');
});

test('detection fills only the draft and deduplicates addresses before an explicit save', async ({
  page,
}) => {
  const fixture = await proxyFixture(page, { trustedProxies: ['127.0.0.1'] });
  const dialog = await openAccess(page);
  await expect(dialog).toContainText(explanation);
  await dialog.getByRole('switch', { name: '识别真实访客 IP', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '自动检测', exact: true })).toBeEnabled();
  const input = dialog.getByLabel('可信反向代理 IP', { exact: false });
  await expect(input).toHaveValue('127.0.0.1');
  for (let attempt = 0; attempt < 2; attempt++) {
    await dialog.getByRole('button', { name: '自动检测', exact: true }).click();
    await expect.poll(() => fixture.pending.length).toBe(1);
    fixture.reply();
    await expect(dialog.getByRole('status')).toHaveText(detectedMessage);
    await expect(input).toHaveValue(`127.0.0.1\n${detectedAddress}`);
    expect(fixture.commands.filter((command) => command.type === 'web.settings.update')).toEqual(
      [],
    );
    expect(fixture.values.proxyEnabled).toBe(false);
    expect(fixture.values.trustedProxies).toEqual(['127.0.0.1']);
  }
  await dialog.getByRole('button', { name: '确认', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(fixture.commands.filter((command) => command.type === 'web.settings.update')).toEqual([
    expect.objectContaining({
      values: {
        path: 'entry',
        idleMinutes: 120,
        proxyEnabled: true,
        trustedProxies: ['127.0.0.1', detectedAddress],
      },
    }),
  ]);
});

test('detection freezes editable fields, reports failures locally, and preserves manual input', async ({
  page,
}) => {
  const fixture = await proxyFixture(page);
  const dialog = await openAccess(page);
  await dialog.getByRole('switch', { name: '识别真实访客 IP', exact: true }).click();
  const input = dialog.getByLabel('可信反向代理 IP', { exact: false });
  await input.fill('192.0.2.4');
  await dialog.getByRole('button', { name: '自动检测', exact: true }).click();
  await expect.poll(() => fixture.pending.length).toBe(1);
  for (const field of [
    dialog.getByLabel('Web 对外地址', { exact: true }),
    dialog.getByLabel('服务端访问路径', { exact: false }),
    dialog.getByLabel('登录空闲有效期（分钟）'),
    input,
    dialog.getByRole('switch', { name: '识别真实访客 IP', exact: true }),
    dialog.getByRole('button', { name: '确认', exact: true }),
    dialog.getByRole('button', { name: '取消', exact: true }),
  ])
    await expect(field).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  fixture.reply('自动检测超时，请检查 Web 对外地址后重试。');
  await expect(dialog.getByRole('alert')).toHaveText('自动检测超时，请检查 Web 对外地址后重试。');
  await expect(input).toHaveValue('192.0.2.4');
  await expect(dialog.getByRole('button', { name: '确认', exact: true })).toBeEnabled();
  expect(fixture.commands.some((command) => command.type === 'web.settings.update')).toBe(false);
  await dialog.getByRole('button', { name: '自动检测', exact: true }).click();
  await expect.poll(() => fixture.pending.length).toBe(1);
  fixture.reply();
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  await expect(input).toHaveValue(`192.0.2.4\n${detectedAddress}`);
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await openAccess(page);
  await dialog.getByRole('switch', { name: '识别真实访客 IP', exact: true }).click();
  await expect(input).toHaveValue('');
});

for (const existingCandidate of [false, true])
  test(`a full trusted-proxy list ${existingCandidate ? 'accepts its existing candidate' : 'rejects a new candidate without changing input'}`, async ({
    page,
  }) => {
    const trustedProxies = Array.from({ length: 16 }, (_, index) => `192.0.2.${index + 1}`);
    if (existingCandidate) trustedProxies[0] = detectedAddress;
    const fixture = await proxyFixture(page, { trustedProxies });
    const dialog = await openAccess(page);
    await dialog.getByRole('switch', { name: '识别真实访客 IP', exact: true }).click();
    const input = dialog.getByLabel('可信反向代理 IP', { exact: false });
    await expect(input).toHaveValue(trustedProxies.join('\n'));
    await dialog.getByRole('button', { name: '自动检测', exact: true }).click();
    await expect.poll(() => fixture.pending.length).toBe(1);
    fixture.reply();
    if (existingCandidate) {
      await expect(dialog.getByRole('status')).toHaveText(detectedMessage);
      await expect(dialog.getByRole('alert')).toHaveCount(0);
    } else {
      await expect(dialog.getByRole('alert')).toHaveText(
        '最多保存 16 个代理 IP，请先移除不用的地址后重试。',
      );
      await expect(dialog.getByRole('status')).toHaveCount(0);
    }
    await expect(input).toHaveValue(trustedProxies.join('\n'));
    expect(fixture.commands.some((command) => command.type === 'web.settings.update')).toBe(false);
  });

for (const field of ['origin', 'path'] as const)
  test(`an unsaved ${field} prevents detection without preventing a deliberate settings save`, async ({
    page,
  }) => {
    const fixture = await proxyFixture(page, { trustedProxies: ['127.0.0.1'] });
    const dialog = await openAccess(page);
    await dialog.getByRole('switch', { name: '识别真实访客 IP', exact: true }).click();
    const input =
      field === 'origin'
        ? dialog.getByLabel('Web 对外地址', { exact: true })
        : dialog.getByLabel('服务端访问路径', { exact: false });
    await input.fill(field === 'origin' ? 'other.example.com:1443' : 'changed');
    await expect(dialog.getByRole('button', { name: '自动检测', exact: true })).toBeDisabled();
    await expect(dialog).toContainText(/先保存/);
    await expect(dialog.getByRole('button', { name: '确认', exact: true })).toBeEnabled();
    expect(fixture.commands.some((command) => command.type === 'web.proxy.detect')).toBe(false);
    await dialog.getByRole('button', { name: '确认', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await openAccess(page);
    await expect(dialog.getByRole('button', { name: '自动检测', exact: true })).toBeEnabled();
  });

test('an unset public address leaves manual configuration available without a probe', async ({
  page,
}) => {
  const fixture = await proxyFixture(page, { publicOrigin: '' });
  const dialog = await openAccess(page);
  await dialog.getByRole('switch', { name: '识别真实访客 IP', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '自动检测', exact: true })).toBeDisabled();
  await expect(dialog).toContainText(/先.*保存/);
  await dialog.getByLabel('可信反向代理 IP', { exact: false }).fill('127.0.0.1');
  await dialog.getByRole('button', { name: '确认', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(fixture.commands.some((command) => command.type === 'web.proxy.detect')).toBe(false);
  expect(fixture.values.trustedProxies).toEqual(['127.0.0.1']);
});

test('a reply from a closed connection cannot fill a newly opened settings dialog', async ({
  page,
}) => {
  const fixture = await proxyFixture(page);
  const dialog = await openAccess(page);
  await dialog.getByRole('switch', { name: '识别真实访客 IP', exact: true }).click();
  await dialog.getByRole('button', { name: '自动检测', exact: true }).click();
  await expect.poll(() => fixture.pending.length).toBe(1);
  const previousRequest = fixture.pending.shift();
  await page.evaluate(() =>
    (window as unknown as { proxyFixture: { disconnect: () => void } }).proxyFixture.disconnect(),
  );
  await expect(dialog).toHaveCount(0);
  await page.evaluate(() =>
    (window as unknown as { proxyFixture: { reconnect: () => void } }).proxyFixture.reconnect(),
  );
  await openAccess(page);
  await dialog.getByRole('switch', { name: '识别真实访客 IP', exact: true }).click();
  const input = dialog.getByLabel('可信反向代理 IP', { exact: false });
  await input.fill('192.0.2.5');
  fixture.reply(undefined, previousRequest);
  await dialog.getByRole('button', { name: '自动检测', exact: true }).click();
  await expect.poll(() => fixture.pending.length).toBe(1);
  fixture.reply('本次检测失败，请重试。');
  await expect(dialog.getByRole('alert')).toHaveText('本次检测失败，请重试。');
  await expect(input).toHaveValue('192.0.2.5');
  await expect(dialog.getByRole('status')).toHaveCount(0);
  expect(fixture.commands.some((command) => command.type === 'web.settings.update')).toBe(false);
});

for (const target of [
  { publicOrigin: 'https://changed.example.com', path: 'entry' },
  { publicOrigin: 'https://web.example.com:1443', path: 'changed' },
])
  test(`a result for another saved target is rejected (${target.publicOrigin}/${target.path})`, async ({
    page,
  }) => {
    const fixture = await proxyFixture(page);
    const dialog = await openAccess(page);
    await dialog.getByRole('switch', { name: '识别真实访客 IP', exact: true }).click();
    const input = dialog.getByLabel('可信反向代理 IP', { exact: false });
    await input.fill('192.0.2.6');
    await dialog.getByRole('button', { name: '自动检测', exact: true }).click();
    await expect.poll(() => fixture.pending.length).toBe(1);
    fixture.reply(undefined, undefined, target);
    await expect(dialog.getByRole('alert')).toContainText(/重新打开/);
    await expect(input).toHaveValue('192.0.2.6');
    await expect(dialog.getByRole('status')).toHaveCount(0);
    expect(fixture.commands.some((command) => command.type === 'web.settings.update')).toBe(false);
  });

test('browser settings expose neither proxy trust controls nor automatic detection', async ({
  page,
}) => {
  const fixture = await proxyFixture(page, { browser: true });
  const dialog = await openAccess(page);
  await expect(dialog.getByRole('switch', { name: '识别真实访客 IP' })).toHaveCount(0);
  await expect(dialog.getByLabel('可信反向代理 IP', { exact: false })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: '自动检测', exact: true })).toHaveCount(0);
  expect(fixture.commands.some((command) => command.type === 'web.proxy.detect')).toBe(false);
});

for (const width of [1280, 390])
  test(`proxy detection explanations and results fit at ${width}px`, async ({ page }) => {
    mkdirSync(screenshotDirectory, { recursive: true });
    await page.setViewportSize({ width, height: 900 });
    const fixture = await proxyFixture(page);
    const dialog = await openAccess(page);
    await dialog.getByRole('switch', { name: '识别真实访客 IP', exact: true }).click();
    await dialog.getByRole('button', { name: '自动检测', exact: true }).click();
    await expect.poll(() => fixture.pending.length).toBe(1);
    fixture.reply();
    await expect(dialog.getByRole('status')).toHaveText(detectedMessage);
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: resolve(screenshotDirectory, `detected-${width}.png`) });
  });
