import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import type { Session } from '@cc-desk-tunnel/protocol';

const clock = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

// Two finished turns. The first reply is written over 25 minutes, so the time under it must be the one of its last
// text, not of its first. The second question is put in on the same run, and its delivery was never confirmed.
// Unfinished, only the first turn is there, still running, its figures already reported.
async function open(page: import('@playwright/test').Page, finished = true) {
  await page.addInitScript(() =>
    localStorage.setItem('proxy-prefs', JSON.stringify({ stats: { enabled: true } })),
  );
  const now = new Date().toISOString();
  const connectionId = randomUUID();
  const runId = randomUUID();
  const questions = [randomUUID(), randomUUID()];
  const replies = [randomUUID(), randomUUID()];
  const session: Session = {
    id: randomUUID(),
    title: '回复底部',
    autoTitle: false,
    projectPath: 'D:\\工作\\底部',
    permissionMode: 'auto',
    model: null,
    effort: null,
    createdAt: now,
    updatedAt: now,
    activeRun: null,
  };
  const stats = {
    requests: 1,
    inputTokens: 10,
    outputTokens: 100,
    cacheReadTokens: 1000,
    cacheCreationTokens: 0,
    modelMs: 2000,
    ttftMs: 500,
    outputPerSecond: 50,
    partial: false,
  };
  await page.routeWebSocket('ws://127.0.0.1:18893/ws', (route) => {
    const reply = (value: unknown) => route.send(JSON.stringify(value));
    let sequence = 0;
    const event = (createdAt: Date, payload: unknown) => ({
      sessionId: session.id,
      runId,
      sequence: ++sequence,
      createdAt: createdAt.toISOString(),
      payload,
    });
    route.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === 'device') return;
      if (message.type === 'auth') {
        reply({
          type: 'ready',
          protocolVersion: PROTOCOL_VERSION,
          serverDeviceId: '00000000-0000-4000-8000-000000000001',
          version: '0.0.1',
          connectionId,
          adapter: 'claude-code',
          projects: [],
          sessions: [session],
        });
        return;
      }
      if (message.type === 'session.subscribe') {
        const events = [
          event(minutesAgo(40), {
            type: 'message.user',
            messageId: questions[0],
            text: '第一问',
            scenario: 'chat',
          }),
          event(minutesAgo(40), {
            type: 'message.delivery',
            messageId: questions[0],
            status: 'received',
          }),
          event(minutesAgo(30), {
            type: 'text.delta',
            messageId: replies[0],
            text: '第一答，开头',
          }),
          event(minutesAgo(5), { type: 'text.delta', messageId: replies[0], text: '，结尾。' }),
          event(minutesAgo(5), { type: 'run.status', status: 'completed', connectionId }),
          event(minutesAgo(5), { type: 'turn.stats', messageId: questions[0], ...stats }),
          event(minutesAgo(3), {
            type: 'message.user',
            messageId: questions[1],
            text: '第二问',
            scenario: 'chat',
          }),
          event(minutesAgo(3), {
            type: 'message.delivery',
            messageId: questions[1],
            status: 'unconfirmed',
          }),
          event(minutesAgo(2), { type: 'text.delta', messageId: replies[1], text: '第二答。' }),
          event(minutesAgo(1), { type: 'turn.stats', messageId: questions[1], ...stats }),
        ];
        const shown = finished ? events : [events[0], events[1], events[2], events[5]];
        reply({
          type: 'session.snapshot',
          requestId: message.requestId,
          session,
          mode: 'replace',
          firstSequence: 1,
          lastSequence: sequence,
          hasEarlier: false,
          events: shown,
        });
      }
      reply({ type: 'response', requestId: message.requestId, ok: true });
    });
  });
  await page.goto('/');
  await page.getByLabel('服务地址', { exact: true }).fill('ws://127.0.0.1:18893/ws');
  await page
    .getByLabel('服务凭据', { exact: true })
    .fill('test-only-footer-token-with-enough-length');
  await page.getByRole('button', { name: '连接', exact: true }).click();
  const expand = page.getByRole('button', { name: '展开会话列表', exact: true });
  if (await expand.isVisible()) await expand.click();
  await page
    .locator('.session-row')
    .filter({ hasText: session.title })
    .locator('.session-select')
    .click();
  await expect(page.locator('.message.assistant')).toHaveCount(finished ? 2 : 1);
}

test('a reply has no heading; copy, figures and time are under it', async ({ page }) => {
  await open(page);
  await expect(page.locator('.message.assistant .message-label')).toHaveCount(0);
  const footer = page.locator('.message.assistant').first().locator('.message-footer');
  await expect(footer.locator('.copy-button')).toHaveCount(1);
  await expect(footer.locator('.turn-stats')).toHaveCount(1);
  // The time is when the reply was done, not when it began.
  await expect(footer.locator('.message-time')).toContainText(clock.format(minutesAgo(5)));
  await expect(footer.locator('.message-time')).not.toContainText(clock.format(minutesAgo(30)));
});

test('a question has no heading either; its line is under it at the right', async ({ page }) => {
  await open(page);
  await expect(page.locator('.message.user .message-label')).toHaveCount(0);
  const [first, second] = await page.locator('.message.user').all();
  const line = first.locator('.message-footer');
  await expect(line.locator('.message-time')).toContainText(clock.format(minutesAgo(40)));
  await expect(line.getByRole('button', { name: '编辑重发', exact: true })).toHaveCount(1);
  await expect(line.locator('.copy-button')).toHaveCount(1);
  const bubble = (await first.locator('.message-content').boundingBox())!;
  const under = (await line.boundingBox())!;
  expect(Math.abs(bubble.x + bubble.width - (under.x + under.width))).toBeLessThanOrEqual(2);
  // A question put in on the running run is a smaller bubble, and cannot be edited.
  await expect(second).toHaveClass(/joined/);
  await expect(second.getByRole('button', { name: '编辑重发', exact: true })).toHaveCount(0);
  await page.mouse.move(2, 2);
  // Plainly received is quiet; a delivery left unconfirmed stays in sight without the pointer.
  await expect(line.locator('.message-delivery')).toHaveText('原生已接收');
  await expect(line.locator('.message-delivery')).toHaveCSS('opacity', '0');
  await expect(line.locator('.copy-button')).toHaveCSS('opacity', '0');
  const unconfirmed = second.locator('.message-delivery');
  await expect(unconfirmed).toHaveText('接收未确认');
  await expect(unconfirmed).toHaveCSS('opacity', '1');
  await expect(second.locator('.copy-button')).toHaveCSS('opacity', '0');
  await first.locator('.message-content').hover();
  await expect(line.locator('.copy-button')).toHaveCSS('opacity', '1');
  await page.screenshot({ path: resolve('.local/screenshots/question-footer.png') });
});

test('the line under a reply shows on the latest one, and on another while the pointer is over it', async ({
  page,
}) => {
  await open(page);
  const [first, last] = await page.locator('.message.assistant').all();
  // Hidden or shown, the line takes the same small room: replies one after the other stay close.
  const gap = (await page.locator('.message.user').nth(1).boundingBox())!.y;
  const end = await first.boundingBox();
  expect(gap - (end!.y + end!.height)).toBeLessThanOrEqual(6);
  expect((await first.locator('.message-footer').boundingBox())!.height).toBeLessThanOrEqual(30);
  await page.mouse.move(2, 2);
  await expect(last.locator('.message-footer .copy-button')).toHaveCSS('opacity', '1');
  await expect(first.locator('.message-footer .copy-button')).toHaveCSS('opacity', '0');
  await first.locator('.message-content').hover();
  await expect(first.locator('.message-footer .copy-button')).toHaveCSS('opacity', '1');
  // An open card keeps its line shown, even with the pointer away.
  await first.locator('.turn-stats button').click();
  await page.mouse.move(2, 2);
  await expect(first.getByRole('dialog', { name: '本轮用量' })).toBeVisible();
  await expect(first.locator('.message-footer .copy-button')).toHaveCSS('opacity', '1');
  await page.screenshot({ path: resolve('.local/screenshots/reply-footer.png') });
});

test('while the turn is still running its figures are not shown on their own', async ({ page }) => {
  await open(page, false);
  await expect(page.locator('.turn-stats')).toHaveCount(0);
  // What is said along the way has nothing under it: no copy, no time.
  await expect(page.locator('.message.assistant .message-footer')).toHaveCount(0);
});

test('the figures card opens above a short reply without being cut off by it', async ({ page }) => {
  await open(page);
  const last = page.locator('.message.assistant').last();
  await last.locator('.turn-stats button').click();
  const header = last.getByRole('dialog', { name: '本轮用量' }).locator('header');
  await expect(header).toBeVisible();
  // Where the card is, the card is what the pointer would hit; a card cut off by the reply would let the page through.
  const hit = await header.evaluate((node) => {
    const box = node.getBoundingClientRect();
    const found = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return !!found && node.contains(found);
  });
  expect(hit).toBe(true);
});
