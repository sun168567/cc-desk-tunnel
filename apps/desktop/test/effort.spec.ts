import { test, expect } from '@playwright/test';
import type { WebSocketRoute } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import type { Session, Effort } from '@cc-desk-tunnel/protocol';

test('effort drag previews continuously, saves on release and keeps the menu open while saving', async ({
  page,
}) => {
  const now = new Date().toISOString();
  const session: Session = {
    id: randomUUID(),
    title: '滑条回归',
    autoTitle: false,
    projectPath: 'D:\\工作\\滑条回归',
    permissionMode: 'auto',
    model: 'test-model',
    effort: 'high',
    createdAt: now,
    updatedAt: now,
    activeRun: null,
  };
  const connectionId = randomUUID(),
    runId = randomUUID();
  const pending: { route: WebSocketRoute; requestId: string; effort: Effort | null }[] = [];
  let saves = 0;
  await page.routeWebSocket('ws://127.0.0.1:18888/ws', (route) => {
    const send = (value: unknown) => route.send(JSON.stringify(value));
    route.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === 'auth') {
        send({
          type: 'ready',
          protocolVersion: PROTOCOL_VERSION,
          version: '0.0.1',
          connectionId,
          adapter: 'claude-code',
          sessions: [session],
        });
      } else if (message.type === 'session.subscribe') {
        send({
          type: 'session.snapshot',
          requestId: message.requestId,
          session,
          mode: 'replace',
          firstSequence: 1,
          lastSequence: 2,
          hasEarlier: false,
          events: [
            {
              sessionId: session.id,
              runId,
              sequence: 1,
              createdAt: now,
              payload: {
                type: 'native.capabilities',
                account: {},
                commands: [],
                models: [
                  {
                    value: 'test-model',
                    displayName: '测试模型',
                    description: '回归夹具',
                    source: 'native',
                    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
                  },
                ],
              },
            },
            {
              sessionId: session.id,
              runId,
              sequence: 2,
              createdAt: now,
              payload: {
                type: 'native.session',
                nativeSessionId: randomUUID(),
                model: 'test-model',
                version: 'test',
                effort: 'high',
              },
            },
          ],
        });
        send({ type: 'response', requestId: message.requestId, ok: true });
      } else if (message.type === 'session.configure') {
        saves++;
        pending.push({ route, requestId: message.requestId, effort: message.effort });
      } else {
        send({ type: 'response', requestId: message.requestId, ok: true });
      }
    });
  });
  function complete(ok = true) {
    const request = pending.shift()!;
    if (ok) {
      session.effort = request.effort;
      request.route.send(JSON.stringify({ type: 'session.updated', session }));
    }
    request.route.send(
      JSON.stringify({
        type: 'response',
        requestId: request.requestId,
        ok,
        message: ok ? undefined : '测试保存失败',
      }),
    );
  }
  await page.goto('/');
  await page.getByLabel('服务地址', { exact: true }).fill('ws://127.0.0.1:18888/ws');
  await page
    .getByLabel('服务凭据', { exact: true })
    .fill('test-only-effort-token-with-enough-length');
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await page.locator('.session-select').filter({ hasText: session.title }).click();
  await page.getByRole('button', { name: '模型与推理强度', exact: true }).click();
  const menu = page.getByRole('dialog', { name: '模型与推理强度', exact: true });
  const slider = page.getByRole('slider', { name: '推理强度', exact: true });
  await expect(slider).toBeEnabled();
  const box = (await slider.boundingBox())!;
  await page.mouse.move(box.x + 8, box.y + box.height / 2);
  await page.mouse.down();
  for (const fraction of [0.3, 0.6, 0.9, 1]) {
    await page.mouse.move(box.x + 8 + (box.width - 16) * fraction, box.y + box.height / 2, {
      steps: 4,
    });
    await expect(menu).toBeVisible();
    expect(saves).toBe(0);
  }
  await expect(slider).toHaveValue('4');
  await expect(menu.locator('.effort-heading')).toContainText('最高');
  await page.mouse.up();
  await expect.poll(() => saves).toBe(1);
  await expect(slider).toBeDisabled();
  await expect(menu).toBeVisible();
  expect(pending[0].effort).toBe('max');
  complete();
  await expect(slider).toBeEnabled();
  await expect(slider).toHaveValue('4');

  await slider.focus();
  await page.keyboard.down('Home');
  await expect(slider).toHaveValue('0');
  expect(saves).toBe(1);
  await page.keyboard.up('Home');
  await expect.poll(() => saves).toBe(2);
  expect(pending[0].effort).toBe('low');
  complete();
  await expect(slider).toBeEnabled();
  await expect(menu).toBeVisible();
  await page.screenshot({ path: resolve('.local/screenshots/effort-desktop.png') });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '恢复默认推理强度', exact: true }).click();
  await expect.poll(() => saves).toBe(3);
  expect(pending[0].effort).toBeNull();
  complete();
  await expect(slider).toBeEnabled();
  await expect(menu).toBeVisible();
  await page.screenshot({ path: resolve('.local/screenshots/effort-mobile.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await slider.press('End');
  await expect.poll(() => saves).toBe(4);
  complete(false);
  await expect(page.getByRole('alert')).toContainText('测试保存失败');
  await expect(slider).toBeEnabled();
  await expect(menu).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
});
