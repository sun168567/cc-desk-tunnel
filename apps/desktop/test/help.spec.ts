import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { login, screenshots } from './helpers.ts';

// The help is a page of its own: reached from the rail, the menus and the "?" beside controls; its articles link to
// each other, are found by searching, and offer prompts that start a session.
test('help center: front page, articles, search, links and prompts', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await login(page);
  // The prompts to try start a session in a project of this computer: one of its own, not one an earlier test
  // left in the service.
  await page.getByRole('button', { name: '添加项目', exact: true }).click();
  await page.getByLabel('本机项目目录').fill('D:\\工作\\中文项目');
  await page.getByRole('button', { name: '添加', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
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
  // The task list is pictured with the real checklist.
  await expect(page.locator('.fig-tasks .task-checklist li')).toHaveCount(3);
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
  // A setting the article talks about opens from it; the settings page's "?" opens the article on what it is for,
  // and back returns to the page.
  await page.getByRole('button', { name: '账号与额度', exact: true }).click();
  await expect(page.locator('.titlebar h1')).toHaveText('账号与额度');
  await page.getByRole('button', { name: '账号与额度：说明', exact: true }).click();
  await expect(page.locator('.help-article-head h1')).toHaveText('额度与用量');
  await page.getByRole('button', { name: '后退', exact: true }).click();
  await expect(page.locator('.titlebar h1')).toHaveText('账号与额度');
  // The "?" beside a setting opens the part of the help that explains it.
  await page
    .getByRole('navigation', { name: '设置分类' })
    .getByRole('button', { name: '常规', exact: true })
    .click();
  await page.getByRole('button', { name: '允许绕过权限：说明', exact: true }).click();
  await expect(page.locator('.help-article-head h1')).toHaveText('权限相关的开关');
  await expect(page.locator('#help-bypass')).toBeInViewport();
  // A feature new to the window is pictured, with a button that does it, which says why when it cannot yet.
  await rail.getByRole('button', { name: '帮助', exact: true }).click();
  await contents.getByRole('button', { name: '记忆与说明' }).click();
  await expect(page.locator('.fig-sync .fig-files').first()).toContainText('CLAUDE.md');
  // Code inside bold words is code too.
  await expect(page.locator('.help-article td strong code').first()).toHaveText('CLAUDE.md');
  await contents.getByRole('button', { name: '项目与会话' }).click();
  await expect(page.locator('.fig-export .fig-mode')).toHaveCount(3);
  // No session is selected yet.
  await expect(page.getByRole('button', { name: '导出当前会话' })).toBeDisabled();
  await expect(page.locator('.help-target-why')).toHaveText('先选中一个会话');
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

// In English the help is written in English throughout: its articles, its pictures, its search and its links to
// headings, which are named the same in every language.
test('the help in English', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await login(page);
  await page.getByRole('button', { name: '设置与账号', exact: true }).click();
  await page.getByRole('menuitem', { name: '设置', exact: true }).click();
  await page
    .getByRole('navigation', { name: '设置分类' })
    .getByRole('button', { name: '外观', exact: true })
    .click();
  await page
    .getByRole('radiogroup', { name: '界面语言' })
    .getByRole('radio', { name: 'English' })
    .click();
  const rail = page.getByRole('navigation', { name: 'Pages' });
  await rail.getByRole('button', { name: 'Help', exact: true }).click();
  await expect(page.locator('.help-hero h1')).toContainText('a pair of hands for it');
  await expect(page.locator('.fig-map-server')).toContainText('Your server');
  await page.screenshot({ path: resolve(screenshots, 'help-en-home.png') });
  const contents = page.getByRole('navigation', { name: 'Help contents' });
  await expect(contents).toContainText('Getting started');
  await contents.getByRole('button', { name: 'Questions' }).click();
  await page.getByText('Can’t start a session on another computer?').click();
  await page.locator('.help-inline-link', { hasText: 'Several computers' }).click();
  await expect(page.locator('.help-article-head h1')).toHaveText('Several computers');
  await expect(page.locator('#help-no-project')).toHaveText('That computer has no projects yet');
  await expect(page.locator('#help-no-project')).toBeInViewport();
  await page.screenshot({ path: resolve(screenshots, 'help-en-article.png') });
  await page.getByLabel('Search help').fill('quota');
  await expect(page.locator('.help-result').first()).toContainText('Quota and usage');
  expect(errors).toEqual([]);
});
