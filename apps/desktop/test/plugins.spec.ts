import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { login, screenshots } from './helpers.ts';

const shots = resolve(screenshots, 'plugins');
mkdirSync(shots, { recursive: true });
const plugins = resolve('.local/ui-test/sessions/plugins');
const ui = `
export const settings = [
  { title: '钉钉', showWhen: 'on', fields: {
    on: { type: 'boolean', title: '启用钉钉' },
    url: { type: 'string', title: '机器人地址', sensitive: true, required: true,
      validate: (value: string) => ({ valid: value.startsWith('https://'), message: '要以 https:// 开头' }) },
    format: { type: 'string', title: '格式', description: '消息的样式', options: [{ value: 'card', label: '卡片' }, { value: 'text', label: '文本' }], default: 'card' },
    body: { type: 'string', title: '模板', multiline: true, default: '{session}' },
    test: { type: 'button', title: '测试消息', label: '发送', run: async (all: { url: string }) => ({ ok: true, message: '已发送到 ' + all.url }) },
  } },
];`;
function add(id: string) {
  const root = resolve(plugins, id);
  // Enabled by the user, as one is where the system cannot confine it.
  mkdirSync(resolve(plugins, '../plugin-config'), { recursive: true });
  writeFileSync(resolve(plugins, `../plugin-config/${id}.json`), '{"agreed":true}');
  mkdirSync(resolve(root, '.claude-plugin'), { recursive: true });
  mkdirSync(resolve(root, 'hooks'), { recursive: true });
  writeFileSync(
    resolve(root, '.claude-plugin/plugin.json'),
    JSON.stringify({
      id,
      displayName: '通知',
      version: '0.1.0',
      description: '推送到钉钉',
      author: { name: '作者甲' },
      repository: 'https://example.com/notify',
    }),
  );
  writeFileSync(
    resolve(root, 'hooks/hooks.json'),
    JSON.stringify({
      hooks: {
        RunEnded: [
          { hooks: [{ type: 'command', command: 'node', args: ['-e', 'console.log("收到")'] }] },
        ],
      },
    }),
  );
  writeFileSync(resolve(root, 'ui.ts'), ui);
}
// The service watches the directory itself, which stays; Windows keeps a plugin's while a command of it ends.
async function clean() {
  for (const path of ['t.notify', '../plugin-config'])
    await expect
      .poll(() => {
        try {
          rmSync(resolve(plugins, path), { recursive: true, force: true });
          return true;
        } catch {
          return false;
        }
      })
      .toBe(true);
}
test.beforeAll(clean);
test.afterEach(clean);

async function openPlugins(page: Page) {
  await page.goto('/');
  await login(page);
  await page.getByRole('button', { name: '设置与账号', exact: true }).click();
  await page.getByRole('menuitem', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '插件', exact: true }).click();
}

test('a plugin put in place is set on its own page, each change saved at once, tried and switched off', async ({
  page,
}) => {
  await openPlugins(page);
  await expect(page.getByText('还没有插件')).toBeVisible();
  add('t.notify');
  page.on('dialog', (asked) => void asked.accept());
  const row = page.locator('.plugin-open').filter({ hasText: '通知' });
  // One that goes well says nothing of it.
  await expect(row).toHaveText('通知推送到钉钉');
  await row.click();
  const form = page.locator('.workspace');
  await expect(form.getByRole('heading', { level: 1 })).toHaveText('通知');
  await expect(form).toContainText('作者甲');
  const url = form.getByLabel('机器人地址');
  await expect(url).toHaveCount(0);
  await form.getByRole('switch', { name: '启用钉钉' }).click();
  await expect(form.getByRole('alert')).toHaveText('未运行：待配置：机器人地址');
  // Each change is saved when its box is left; one that does not hold stays there, told of.
  await url.fill('http://x');
  await url.blur();
  await expect(form).toContainText('要以 https:// 开头');
  await expect(url).toHaveValue('http://x');
  await url.fill('https://example.com/robot');
  await url.press('Enter');
  await expect(url).toHaveAttribute('placeholder', '已设置，留空沿用');
  await expect(url).toHaveValue('');
  await expect(form.getByRole('alert')).toHaveCount(0);
  await form.getByLabel('格式').selectOption({ label: '文本' });
  await form.getByLabel('模板').fill('{session} {project}');
  await form.getByLabel('模板').blur();
  await form.getByRole('button', { name: '发送' }).click();
  await expect(form.getByRole('status')).toHaveText('已发送到 ***');
  await form.getByRole('button', { name: '运行', exact: true }).click();
  await expect(form.locator('pre')).toContainText('收到');
  await page.screenshot({ path: resolve(shots, 'settings.png'), fullPage: true });

  // On a phone's width the way back is the title bar's, and nothing is wider than the page.
  await page.setViewportSize({ width: 360, height: 780 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: resolve(shots, 'narrow.png') });
  const wide = () => form.evaluate((node) => node.scrollWidth - node.clientWidth);
  expect(await wide()).toBe(0);
  await page.getByRole('button', { name: '后退', exact: true }).click();
  await expect(row).toBeVisible();
  await page.waitForTimeout(400);
  expect(await wide()).toBe(0);
  await page.screenshot({ path: resolve(shots, 'narrow-list.png') });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: resolve(shots, 'list.png') });

  await page.getByRole('button', { name: '通知：日志' }).click();
  await expect(page.locator('.plugin-log')).toContainText('[试跑] RunEnded → 成功');
  await expect(page.locator('.plugin-log')).not.toContainText('example.com');
  await page.screenshot({ path: resolve(shots, 'log.png') });
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('switch', { name: '启用 通知' }).click();
  await row.click();
  await expect(form.getByLabel('启用钉钉')).toHaveCount(0);
  await form.getByRole('switch', { name: '启用 通知' }).click();
  await expect(form.getByLabel('格式')).toHaveValue('text');
  await expect(form.getByLabel('模板')).toHaveValue('{session} {project}');
});
