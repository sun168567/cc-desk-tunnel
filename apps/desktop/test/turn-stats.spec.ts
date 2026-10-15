import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import type { Session } from '@cc-desk-tunnel/protocol';

// The line is off until the user switches it on, so every test but the default one starts with it on.
async function switchOn(page: Page) {
  await page.addInitScript(() => {
    if (!localStorage.getItem('proxy-prefs'))
      localStorage.setItem('proxy-prefs', JSON.stringify({ stats: { enabled: true } }));
  });
}

// A finished turn whose figures the service reported a moment after it ended.
async function open(page: Page, stats: Record<string, unknown>, on = true) {
  if (on) await switchOn(page);
  const now = new Date().toISOString();
  const connectionId = randomUUID();
  const runId = randomUUID();
  const questionId = randomUUID();
  const session: Session = {
    id: randomUUID(),
    title: '回复小结',
    autoTitle: false,
    projectPath: 'D:\\工作\\小结',
    provider: 'claude',
    profileId: 'default',
    permissionMode: 'auto',
    model: null,
    effort: null,
    createdAt: now,
    updatedAt: now,
    activeRun: null,
  };
  await page.routeWebSocket('ws://127.0.0.1:18891/ws', (route) => {
    const reply = (value: unknown) => route.send(JSON.stringify(value));
    const event = (sequence: number, payload: unknown) => ({
      sessionId: session.id,
      runId,
      sequence,
      createdAt: now,
      payload,
    });
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
          lastSequence: 4,
          hasEarlier: false,
          events: [
            event(1, {
              type: 'message.user',
              messageId: questionId,
              text: '你好',
              scenario: 'chat',
            }),
            event(2, {
              type: 'text.delta',
              messageId: randomUUID(),
              text: '你好，有什么可以帮你？',
            }),
            event(3, { type: 'run.status', status: 'completed', connectionId }),
            event(4, { type: 'turn.stats', messageId: questionId, ...stats }),
          ],
        });
      reply({ type: 'response', requestId: message.requestId, ok: true });
    });
  });
  await page.goto('/');
  await page.getByLabel('服务地址', { exact: true }).fill('ws://127.0.0.1:18891/ws');
  await page
    .getByLabel('服务凭据', { exact: true })
    .fill('test-only-stats-token-with-enough-length');
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

const stats = {
  requests: 2,
  inputTokens: 12,
  outputTokens: 2700,
  cacheReadTokens: 36567,
  cacheCreationTokens: 9259,
  modelMs: 28200,
  ttftMs: 952,
  outputPerSecond: 99.3,
  partial: false,
};

test('a reply ends with a button of figures that opens a card, which closes on an outside click', async ({
  page,
}) => {
  await open(page, stats);
  const line = page.locator('.turn-stats');
  await expect(line.locator('button')).toHaveText('4.9万 tok · 平均首字 952 ms · 平均 99 tok/s');
  await expect(line.locator('dl')).toBeHidden();
  await line.locator('button').click();
  await expect(line.getByRole('dialog', { name: '本轮用量' }).locator('header')).toHaveText(
    '本轮用量48,538 tok',
  );
  await expect(line.locator('dt')).toHaveText([
    '平均首字',
    '平均速度',
    '模型用时',
    '模型请求',
    '输入',
    '输出',
    '缓存读取',
    '缓存写入',
    '缓存命中',
  ]);
  await expect(line.locator('dd')).toHaveText([
    '952 ms',
    '99.3 tok/s',
    '28.2 s',
    '2 次',
    '12 tok',
    '2,700 tok',
    '36,567 tok',
    '9,259 tok',
    '79.8%',
  ]);
  // Two figures to a row, so the card stays narrow.
  expect((await line.getByRole('dialog').boundingBox())!.width).toBeLessThanOrEqual(280);
  const [first, second] = await line.locator('dl > div').all();
  expect((await first.boundingBox())!.y).toBe((await second.boundingBox())!.y);
  await expect(line.getByText('可能偏小')).toHaveCount(0);
  await page.screenshot({ path: resolve('.local/screenshots/turn-stats.png') });
  await page.keyboard.press('Escape');
  await expect(line.locator('dl')).toBeHidden();
  await line.locator('button').click();
  await page.locator('textarea').click();
  await expect(line.locator('dl')).toBeHidden();
});

test('the card stays inside a 430px window', async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 900 });
  await open(page, stats);
  const line = page.locator('.turn-stats');
  await line.locator('button').click();
  const box = await line.getByRole('dialog', { name: '本轮用量' }).boundingBox();
  expect(box).toBeTruthy();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(430);
  expect(box!.y + box!.height).toBeLessThanOrEqual(900);
  expect(box!.width).toBeLessThanOrEqual(280);
  await page.screenshot({ path: resolve('.local/screenshots/turn-stats-narrow.png') });
});

test('a figure without a value is left out, and a partial report says so', async ({ page }) => {
  await open(page, { ...stats, ttftMs: null, outputPerSecond: null, partial: true });
  const line = page.locator('.turn-stats');
  await expect(line.locator('button')).toHaveText('4.9万 tok');
  await line.locator('button').click();
  await expect(line.locator('dt')).not.toContainText(['平均首字', '平均速度']);
  await expect(line.getByText('可能偏小')).toBeVisible();
});

test('the line is off until the setting is switched on', async ({ page }) => {
  await open(page, stats, false);
  await expect(page.locator('.turn-stats')).toHaveCount(0);
  await page.reload();
  await page.getByRole('button', { name: '本机设置', exact: true }).click();
  await expect(page.getByRole('switch', { name: '显示回复小结' })).not.toBeChecked();
});

test('the settings choose which figures the line shows, or hide it', async ({ page }) => {
  await switchOn(page);
  await page.goto('/');
  await page.getByRole('button', { name: '本机设置', exact: true }).click();
  const choice = (name: string) => page.getByRole('button', { name, exact: true });
  await expect(choice('平均首字')).toHaveAttribute('aria-pressed', 'true');
  await expect(choice('缓存命中')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByText('4.9万 tok · 平均首字 952 ms · 平均 99 tok/s')).toBeVisible();
  await choice('平均首字').click();
  await choice('缓存命中').click();
  await expect(page.getByText('4.9万 tok · 平均 99 tok/s · 缓存命中 79.8%')).toBeVisible();
  await page.getByRole('switch', { name: '显示回复小结' }).click();
  await expect(choice('缓存命中')).toBeDisabled();
  await page.getByRole('switch', { name: '显示回复小结' }).click();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('proxy-prefs')!).stats)).toEqual(
    {
      enabled: true,
      summary: { ttft: false, cacheHit: true },
    },
  );
  await page.getByRole('button', { name: '返回登录', exact: true }).click();
  await open(page, stats);
  await expect(page.locator('.turn-stats button')).toHaveText(
    '4.9万 tok · 平均 99 tok/s · 缓存命中 79.8%',
  );
  await page.evaluate(() =>
    localStorage.setItem('proxy-prefs', JSON.stringify({ stats: { enabled: false } })),
  );
  await page.reload();
  await page.getByLabel('服务地址', { exact: true }).fill('ws://127.0.0.1:18891/ws');
  await page
    .getByLabel('服务凭据', { exact: true })
    .fill('test-only-stats-token-with-enough-length');
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await page.locator('.session-row').first().locator('.session-select').click();
  await expect(page.locator('.message.assistant')).toContainText('有什么可以帮你');
  await expect(page.locator('.turn-stats')).toHaveCount(0);
});
