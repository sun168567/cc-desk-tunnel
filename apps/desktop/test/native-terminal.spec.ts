import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import type { Session } from '@cc-desk-tunnel/protocol';
import { screenshots, sessionAction } from './helpers.ts';

test('the native terminal is drawn by the GPU, sends keys and acknowledges what it drew', async ({
  page,
}) => {
  const session: Session = {
    id: randomUUID(),
    title: '终端里继续',
    autoTitle: false,
    projectPath: 'D:\\工作\\存储',
    permissionMode: 'auto',
    model: null,
    effort: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    activeRun: null,
  };
  const terminalId = randomUUID();
  const screen =
    '\x1b[1;38;5;173m✻ Welcome to Claude Code!\x1b[0m\r\n\r\n' +
    '  /help 查看命令 · 当前目录 D:\\工作\\存储\r\n\r\n' +
    '\x1b[38;5;244m' +
    '─'.repeat(60) +
    '\x1b[0m\r\n> ';
  const sent: { type: string; [key: string]: unknown }[] = [];
  await page.routeWebSocket('ws://127.0.0.1:18899/ws', (route) => {
    const send = (value: unknown) => route.send(JSON.stringify(value));
    route.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === 'device') return;
      sent.push(message);
      if (message.type === 'auth') {
        send({
          type: 'ready',
          protocolVersion: PROTOCOL_VERSION,
          version: '0.0.1',
          connectionId: randomUUID(),
          adapter: 'claude-code',
          sessions: [session],
        });
        return;
      }
      if (!message.requestId) return;
      if (message.type === 'session.subscribe')
        send({
          type: 'session.snapshot',
          requestId: message.requestId,
          session,
          mode: 'replace',
          firstSequence: 0,
          lastSequence: 0,
          hasEarlier: false,
          events: [],
        });
      send({ type: 'response', requestId: message.requestId, ok: true });
      if (message.type === 'terminal.open') {
        send({ type: 'terminal.opened', sessionId: session.id, terminalId });
        send({
          type: 'terminal.data',
          sessionId: session.id,
          terminalId,
          data: screen,
          bytes: Buffer.byteLength(screen),
        });
      }
    });
  });
  await page.goto('/');
  await page.getByLabel('服务地址', { exact: true }).fill('ws://127.0.0.1:18899/ws');
  await page
    .getByLabel('服务凭据', { exact: true })
    .fill('test-only-native-terminal-token-with-length');
  await page.getByRole('button', { name: '连接', exact: true }).click();
  const expand = page.getByRole('button', { name: '展开会话列表', exact: true });
  if (await expand.isVisible()) await expand.click();
  await page
    .locator('.session-row')
    .filter({ hasText: session.title })
    .locator('.session-select')
    .click();
  await sessionAction(page, '原生终端');
  const terminal = page.getByRole('region', { name: '原生 Claude Code 终端' });
  await expect(terminal).toContainText('Linux · Claude Code');
  // The WebGL renderer draws on canvases, where the DOM renderer would have rows of text.
  await expect(terminal.locator('.xterm-screen canvas').first()).toBeVisible();
  await expect(terminal.locator('.xterm-rows')).toHaveCount(0);
  await expect
    .poll(() => sent.find((message) => message.type === 'terminal.ack')?.bytes)
    .toBe(Buffer.byteLength(screen));
  await page.keyboard.type('/help');
  await expect
    .poll(() =>
      sent
        .filter((message) => message.type === 'terminal.input')
        .map((message) => message.data)
        .join(''),
    )
    .toBe('/help');
  await page.screenshot({ path: resolve(screenshots, 'native-terminal.png') });
});
