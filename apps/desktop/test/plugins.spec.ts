import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { login, screenshots } from './helpers.ts';

const shots = resolve(screenshots, 'plugins');
mkdirSync(shots, { recursive: true });
const plugins = resolve('.local/ui-test/sessions/plugins');
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

test('a plugin put in place is listed, has a page of its own and is switched off and on', async ({
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

  await page.getByRole('switch', { name: '启用 通知' }).click();
  await expect(page.getByRole('switch', { name: '启用 通知' })).not.toBeChecked();
  await page.getByRole('switch', { name: '启用 通知' }).click();
  await expect(page.getByRole('switch', { name: '启用 通知' })).toBeChecked();
});
