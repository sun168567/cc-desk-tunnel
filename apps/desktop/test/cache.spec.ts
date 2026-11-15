import { test, expect, _electron } from '@playwright/test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createProxyServer } from '../../server/src/server.ts';

test('desktop disk cache survives restart, reads offline pages and clears from settings', async () => {
  test.skip(
    process.platform !== 'win32',
    'Desktop UI; packaged cache smoke also runs on macOS/Linux',
  );
  test.setTimeout(90000);
  const root = resolve('.local/cache-ui');
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, 'run-')),
    folder = join(directory, 'project');
  mkdirSync(folder);
  const token = 'cache-ui-' + randomUUID();
  const server = createProxyServer({
    host: '127.0.0.1',
    token,
    dataDir: join(directory, 'server'),
  });
  const url = (await server.listen(0)).replace('http:', 'ws:') + '/ws';
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE',
    ),
  );
  const launch = () =>
    _electron.launch({
      args: [
        resolve('apps/desktop'),
        '--smoke-test',
        `--user-data-dir=${join(directory, 'profile')}`,
      ],
      env,
    });
  let application = await launch();
  let serviceClosed = false;
  try {
    let page = await application.firstWindow();
    await expect(page.getByRole('heading', { name: '连接代理服务', exact: true })).toBeVisible();
    const device = await page.evaluate(() => window.desktop!.device());
    const session = server.store.create(randomUUID(), '缓存回归会话', folder, device);
    for (let i = 0; i < 3; i++) {
      const run = randomUUID();
      server.store.append(session.id, run, {
        type: 'message.user',
        messageId: randomUUID(),
        scenario: 'chat',
        text: `缓存问题${i}`,
      });
      server.store.append(session.id, run, {
        type: 'text.delta',
        messageId: randomUUID(),
        text: `缓存回答${i}\n` + 'history '.repeat(40000),
      });
    }
    await page.evaluate((folder) => window.desktop!.saveShared('projects', [folder]), folder);
    await page.getByRole('button', { name: '本地模拟', exact: true }).click();
    await page.getByLabel('服务地址').fill(url);
    await page.getByLabel('服务凭据').fill(token);
    await page.getByRole('button', { name: '连接', exact: true }).click();
    await expect(page.locator('.connection-status')).toContainText('已连接');
    await page.locator('.session-select').filter({ hasText: '缓存回归会话' }).click();
    await expect(page.locator('.message.user')).toContainText('缓存问题2');
    for (let i = 0; i < 2; i++) {
      await page.getByRole('button', { name: '加载更早记录', exact: true }).click();
      await expect(page.getByText(`缓存问题${1 - i}`, { exact: true })).toBeVisible();
    }
    await expect
      .poll(
        async () =>
          await page.evaluate(
            async (url) =>
              ((await window.desktop!.historyCache({ type: 'stats', url })) as { events: number })
                .events,
            url,
          ),
      )
      .toBe(6);
    await application.close();
    await server.close();
    serviceClosed = true;
    application = await launch();
    page = await application.firstWindow();
    await expect(page.getByRole('button', { name: '离线查看缓存', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '离线查看缓存', exact: true }).click();
    await expect(page.locator('.connection-status')).toContainText('离线');
    await page.locator('.session-select').filter({ hasText: '缓存回归会话' }).click();
    await expect(page.getByText('缓存问题2', { exact: true })).toBeVisible();
    await expect(page.getByRole('textbox', { name: '消息', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: '加载更早记录', exact: true }).click();
    await expect(page.getByText('缓存问题1', { exact: true })).toBeVisible();
    await page.screenshot({ path: join(root, 'offline.png') });
    await page.getByRole('button', { name: '返回连接页', exact: true }).click();
    await page.getByRole('button', { name: '本机设置', exact: true }).click();
    await page.getByRole('button', { name: '对话缓存', exact: true }).click();
    await expect(page.getByText(/1 个会话 · 6 条记录/)).toBeVisible();
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: '清理缓存', exact: true }).click();
    await expect(page.getByText(/0 个会话 · 0 条记录/)).toBeVisible();
    await page.screenshot({ path: join(root, 'cleared.png') });
  } finally {
    await application.close();
    if (!serviceClosed) await server.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
