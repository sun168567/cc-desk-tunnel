import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import type { Session, TerminalActivity } from '@cc-desk-tunnel/protocol';
import { screenshots } from './helpers.ts';

const folder = resolve(screenshots, '终端占用');
mkdirSync(folder, { recursive: true });
const shot = (page: Page, name: string) =>
  page.screenshot({ path: resolve(folder, `${name}.png`) });

test('a session a terminal of ccdt holds says what the terminal does, and takes no message here', async ({
  page,
}) => {
  const connectionId = randomUUID();
  const runId = randomUUID();
  const now = new Date().toISOString();
  const held = (activity?: TerminalActivity): Session => ({
    id: session.id,
    title: '终端里的会话',
    autoTitle: false,
    projectPath: 'D:\\工作\\终端',
    permissionMode: 'default',
    model: null,
    effort: null,
    createdAt: now,
    updatedAt: now,
    activeRun: activity
      ? { id: runId, status: 'running', connectionId, surface: 'terminal', activity }
      : null,
  });
  const session = { id: randomUUID() } as Session;
  Object.assign(session, held('working'));
  const events = [
    {
      sessionId: session.id,
      runId,
      sequence: 1,
      createdAt: now,
      payload: { type: 'run.status', status: 'running', connectionId, surface: 'terminal' },
    },
    {
      sessionId: session.id,
      runId,
      sequence: 2,
      createdAt: now,
      payload: {
        type: 'message.user',
        messageId: randomUUID(),
        text: '终端里问的',
        scenario: 'chat',
      },
    },
    {
      sessionId: session.id,
      runId,
      sequence: 3,
      createdAt: now,
      payload: { type: 'text.delta', messageId: randomUUID(), text: '终端里答的' },
    },
  ];
  let send: (value: unknown) => void = () => {};
  await page.routeWebSocket('ws://127.0.0.1:18898/ws', (route) => {
    send = (value) => route.send(JSON.stringify(value));
    route.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === 'device') return;
      if (message.type === 'auth')
        return send({
          type: 'ready',
          protocolVersion: PROTOCOL_VERSION,
          version: '0.0.1',
          connectionId: randomUUID(),
          adapter: 'claude-code',
          sessions: [session],
        });
      if (message.type === 'session.subscribe')
        send({
          type: 'session.snapshot',
          requestId: message.requestId,
          session,
          mode: 'replace',
          firstSequence: 1,
          lastSequence: events.length,
          hasEarlier: false,
          events,
        });
      send({ type: 'response', requestId: message.requestId, ok: true });
    });
  });
  await page.goto('/');
  await page.getByLabel('服务地址', { exact: true }).fill('ws://127.0.0.1:18898/ws');
  await page
    .getByLabel('服务凭据', { exact: true })
    .fill('test-only-terminal-token-with-enough-length');
  await page.getByRole('button', { name: '连接', exact: true }).click();
  const row = page.locator('.session-row').filter({ hasText: '终端里的会话' });
  await row.locator('.session-select').click();
  const status = page.locator('.transcript > .run-indicator');
  const input = page.getByLabel('消息', { exact: true });

  // The terminal's turns show here as its CLI writes them; the message box waits for the terminal to close.
  await expect(page.locator('.transcript')).toContainText('终端里答的');
  await expect(status).toContainText('终端运行中');
  await expect(status.locator('.running-dot')).toHaveClass(/breathing/);
  await expect(row).toContainText('终端运行中');
  await expect(input).toBeDisabled();
  await expect(input).toHaveAttribute('placeholder', /关闭终端后/);
  await expect(page.getByRole('button', { name: '停止运行' })).toHaveCount(0);
  await shot(page, '01-终端运行中');

  send({ type: 'session.updated', session: held('waiting') });
  await expect(status).toContainText('终端等你确认');
  await expect(row).toContainText('终端等你确认');
  await expect(status.locator('.running-dot')).not.toHaveClass(/breathing/);
  send({ type: 'session.updated', session: held('idle') });
  await expect(row).toContainText('终端打开中');
  await shot(page, '02-终端打开中');

  // Closed, the session is this window's again.
  send({ type: 'session.updated', session: held() });
  await expect(status).toHaveCount(0);
  await expect(input).toBeEnabled();
});
