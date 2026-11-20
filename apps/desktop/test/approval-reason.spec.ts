import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import type { Session } from '@cc-desk-tunnel/protocol';

// A call Claude Code's own safety check asks about, in a session that bypasses permissions: the card says why it
// asks all the same, in Claude Code's words.
test('an approval asked by a safety check says so, and why, even when permissions are bypassed', async ({
  page,
}) => {
  const now = new Date().toISOString();
  const connectionId = randomUUID();
  const runId = randomUUID();
  const approvalId = randomUUID();
  const session: Session = {
    id: randomUUID(),
    title: '安全检查',
    autoTitle: false,
    projectPath: 'D:\\工作\\安全检查',
    permissionMode: 'bypassPermissions',
    model: null,
    effort: null,
    createdAt: now,
    updatedAt: now,
    activeRun: { id: runId, status: 'awaiting_approval', connectionId, waiting: 'approval' },
  };
  const reason = 'Dangerous rm operation on statically-unresolvable target: /tmp/pcx/sa/*';
  let sequence = 0;
  const event = (payload: unknown) => ({
    sessionId: session.id,
    runId,
    sequence: ++sequence,
    createdAt: now,
    payload,
  });
  const events = [
    event({ type: 'message.user', messageId: randomUUID(), text: '清理一下', scenario: 'chat' }),
    event({ type: 'run.status', status: 'running', connectionId }),
    event({
      type: 'tool.requested',
      toolId: 't1',
      name: 'Bash',
      input: JSON.stringify(
        { command: 'mkdir -p /tmp/pcx/sa && cd /tmp/pcx/sa && rm -f *' },
        null,
        2,
      ),
      target: 'Linux',
    }),
    event({ type: 'approval.requested', approvalId, toolId: 't1', reason, safetyCheck: true }),
    event({ type: 'run.status', status: 'awaiting_approval', connectionId, waiting: 'approval' }),
  ];
  await page.routeWebSocket('ws://127.0.0.1:18895/ws', (route) => {
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
      if (message.type === 'session.subscribe') {
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
        reply({ type: 'response', requestId: message.requestId, ok: true });
        return;
      }
      reply({ type: 'response', requestId: message.requestId, ok: true });
    });
  });
  await page.goto('/');
  await page.getByLabel('服务地址', { exact: true }).fill('ws://127.0.0.1:18895/ws');
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
  const note = page.getByRole('note').filter({ hasText: 'Claude Code 安全拦截' });
  await expect(note).toContainText('绕过时也提醒');
  await expect(note).toContainText(reason);
  await expect(page.getByRole('button', { name: '允许', exact: true })).toBeVisible();
  if (process.env.APPROVAL_SHOTS)
    await page.screenshot({ path: resolve(process.env.APPROVAL_SHOTS, '安全检查审批.png') });
});
