import { test, expect, _electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { connection, login, send, settled } from './helpers.ts';

const section = (page: Page, name: string) =>
  page
    .getByRole('navigation', { name: '设置分类' })
    .getByRole('button', { name, exact: true })
    .click();
async function settings(page: Page, name: string) {
  await page.getByRole('button', { name: '设置与账号', exact: true }).click();
  await page.getByRole('menuitem', { name: '设置', exact: true }).click();
  await section(page, name);
}
const title = (application: ElectronApplication) =>
  application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle());
// A window that hands its sign-in over exits by itself. The window it starts inherits Playwright's pipe to it,
// which stays open, so the application's own close event does not come until that one goes too.
const exited = (application: ElectronApplication) =>
  new Promise<void>((done) => {
    const child = application.process();
    if (child.exitCode !== null) done();
    else child.once('exit', () => done());
  });
const heading = (page: Page) => page.getByRole('heading', { name: '连接代理服务', exact: true });

test('Electron: each start is a sign-in window of its own, one service to a window', async () => {
  test.skip(process.platform !== 'win32', 'Windows desktop smoke test');
  // Seven starts of the program, one after another.
  test.setTimeout(300_000);
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env))
    if (value !== undefined && name !== 'ELECTRON_RUN_AS_NODE') env[name] = value;
  const profile = resolve('.local/ui-test/profile-connections');
  rmSync(profile, { recursive: true, force: true });
  const args = [resolve('apps/desktop'), '--smoke-test', `--user-data-dir=${profile}`];
  const start = () => _electron.launch({ args, env });
  const { serverUrl, token } = connection();
  // The same service under another address is another service to the client.
  const elsewhere = serverUrl.replace('127.0.0.1', 'localhost');
  const shown = (url: string) => url.replace(/^\w+:\/\//, '');
  const settingsOf = (id: string) =>
    JSON.parse(
      readFileSync(resolve(profile, id ? `connections/${id}` : '', 'settings.json'), 'utf8'),
    );
  const list = () =>
    JSON.parse(readFileSync(resolve(profile, 'shared/connections.json'), 'utf8')) as {
      id: string;
      name: string;
    }[];
  const opened: ElectronApplication[] = [];
  const launched: string[] = [];
  // What the program starts by itself is not Playwright's to close: it is asked to go as the tray's
  // "退出全部连接" asks it.
  const dismiss = (id: string) =>
    execFileSync(
      createRequire(import.meta.url)('electron') as unknown as string,
      [...args, `--connection=${id}`, '--quit-connection'],
      { env },
    );
  try {
    // A first start: an empty list, the first connection.
    const first = await start();
    opened.push(first);
    const page = await first.firstWindow();
    await expect(heading(page)).toBeVisible();
    await expect(page.getByRole('button', { name: '登录过的服务', exact: true })).toHaveCount(0);
    expect(await title(first)).toBe('CC Desk Tunnel');
    await login(page);
    // One service needs no name in the window; its title and tray tell it.
    await expect(page.locator('.brand-connection')).toHaveCount(0);
    await expect.poll(() => title(first)).toBe(`CC Desk Tunnel · ${shown(serverUrl)}`);
    expect(settingsOf('').login).toMatchObject({ url: serverUrl, mode: 'local' });
    expect(settingsOf('').login.token).toBeUndefined();

    // Started again: another sign-in window, in a connection of its own, offering the service signed in to.
    const second = await start();
    opened.push(second);
    const other = await second.firstWindow();
    await expect(heading(other)).toBeVisible();
    const id = list().find((entry) => entry.id)!.id;
    expect(await second.evaluate(({ app }) => app.getPath('userData'))).toBe(
      resolve(profile, 'connections', id),
    );
    const device = (target: Page) => target.evaluate(() => window.desktop!.device());
    expect(await device(other)).toEqual(await device(page));
    const localMode = other.getByRole('button', { name: '本地模拟', exact: true });
    await other.getByRole('button', { name: '登录过的服务', exact: true }).click();
    const records = other.getByRole('list', { name: '登录过的服务', exact: true });
    await expect(records).toContainText(shown(serverUrl));
    await expect(records).toContainText('已打开');
    await expect(records).toContainText('未记住凭据');
    await records
      .getByRole('button', { name: new RegExp(shown(serverUrl)) })
      .first()
      .click();
    await expect(other.getByLabel('服务地址')).toHaveValue(serverUrl);
    await expect(localMode).toHaveAttribute('aria-pressed', 'true');
    // A service signed in to in another window is that window's.
    await other.getByLabel('服务凭据').fill(token);
    await other.getByRole('button', { name: '连接', exact: true }).click();
    await expect(other.getByRole('alert')).toContainText('已在另一个窗口登录');
    await expect(heading(other)).toBeVisible();

    // Another service signs in here, remembered and chosen to sign in by itself.
    await other.getByLabel('服务地址').fill(elsewhere);
    await other.getByLabel('自动登录').check();
    await expect(other.getByLabel('记住凭据')).toBeChecked();
    await other.getByRole('button', { name: '连接', exact: true }).click();
    await expect(other.locator('.connection-status')).toContainText('已连接');
    await expect.poll(() => settingsOf(id).login?.url).toBe(elsewhere);
    expect(settingsOf(id).login.token).toBeTruthy();
    expect(JSON.parse(readFileSync(resolve(profile, 'shared/autoLogin.json'), 'utf8'))).toEqual({
      id,
    });
    await expect.poll(() => title(second)).toBe(`CC Desk Tunnel · ${shown(elsewhere)}`);
    // Two services: each window names its own.
    await expect(other.locator('.brand-connection')).toHaveText(shown(elsewhere));
    await expect(page.locator('.brand-connection')).toHaveText(shown(serverUrl));

    // What runs here is told with its folder. Another connection's session in that folder, or above it, is
    // warned of over the conversation.
    const instance = resolve(profile, 'connections', id, 'instance.json');
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
      `连接“${shown(serverUrl)}”里有会话正在这个文件夹里运行`,
    );
    await page.evaluate(() => window.desktop!.setBusy([]));
    await expect(other.locator('.elsewhere-bar')).toHaveCount(0);

    // A choice made in one window is the other's within seconds; how the window closes is the computer's too.
    await settings(other, '外观');
    const stats = (target: Page) =>
      target.getByRole('switch', { name: '显示回复小结', exact: true });
    await expect(stats(other)).not.toBeChecked();
    await settings(page, '外观');
    await stats(page).click();
    await expect(stats(other)).toBeChecked();
    await section(other, '常规');
    await other.getByRole('switch', { name: '关闭窗口时留在后台', exact: true }).click();
    await expect.poll(() => settingsOf('').closeToTray).toBe(false);

    // The settings list the services, and a name given there replaces the address.
    await section(page, '连接');
    const row = page
      .locator('.setting-row')
      .filter({ has: page.getByText(shown(elsewhere), { exact: true }) });
    await expect(row).toContainText('已打开');
    await expect(row).toContainText('自动登录');
    // An open connection is not removed from under its window.
    page.once('dialog', (dialog) => void dialog.accept());
    await page.getByRole('button', { name: `删除 ${shown(elsewhere)}`, exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('还开着');
    await page.getByRole('button', { name: `备注名 ${shown(elsewhere)}`, exact: true }).click();
    await page.getByRole('textbox', { name: '备注名', exact: true }).fill('工作');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await expect.poll(() => title(second)).toBe('CC Desk Tunnel · 工作');

    // With no window open, the service chosen to sign in by itself does.
    await second.close();
    opened.splice(opened.indexOf(second), 1);
    await first.close();
    opened.splice(opened.indexOf(first), 1);
    const third = await start();
    opened.push(third);
    const auto = await third.firstWindow();
    await expect(auto.locator('.connection-status')).toContainText('已连接');
    expect(await third.evaluate(({ app }) => app.getPath('userData'))).toBe(
      resolve(profile, 'connections', id),
    );
    // Started again, the latest service that is not open, on its sign-in page.
    const fourth = await start();
    opened.push(fourth);
    const login2 = await fourth.firstWindow();
    await expect(heading(login2)).toBeVisible();
    await expect(login2.getByLabel('服务地址')).toHaveValue(serverUrl);
    expect(await fourth.evaluate(({ app }) => app.getPath('userData'))).toBe(profile);

    // A service whose window is not open is signed in to in a window started for it, as this one closes.
    await third.close();
    opened.splice(opened.indexOf(third), 1);
    const before = settingsOf(id).login.usedAt;
    await login2.getByRole('button', { name: '登录过的服务', exact: true }).click();
    await login2
      .getByRole('list', { name: '登录过的服务', exact: true })
      .getByRole('button', { name: /^工作/ })
      .click();
    await expect(login2.getByLabel('服务地址')).toHaveValue(elsewhere);
    // Its token stays with its own connection, which signs in with it.
    await expect(login2.getByLabel('服务凭据')).toHaveAttribute(
      'placeholder',
      '已记住，可直接连接',
    );
    const closed = exited(fourth);
    launched.push(id);
    await login2.getByRole('button', { name: '连接', exact: true }).click();
    await closed;
    opened.splice(opened.indexOf(fourth), 1);
    await expect.poll(() => existsSync(instance), { timeout: 30000 }).toBe(true);
    await expect
      .poll(() => settingsOf(id).login.usedAt, { timeout: 30000 })
      .toBeGreaterThan(before);
    expect(settingsOf(id).handoff).toBeUndefined();
    dismiss(id);
    launched.splice(launched.indexOf(id), 1);
    await expect.poll(() => existsSync(instance), { timeout: 30000 }).toBe(false);

    // A token typed for a service not remembered goes to the window started for it.
    const fifth = await start();
    opened.push(fifth);
    const work = await fifth.firstWindow();
    await expect(work.locator('.connection-status')).toContainText('已连接');
    await work.getByRole('button', { name: '设置与账号', exact: true }).click();
    await work.getByRole('menuitem', { name: '断开连接', exact: true }).click();
    await expect(heading(work)).toBeVisible();
    const used = settingsOf('').login.usedAt;
    await work.getByRole('button', { name: '登录过的服务', exact: true }).click();
    await work
      .getByRole('list', { name: '登录过的服务', exact: true })
      .getByRole('button', { name: new RegExp(`^${shown(serverUrl)}`) })
      .click();
    await expect(work.getByLabel('服务地址')).toHaveValue(serverUrl);
    await work.getByLabel('服务凭据').fill(token);
    const gone = exited(fifth);
    launched.push('');
    await work.getByRole('button', { name: '连接', exact: true }).click();
    await gone;
    opened.splice(opened.indexOf(fifth), 1);
    await expect.poll(() => settingsOf('').login.usedAt, { timeout: 30000 }).toBeGreaterThan(used);
    expect(settingsOf('').login.token).toBeUndefined();
    dismiss('');
    launched.splice(launched.indexOf(''), 1);
    await expect
      .poll(() => existsSync(resolve(profile, 'instance.json')), { timeout: 30000 })
      .toBe(false);

    // A record forgotten from the sign-in page takes its connection with it.
    const sixth = await start();
    opened.push(sixth);
    await expect((await sixth.firstWindow()).locator('.connection-status')).toContainText('已连接');
    const seventh = await start();
    opened.push(seventh);
    const forget = await seventh.firstWindow();
    await expect(heading(forget)).toBeVisible();
    await forget.getByRole('button', { name: '登录过的服务', exact: true }).click();
    forget.once('dialog', (dialog) => void dialog.accept());
    await forget
      .getByRole('button', { name: `删除 ${shown(serverUrl)} 的登录记录`, exact: true })
      .click();
    await expect(forget.getByRole('list', { name: '登录过的服务', exact: true })).not.toContainText(
      shown(serverUrl),
    );
    expect(settingsOf('').login).toBeUndefined();
    expect(settingsOf('').closeToTray).toBe(false);
  } finally {
    for (const application of opened.reverse()) await application.close().catch(() => {});
    for (const id of launched) dismiss(id);
  }
});
