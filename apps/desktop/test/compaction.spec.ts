import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import type { Session } from '@cc-desk-tunnel/protocol';
import { screenshots } from './helpers.ts';

const secondsAgo = (seconds: number) => new Date(Date.now() - seconds * 1000);

// A run that compacts its context on its own, as the CLI reports it: "compacting" several times over, a status that
// is over, then the boundary. Unfinished, the boundary has not come yet.
async function open(page: import('@playwright/test').Page, finished: boolean) {
  const now = new Date().toISOString();
  const connectionId = randomUUID();
  const runId = randomUUID();
  const session: Session = {
    id: randomUUID(),
    title: '自动压缩',
    autoTitle: false,
    projectPath: 'D:\\工作\\压缩',
    permissionMode: 'auto',
    model: null,
    effort: null,
    createdAt: now,
    updatedAt: now,
    activeRun: { id: runId, status: 'running', connectionId },
  };
  await page.routeWebSocket('ws://127.0.0.1:18894/ws', (route) => {
    const reply = (value: unknown) => route.send(JSON.stringify(value));
    let sequence = 0;
    const event = (seconds: number, payload: unknown) => ({
      sessionId: session.id,
      runId,
      sequence: ++sequence,
      createdAt: secondsAgo(seconds).toISOString(),
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
          event(90, {
            type: 'message.user',
            messageId: randomUUID(),
            text: '整理代码',
            scenario: 'chat',
          }),
          event(80, { type: 'text.delta', messageId: randomUUID(), text: '压缩之前说的。' }),
          event(60, { type: 'native.notice', text: 'compacting' }),
          event(50, { type: 'native.notice', text: 'compacting' }),
          event(40, { type: 'native.notice', text: 'compacting' }),
          ...(finished
            ? [
                event(31, { type: 'native.notice', text: 'status' }),
                event(30, { type: 'native.compact', trigger: 'auto', previousTokens: 468496 }),
                event(20, { type: 'text.delta', messageId: randomUUID(), text: '压缩之后说的。' }),
              ]
            : []),
        ];
        reply({
          type: 'session.snapshot',
          requestId: message.requestId,
          session,
          mode: 'replace',
          firstSequence: 1,
          lastSequence: sequence,
          hasEarlier: false,
          events,
        });
      }
      reply({ type: 'response', requestId: message.requestId, ok: true });
    });
  });
  await page.goto('/');
  await page.getByLabel('服务地址', { exact: true }).fill('ws://127.0.0.1:18894/ws');
  await page
    .getByLabel('服务凭据', { exact: true })
    .fill('test-only-compaction-token-with-enough-length');
  await page.getByRole('button', { name: '连接', exact: true }).click();
  const expand = page.getByRole('button', { name: '展开会话列表', exact: true });
  if (await expand.isVisible()) await expand.click();
  await page
    .locator('.session-row')
    .filter({ hasText: session.title })
    .locator('.session-select')
    .click();
}

test('a compaction under way is one line with its timer, not a notice per status', async ({
  page,
}) => {
  await open(page, false);
  const mark = page.locator('.compact-mark');
  await expect(mark).toHaveCount(1);
  await expect(mark).toHaveClass(/running/);
  await expect(mark).toContainText(/正在压缩上下文 · 1 分 \d+ 秒/);
  await expect(page.locator('.run-notice')).toHaveCount(0);
  await page.screenshot({ path: resolve(screenshots, 'compaction-running.png') });
});

test('what is said after a compaction comes under it', async ({ page }) => {
  await open(page, true);
  const mark = page.locator('.compact-mark');
  await expect(mark).toHaveCount(1);
  await expect(mark).toContainText('上下文已自动压缩 · 压缩前 468,496 tokens · 30 秒');
  await expect(page.locator('.run-notice')).toHaveCount(0);
  const order = await page
    .locator('.message.assistant, .compact-mark')
    .evaluateAll((nodes) => nodes.map((node) => node.textContent?.trim().slice(0, 7)));
  expect(order).toEqual(['压缩之前说的。', '上下文已自动压', '压缩之后说的。']);
  await page.screenshot({ path: resolve(screenshots, 'compaction-done.png') });
});
