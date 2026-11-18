import { test, expect, _electron } from '@playwright/test';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { connectionArgs, signInWindow, screenshots } from './helpers.ts';

// Files put in a message show as files where they stand, in the box and in the question sent; the text holds
// their quoted paths, as before.
test('Electron: files in a message show as files, and are sent as their paths', async () => {
  test.skip(process.platform !== 'win32', 'Windows desktop test');
  test.slow();
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env))
    if (value !== undefined && name !== 'ELECTRON_RUN_AS_NODE') env[name] = value;
  const profile = resolve('.local/ui-test/profile-attachments');
  rmSync(profile, { recursive: true, force: true });
  const application = await _electron.launch({
    args: [resolve('apps/desktop'), '--smoke-test', ...connectionArgs(profile)],
    env,
  });
  try {
    const launcher = await application.firstWindow();
    await expect(
      launcher.getByRole('heading', { name: '连接代理服务', exact: true }),
    ).toBeVisible();
    const page = await signInWindow(application);
    const repository = resolve('.');
    const picture = resolve('apps/desktop/electron/icon.png');
    const file = resolve('package.json');
    // The folder for the project; then, one dialog after another, the files chosen.
    await application.evaluate(
      ({ dialog }, { repository, picks }) => {
        dialog.showOpenDialog = (async (_window: unknown, options: { properties?: string[] }) => ({
          canceled: false,
          filePaths: options.properties?.includes('openDirectory') ? [repository] : picks.shift(),
        })) as typeof dialog.showOpenDialog;
      },
      { repository, picks: [[picture, file], [file]] },
    );
    await page.getByRole('button', { name: '添加项目', exact: true }).click();
    await page.getByRole('button', { name: `新建会话 · ${repository}`, exact: true }).click();
    const box = page.getByRole('textbox', { name: '消息' });
    await box.fill('看看 ');
    await page.getByRole('button', { name: /^添加文件/ }).click();
    const chips = box.locator('.path-chip');
    await expect(chips).toHaveCount(2);
    await expect(chips.first()).toHaveAttribute('title', picture);
    await expect(chips.nth(1)).toHaveText('package.json');
    // The picture is the picture itself.
    await expect
      .poll(() =>
        chips
          .first()
          .locator('img')
          .evaluate((image: HTMLImageElement) => image.naturalWidth),
      )
      .toBeGreaterThan(0);
    await page.keyboard.type('有什么');
    await page.screenshot({ path: resolve(screenshots, 'redesign', '17-输入框里的文件.png') });
    // Taken out again, with the space after it.
    await chips.nth(1).hover();
    await chips.nth(1).locator('.path-chip-remove').click();
    await expect(chips).toHaveCount(1);
    await page.keyboard.press('End');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('第二行');
    await page.getByRole('button', { name: /^添加文件/ }).click();
    await expect(chips).toHaveCount(2);
    // A picture opens whole, and closes.
    await chips.first().click();
    const viewer = page.locator('dialog:has(.picture-view)');
    await expect(viewer.locator('.picture-view img')).toBeVisible();
    await expect(viewer.getByRole('heading', { name: 'icon.png' })).toBeVisible();
    await viewer.getByRole('button', { name: '关闭', exact: true }).click();
    await expect(viewer).toHaveCount(0);
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    const question = page.locator('.message.user .message-content').first();
    await expect(question).toHaveAttribute(
      'data-copy-text',
      `看看 "${picture}" 有什么\n第二行 "${file}"`,
    );
    await expect(box).toHaveText('');
    await expect
      .poll(() =>
        question
          .locator('.path-chip img')
          .evaluate((image: HTMLImageElement) => image.naturalWidth),
      )
      .toBeGreaterThan(0);
    await expect(question.locator('a.path-chip')).toHaveText('package.json');
    await expect(question.locator('button.path-chip')).toHaveAttribute('title', picture);
    await question.locator('button.path-chip').click();
    await expect(viewer.locator('.picture-view img')).toBeVisible();
    await viewer.getByRole('button', { name: '关闭', exact: true }).click();
    await page.screenshot({ path: resolve(screenshots, 'redesign', '18-问题里的文件.png') });
  } finally {
    await application.close();
  }
});
