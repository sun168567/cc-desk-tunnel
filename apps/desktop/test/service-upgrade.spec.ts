import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import type { Session } from '@cc-desk-tunnel/protocol';

const now = new Date().toISOString();
const session = (title: string, activeRun: Session['activeRun'] = null): Session => ({
  id: randomUUID(),
  title,
  autoTitle: false,
  projectPath: 'D:\\项目',
  permissionMode: 'default',
  model: null,
  effort: null,
  createdAt: now,
  updatedAt: now,
  activeRun,
});
const run = { id: randomUUID(), connectionId: randomUUID(), status: 'running' as const };

// A service of `version` that offers 9.9.9, with these sessions; what it was asked to install is kept.
async function connect(page: Page, version: string, sessions: Session[]) {
  const installs: { force?: boolean }[] = [];
  await page.routeWebSocket('ws://127.0.0.1:18898/ws', (route) => {
    const send = (value: unknown) => route.send(JSON.stringify(value));
    route.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === 'device') return;
      if (message.type === 'auth')
        return send({
          type: 'ready',
          protocolVersion: PROTOCOL_VERSION,
          version,
          connectionId: randomUUID(),
          adapter: 'claude-code',
          sessions,
          update: { state: 'available', latest: '9.9.9', checkedAt: Date.now() },
        });
      if (message.type === 'service.update.install') installs.push(message);
      send({ type: 'response', requestId: message.requestId, ok: true });
    });
  });
  await page.goto('/');
  await page.getByLabel('服务地址', { exact: true }).fill('ws://127.0.0.1:18898/ws');
  await page
    .getByLabel('服务凭据', { exact: true })
    .fill('test-only-upgrade-token-with-enough-length');
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await expect(page.locator('.session-row')).toHaveCount(sessions.length);
  return installs;
}
// Opens the update menu, takes the upgrade and answers its question yes; resolves to the question.
async function upgrade(page: Page) {
  await page.getByRole('button', { name: '更新' }).click();
  const asked = new Promise<string>((resolve) =>
    page.once('dialog', (dialog) => {
      resolve(dialog.message());
      void dialog.accept();
    }),
  );
  await page.getByRole('menuitem', { name: /升级服务端到 9\.9\.9/ }).click();
  return asked;
}

test('an upgrade goes ahead past open terminals at rest and background tasks, and says they end', async ({
  page,
}) => {
  const installs = await connect(page, '0.3.15', [
    session('空闲的会话'),
    session('终端开着', { ...run, surface: 'terminal', activity: 'idle' }),
    session('等后台任务', { ...run, waiting: 'background' }),
  ]);
  await page.getByRole('button', { name: '更新' }).click();
  await expect(
    page.getByRole('menuitem', { name: '升级服务端到 9.9.9', exact: true }),
  ).toBeEnabled();
  await page.keyboard.press('Escape');
  const question = await upgrade(page);
  expect(question).toContain('「终端开着」「等后台任务」开着终端或在等后台任务，它们会被结束');
  await expect.poll(() => installs).toEqual([expect.not.objectContaining({ force: true })]);
});

test('sessions at work are named, and the upgrade goes past them only when forced', async ({
  page,
}) => {
  const installs = await connect(page, '0.3.15', [
    session('在回答', run),
    session('终端在跑', { ...run, surface: 'terminal', activity: 'working' }),
  ]);
  await page.getByRole('button', { name: '更新' }).click();
  await expect(
    page.getByRole('menuitem', { name: '升级服务端到 9.9.9（2 个会话正在运行）' }),
  ).toBeEnabled();
  await page.keyboard.press('Escape');
  const question = await upgrade(page);
  expect(question).toContain('「在回答」「终端在跑」正在运行');
  expect(question).toContain('仍然强行升级到 9.9.9');
  await expect.poll(() => installs).toEqual([expect.objectContaining({ force: true })]);
});

test('a service that cannot be forced says what to end first', async ({ page }) => {
  await connect(page, '0.3.14', [
    session('终端开着', { ...run, surface: 'terminal', activity: 'idle' }),
  ]);
  await page.getByRole('button', { name: '更新' }).click();
  await expect(
    page.getByRole('menuitem', { name: '升级服务端到 9.9.9（先关闭终端、等后台任务结束）' }),
  ).toBeDisabled();
});
