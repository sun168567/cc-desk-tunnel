import { test, expect, _electron } from '@playwright/test';
import type { Page } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { connectionArgs, signInWindow } from './helpers.ts';

// Pictures of the panel for a review, when asked for.
const shot = async (page: Page, name: string) => {
  if (process.env.FILE_SHOTS)
    await page.screenshot({ path: resolve(process.env.FILE_SHOTS, `${name}.png`) });
};

// The file panel on this computer's files, beside a session of a project here. (The service's files and other
// computers' go through the same panel over SFTP; that path is tested in apps/server/test/files.test.ts and
// apps/desktop/test-main/files.test.mjs.)
test('Electron: the file panel shows the project, previews files and copies, renames and removes them', async () => {
  test.slow();
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env))
    if (value !== undefined && name !== 'ELECTRON_RUN_AS_NODE') env[name] = value;
  const profile = resolve('.local/ui-test/profile-files');
  rmSync(profile, { recursive: true, force: true });
  const base = mkdtempSync(join(tmpdir(), 'cc-file-panel-'));
  const project = join(base, '示例项目');
  mkdirSync(join(project, 'docs'), { recursive: true });
  mkdirSync(join(project, 'src'));
  writeFileSync(join(project, 'README.md'), '# 示例项目\n\n- 第一条\n- 第二条\n');
  writeFileSync(
    join(project, 'src', 'main.ts'),
    Array.from({ length: 40 }, (_, line) => `export const value${line} = ${line};`).join('\n'),
  );
  writeFileSync(join(project, 'docs', 'notes.txt'), '笔记');
  writeFileSync(join(project, 'data.bin'), Buffer.from([0, 1, 2, 3, 0, 5]));
  copyIcon(join(project, 'docs', 'icon.png'));
  const outside = join(base, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'upload.txt'), 'uploaded');
  const application = await _electron.launch({
    args: [resolve('apps/desktop'), '--smoke-test', ...connectionArgs(profile)],
    env,
  });
  try {
    const page = await signInWindow(application);
    await application.evaluate(
      ({ dialog }, { project, picks }) => {
        dialog.showOpenDialog = (async (_window: unknown, options: { properties?: string[] }) => ({
          canceled: false,
          filePaths: options.properties?.includes('openFile') ? picks.shift() : [project],
        })) as typeof dialog.showOpenDialog;
      },
      { project, picks: [[join(outside, 'upload.txt')], [join(outside, 'upload.txt')]] },
    );
    await page.getByRole('button', { name: '添加项目', exact: true }).click();
    await page.getByRole('button', { name: `新建会话 · ${project}`, exact: true }).click();

    // Opened beside the conversation, at the session's project.
    await page.getByRole('button', { name: /打开文件面板/ }).click();
    const panel = page.getByRole('complementary', { name: '文件' });
    await expect(panel.getByRole('tab', { name: '本机' })).toHaveCount(0);
    await expect(panel.locator('.file-crumb-list .current')).toHaveText('示例项目');
    const row = (name: string) => panel.locator('.file-tree .file-row', { hasText: name }).first();
    await expect(row('docs')).toBeVisible();
    await expect(row('README.md')).toBeVisible();
    // The message box keeps its place beside the panel.
    await expect(page.getByRole('textbox', { name: '消息' })).toBeInViewport();
    await shot(page, '1-侧栏-目录树');

    // Narrow, a file's preview takes the panel's place, and goes back to the tree.
    await row('README.md').click();
    const preview = panel.getByRole('region', { name: '文件预览' });
    await expect(preview.getByRole('heading', { name: '示例项目' })).toBeVisible();
    await preview.getByRole('button', { name: '原文', exact: true }).click();
    await expect(preview.locator('.file-code')).toContainText('- 第一条');
    await shot(page, '2-侧栏-预览');
    await preview.getByRole('button', { name: '返回目录', exact: true }).click();

    // With the session list put away, made wider, the tree and the preview sit side by side. (Beside the list in
    // a window of the default size the conversation keeps its room, and the panel cannot be made that wide.)
    await page.getByRole('button', { name: '收起侧栏', exact: true }).click();
    const handle = panel.getByRole('separator', { name: '调整文件面板宽度' });
    const box = (await handle.boundingBox())!;
    await page.mouse.move(box.x + 4, box.y + 200);
    await page.mouse.down();
    await page.mouse.move(box.x - 300, box.y + 200, { steps: 8 });
    await page.mouse.up();
    await row('src').click();
    await row('main.ts').click();
    await expect(preview.locator('.file-code')).toContainText('export const value39 = 39;');
    await expect(preview.locator('.line-number').first()).toHaveText('1');
    await expect(page.getByRole('textbox', { name: '消息' })).toBeInViewport();
    await shot(page, '3-宽栏-代码预览');
    await row('docs').click();
    await row('icon.png').click();
    await expect
      .poll(() => preview.locator('img').evaluate((image: HTMLImageElement) => image.naturalWidth))
      .toBeGreaterThan(0);
    await row('data.bin').click();
    await expect(preview).toContainText('不是文本');

    // Uploaded from elsewhere on this computer; once more, the name taken, it is left as it is.
    await panel.getByRole('button', { name: '上传文件…', exact: true }).click();
    await expect(row('upload.txt')).toBeVisible();
    await panel.getByRole('button', { name: '上传文件…', exact: true }).click();
    const conflict = page.getByRole('dialog').filter({ hasText: '目标位置已有同名项' });
    await expect(conflict).toContainText('upload.txt');
    await shot(page, '4-同名确认');
    await conflict.getByRole('button', { name: '跳过', exact: true }).click();

    // A folder made, renamed and removed from the menu.
    await panel.locator('.file-tree').click({ button: 'right', position: { x: 60, y: 300 } });
    await page.getByRole('menuitem', { name: '新建文件夹' }).click();
    await page
      .getByRole('dialog')
      .filter({ hasText: '新建文件夹' })
      .getByLabel('名称')
      .fill('新文件夹');
    await page.getByRole('button', { name: '确定', exact: true }).click();
    await expect(row('新文件夹')).toBeVisible();
    expect(existsSync(join(project, '新文件夹'))).toBe(true);
    await row('新文件夹').click({ button: 'right' });
    await page.getByRole('menuitem', { name: '重命名' }).click();
    await page.getByRole('dialog').filter({ hasText: '重命名' }).getByLabel('名称').fill('改名后');
    await page.getByRole('button', { name: '确定', exact: true }).click();
    await expect(row('改名后')).toBeVisible();
    await row('改名后').click({ button: 'right' });
    await page.getByRole('menuitem', { name: '删除' }).click();
    await page
      .getByRole('dialog')
      .filter({ hasText: '删除' })
      .getByRole('button', { name: '删除' })
      .click();
    await expect(row('改名后')).toHaveCount(0);
    expect(existsSync(join(project, '改名后'))).toBe(false);
    expect(readFileSync(join(project, 'upload.txt'), 'utf8')).toBe('uploaded');

    // As a page of its own: the folder's list between the tree and the preview.
    await panel.getByRole('button', { name: '展开为整页', exact: true }).click();
    const list = panel.locator('.file-list');
    await expect(list).toContainText('README.md');
    await list.getByRole('row', { name: /src/ }).click();
    await expect(list).toContainText('main.ts');
    await list.getByRole('row', { name: /main\.ts/ }).click();
    await expect(panel.getByRole('region', { name: '文件预览' })).toContainText('value39');
    await expect(page.locator('.workspace')).toBeHidden();
    await shot(page, '5-整页');
    await panel.getByRole('button', { name: '收回侧栏', exact: true }).click();
    await expect(page.getByRole('textbox', { name: '消息' })).toBeInViewport();

    // Closed and opened again by its shortcut, where it was.
    await page.keyboard.press('Control+Shift+KeyE');
    await expect(panel).toHaveCount(0);
    await page.keyboard.press('Control+Shift+KeyE');
    await expect(panel.locator('.file-crumb-list .current')).toHaveText('示例项目');
  } finally {
    await application.close();
    rmSync(base, { recursive: true, force: true });
  }
});

function copyIcon(to: string) {
  writeFileSync(to, readFileSync(resolve('apps/desktop/electron/icon.png')));
}
