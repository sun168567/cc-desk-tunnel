import { expect, test } from '@playwright/test';
import { createSession, login } from './helpers.ts';

test('the bottom model list chooses the vendor', async ({ page }) => {
  await page.goto('/');
  await login(page);
  await expect(page.getByRole('button', { name: '新建 OpenAI 会话' })).toHaveCount(0);
  await page.getByRole('button', { name: '文件', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: '新建 OpenAI 会话' })).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: '新建会话', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await createSession(page, '模型');
  const models = page.getByLabel('会话模型');
  await expect(models.locator('optgroup')).toHaveCount(2);
  await models.selectOption('openai:');
  await expect(page.getByRole('alert')).toContainText('Codex');
  await expect(page.locator('.session-row.selected')).not.toContainText('OpenAI');
});
