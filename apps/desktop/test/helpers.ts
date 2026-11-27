import { expect } from '@playwright/test';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Screenshots are for the eye and stay on this machine.
export const screenshots = resolve('.local/screenshots');
mkdirSync(resolve(screenshots, 'redesign'), { recursive: true });
// The arguments that start the program on `profile` for a connection made there, as one an earlier version made
// without keeping its address (see `launcher:load` in electron/main.cjs): signed in to from the sign-in window, it
// keeps the address given there. Its files are in `connectionDirectory`.
export const testConnection = 'test0000';
export const connectionDirectory = (profile: string) =>
  resolve(profile, 'connections', testConnection);
// `fresh` starts from an empty profile: a connection that signed in before keeps to its service.
export function connectionArgs(profile: string, fresh = false) {
  if (fresh) rmSync(profile, { recursive: true, force: true });
  mkdirSync(connectionDirectory(profile), { recursive: true });
  mkdirSync(resolve(profile, 'shared'), { recursive: true });
  const list = resolve(profile, 'shared', 'connections.json');
  if (!existsSync(list)) writeFileSync(list, JSON.stringify([{ id: testConnection, name: '' }]));
  return [`--user-data-dir=${profile}`, `--connection=${testConnection}`];
}
export function connection() {
  return JSON.parse(readFileSync(resolve('.local/ui-test/dev-connection.json'), 'utf8')) as {
    serverUrl: string;
    token: string;
  };
}
// Signs in on the sign-in page; in a browser the page signed in takes its place in the tab.
export async function login(page: Page, wait = true) {
  const config = connection();
  // The mode buttons come with the form: until it is drawn they are not visible either.
  await page.getByLabel('服务地址').waitFor();
  const localMode = page.getByRole('button', { name: '本地模拟', exact: true });
  if (await localMode.isVisible()) await localMode.click();
  await page.getByLabel('服务地址').fill(config.serverUrl);
  await page.getByLabel('服务凭据').fill(config.token);
  await page.getByRole('button', { name: '连接', exact: true }).click();
  if (wait) await expect(page.locator('.connection-status')).toContainText('已连接');
}
// The window of the connection the program's sign-in window signs in to: made while it signs in, and shown, the
// sign-in window gone, once it has connected.
export async function connectionWindow(application: ElectronApplication) {
  let found: Page | undefined;
  await expect
    .poll(
      async () => {
        for (const page of application.windows())
          if (
            await page.evaluate(() => window.desktop?.boot?.launcher === false).catch(() => false)
          ) {
            found = page;
            return true;
          }
        return false;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  return found!;
}
// The processes of the program on `profile` that it started by itself, outside Playwright: the sign-in window a
// connection signed out of gives way to, or one it hands a sign-in to. Ended here.
export function endStrays(profile: string) {
  if (process.platform !== 'win32') return;
  const pattern = `*--user-data-dir=${profile}*`.replaceAll("'", "''");
  execFileSync('powershell.exe', [
    '-NoProfile',
    '-Command',
    `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '${pattern}' -and $_.CommandLine -notlike '*--type=*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
  ]);
}
// Signs in on the program's sign-in window, as the user does; the connection's window, connected.
export async function signInWindow(application: ElectronApplication) {
  const launcher = await application.firstWindow();
  await expect(launcher.getByRole('heading', { name: '连接代理服务', exact: true })).toBeVisible();
  await login(launcher, false);
  const page = await connectionWindow(application);
  await expect(page.locator('.connection-status')).toContainText('已连接');
  return page;
}
// Finished turns, runs of tool calls and each call are folded; open them all to inspect the details.
export async function expandActivity(page: Page, shown?: Locator) {
  const expand = async () => {
    for (const selector of ['.turn-process', '.work', '.tool']) {
      const closed = page.locator(`${selector}:not([open]) > summary`);
      // A row that arrives late draws its group again while it is being clicked, and the group may come back open:
      // a click that finds nothing to click gives up soon, and the groups are counted again.
      while (await closed.count())
        await closed
          .first()
          .click({ timeout: 2000 })
          .catch(() => {});
    }
  };
  if (!shown) return await expand();
  // The session stops running a moment before the turn's end arrives, and only an ended turn is folded: expanded
  // in that moment, the turn folds after it. Expanded again until what it is opened for is in view.
  await expect(async () => {
    await expand();
    await expect(shown).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 15000 });
}
export async function sessionAction(page: Page, action: string) {
  const sidebar = page.getByRole('button', { name: '展开会话列表' });
  if (await sidebar.isVisible()) await sidebar.click();
  const row = page.locator('.session-row.selected');
  await row.hover();
  await row.getByRole('button', { name: '会话操作', exact: true }).click();
  await page.getByRole('menuitem', { name: action, exact: true }).click();
}
export async function search(page: Page, text: string) {
  const box = page.getByLabel('搜索会话');
  if (!(await box.isVisible()))
    await page.getByRole('button', { name: '搜索', exact: true }).click();
  await box.fill(text);
}
export async function createSession(page: Page, prefix: string) {
  const title = `${prefix} ${Date.now()}`;
  await page.getByRole('button', { name: '添加项目', exact: true }).click();
  await page.getByLabel('本机项目目录').fill('D:\\工作\\中文项目');
  await page.getByRole('button', { name: '添加', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.getByRole('button', { name: '新建会话 · D:\\工作\\中文项目', exact: true }).click();
  await expect(page.locator('.session-row.selected strong')).toHaveText('新会话');
  await sessionAction(page, '重命名');
  await page.getByRole('dialog').getByLabel('名称', { exact: true }).fill(title);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('.session-row.selected strong')).toHaveText(title);
  return title;
}
export async function send(page: Page, text: string, scenario = 'chat') {
  await page.getByLabel('模拟场景').selectOption(scenario);
  await expect(page.getByLabel('模拟场景')).toHaveValue(scenario);
  await page.getByRole('textbox', { name: '消息' }).fill(text);
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
}
export async function settled(page: Page) {
  await expect(page.getByRole('textbox', { name: '消息' })).toBeEnabled();
  await expect(page.getByRole('button', { name: '停止运行', exact: true })).not.toBeVisible();
}
