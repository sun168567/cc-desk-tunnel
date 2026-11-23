import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import type { Session } from '@cc-desk-tunnel/protocol';

// One turn of hundreds of steps, as a long agent run leaves behind: opening it must stay quick in both views, and
// typing in the message box must not wait on the steps.
const steps = 400;

for (const mode of ['standard', 'expanded']) {
  test(`a turn of ${steps} steps opens quickly and typing stays quick · ${mode}`, async ({
    page,
  }) => {
    await page.addInitScript(
      (saved) => localStorage.setItem('proxy-prefs', JSON.stringify(saved)),
      { view: { mode } },
    );
    const now = new Date().toISOString();
    const connectionId = randomUUID();
    const runId = randomUUID();
    const session: Session = {
      id: randomUUID(),
      title: '长会话',
      autoTitle: false,
      projectPath: 'D:\\工作\\长会话',
      permissionMode: 'auto',
      model: null,
      effort: null,
      createdAt: now,
      updatedAt: now,
      activeRun: null,
    };
    await page.routeWebSocket('ws://127.0.0.1:18894/ws', (route) => {
      const reply = (value: unknown) => route.send(JSON.stringify(value));
      let history:
        { requestId: string; text: string; offset: number; outstanding: number } | undefined;
      const deliver = () => {
        if (!history) return;
        while (history.outstanding < 4 && history.offset < history.text.length) {
          const data = history.text.slice(history.offset, history.offset + 32768);
          history.offset += data.length;
          history.outstanding++;
          reply({
            type: 'session.history.part',
            requestId: history.requestId,
            sessionId: session.id,
            data,
            last: history.offset === history.text.length,
          });
        }
        if (!history.outstanding) {
          reply({ type: 'response', requestId: history.requestId, ok: true });
          history = undefined;
        }
      };
      let sequence = 0;
      const at = Date.now() - 3_600_000;
      const event = (payload: unknown) => ({
        sessionId: session.id,
        runId,
        sequence: ++sequence,
        createdAt: new Date(at + sequence * 1000).toISOString(),
        payload,
      });
      const events = [
        event({
          type: 'message.user',
          messageId: randomUUID(),
          text: '跑一长串步骤',
          scenario: 'chat',
        }),
      ];
      for (let n = 0; n < steps; n++) {
        const toolId = `t${n}`;
        events.push(
          event({
            type: 'thinking.delta',
            messageId: randomUUID(),
            text: `**第${n}步**\n先想一想`,
          }),
          event({
            type: 'tool.requested',
            toolId,
            name: 'Bash',
            input: JSON.stringify({ command: 'ls', description: `第${n}步` }),
            target: 'Windows',
          }),
          event({ type: 'tool.result', toolId, status: 'completed', output: 'a b', exitCode: 0 }),
        );
      }
      events.push(
        event({ type: 'text.delta', messageId: randomUUID(), text: '全部做完。' }),
        event({ type: 'run.status', status: 'completed', connectionId }),
      );
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
        if (message.type === 'session.subscribe') {
          history = {
            requestId: message.requestId,
            offset: 0,
            outstanding: 0,
            text: JSON.stringify([
              {
                type: 'session.snapshot',
                requestId: message.requestId,
                session,
                mode: 'replace',
                firstSequence: 1,
                lastSequence: sequence,
                hasEarlier: false,
                events,
              },
            ]),
          };
          deliver();
          return;
        }
        if (message.type === 'session.history.next' && history) {
          history.outstanding--;
          deliver();
          return;
        }
        reply({ type: 'response', requestId: message.requestId, ok: true });
      });
    });
    await page.goto('/');
    await page.getByLabel('服务地址', { exact: true }).fill('ws://127.0.0.1:18894/ws');
    await page
      .getByLabel('服务凭据', { exact: true })
      .fill('test-only-view-token-with-enough-length');
    await page.getByRole('button', { name: '连接', exact: true }).click();
    const expand = page.getByRole('button', { name: '展开会话列表', exact: true });
    if (await expand.isVisible()) await expand.click();
    const opened = Date.now();
    await page
      .locator('.session-row')
      .filter({ hasText: session.title })
      .locator('.session-select')
      .click();
    await expect(page.getByText('全部做完。')).toBeVisible();
    const openMs = Date.now() - opened;
    // The folded view draws one line; the expanded one draws every step.
    await expect(page.locator('.work-flat .tool-subject')).toHaveCount(
      mode === 'expanded' ? steps : 0,
    );
    const box = page.getByRole('textbox').last();
    const typed = Date.now();
    await box.pressSequentially('abcdefghijklmnopqrstuvwxyz0123456789');
    const perKey = (Date.now() - typed) / 36;
    console.log(`${mode}: opened in ${openMs} ms, ${perKey.toFixed(1)} ms per key`);
    expect(openMs).toBeLessThan(5000);
    expect(perKey).toBeLessThan(150);
  });
}
