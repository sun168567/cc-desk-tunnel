import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import type { Session } from '@cc-desk-tunnel/protocol';

// The bar is off until the user switches it on, so every test but the default one starts with it on.
async function switchOn(page: Page) {
  await page.addInitScript(() => {
    if (!localStorage.getItem('proxy-prefs'))
      localStorage.setItem('proxy-prefs', JSON.stringify({ sessionBar: { enabled: true } }));
  });
}

const figures = {
  turns: 3,
  requests: 7,
  inputTokens: 100,
  outputTokens: 2000,
  cacheReadTokens: 40000,
  cacheCreationTokens: 8000,
  modelMs: 28200,
  ttftMs: 952,
  outputPerSecond: 99.3,
  firstRecordAt: '2026-10-01T00:00:00.000Z',
};

// A session whose figures the service sums up on request.
async function open(
  page: Page,
  stats: Record<string, unknown> = figures,
  on = true,
  percentage = 8,
) {
  if (on) await switchOn(page);
  const now = new Date().toISOString();
  const connectionId = randomUUID();
  const runId = randomUUID();
  const session: Session = {
    id: randomUUID(),
    title: '会话栏',
    autoTitle: false,
    projectPath: 'D:\\工作\\会话栏',
    permissionMode: 'auto',
    model: null,
    effort: null,
    createdAt: now,
    updatedAt: now,
    activeRun: null,
  };
  await page.routeWebSocket('ws://127.0.0.1:18892/ws', (route) => {
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
          lastSequence: 3,
          hasEarlier: false,
          events: [
            {
              sessionId: session.id,
              runId,
              sequence: 1,
              createdAt: now,
              payload: {
                type: 'text.delta',
                messageId: randomUUID(),
                text: '你好，有什么可以帮你？',
              },
            },
            {
              sessionId: session.id,
              runId,
              sequence: 2,
              createdAt: now,
              payload: { type: 'run.status', status: 'completed', connectionId },
            },
            {
              sessionId: session.id,
              runId,
              sequence: 3,
              createdAt: now,
              payload: {
                type: 'native.metrics',
                context: {
                  model: 'claude-haiku-5-5',
                  usedTokens: 16000,
                  windowTokens: 200000,
                  percentage,
                  measuredAt: now,
                  categories: [
                    { name: 'System prompt', tokens: 3200, kind: 'used' },
                    { name: 'System tools', tokens: 6100, kind: 'used' },
                    { name: 'MCP tools (deferred)', tokens: 2615, kind: 'deferred' },
                    { name: 'Skills', tokens: 2900, kind: 'used' },
                    { name: 'Messages', tokens: 3800, kind: 'used' },
                    { name: 'Autocompact buffer', tokens: 33000, kind: 'buffer' },
                    { name: 'Free space', tokens: 941333, kind: 'free' },
                  ],
                },
                usage: null,
                rateLimits: null,
              },
            },
          ],
        });
      if (message.type === 'session.stats')
        reply({
          type: 'session.stats',
          requestId: message.requestId,
          sessionId: message.sessionId,
          ...stats,
        });
      reply({ type: 'response', requestId: message.requestId, ok: true });
    });
  });
  await page.goto('/');
  await page.getByLabel('服务地址', { exact: true }).fill('ws://127.0.0.1:18892/ws');
  await page.getByLabel('服务凭据', { exact: true }).fill('test-only-bar-token-with-enough-length');
  await page.getByRole('button', { name: '连接', exact: true }).click();
  const expand = page.getByRole('button', { name: '展开会话列表', exact: true });
  if (await expand.isVisible()) await expand.click();
  await page
    .locator('.session-row')
    .filter({ hasText: session.title })
    .locator('.session-select')
    .click();
  await expect(page.locator('.message.assistant')).toContainText('有什么可以帮你');
}

test('the bar under the input box shows the session, and each part opens a card above it', async ({
  page,
}) => {
  await open(page);
  const bar = page.locator('.session-bar');
  const left = bar.locator('.session-bar-part.session');
  const right = bar.locator('.session-bar-part.tokens');
  await expect(left.locator('button')).toHaveText('3 轮 · 7 步 · 平均 99 tok/s');
  await expect(right.locator('button')).toHaveText(/tok · 缓存命中 \d+(\.\d)?%$/);
  // Under the input box, not above it.
  expect((await bar.boundingBox())!.y).toBeGreaterThan(
    (await page.locator('textarea').boundingBox())!.y,
  );
  await left.locator('button').click();
  const card = left.getByRole('dialog', { name: '会话统计' });
  // The card opens above its own button, its left edge in line with the button's.
  const button = (await left.locator('button').boundingBox())!;
  const opened = (await card.boundingBox())!;
  expect(Math.abs(opened.x - button.x)).toBeLessThanOrEqual(1);
  expect(opened.y + opened.height).toBeLessThanOrEqual(button.y);
  await expect(card.locator('header')).toHaveText('会话统计3 轮');
  await expect(card.locator('dt')).toHaveText(['步数', '平均速度', '平均首字', '模型用时']);
  await expect(card.locator('dd')).toHaveText(['7 步', '99.3 tok/s', '952 ms', '28.2 s']);
  await expect(card.getByText('2026/10/1 起')).toBeVisible();
  await page.screenshot({ path: resolve('.local/screenshots/session-bar.png') });
  await page.keyboard.press('Escape');
  await expect(card).toBeHidden();
  await right.locator('button').click();
  const tokens = right.getByRole('dialog', { name: 'Token 用量' });
  expect(
    Math.abs((await tokens.boundingBox())!.x - (await right.locator('button').boundingBox())!.x),
  ).toBeLessThanOrEqual(1);
  await expect(tokens.locator('header')).toContainText('50,100 tok');
  await expect(tokens.locator('dt')).toHaveText([
    '缓存命中',
    '未缓存输入',
    '缓存读取',
    '缓存写入',
    '输出',
  ]);
  await expect(tokens.locator('dd')).toHaveText([
    /^\d+(\.\d)?%$/,
    '100 tok',
    '40,000 tok',
    '8,000 tok',
    '2,000 tok',
  ]);
  // Clicking elsewhere closes it.
  await page.locator('.message.assistant').click();
  await expect(tokens).toBeHidden();
});

test('both cards stay inside a 430px window', async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 900 });
  await open(page);
  for (const [part, name] of [
    ['session', '会话统计'],
    ['tokens', 'Token 用量'],
  ]) {
    const button = page.locator(`.session-bar-part.${part} > button`);
    await button.click();
    const box = await page.getByRole('dialog', { name }).boundingBox();
    expect(box).toBeTruthy();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(430);
    expect(box!.y + box!.height).toBeLessThanOrEqual(900);
    await page.screenshot({ path: resolve(`.local/screenshots/session-bar-narrow-${part}.png`) });
    await button.click();
  }
  // The bar itself does not run past the window either.
  const bar = await page.locator('.session-bar').boundingBox();
  expect(bar!.x + bar!.width).toBeLessThanOrEqual(430);
});

test('a session without any request has no bar', async ({ page }) => {
  await open(page, { ...figures, turns: 0, requests: 0, ttftMs: null, outputPerSecond: null });
  await expect(page.locator('.session-bar-part:not(.context)')).toHaveCount(0);
  // The ring is still there to show the context window.
  await expect(page.locator('.session-bar-part.context > button')).toHaveText('8%');
});

test('requests from before prompts were recorded have steps but no turn count', async ({
  page,
}) => {
  await open(page, { ...figures, turns: 0 });
  const left = page.locator('.session-bar-part.session');
  await expect(left.locator('button')).toHaveText('7 步 · 平均 99 tok/s');
  await left.locator('button').click();
  await expect(left.getByRole('dialog').locator('dt')).toHaveText([
    '步数',
    '平均速度',
    '平均首字',
    '模型用时',
  ]);
});

test('the bar is off by default, in the window and in the settings', async ({ page }) => {
  await open(page, figures, false);
  await expect(page.locator('.session-bar')).toHaveCount(0);
  await page.reload();
  await page.getByRole('button', { name: '本机设置', exact: true }).click();
  await page
    .getByRole('navigation', { name: '设置分类' })
    .getByRole('button', { name: '外观', exact: true })
    .click();
  await expect(page.getByRole('switch', { name: '显示会话栏' })).not.toBeChecked();
});

test('the settings choose which figures the bar shows, or hide it', async ({ page }) => {
  await switchOn(page);
  await page.goto('/');
  await page.getByRole('button', { name: '本机设置', exact: true }).click();
  await page
    .getByRole('navigation', { name: '设置分类' })
    .getByRole('button', { name: '外观', exact: true })
    .click();
  const choice = (name: string) =>
    page.getByRole('group', { name: '会话栏里显示' }).getByRole('button', { name, exact: true });
  await expect(choice('步数')).toHaveAttribute('aria-pressed', 'true');
  await expect(choice('模型用时')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByText(/^12 轮 · 38 步 · 平均 96 tok\/s/)).toBeVisible();
  await choice('步数').click();
  await choice('模型用时').click();
  await expect(page.getByText(/^12 轮 · 平均 96 tok\/s · 模型 412.0 s/)).toBeVisible();
  await page.getByRole('switch', { name: '显示会话栏' }).click();
  await expect(choice('模型用时')).toBeDisabled();
  await page.getByRole('switch', { name: '显示会话栏' }).click();
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem('proxy-prefs')!).sessionBar),
  ).toEqual({ enabled: true, summary: { steps: false, modelTime: true } });
});

test('the strip is one centred row with the context ring, which leaves the toolbar while it is on', async ({
  page,
}) => {
  await open(page);
  const bar = page.locator('.session-bar');
  await expect(bar.locator('.session-bar-part.context > button')).toHaveText('8%');
  await expect(page.locator('.composer-controls .context-control')).toHaveCount(0);
  // Three items on one row, as far from the left edge of the strip as from its right.
  const items = await bar.locator(':scope > *').all();
  expect(items).toHaveLength(3);
  const boxes = await Promise.all(items.map((item) => item.boundingBox()));
  expect(new Set(boxes.map((box) => Math.round(box!.y))).size).toBe(1);
  const strip = (await bar.boundingBox())!;
  const left = boxes[0]!.x - strip.x;
  const right = strip.x + strip.width - (boxes[2]!.x + boxes[2]!.width);
  expect(Math.abs(left - right)).toBeLessThanOrEqual(2);
  // Like the other parts, it opens a card when clicked, not when pointed at.
  const context = bar.locator('.session-bar-part.context');
  await context.locator('button').hover();
  await expect(context.getByRole('dialog')).toHaveCount(0);
  await context.locator('button').click();
  const card = context.getByRole('dialog', { name: '上下文窗口' });
  await expect(card.locator('header')).toHaveText('上下文窗口8%');
  await expect(card.locator('dt')).toHaveText(['已用', '窗口', '剩余', '模型']);
  await expect(card.locator('dd')).toHaveText([
    '16,000 tok',
    '200,000 tok',
    '92%',
    'claude-haiku-5-5',
  ]);
  // What the used part is made of: the used categories only, not free space, the compaction buffer or tools loaded on demand.
  await expect(card.locator('.context-breakdown li span')).toHaveText([
    '系统提示词',
    '系统工具',
    '技能',
    '对话消息',
  ]);
  await expect(card.locator('.context-breakdown li b')).toHaveText([
    '3,200 tok',
    '6,100 tok',
    '2,900 tok',
    '3,800 tok',
  ]);
  // The bar is filled across by the categories, whatever share of the window they take.
  const filled = await card.locator('.context-breakdown-bar').boundingBox();
  const parts = await card
    .locator('.context-breakdown-bar span')
    .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().width));
  expect(
    Math.abs(parts.reduce((sum, width) => sum + width, 0) - filled!.width),
  ).toBeLessThanOrEqual(1);
  await page.screenshot({ path: resolve('.local/screenshots/session-bar-context.png') });
  await page.keyboard.press('Escape');
  await expect(card).toBeHidden();
  await page.screenshot({ path: resolve('.local/screenshots/session-bar-row.png') });
});

test('with the bar off the context ring stays in the toolbar', async ({ page }) => {
  await open(page, figures, false);
  await expect(page.locator('.composer-controls .context-control')).toHaveCount(1);
  await expect(page.locator('.session-bar')).toHaveCount(0);
});

// The ring turns amber from 70% and red from 90%, in the strip as it did in the toolbar.
for (const [percentage, level, colour] of [
  [8, 'ok', '--accent'],
  [75, 'high', '--warn'],
  [95, 'full', '--danger'],
] as const) {
  test(`the context ring is ${level} at ${percentage}%`, async ({ page }) => {
    await open(page, figures, true, percentage);
    const ring = page.locator('.session-bar-part.context .context-ring');
    await expect(ring).toHaveClass(new RegExp(level));
    const [stroke, expected] = await page.evaluate((name) => {
      const probe = document.createElement('i');
      probe.style.color = `var(${name})`;
      document.body.append(probe);
      const expected = getComputedStyle(probe).color;
      probe.remove();
      return [
        getComputedStyle(document.querySelector('.session-bar .context-ring-used')!).stroke,
        expected,
      ];
    }, colour);
    expect(stroke).toBe(expected);
  });
}
