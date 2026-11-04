import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import type { IdleCompaction, Session } from '@cc-desk-tunnel/protocol';
import { screenshots } from './helpers.ts';

const shots = resolve(screenshots, 'idle-compaction');
mkdirSync(shots, { recursive: true });
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

// A session whose last turn ended `minutes` ago with a context of 152K tokens and a cache that lasts `ttl`, served by a
// service whose idle compaction setting is `settings`. Gives what the page sent.
async function open(
  page: Page,
  {
    minutes,
    ttl = '1h',
    settings,
  }: { minutes: number; ttl?: '5m' | '1h'; settings: IdleCompaction },
) {
  const connectionId = randomUUID();
  const runId = randomUUID();
  const session: Session = {
    id: randomUUID(),
    title: '重构存储层',
    autoTitle: false,
    projectPath: 'D:\\工作\\存储',
    permissionMode: 'auto',
    model: null,
    effort: null,
    createdAt: minutesAgo(minutes + 10),
    updatedAt: minutesAgo(minutes),
    activeRun: null,
  };
  const sent: { type: string; [key: string]: unknown }[] = [];
  await page.routeWebSocket('ws://127.0.0.1:18893/ws', (route) => {
    const reply = (value: unknown) => route.send(JSON.stringify(value));
    let sequence = 0;
    const event = (at: string, payload: unknown) => ({
      sessionId: session.id,
      runId,
      sequence: ++sequence,
      createdAt: at,
      payload,
    });
    route.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === 'device') return;
      sent.push(message);
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
      if (message.type === 'compaction.get')
        reply({ type: 'compaction.state', requestId: message.requestId, values: settings });
      if (message.type === 'session.subscribe') {
        const ended = minutesAgo(minutes);
        const events = [
          event(minutesAgo(minutes + 3), {
            type: 'message.user',
            messageId: randomUUID(),
            text: '把存储层的读写拆成两个模块',
            scenario: 'chat',
          }),
          event(minutesAgo(minutes + 1), {
            type: 'text.delta',
            messageId: randomUUID(),
            text: '已拆分为 reader.ts 与 writer.ts，测试全部通过。',
          }),
          event(ended, { type: 'native.context', nativeSessionId: session.id, persisted: true }),
          event(ended, {
            type: 'native.metrics',
            context: {
              model: 'claude-opus-5-5',
              usedTokens: 152_000,
              windowTokens: 1_000_000,
              percentage: 15.2,
              measuredAt: ended,
              categories: [],
            },
            usage: null,
            rateLimits: null,
            cacheTtl: ttl,
          }),
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
  await page.getByLabel('服务地址', { exact: true }).fill('ws://127.0.0.1:18893/ws');
  await page
    .getByLabel('服务凭据', { exact: true })
    .fill('test-only-idle-compaction-token-with-length');
  await page.getByRole('button', { name: '连接', exact: true }).click();
  const expand = page.getByRole('button', { name: '展开会话列表', exact: true });
  if (await expand.isVisible()) await expand.click();
  await page
    .locator('.session-row')
    .filter({ hasText: session.title })
    .locator('.session-select')
    .click();
  return sent;
}

const off: IdleCompaction = { enabled: false, afterMinutes: 50, minTokens: 100_000 };

test('before the one-hour cache lapses, the session reminds to compact while the cache is read', async ({
  page,
}) => {
  const sent = await open(page, { minutes: 52, settings: off });
  const reminder = page.locator('.idle-reminder');
  await expect(reminder).toContainText('提示缓存约 8 分钟后过期');
  await expect(reminder).toContainText('152K tokens');
  await page.screenshot({ path: resolve(shots, 'before-expiry.png') });
  await reminder.screenshot({ path: resolve(shots, 'before-expiry-bar.png') });
  await reminder.getByRole('button', { name: '现在压缩', exact: true }).click();
  await expect.poll(() => sent.some((message) => message.type === 'session.compact')).toBe(true);
});

test('a reminder closed stays closed for that turn', async ({ page }) => {
  await open(page, { minutes: 52, settings: off });
  const reminder = page.locator('.idle-reminder');
  await expect(reminder).toBeVisible();
  await reminder.getByRole('button', { name: '关闭提醒', exact: true }).click();
  await expect(reminder).toHaveCount(0);
  await page.screenshot({ path: resolve(shots, 'before-expiry-closed.png') });
});

test('after the cache lapsed, the session suggests a new session or a cheaper model to compact with', async ({
  page,
}) => {
  const sent = await open(page, { minutes: 80, settings: off });
  const reminder = page.locator('.idle-reminder');
  await expect(reminder).toContainText('距上一轮已过 1 小时 20 分钟');
  await expect(reminder).toContainText('相当于 /clear');
  await expect(reminder.getByRole('button', { name: '现在压缩' })).toHaveCount(0);
  await page.screenshot({ path: resolve(shots, 'after-expiry.png') });
  await reminder.screenshot({ path: resolve(shots, 'after-expiry-bar.png') });
  await reminder.getByRole('button', { name: '新建会话', exact: true }).click();
  await expect
    .poll(() => sent.some((message) => /^(server\.)?session\.create$/.test(message.type)))
    .toBe(true);
});

test('with idle compaction on, the service compacts and nothing is said before the cache lapses', async ({
  page,
}) => {
  await open(page, { minutes: 52, settings: { ...off, enabled: true } });
  await expect(page.getByRole('textbox', { name: '消息' })).toBeVisible();
  await expect(page.locator('.idle-reminder')).toHaveCount(0);
});

test('a five-minute cache or a small context brings no reminder before the hour', async ({
  page,
}) => {
  await open(page, { minutes: 52, ttl: '5m', settings: off });
  await expect(page.getByRole('textbox', { name: '消息' })).toBeVisible();
  await expect(page.locator('.idle-reminder')).toHaveCount(0);
});

test('idle compaction is set on the settings page and saved at once', async ({ page }) => {
  const values: IdleCompaction = { ...off };
  const updates: unknown[] = [];
  await page.routeWebSocket('ws://127.0.0.1:18892/ws', (route) => {
    const send = (value: unknown) => route.send(JSON.stringify(value));
    route.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === 'device') return;
      if (message.type === 'auth') {
        send({
          type: 'ready',
          protocolVersion: PROTOCOL_VERSION,
          version: '0.0.1',
          connectionId: randomUUID(),
          adapter: 'claude-code',
          sessions: [],
        });
        return;
      }
      if (message.type === 'compaction.update') {
        updates.push(message.values);
        Object.assign(values, message.values);
      }
      if (message.type.startsWith('compaction.'))
        send({ type: 'compaction.state', requestId: message.requestId, values });

      send({ type: 'response', requestId: message.requestId, ok: true });
    });
  });
  await page.goto('/');
  await page.getByLabel('服务地址', { exact: true }).fill('ws://127.0.0.1:18892/ws');
  await page
    .getByLabel('服务凭据', { exact: true })
    .fill('test-only-idle-settings-token-with-length');
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await page.getByRole('button', { name: '设置与账号', exact: true }).click();
  await page.getByRole('menuitem', { name: '设置', exact: true }).click();
  // The service's own, apart from Claude Code's.
  const sections = page.getByRole('navigation', { name: '设置分类' });
  await sections.getByRole('button', { name: '上下文与缓存', exact: true }).click();
  const panel = page.getByRole('region', { name: '上下文与缓存' });
  await expect(panel).toContainText('保存在服务端');
  const enabled = panel.getByRole('switch', { name: '自动压缩', exact: true });
  await expect(enabled).not.toBeChecked();
  await page.screenshot({ path: resolve(shots, 'settings-off.png') });
  await enabled.click();
  await expect(enabled).toBeChecked();
  await panel.getByLabel('空闲多久后压缩', { exact: true }).selectOption('45');
  await panel.getByLabel('上下文至少', { exact: true }).selectOption('150000');
  await expect
    .poll(() => updates)
    .toEqual([{ enabled: true }, { afterMinutes: 45 }, { minTokens: 150_000 }]);
  await expect(panel.getByLabel('上下文至少', { exact: true })).toHaveValue('150000');
  await page.screenshot({ path: resolve(shots, 'settings-on.png') });
});
