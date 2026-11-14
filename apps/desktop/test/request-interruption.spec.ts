import { test, expect } from '@playwright/test';
import { login, createSession, send } from './helpers.ts';
import { randomUUID } from 'node:crypto';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import type { Session } from '@cc-desk-tunnel/protocol';

for (const delivery of ['not_sent', 'unconfirmed', 'received'] as const) {
  test(`editing a ${delivery} message uses its confirmed delivery state`, async ({ page }) => {
    const now = new Date().toISOString();
    const connectionId = randomUUID(),
      runId = randomUUID(),
      messageId = randomUUID();
    const session: Session = {
      id: randomUUID(),
      title: '未送达消息',
      autoTitle: false,
      projectPath: '/tmp/message-edit',
      permissionMode: 'auto',
      model: null,
      effort: null,
      createdAt: now,
      updatedAt: now,
      activeRun: null,
    };
    const original = '请先检查代码，不要修改文件';
    const requests: {
      type: string;
      sessionId?: string;
      beforeMessageId?: string;
      text?: string;
    }[] = [];
    const events = [
      { type: 'message.user', messageId, text: original, scenario: 'chat' },
      { type: 'message.delivery', messageId, status: delivery },
      { type: 'run.status', status: 'cancelled', connectionId },
    ].map((payload, index) => ({
      sessionId: session.id,
      runId,
      sequence: index + 1,
      createdAt: now,
      payload,
    }));
    await page.routeWebSocket('ws://127.0.0.1:18914/ws', (route) => {
      const reply = (message: unknown) => route.send(JSON.stringify(message));
      route.onMessage((raw) => {
        const message = JSON.parse(String(raw));
        if (message.type === 'device') return;
        if (message.type === 'auth') {
          reply({
            type: 'ready',
            protocolVersion: PROTOCOL_VERSION,
            version: '0.3.15',
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
        if (['session.fork', 'message.send'].includes(message.type)) requests.push(message);
        reply({ type: 'response', requestId: message.requestId, ok: true });
      });
    });
    await page.goto('/');
    await page.getByLabel('服务地址', { exact: true }).fill('ws://127.0.0.1:18914/ws');
    await page
      .getByLabel('服务凭据', { exact: true })
      .fill('test-only-message-edit-token-long-enough');
    await page.getByRole('button', { name: '连接', exact: true }).click();
    const expand = page.getByRole('button', { name: '展开会话列表', exact: true });
    if (await expand.isVisible()) await expand.click();
    await page.locator('.session-select').filter({ hasText: session.title }).click();
    const box = page.getByRole('textbox', { name: '消息' });
    const edit = page.getByRole('button', { name: '编辑重发', exact: true });
    await edit.click();
    if (delivery !== 'not_sent') {
      await expect.poll(() => requests.length).toBe(1);
      expect(requests[0]).toMatchObject({
        type: 'session.fork',
        sessionId: session.id,
        beforeMessageId: messageId,
      });
      await expect(box).toHaveValue('');
      return;
    }
    await expect(box).toHaveValue(original);
    await expect(edit).toHaveAttribute('title', /当前会话.*不创建分叉/);
    await expect(page.locator('.session-row')).toHaveCount(1);
    await expect(page.locator('.session-row.selected strong')).toHaveText(session.title);
    expect(requests).toEqual([]);
    // Cancelling the draft does not leave behind a new session, and unrelated draft text is preserved.
    await box.fill('');
    await box.fill('尚未发送的另一份草稿');
    await edit.click();
    await expect(box).toHaveValue('尚未发送的另一份草稿');
    await expect(page.getByRole('alert')).toContainText('输入框里还有草稿');
    expect(requests).toEqual([]);
    await box.fill('');
    await edit.click();
    await expect(box).toHaveValue(original);
    await box.fill('请先检查类型错误，不要修改文件');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect.poll(() => requests.length).toBe(1);
    expect(requests[0]).toMatchObject({
      type: 'message.send',
      sessionId: session.id,
      text: '请先检查类型错误，不要修改文件',
    });
    await expect(box).toHaveValue('');
    await expect(page.locator('.message-delivery')).toHaveText('未送达原生');
  });
}

test('a lost acknowledgement is described as a past interruption after reconnect, without resending', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const Original = window.WebSocket;
    const sent: string[] = [];
    Object.assign(window, { interruptedSends: sent });
    let interrupted = false;
    window.WebSocket = class extends Original {
      pendingMessage?: string;
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        this.addEventListener('message', (event) => {
          const message = JSON.parse(String(event.data));
          if (
            !interrupted &&
            message.type === 'response' &&
            message.requestId === this.pendingMessage
          ) {
            // The server accepted the message, but the acknowledgement did not reach the renderer.
            interrupted = true;
            event.stopImmediatePropagation();
            this.close();
          }
        });
      }
      send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
        if (typeof data === 'string') {
          const command = JSON.parse(data);
          if (command.type === 'message.send') {
            sent.push(command.requestId);
            this.pendingMessage = command.requestId;
          }
        }
        super.send(data);
      }
    };
  });
  await page.goto('/');
  await login(page);
  await createSession(page, '确认丢失');
  await send(page, '这条消息只能发送一次');
  await expect(page.getByText('连接中断，等待恢复', { exact: true })).toBeVisible();
  await expect(page.locator('.connection-status')).toContainText('已连接');
  await expect(page.locator('.error-banner')).toContainText('连接已恢复');
  await expect(page.locator('.error-banner')).toContainText('上次请求');
  await expect(page.locator('.error-banner')).toContainText('任务可能仍在运行');
  await expect(page.locator('.error-banner')).toContainText('不会自动重发');
  await expect(page.locator('.message.user')).toHaveCount(1);
  expect(
    await page.evaluate(
      () => (window as unknown as { interruptedSends: string[] }).interruptedSends.length,
    ),
  ).toBe(1);
});
