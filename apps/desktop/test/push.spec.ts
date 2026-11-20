import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createSession, login, screenshots } from './helpers.ts';

const shots = resolve(screenshots, 'push');

// The bell beside the approval mode shows once the service has a channel to push to; what a session is subscribed to
// is marked in the list. The channel's address is not shown again once it is added.
test('a session is subscribed to pushes from beside the input box once a channel is set up', async ({
  page,
}) => {
  mkdirSync(shots, { recursive: true });
  await page.goto('/');
  await login(page);
  const title = await createSession(page, '推送');
  const bell = page.getByRole('button', { name: '外部推送', exact: true });
  await expect(bell).toHaveCount(0);

  await page.getByRole('button', { name: '设置与账号', exact: true }).click();
  await page.getByRole('menuitem', { name: '设置', exact: true }).click();
  await page
    .getByRole('navigation', { name: '设置分类' })
    .getByRole('button', { name: '外部推送', exact: true })
    .click();
  const panel = page.getByRole('region', { name: '外部推送' });
  await panel.getByRole('switch', { name: '开启外部推送', exact: true }).click();
  await panel.getByRole('button', { name: '添加渠道', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('类型').selectOption('bark');
  await dialog.getByLabel('Bark 地址').fill('https://api.day.app/ui-test-key');
  await dialog.getByRole('button', { name: '确认', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(panel.getByRole('switch', { name: '启用 Bark', exact: true })).toBeChecked();
  await expect(panel).not.toContainText('ui-test-key');
  await page.screenshot({ path: resolve(shots, 'settings.png') });
  // Changed without the address it sends to, which is not shown again and is kept.
  await panel.getByRole('button', { name: '编辑 Bark', exact: true }).click();
  await expect(dialog.getByLabel('Bark 地址')).toHaveValue('');
  await expect(dialog.getByLabel('Bark 地址')).toHaveAttribute('placeholder', '已设置，留空不修改');
  await dialog.getByLabel('标题').fill('{session}');
  await expect(dialog.locator('.push-preview')).toContainText('修复登录页样式');
  await page.screenshot({ path: resolve(shots, 'edit.png') });
  await dialog.getByRole('button', { name: '确认', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(panel).not.toContainText('ui-test-key');

  await page.getByRole('button', { name: '会话', exact: true }).click();
  await expect(page.locator('.session-row.selected strong')).toHaveText(title);
  const tip = page.locator('.push-tip');
  await bell.click();
  await expect(bell).toHaveAttribute('title', /^外部推送：本轮/);
  await expect(tip).toContainText('已订阅本轮');
  await expect(page.locator('.session-row.selected').getByLabel('本轮推送')).toBeVisible();
  await page.screenshot({ path: resolve(shots, 'subscribed.png') });
  // A toolbar too narrow for the native controls, as on a phone, folds the approval mode to its icon; the bell keeps
  // its own. The simulated service has none of those controls, so the toolbar is folded here by hand, and read before
  // it measures itself again.
  const folded = await page.locator('.composer-toolbar').evaluate((bar) => {
    bar.classList.add('compact-permission');
    const icon = bar.querySelector('[aria-label="外部推送"] svg')!;
    return getComputedStyle(icon).display;
  });
  expect(folded).not.toBe('none');
  // Past the window in which a second click makes the subscription lasting, a click cancels it.
  await page.waitForTimeout(500);
  await bell.click();
  await expect(tip).toHaveText('已取消订阅');
  await expect(page.locator('.session-row.selected .push-mark')).toHaveCount(0);
  await bell.dblclick();
  await expect(page.locator('.session-row.selected').getByLabel('持续推送')).toBeVisible();
  await page.waitForTimeout(500);
  await bell.click();
  await expect(page.locator('.session-row.selected .push-mark')).toHaveCount(0);

  // The simulated service keeps its settings between runs.
  await page.getByRole('button', { name: '设置与账号', exact: true }).click();
  await page.getByRole('menuitem', { name: '设置', exact: true }).click();
  await page
    .getByRole('navigation', { name: '设置分类' })
    .getByRole('button', { name: '外部推送', exact: true })
    .click();
  await panel.getByRole('button', { name: '删除 Bark', exact: true }).click();
  await panel.getByRole('switch', { name: '开启外部推送', exact: true }).click();
  await expect(panel.getByRole('switch', { name: '开启外部推送', exact: true })).not.toBeChecked();
});
