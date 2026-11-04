import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import type { Session } from '@cc-desk-tunnel/protocol';

test('the client tells the service whether to keep the quota current, from either place it is set', async ({
  page,
}) => {
  const now = new Date().toISOString();
  const session: Session = {
    id: randomUUID(),
    title: '额度',
    autoTitle: false,
    projectPath: 'D:\\工作\\额度',
    permissionMode: 'default',
    model: null,
    effort: null,
    createdAt: now,
    updatedAt: now,
    activeRun: null,
  };
  const watched: boolean[] = [];
  const statuses: unknown[] = [];
  await page.routeWebSocket('ws://127.0.0.1:18899/ws', (route) => {
    const send = (value: unknown) => route.send(JSON.stringify(value));
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
      if (message.type === 'quota.watch') watched.push(message.active);
      if (message.type === 'session.status') statuses.push(message.quota);
      send({ type: 'response', requestId: message.requestId, ok: true });
    });
  });
  await page.goto('/');
  await page.getByLabel('服务地址', { exact: true }).fill('ws://127.0.0.1:18899/ws');
  await page
    .getByLabel('服务凭据', { exact: true })
    .fill('test-only-quota-token-with-enough-length');
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await expect.poll(() => watched).toEqual([true]);

  await page.getByRole('button', { name: '设置与账号', exact: true }).click();
  await page.getByRole('menuitem', { name: '设置', exact: true }).click();
  const sections = page.getByRole('navigation', { name: '设置分类' });
  await sections.getByRole('button', { name: '账号与额度', exact: true }).click();
  const name = { name: '运行中每分钟读取一次额度', exact: true };
  await expect(page.getByRole('switch', name)).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('switch', name).click();
  await expect.poll(() => watched).toEqual([true, false]);
  // The account page's refresh reads the quota all the same.
  await page.getByRole('button', { name: '刷新账号信息', exact: true }).click();
  await expect.poll(() => statuses.at(-1)).toBe(true);

  // Kept when the page is left and opened again.
  await sections.getByRole('button', { name: '常规', exact: true }).click();
  await sections.getByRole('button', { name: '账号与额度', exact: true }).click();
  await expect(page.getByRole('switch', name)).toHaveAttribute('aria-checked', 'false');
  await page.getByRole('switch', name).click();
  await expect.poll(() => watched).toEqual([true, false, true]);
});
