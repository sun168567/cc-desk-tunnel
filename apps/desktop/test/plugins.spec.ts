import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { strToU8, zipSync } from 'fflate';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createSession, login, screenshots, send, settled } from './helpers.ts';

const shots = resolve(screenshots, 'plugins');
mkdirSync(shots, { recursive: true });
const plugins = resolve('.local/ui-test/sessions/plugins');
const ui = `
export const settings = [
  { title: '钉钉', showWhen: 'on', fields: {
    on: { type: 'boolean', title: '启用钉钉' },
    bell: { type: 'boolean', title: '显示铃铛', default: true },
    url: { type: 'string', title: '机器人地址', sensitive: true, required: true,
      validate: (value: string) => ({ valid: value.startsWith('https://'), message: '要以 https:// 开头' }) },
    format: { type: 'string', title: '格式', description: '消息的样式', options: [{ value: 'card', label: '卡片' }, { value: 'text', label: '文本' }], default: 'card' },
    body: { type: 'string', title: '模板', multiline: true, default: '{session}' },
    test: { type: 'button', title: '测试消息', label: '发送', run: async (all: { url: string }) => ({ ok: true, message: '已发送到 ' + all.url }) },
  } },
];
const state = (icon: string, title: string, more = {}) => ({ icon, title, ...more });
export const slots = { composer: {
  title: '外部推送', showWhen: 'bell', initial: 'off', mark: true,
  hold: { ms: 700, ring: true, effect: 'tremble' },
  states: {
    off: state('bell.svg', '不订阅', { tip: '已取消订阅' }),
    once: state('bell.svg', '本轮', { tip: '已订阅本轮', effect: 'shake', pivot: 'top', active: true }),
    always: state('bell.svg', '持续', { tip: '已持续订阅', effect: 'shake', pivot: 'top', active: true }),
  },
  on: {
    click: { off: 'once', once: 'off', always: 'off' },
    doubleClick: { once: 'always' },
    longPress: { off: 'always', once: 'always' },
    RunEnded: { once: 'off' },
  },
} };`;
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
  writeFileSync(
    resolve(root, 'bell.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/></svg>',
  );
  writeFileSync(resolve(root, 'ui.ts'), ui);
}
// The service watches the directory itself, which stays; Windows keeps a plugin's while a command of it ends.
async function clean() {
  for (const path of ['t.notify', 't.bell', '../plugin-config'])
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

test('a plugin is installed from an archive once its contents were agreed to, and removed', async ({
  page,
}) => {
  await openPlugins(page);
  const choose = (files: Record<string, string>) =>
    page.getByLabel('插件压缩包').setInputFiles({
      name: 'notify.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from(
        zipSync(
          Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])),
        ),
      ),
    });
  await choose({ 'readme.txt': 'nothing' });
  await expect(page.getByRole('alert')).toContainText('没有 .claude-plugin/plugin.json');
  await choose({
    'notify/.claude-plugin/plugin.json': JSON.stringify({
      id: 't.notify',
      displayName: '通知',
      version: '1.0.0',
      permissions: ['full'],
    }),
    'notify/hooks/hooks.json': JSON.stringify({
      hooks: {
        RunEnded: [{ hooks: [{ type: 'command', command: 'node', args: ['notify.mjs'] }] }],
      },
    }),
    // More than one part of an upload.
    'notify/notify.mjs': Array.from({ length: 12_000 }, () => Math.random().toString(36)).join(
      '\n',
    ),
  });
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('node notify.mjs');
  expect(existsSync(resolve(plugins, 't.notify'))).toBe(false);
  await page.screenshot({ path: resolve(shots, 'install.png') });
  await dialog.getByRole('button', { name: '安装', exact: true }).click();
  // It is the user who enables one that is not confined.
  const row = page.locator('.plugin-open').filter({ hasText: '通知' });
  await expect(row).toContainText('它要完整权限，由你启用。');
  page.once('dialog', (asked) => void asked.accept());
  await page.getByRole('switch', { name: '启用 通知' }).click();
  await expect(row).toHaveText('通知');
  await row.click();
  await expect(page.locator('.workspace')).toContainText('1.0.0');
  await page.locator('.plugin-back').click();
  page.once('dialog', (asked) => void asked.accept());
  await page.getByRole('button', { name: '删除 通知' }).click();
  await expect(page.getByText('还没有插件')).toBeVisible();
  expect(existsSync(resolve(plugins, 't.notify'))).toBe(false);
});

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

test('a plugin’s button goes by click, double click and long press, in every window, and by the end of a run', async ({
  page,
  context,
}) => {
  add('t.bell');
  await page.goto('/');
  await login(page);
  await createSession(page, '订阅');
  const bell = page.getByRole('button', { name: '外部推送', exact: true });
  const mark = page.locator('.session-row.selected').getByRole('img', { name: /外部推送/ });
  await expect(bell).toHaveAttribute('title', '外部推送：不订阅');
  await bell.click();
  await expect(bell).toHaveAttribute('title', '外部推送：本轮');
  await expect(page.getByRole('status').filter({ hasText: '已订阅本轮' })).toBeVisible();
  await expect(mark).toHaveAttribute('aria-label', '外部推送：本轮');
  await page.waitForTimeout(450);
  await bell.click();
  await expect(bell).toHaveAttribute('title', '外部推送：不订阅');
  await expect(mark).toHaveCount(0);
  await page.waitForTimeout(450);
  await bell.dblclick();
  await expect(bell).toHaveAttribute('title', '外部推送：持续');
  await page.waitForTimeout(450);
  await bell.click();

  // Let go before it counts, a long press was thought better of.
  const box = (await bell.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect(page.locator('.slot-ring')).toBeVisible();
  await expect(page.locator('.slot-icon.tremble')).toBeVisible();
  await page.screenshot({ path: resolve(shots, 'hold.png') });
  await page.mouse.up();
  await page.waitForTimeout(450);
  await expect(bell).toHaveAttribute('title', '外部推送：不订阅');
  await page.mouse.down();
  await expect(bell).toHaveAttribute('title', '外部推送：持续');
  await page.mouse.up();
  await page.screenshot({ path: resolve(shots, 'subscribed.png') });

  const other = await context.newPage();
  await other.goto('/');
  await login(other);
  await other.locator('.session-row').filter({ hasText: '订阅' }).first().click();
  const there = other.getByRole('button', { name: '外部推送', exact: true });
  await expect(there).toHaveAttribute('title', '外部推送：持续');
  await there.click();
  await expect(bell).toHaveAttribute('title', '外部推送：不订阅');
  await other.waitForTimeout(450);
  await there.click();
  await expect(bell).toHaveAttribute('title', '外部推送：本轮');
  await send(page, '梳理当前项目');
  await settled(page);
  await expect(bell).toHaveAttribute('title', '外部推送：不订阅');
  await expect(there).toHaveAttribute('title', '外部推送：不订阅');
});
