import { test, expect, _electron } from '@playwright/test';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createSession, login, send, settled, screenshots } from './helpers.ts';

test('message dates, selection menu, code copy and conversation find work together', async ({
  page,
}) => {
  await page.goto('/');
  await login(page);
  await createSession(page, '阅读工具');
  await page.evaluate(() => {
    Object.defineProperty(navigator.clipboard, 'writeText', {
      value: async (text: string) => {
        (window as unknown as { copied: string }).copied = text;
      },
    });
  });
  await send(page, '阅读唯一词 阅读唯一词');
  await settled(page);
  const time = page.locator('.message.user time');
  await expect(time).toContainText(/今天 \d\d:\d\d/);
  await expect(time).toHaveAttribute('datetime', /T/);
  await expect(time).toHaveAttribute('title', /\d{4}.*\d\d:\d\d:\d\d/);
  const user = page.locator('.message.user .message-content');
  const selectionPoint = await user.evaluate((element) => {
    const text = element.querySelector('p')!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 5);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    const box = range.getBoundingClientRect();
    return { x: box.x + 5, y: box.y + box.height / 2 };
  });
  await page.mouse.click(selectionPoint.x, selectionPoint.y, { button: 'right' });
  await page.getByRole('menuitem', { name: '复制选中文字', exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { copied: string }).copied)).toBe(
    '阅读唯一词',
  );
  await page.keyboard.press('Control+f');
  const find = page.getByRole('search', { name: '对话内查找' });
  await find.getByRole('textbox').fill('阅读唯一词');
  await expect(find.getByRole('status')).toHaveText('1 / 4');
  await find.getByRole('button', { name: '下一个匹配（Enter）', exact: true }).click();
  await expect(find.getByRole('status')).toHaveText('2 / 4');
  await find.getByRole('textbox').press('Enter');
  await expect(find.getByRole('status')).toHaveText('3 / 4');
  await find.getByRole('textbox').press('Shift+Enter');
  await expect(find.getByRole('status')).toHaveText('2 / 4');
  await find.getByRole('textbox').press('Shift+Enter');
  await find.getByRole('textbox').press('Shift+Enter');
  await expect(find.getByRole('status')).toHaveText('4 / 4');
  await find.getByRole('textbox').fill('这是 离线模拟回复');
  await expect(find.getByRole('status')).toHaveText('1 / 1');
  expect(
    await page.evaluate(() =>
      [...CSS.highlights.get('conversation-current')!].map((r) => r.toString()),
    ),
  ).toEqual(['这是 离线模拟回复']);
  await find.getByRole('textbox').fill('[不存在.*]');
  await expect(find.getByRole('status')).toHaveText('0 / 0');
  await find.getByRole('textbox').press('Escape');
  await expect(find).toHaveCount(0);
  expect(await page.evaluate(() => CSS.highlights.has('conversation-matches'))).toBe(false);
  await send(page, '代码：\n```js\nconst value = "中文";\n```');
  await settled(page);
  await page.keyboard.press('Control+f');
  await find.getByRole('textbox').fill('const value');
  const copy = page.getByRole('button', { name: '复制代码', exact: true }).first();
  await expect(copy).toBeVisible();
  await copy.click();
  expect(await page.evaluate(() => (window as unknown as { copied: string }).copied)).toBe(
    'const value = "中文";\n',
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(find).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: join(screenshots, 'conversation-find-narrow.png') });
});

test('find opens folded tool details then restores folds, and never steals dialog shortcuts', async ({
  page,
}) => {
  await page.goto('/');
  await login(page);
  await createSession(page, '折叠查找');
  await send(page, '查看工具', 'tool');
  await page.getByRole('button', { name: '允许', exact: true }).click();
  await settled(page);
  await expect(page.locator('.turn-process')).not.toHaveAttribute('open');
  await page.keyboard.press('Control+f');
  await page.getByLabel('查找对话内容', { exact: true }).fill('Get-Location');
  await expect(page.locator('.find-count')).toHaveText('1 / 1');
  await expect(page.locator('.tool-input')).toBeVisible();
  await page.getByLabel('查找对话内容', { exact: true }).press('Escape');
  await expect(page.locator('.turn-process')).not.toHaveAttribute('open');
  await page.getByRole('button', { name: '添加项目', exact: true }).click();
  await page.keyboard.press('Control+f');
  await expect(page.getByRole('search', { name: '对话内查找' })).toHaveCount(0);
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
  await page.keyboard.press('Control+f');
  await page.getByLabel('查找对话内容', { exact: true }).fill('Get-Location');
  await createSession(page, '另一会话');
  await expect(page.getByRole('search', { name: '对话内查找' })).toHaveCount(0);
});

test('find covers the loaded part of a long session and follows it as earlier pages are loaded', async ({
  page,
}) => {
  await page.goto('/');
  await login(page);
  const title = await createSession(page, '长历史查找');
  const db = new DatabaseSync(resolve('.local/ui-test/sessions/sessions.sqlite'));
  try {
    const session = JSON.parse(
      String(
        db
          .prepare("SELECT metadata FROM sessions WHERE json_extract(metadata, '$.title') = ?")
          .get(title)!.metadata,
      ),
    );
    const insert = db.prepare('INSERT INTO events VALUES (?, ?, ?, ?)');
    db.exec('BEGIN');
    let sequence = 0;
    for (let i = 0; i < 360; i++) {
      const runId = randomUUID();
      const createdAt = new Date(Date.now() - (360 - i) * 60000).toISOString();
      for (const payload of [
        {
          type: 'message.user',
          messageId: randomUUID(),
          text: i === 0 ? '早期唯一词' : `问题 ${i}`,
          scenario: 'chat',
        },
        { type: 'text.delta', messageId: randomUUID(), text: `回复 ${i}` },
        { type: 'run.status', status: 'completed', connectionId: randomUUID() },
      ]) {
        sequence++;
        insert.run(
          session.id,
          sequence,
          runId,
          JSON.stringify({ sessionId: session.id, runId, sequence, createdAt, payload }),
        );
      }
    }
    db.exec('COMMIT');
  } finally {
    db.close();
  }
  await page.reload();
  await login(page);
  await page.locator('.session-select').filter({ hasText: title }).click();
  await expect(page.getByRole('button', { name: '加载更早记录', exact: true })).toBeVisible();
  await expect(page.getByText('早期唯一词', { exact: true })).toHaveCount(0);
  await page.keyboard.press('Control+f');
  await page.getByLabel('查找对话内容', { exact: true }).fill('早期唯一词');
  await expect(page.locator('.find-count')).toHaveText('0 / 0（仅已加载部分）');
  await expect(page.getByText('早期唯一词', { exact: true })).toHaveCount(0);
  // Reading upwards to the start of what is loaded brings the earlier page without a click.
  await page.locator('.conversation').hover();
  await page.mouse.wheel(0, -100000);
  await expect(page.getByRole('button', { name: '加载更早记录', exact: true })).toHaveCount(0);
  await expect(page.locator('.find-count')).toHaveText('1 / 1');
  await expect(page.getByText('早期唯一词', { exact: true })).toBeVisible();
});

test('Electron copies text and supplies the native editing context menu', async () => {
  test.skip(process.platform !== 'win32');
  mkdirSync(resolve('.local/conversation-tools-test'), { recursive: true });
  const profile = mkdtempSync(resolve('.local/conversation-tools-test/profile-'));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE',
    ),
  );
  const application = await _electron.launch({
    args: [resolve('apps/desktop'), '--smoke-test', `--user-data-dir=${profile}`],
    env,
  });
  const previous = await application.evaluate(({ clipboard }) => clipboard.readText());
  try {
    const page = await application.firstWindow();
    await page.evaluate(() => window.desktop!.copyText('复制粘贴测试'));
    expect(await application.evaluate(({ clipboard }) => clipboard.readText())).toBe(
      '复制粘贴测试',
    );
    const input = page.getByLabel('服务地址', { exact: true });
    await input.fill('');
    await input.focus();
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.paste(),
    );
    await expect(input).toHaveValue('复制粘贴测试');
    const roles = await application.evaluate(({ BrowserWindow, Menu }) => {
      const build = Menu.buildFromTemplate;
      let items: unknown[] = [];
      Menu.buildFromTemplate = ((template: unknown[]) => {
        items = template;
        return { popup() {} };
      }) as typeof build;
      try {
        BrowserWindow.getAllWindows()[0].webContents.emit(
          'context-menu',
          {},
          {
            isEditable: true,
            editFlags: {
              canUndo: true,
              canRedo: false,
              canCut: true,
              canCopy: true,
              canPaste: true,
            },
          },
        );
        return items;
      } finally {
        Menu.buildFromTemplate = build;
      }
    });
    expect(roles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'copy', enabled: true }),
        expect.objectContaining({ role: 'paste', enabled: true }),
      ]),
    );
  } finally {
    await application.evaluate(({ clipboard }, text) => clipboard.writeText(text), previous);
    await application.close();
  }
});
