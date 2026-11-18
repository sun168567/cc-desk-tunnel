import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import type { Session } from '@cc-desk-tunnel/protocol';

const pixel =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

// One finished turn: Claude looked at a picture, then answered with links to a file of the project, a file on
// the service and a web page, and with two pictures.
async function open(page: import('@playwright/test').Page) {
  await page.addInitScript(() =>
    localStorage.setItem('proxy-prefs', JSON.stringify({ view: { mode: 'expanded' } })),
  );
  const now = new Date().toISOString();
  const connectionId = randomUUID();
  const runId = randomUUID();
  const session: Session = {
    id: randomUUID(),
    title: '链接与图片',
    autoTitle: false,
    projectPath: 'D:\\工作\\链接',
    permissionMode: 'auto',
    model: null,
    effort: null,
    createdAt: now,
    updatedAt: now,
    activeRun: null,
  };
  const payloads = [
    { type: 'message.user', messageId: randomUUID(), text: '看图', scenario: 'chat' },
    {
      type: 'tool.requested',
      toolId: 'read',
      name: 'Read',
      input: JSON.stringify({ file_path: '/tmp/shot.png' }),
      target: 'Linux',
    },
    {
      type: 'tool.result',
      toolId: 'read',
      status: 'completed',
      output: JSON.stringify([
        { type: 'text', text: 'Read image' },
        { type: 'image', source: { type: 'base64', data: pixel, media_type: 'image/png' } },
      ]),
      exitCode: null,
    },
    {
      type: 'text.delta',
      messageId: randomUUID(),
      text: '见 [配置](src/config.ts:12)、[服务端文件](/data/state/x.txt) 和 [文档](https://example.com/docs)。\n\n![截图](D:\\shots\\a.png) ![远程图](https://example.com/a.png)',
    },
    { type: 'run.status', status: 'completed', connectionId },
  ];
  const events = payloads.map((payload, index) => ({
    sessionId: session.id,
    runId,
    sequence: index + 1,
    createdAt: now,
    payload,
  }));
  await page.routeWebSocket('ws://127.0.0.1:18897/ws', (route) => {
    const reply = (value: unknown) => route.send(JSON.stringify(value));
    route.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === 'device') return;
      if (message.type === 'auth') {
        reply({
          type: 'ready',
          protocolVersion: PROTOCOL_VERSION,
          version: '0.0.1',
          connectionId,
          adapter: 'claude-code',
          sessions: [session],
        });
        return;
      }
      if (message.type === 'session.subscribe')
        reply({
          type: 'session.snapshot',
          requestId: message.requestId,
          session,
          mode: 'replace',
          firstSequence: 1,
          lastSequence: events.length,
          hasEarlier: false,
          events,
        });
      reply({ type: 'response', requestId: message.requestId, ok: true });
    });
  });
  await page.goto('/');
  await page.getByLabel('服务地址', { exact: true }).fill('ws://127.0.0.1:18897/ws');
  await page
    .getByLabel('服务凭据', { exact: true })
    .fill('test-only-view-token-with-enough-length');
  await page.getByRole('button', { name: '连接', exact: true }).click();
  const expand = page.getByRole('button', { name: '展开会话列表', exact: true });
  if (await expand.isVisible()) await expand.click();
  await page
    .locator('.session-row')
    .filter({ hasText: session.title })
    .locator('.session-select')
    .click();
  await expect(page.locator('.message.assistant')).toHaveCount(1);
}

test('links are followed by the conversation and pictures from the web are not fetched', async ({
  page,
}) => {
  const fetched: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).hostname === 'example.com') fetched.push(request.url());
  });
  await open(page);
  await page.evaluate(() => {
    window.open = (url) => {
      (window as unknown as { opened: unknown }).opened = String(url);
      return null;
    };
  });
  const answer = page.locator('.message.assistant');
  const links = answer.locator('a[data-link]');
  await expect(links).toHaveCount(5);
  await expect(answer.locator('a[target]')).toHaveCount(0);
  // A browser opens no file of a computer; such links read quieter and say why when clicked.
  const config = answer.getByRole('link', { name: '配置', exact: true });
  await expect(config).toHaveClass(/link-elsewhere/);
  await expect(answer.getByRole('link', { name: '文档', exact: true })).not.toHaveClass(
    /link-elsewhere/,
  );
  // Resting on a link tells where it leads, and why it cannot be opened, beside it.
  await config.hover();
  const card = page.getByRole('tooltip');
  await expect(card).toContainText('D:\\工作\\链接\\src\\config.ts');
  await expect(card).toContainText('浏览器');
  await config.click();
  await expect(card.locator('strong')).toContainText('浏览器');
  await page.mouse.move(0, 0);
  // A web address opens after it was shown whole and confirmed, or at once with Ctrl or ⌘ held.
  const opened = () => page.evaluate(() => (window as unknown as { opened?: string }).opened);
  const docs = answer.getByRole('link', { name: '文档', exact: true });
  await expect(card).toHaveCount(0, { timeout: 6000 });
  await docs.hover();
  await expect(card).toContainText('单击确认后打开');
  await docs.click();
  const leave = page.getByRole('dialog').filter({ hasText: '打开外部链接' });
  await expect(leave).toContainText('https://example.com/docs');
  expect(await opened()).toBeUndefined();
  await leave.getByRole('button', { name: '取消', exact: true }).click();
  await expect(leave).toHaveCount(0);
  expect(await opened()).toBeUndefined();
  await docs.click();
  await leave.getByRole('button', { name: '打开', exact: true }).click();
  await expect(leave).toHaveCount(0);
  await expect.poll(opened).toBe('https://example.com/docs');
  await page.evaluate(() => delete (window as unknown as { opened?: string }).opened);
  await docs.click({ modifiers: ['ControlOrMeta'] });
  await expect(leave).toHaveCount(0);
  await expect.poll(opened).toBe('https://example.com/docs');
  // A picture is a link here: the one from the web is never loaded.
  await expect(answer.locator('img')).toHaveCount(0);
  await expect(answer.locator('.picture-link')).toHaveText(['截图', '远程图']);
  expect(fetched).toEqual([]);

  // The menu of a link starts with its own choices.
  await config.click({ button: 'right' });
  const menu = page.getByRole('menu', { name: '对话文字操作' });
  await expect(menu).toContainText('在浏览器里打不开电脑上的文件');
  await expect(menu.getByRole('menuitem')).toHaveText([
    '复制路径',
    '复制选中文字',
    '复制整条消息',
    '全选对话文字',
    '查找对话内容',
  ]);
  await page.keyboard.press('Escape');
});

test('a picture a tool looked at is shown, and opens whole', async ({ page }) => {
  await open(page);
  const tool = page.locator('details.tool').filter({ has: page.locator('.tool-picture-mark') });
  await tool.locator('summary').click();
  await expect(tool.locator('.tool-output')).toHaveText('Read image');
  const picture = tool.locator('.tool-pictures img');
  await expect(picture).toHaveCount(1);
  await expect
    .poll(() => picture.evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBe(1);
  await expect(tool).not.toContainText(pixel.slice(0, 20));
  await tool.locator('.tool-pictures .picture').click();
  const dialog = page.locator('dialog:has(.picture-view)');
  await expect(dialog.locator('h2')).toHaveText('图片 1');
  await expect(dialog.locator('img')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});
