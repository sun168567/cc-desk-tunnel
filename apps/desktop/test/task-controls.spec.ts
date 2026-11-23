import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import type { Session } from '@cc-desk-tunnel/protocol';
import { screenshots } from './helpers.ts';

const shot = (page: Page, name: string) =>
  page.screenshot({ path: resolve(screenshots, 'redesign', `${name}.png`) });

test('a command waited on in the foreground can be sent to the background or ended on its own', async ({
  page,
}) => {
  const now = new Date().toISOString();
  const connectionId = randomUUID();
  const runId = randomUUID();
  const session: Session = {
    id: randomUUID(),
    title: '前台命令',
    autoTitle: false,
    projectPath: 'D:\\工作\\前台',
    permissionMode: 'auto',
    model: null,
    effort: null,
    createdAt: now,
    updatedAt: now,
    activeRun: { id: runId, status: 'running', connectionId },
  };
  const sent: unknown[] = [];
  await page.routeWebSocket('ws://127.0.0.1:18890/ws', (route) => {
    const reply = (value: unknown) => route.send(JSON.stringify(value));
    const event = (sequence: number, payload: unknown) => ({
      sessionId: session.id,
      runId,
      sequence,
      createdAt: now,
      payload,
    });
    const tool = (toolId: string, command: string) => ({
      type: 'tool.requested',
      toolId,
      name: 'Bash',
      input: JSON.stringify({ command }, null, 2),
      target: 'Linux',
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
          projects: [],
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
          lastSequence: 6,
          hasEarlier: false,
          events: [
            event(1, {
              type: 'message.user',
              messageId: randomUUID(),
              text: '构建并测试',
              scenario: 'chat',
            }),
            event(2, { type: 'run.status', status: 'running', connectionId }),
            event(3, tool('call-build', 'npm run build')),
            event(4, { type: 'tool.task', toolId: 'call-build', taskId: 'b-build' }),
            event(5, tool('call-test', 'npm test')),
            event(6, { type: 'tool.task', toolId: 'call-test', taskId: 'b-test' }),
          ],
        });
      if (message.type === 'run.task.background') {
        sent.push({ type: message.type, toolId: message.toolId });
        reply({
          type: 'session.event',
          event: event(7, {
            type: 'tool.result',
            toolId: message.toolId,
            status: 'completed',
            output: 'Command running in background with ID: b-build',
            exitCode: null,
          }),
        });
      }
      if (message.type === 'run.task.stop')
        sent.push({ type: message.type, taskId: message.taskId });
      reply({ type: 'response', requestId: message.requestId, ok: true });
    });
  });
  await page.goto('/');
  await page.getByLabel('服务地址', { exact: true }).fill('ws://127.0.0.1:18890/ws');
  await page
    .getByLabel('服务凭据', { exact: true })
    .fill('test-only-task-controls-token-with-enough-length');
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await page
    .locator('.session-row')
    .filter({ hasText: session.title })
    .locator('.session-select')
    .click();
  const group = page.locator('details.work');
  const heading = group.locator('> summary');
  const build = group.locator('details.tool').filter({ hasText: 'npm run build' });
  const tests = group.locator('details.tool').filter({ hasText: 'npm test' });
  // Two commands are waited on: each is acted on in its own line, none from the shut group's heading.
  await expect(heading).toContainText('正在运行');
  await expect(heading.getByRole('button')).toHaveCount(0);
  await heading.click();
  await expect(build.getByRole('button', { name: '转后台' })).toBeVisible();
  await expect(tests.getByRole('button', { name: '终止' })).toBeVisible();
  await shot(page, '28-前台命令');
  await build.getByRole('button', { name: '转后台' }).click();
  // The call returned at once: its buttons go, and the press did not open its line.
  await expect(build.getByRole('button', { name: '转后台' })).toHaveCount(0);
  await expect(build).not.toHaveAttribute('open', '');
  // One is left: the shut group offers it in its heading, and a press there leaves the group shut.
  await heading.click();
  await expect(group).not.toHaveAttribute('open', '');
  await shot(page, '29-前台命令-折叠');
  await heading.getByRole('button', { name: '终止' }).click();
  // Until the call returns, a second press would be a second request.
  await expect(heading.getByRole('button', { name: '终止' })).toBeDisabled();
  await expect(group).not.toHaveAttribute('open', '');
  expect(sent).toEqual([
    { type: 'run.task.background', toolId: 'call-build' },
    { type: 'run.task.stop', taskId: 'b-test' },
  ]);
});
