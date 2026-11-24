import { test, expect } from '@playwright/test';
import { login } from './helpers.ts';

// The help is a page of its own: reached from the rail, the menus and the "?" beside controls; its articles link to
// each other, are found by searching, and offer prompts that start a session.
test('help center: front page, articles, search, links and prompts', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await login(page);
  // The "?" beside a heading is styled before the help has ever been opened.
  await expect(page.getByRole('button', { name: '项目和会话是什么', exact: true })).toHaveCSS(
    'width',
    '20px',
  );
  const rail = page.getByRole('navigation', { name: '页面' });
  await rail.getByRole('button', { name: '帮助', exact: true }).click();
  await expect(page.locator('.titlebar h1')).toHaveText('帮助');
  await expect(page.locator('.help-hero h1')).toContainText('你的每台电脑都是它的手');
  const contents = page.getByRole('navigation', { name: '帮助目录' });
  await contents.getByRole('button', { name: '审批模式' }).click();
  await expect(page.locator('.help-article-head h1')).toHaveText('审批模式');
  // The mode menu's own modes are pictured.
  await expect(page.locator('.fig-mode')).toHaveCount(4);
  // A link in the text goes to another article; back returns.
  await page.locator('.help-related-card', { hasText: '对话技巧' }).click();
  await expect(page.locator('.help-article-head h1')).toHaveText('对话技巧');
  await page.getByRole('button', { name: '后退', exact: true }).click();
  await expect(page.locator('.help-article-head h1')).toHaveText('审批模式');
  await page.locator('.help-pager button.next').click();
  await expect(page.locator('.help-article-head h1')).toHaveText('文件面板');
  // Search finds articles by words in their text.
  await page.getByLabel('搜索帮助').fill('额度');
  await expect(page.locator('.help-result').first()).toContainText('额度与用量');
  await page.locator('.help-result').first().click();
  await expect(page.locator('.help-article-head h1')).toHaveText('额度与用量');
  await expect(page.getByLabel('搜索帮助')).toHaveValue('');
  // A settings page's "?" opens its part of the settings guide.
  await page.getByRole('button', { name: '账号与额度', exact: true }).click();
  await page.getByRole('button', { name: '账号与额度：说明', exact: true }).click();
  await expect(page.locator('.help-article-head h1')).toHaveText('设置指南');
  await expect(page.locator('#help-account')).toBeInViewport();
  await page.getByRole('button', { name: '后退', exact: true }).click();
  await page.getByRole('button', { name: '后退', exact: true }).click();
  await expect(page.locator('.help-article-head h1')).toHaveText('额度与用量');
  // A setting the article talks about opens from it.
  await page.getByRole('button', { name: '账号与额度', exact: true }).click();
  await expect(page.locator('.titlebar h1')).toHaveText('账号与额度');
  // The "?" beside the projects heading opens the article on them.
  await rail.getByRole('button', { name: '会话', exact: true }).click();
  await page.getByRole('button', { name: '项目和会话是什么', exact: true }).click();
  await expect(page.locator('.help-article-head h1')).toHaveText('项目与会话');
  // The title bar's menu opens the front page.
  await page.getByRole('button', { name: '帮助', exact: true }).first().click();
  await page.getByRole('menuitem', { name: '使用说明', exact: true }).click();
  await expect(page.locator('.help-hero')).toBeVisible();
  // A prompt to try starts a session with it in the input box, not sent.
  await contents.getByRole('button', { name: '第一次使用' }).click();
  const prompt = page.locator('.help-prompt').first();
  const words = (await prompt.locator('.help-prompt-text').textContent())!.trim();
  await prompt.getByRole('button', { name: '试试', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '消息' })).toHaveValue(words);
  await expect(page.locator('.titlebar h1')).toHaveText('新会话');
  // An empty session offers what to say first.
  await page.getByRole('textbox', { name: '消息' }).fill('');
  await page.locator('.empty-suggestion').first().click();
  await expect(page.getByRole('textbox', { name: '消息' })).not.toHaveValue('');
  expect(errors).toEqual([]);
});
