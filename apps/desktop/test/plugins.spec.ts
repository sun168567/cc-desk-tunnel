import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { login, screenshots } from './helpers.ts';

const shots = resolve(screenshots, 'plugins');
mkdirSync(shots, { recursive: true });
const plugins = resolve('.local/ui-test/sessions/plugins');
// A plugin as one is put in place: a manifest that declares its settings, and a command for a turn's end that says
// what it was given.
function add(id: string) {
  const root = resolve(plugins, id);
  mkdirSync(resolve(root, '.claude-plugin'), { recursive: true });
  mkdirSync(resolve(root, 'hooks'), { recursive: true });
  writeFileSync(
    resolve(root, '.claude-plugin/plugin.json'),
    JSON.stringify({
      name: id,
      displayName: '通知',
      version: '0.1.0',
      description: '推送到手机',
      author: { name: '作者甲' },
      userConfig: {
        token: { type: 'string', title: '令牌', sensitive: true, required: true },
        format: { type: 'string', title: '格式', options: ['card', 'text'], default: 'card' },
        retries: { type: 'number', title: '重试次数', min: 0, max: 5 },
        quiet: { type: 'boolean', title: '安静', description: '夜里不推' },
      },
    }),
  );
  writeFileSync(resolve(root, 'say.mjs'), "console.log('收到', process.argv[2]);\n");
  writeFileSync(
    resolve(root, 'hooks/hooks.json'),
    JSON.stringify({
      hooks: {
        RunEnded: [
          {
            hooks: [
              {
                type: 'command',
                command: process.execPath,
                args: ['${CLAUDE_PLUGIN_ROOT}/say.mjs', '${user_config.format}'],
              },
            ],
          },
        ],
      },
    }),
  );
}
// The service watches the directory itself, which stays; Windows keeps a plugin's while a command of it ends.
async function clean() {
  for (const path of ['t.notify', '../plugin-config', '../plugin-logs', '../plugin-data'])
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

test('a plugin put in place is listed and set from what it declares, tried, and its runs are logged', async ({
  page,
}) => {
  await openPlugins(page);
  await expect(page.getByText('还没有插件')).toBeVisible();
  add('t.notify');
  const card = page.getByRole('region', { name: '通知' });
  await expect(card).toContainText('推送到手机');
  await expect(card).toContainText('版本 0.1.0 · 作者 作者甲');
  // Its required setting has no value: it says so and runs nothing.
  await expect(card.locator('.plugin-trouble')).toHaveText('要先设置：「令牌」');
  const enabled = page.getByRole('switch', { name: '启用 通知' });
  await enabled.click();
  await expect(enabled).not.toBeChecked();
  await enabled.click();
  await expect(enabled).toBeChecked();

  await card.getByRole('button', { name: /通知/ }).click();
  const token = card.getByLabel('令牌', { exact: true });
  await token.fill('secret-1234');
  await token.press('Enter');
  await expect(card.locator('.plugin-trouble')).toHaveCount(0);
  // The secret is not shown again; an empty box keeps it.
  await expect(card.getByLabel('令牌', { exact: true })).toHaveValue('');
  await expect(card.getByLabel('令牌', { exact: true })).toHaveAttribute(
    'placeholder',
    '已设置，留空不变',
  );
  await card.getByLabel('格式', { exact: true }).selectOption('text');
  const retries = card.getByLabel('重试次数', { exact: true });
  await retries.fill('9');
  await retries.press('Enter');
  await expect(card).toContainText('“重试次数”不能大于 5。');
  await retries.fill('2');
  await retries.press('Enter');
  await expect(card).not.toContainText('“重试次数”不能大于 5。');
  await card.getByRole('switch', { name: '安静', exact: true }).click();
  await expect(card.getByRole('switch', { name: '安静', exact: true })).toBeChecked();

  await card.getByRole('button', { name: '一轮结束', exact: true }).click();
  const run = card.locator('.plugin-log li').first();
  await expect(run).toContainText('一轮结束');
  await expect(run).toContainText('试跑');
  await expect(run).toContainText('成功');
  await expect(run.locator('pre')).toHaveText('收到 text');
  await page.screenshot({ path: resolve(shots, 'settings.png'), fullPage: true });

  // Drawn again from what the service holds, the card shows what was set.
  const open = card.getByRole('button', { name: /通知/ });
  await open.click();
  await expect(card.getByLabel('格式', { exact: true })).toHaveCount(0);
  await open.click();
  await expect(card.getByLabel('格式', { exact: true })).toHaveValue('text');
  await expect(card.getByLabel('重试次数', { exact: true })).toHaveValue('2');

  // On a phone's width nothing is wider than the page.
  await page.setViewportSize({ width: 360, height: 780 });
  await page.waitForTimeout(400);
  const workspace = page.locator('.workspace');
  expect(await workspace.evaluate((node) => node.scrollWidth - node.clientWidth)).toBe(0);
  await page.screenshot({ path: resolve(shots, 'narrow.png'), fullPage: true });
});
