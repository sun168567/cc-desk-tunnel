import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Screenshots are for the eye and stay on this machine.
export const screenshots = resolve('.local/screenshots');
mkdirSync(resolve(screenshots, 'redesign'), { recursive: true });
export function connection() {
  return JSON.parse(readFileSync(resolve('.local/ui-test/dev-connection.json'), 'utf8')) as {
    serverUrl: string;
    token: string;
  };
}
export async function login(page: Page) {
  const config = connection();
  const localMode = page.getByRole('button', { name: '本地模拟', exact: true });
  if (await localMode.isVisible()) await localMode.click();
  await page.getByLabel('服务地址').fill(config.serverUrl);
  await page.getByLabel('服务凭据').fill(config.token);
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await expect(page.locator('.connection-status')).toContainText('已连接');
}
// Finished turns, runs of tool calls and each call are folded; open them all to inspect the details.
export async function expandActivity(page: Page) {
  for (const selector of ['.turn-process', '.work', '.tool'])
    while (await page.locator(`${selector}:not([open]) > summary`).count())
      await page.locator(`${selector}:not([open]) > summary`).first().click();
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
  await page.getByLabel('Windows 项目目录').fill('D:\\工作\\中文项目');
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
  await page.getByRole('textbox', { name: '消息' }).fill(text);
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
}
export async function settled(page: Page) {
  await expect(page.getByRole('textbox', { name: '消息' })).toBeEnabled();
  await expect(page.getByRole('button', { name: '停止运行', exact: true })).not.toBeVisible();
}
