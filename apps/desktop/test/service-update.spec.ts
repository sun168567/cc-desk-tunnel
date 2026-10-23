import { expect, test } from '@playwright/test';
import type { Page, WebSocketRoute } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import type { ServiceUpdate, Session } from '@cc-desk-tunnel/protocol';

const address = 'ws://127.0.0.1:18898/ws';
const failedCheck: ServiceUpdate = { state: 'failed', detail: 'fetch failed' };
const checkMessage = '检查服务端更新失败，不影响当前连接。';
const installMessage = '服务端升级未完成，请查看原因后重试。';

async function serviceFixture(page: Page, initial?: ServiceUpdate, sessions: Session[] = []) {
  let update = initial;
  let socket: WebSocketRoute;
  let connections = 0;
  const commands: { type: string; requestId?: string; version?: string }[] = [];
  const send = (value: unknown) => socket.send(JSON.stringify(value));
  const push = (value: ServiceUpdate) => {
    update = value;
    send({ type: 'service.update', ...value });
  };
  await page.routeWebSocket(address, (route) => {
    socket = route;
    route.onMessage((raw) => {
      const command = JSON.parse(String(raw));
      commands.push(command);
      if (command.type === 'device') return;
      if (command.type === 'auth') {
        connections++;
        send({
          type: 'ready',
          protocolVersion: PROTOCOL_VERSION,
          version: '0.3.7',
          connectionId: randomUUID(),
          adapter: 'claude-code',
          sessions,
          update,
        });
        return;
      }
      if (command.type === 'service.update.check') push({ state: 'checking' });
      if (command.type === 'session.create') {
        send({
          type: 'response',
          requestId: command.requestId,
          ok: false,
          message: '项目目录暂时不可写。',
        });
        return;
      }
      send({ type: 'response', requestId: command.requestId, ok: true });
    });
  });
  await page.goto('/');
  const connect = async () => {
    await page.getByLabel('服务地址', { exact: true }).fill(address);
    await page
      .getByLabel('服务凭据', { exact: true })
      .fill('test-only-update-token-with-enough-length');
    await page.getByRole('button', { name: '连接', exact: true }).click();
    await expect(page.locator('.connection-status')).toContainText('已连接');
  };
  await connect();
  return {
    connect,
    push,
    commands,
    connections: () => connections,
  };
}

async function openAbout(page: Page) {
  await page.getByRole('button', { name: '设置与账号', exact: true }).click();
  await page.getByRole('menuitem', { name: '设置', exact: true }).click();
  const expand = page.getByRole('button', { name: '展开会话列表', exact: true });
  if (await expand.isVisible()) await expand.click();
  await page.getByRole('button', { name: '关于与更新', exact: true }).click();
  return page.getByRole('region', { name: '关于与更新', exact: true });
}

test('a cached update-check failure stays in About and a successful retry clears it', async ({
  page,
}) => {
  const fixture = await serviceFixture(page, failedCheck);
  await expect(page.locator('.error-banner')).toHaveCount(0);
  await expect(page.locator('.rail-update')).toHaveCount(0);
  const about = await openAbout(page);
  const notice = about.locator('.service-update-notice');
  await expect(notice).toContainText(checkMessage);
  await expect(notice.locator('details')).not.toHaveAttribute('open');
  await expect(notice.getByText('fetch failed', { exact: true })).not.toBeVisible();
  await notice.getByText('查看失败原因', { exact: true }).click();
  await expect(notice.getByText('fetch failed', { exact: true })).toBeVisible();
  await about.getByRole('button', { name: '重新检查更新', exact: true }).click();
  await expect(about.getByRole('button', { name: '正在检查更新…', exact: true })).toBeDisabled();
  expect(fixture.commands.filter((command) => command.type.startsWith('service.update.'))).toEqual([
    expect.objectContaining({ type: 'service.update.check' }),
  ]);
  fixture.push({ state: 'idle', checkedAt: Date.now() });
  await expect(notice).toHaveCount(0);
  await expect(about.getByRole('button', { name: /已是最新 0.3.7/ })).toBeEnabled();
  await page.getByRole('button', { name: '会话', exact: true }).click();
  await expect(page.locator('.error-banner')).toHaveCount(0);
});

test('pushed and reconnect-cached update failures do not become workbench errors', async ({
  page,
}) => {
  const fixture = await serviceFixture(page, { state: 'idle' });
  fixture.push(failedCheck);
  await openAbout(page);
  await expect(page.locator('.service-update-notice')).toContainText(checkMessage);
  await page.getByRole('button', { name: '会话', exact: true }).click();
  await expect(page.locator('.error-banner')).toHaveCount(0);
  await expect(page.locator('.rail-update')).toHaveCount(0);
  await page.getByRole('button', { name: '设置与账号', exact: true }).click();
  await page.getByRole('menuitem', { name: '断开连接', exact: true }).click();
  await fixture.connect();
  expect(fixture.connections()).toBe(2);
  await expect(page.locator('.error-banner')).toHaveCount(0);
  await openAbout(page);
  await expect(page.locator('.service-update-notice')).toContainText(checkMessage);
});

test('an installation failure keeps its entry and retry checks without installing', async ({
  page,
}) => {
  const fixture = await serviceFixture(page, {
    state: 'failed',
    latest: '0.3.8',
    detail: '下载更新失败。\n连接发布服务器超时。',
  });
  await expect(page.locator('.error-banner')).toHaveCount(0);
  await expect(page.locator('.rail-update')).toHaveAttribute('title', '服务端升级未完成');
  await page.getByRole('button', { name: '更新', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: '重新检查更新', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  const about = await openAbout(page);
  const notice = about.locator('.service-update-notice');
  await expect(notice).toContainText(installMessage);
  await expect(notice.locator('details')).not.toHaveAttribute('open');
  await notice.getByText('查看失败原因', { exact: true }).click();
  await expect(notice).toContainText('下载更新失败。');
  await expect(notice).toContainText('连接发布服务器超时。');
  await about.getByRole('button', { name: '重新检查更新', exact: true }).click();
  await expect(about.getByRole('button', { name: '正在检查更新…', exact: true })).toBeDisabled();
  fixture.push({ state: 'available', latest: '0.3.8', checkedAt: Date.now() });
  await expect(notice).toHaveCount(0);
  await expect(
    about.getByRole('button', { name: '升级服务端到 0.3.8', exact: true }),
  ).toBeEnabled();
  expect(fixture.commands.filter((command) => command.type.startsWith('service.update.'))).toEqual([
    expect.objectContaining({ type: 'service.update.check' }),
  ]);
});

test('a failure without a technical detail still has a useful message and retry', async ({
  page,
}) => {
  await serviceFixture(page, { state: 'failed' });
  const about = await openAbout(page);
  await expect(about.locator('.service-update-notice')).toContainText(checkMessage);
  await expect(about.locator('.service-update-notice details')).toHaveCount(0);
  await expect(about.getByRole('button', { name: '重新检查更新', exact: true })).toBeEnabled();
});

test('background update events neither replace nor clear an unrelated operation error', async ({
  page,
}) => {
  const now = new Date().toISOString();
  const fixture = await serviceFixture(page, { state: 'idle' }, [
    {
      id: randomUUID(),
      title: '已有会话',
      autoTitle: false,
      projectPath: 'D:\\work\\example',
      permissionMode: 'auto',
      model: null,
      effort: null,
      createdAt: now,
      updatedAt: now,
      activeRun: null,
    },
  ]);
  await page.getByRole('button', { name: '文件', exact: true }).click();
  await page.getByRole('menuitem', { name: '新建会话', exact: true }).click();
  await expect(page.locator('.error-banner')).toHaveText('项目目录暂时不可写。');
  for (const update of [failedCheck, { state: 'checking' }, { state: 'idle' }] as ServiceUpdate[]) {
    fixture.push(update);
    // Opening About makes each received update observable before returning to the error.
    const about = await openAbout(page);
    if (update.state === 'failed')
      await expect(about.locator('.service-update-notice')).toContainText(checkMessage);
    else if (update.state === 'checking')
      await expect(
        about.getByRole('button', { name: '正在检查更新…', exact: true }),
      ).toBeDisabled();
    else await expect(about.getByRole('button', { name: '检查更新', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: '会话', exact: true }).click();
    await expect(page.locator('.error-banner')).toHaveText('项目目录暂时不可写。');
  }
});

for (const width of [1280, 390])
  test(`update-check failure remains readable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await serviceFixture(page, {
      ...failedCheck,
      detail: `fetch failed\nhttps://api.github.com/repos/example/project/releases/${'a'.repeat(160)}`,
    });
    const about = await openAbout(page);
    await expect(about.locator('.service-update-notice')).toContainText(checkMessage);
    await about.getByText('查看失败原因', { exact: true }).click();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    expect(await about.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    const folder = resolve('.local/screenshots/service-update');
    mkdirSync(folder, { recursive: true });
    await page.screenshot({ path: resolve(folder, `check-failed-${width}.png`) });
  });
