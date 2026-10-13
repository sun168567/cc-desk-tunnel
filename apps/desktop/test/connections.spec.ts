import { test, expect, _electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { login, send, settled } from './helpers.ts';

async function general(page: Page) {
  await page.getByRole('button', { name: '设置与账号', exact: true }).click();
  await page.getByRole('menuitem', { name: '设置', exact: true }).click();
  await page
    .getByRole('navigation', { name: '设置分类' })
    .getByRole('button', { name: '常规', exact: true })
    .click();
}
const title = (application: ElectronApplication) =>
  application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle());

test('Electron: a second connection is a window of its own and shares what is the computer’s', async () => {
  test.skip(process.platform !== 'win32', 'Windows desktop smoke test');
  test.slow();
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env))
    if (value !== undefined && name !== 'ELECTRON_RUN_AS_NODE') env[name] = value;
  const profile = resolve('.local/ui-test/profile-connections');
  rmSync(profile, { recursive: true, force: true });
  const args = [resolve('apps/desktop'), '--smoke-test', `--user-data-dir=${profile}`];
  const first = await _electron.launch({ args, env });
  let second: ElectronApplication | undefined;
  let id = '';
  // What the program starts by itself is not Playwright's to close: it is asked to go as the tray's
  // "退出全部连接" asks it.
  const dismiss = () =>
    execFileSync(
      createRequire(import.meta.url)('electron') as unknown as string,
      [...args, `--connection=${id}`, '--quit-connection'],
      { env },
    );
  try {
    const page = await first.firstWindow();
    await expect(page.getByRole('heading', { name: '连接代理服务', exact: true })).toBeVisible();
    await login(page);
    // One connection has no name to show.
    await expect(page.locator('.brand-connection')).toHaveCount(0);
    expect(await title(first)).toBe('CC Desk Tunnel');
    await general(page);
    await page.getByRole('textbox', { name: '新连接的名称', exact: true }).fill('工作');
    await page.getByRole('button', { name: '新建并打开', exact: true }).click();
    const list = resolve(profile, 'shared/connections.json');
    await expect.poll(() => existsSync(list)).toBe(true);
    id = JSON.parse(readFileSync(list, 'utf8')).find((entry: { id: string }) => entry.id).id;
    const own = resolve(profile, 'connections', id);
    const instance = resolve(own, 'instance.json');
    await expect.poll(() => existsSync(instance), { timeout: 30000 }).toBe(true);
    await expect.poll(() => title(first)).toBe('CC Desk Tunnel · 主连接');
    const row = page
      .locator('.setting-row')
      .filter({ has: page.getByText('工作', { exact: true }) });
    await expect(row).toContainText('已打开');
    // An open connection is not removed from under its window.
    page.once('dialog', (dialog) => void dialog.accept());
    await page.getByRole('button', { name: '删除 工作', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('还开着');
    expect(existsSync(own)).toBe(true);
    dismiss();
    await expect.poll(() => existsSync(instance), { timeout: 30000 }).toBe(false);
    await expect(row).toContainText('未打开');

    // The same connection under Playwright's eye: its own profile and sign-in, the computer's identity.
    second = await _electron.launch({ args: [...args, `--connection=${id}`], env });
    const other = await second.firstWindow();
    await expect(other.getByRole('heading', { name: '连接代理服务', exact: true })).toBeVisible();
    await expect(other.locator('.brand-connection')).toHaveText('工作');
    expect(await title(second)).toBe('CC Desk Tunnel · 工作');
    expect(await second.evaluate(({ app }) => app.getPath('userData'))).toBe(own);
    const device = (target: Page) => target.evaluate(() => window.desktop!.device());
    expect(await device(other)).toEqual(await device(page));
    await login(other);
    await expect(other.locator('.brand-connection')).toHaveText('工作');

    // What runs here is told with its folder. Another connection's session in that folder, or above it, is
    // warned of over the conversation.
    const runs = () =>
      (JSON.parse(readFileSync(instance, 'utf8')).runs as { folder: string }[]).map(
        (run) => run.folder,
      );
    // This repository stands in for the user's project.
    const repository = resolve('.');
    await second.evaluate(({ dialog }, chosen) => {
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [chosen],
      })) as unknown as typeof dialog.showOpenDialog;
    }, repository);
    await other.getByRole('button', { name: '添加项目', exact: true }).click();
    await other.getByRole('button', { name: `新建会话 · ${repository}`, exact: true }).click();
    await send(other, '检查目录', 'tool');
    await expect.poll(runs).toEqual([repository]);
    await other.getByRole('button', { name: '停止运行', exact: true }).click();
    await settled(other);
    await expect.poll(runs).toEqual([]);
    await expect(other.locator('.elsewhere-bar')).toHaveCount(0);
    await page.evaluate(
      (folder) => window.desktop!.setBusy([{ id: 'another', folder }]),
      resolve('..'),
    );
    await expect(other.locator('.elsewhere-bar')).toContainText(
      '连接“主连接”里有会话正在这个文件夹里运行',
    );
    await page.evaluate(() => window.desktop!.setBusy([]));
    await expect(other.locator('.elsewhere-bar')).toHaveCount(0);

    // A choice made in one window is the other's within seconds; how the window closes is the computer's too.
    await general(other);
    const stats = (target: Page) =>
      target.getByRole('switch', { name: '显示回复小结', exact: true });
    await expect(stats(other)).not.toBeChecked();
    await stats(page).click();
    await expect(stats(other)).toBeChecked();
    await other.getByRole('switch', { name: '关闭窗口时留在后台', exact: true }).click();
    await expect
      .poll(() => JSON.parse(readFileSync(resolve(profile, 'settings.json'), 'utf8')).closeToTray)
      .toBe(false);
    // The connection's own settings hold its sign-in and nothing of the computer's.
    expect(JSON.parse(readFileSync(resolve(own, 'settings.json'), 'utf8'))).toEqual({});
    await other.getByRole('button', { name: '改名 主连接', exact: true }).click();
    await other.getByRole('textbox', { name: '连接的名称', exact: true }).fill('个人');
    await other.getByRole('button', { name: '保存', exact: true }).click();
    await expect.poll(() => title(first)).toBe('CC Desk Tunnel · 个人');

    await second.close();
    second = undefined;
    await expect(row).toContainText('未打开');
    page.once('dialog', (dialog) => void dialog.accept());
    await page.getByRole('button', { name: '删除 工作', exact: true }).click();
    await expect(row).toHaveCount(0);
    expect(existsSync(own)).toBe(false);
    await expect.poll(() => title(first)).toBe('CC Desk Tunnel');
  } finally {
    await second?.close().catch(() => {});
    if (id) dismiss();
    await first.close();
  }
});
