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
async function offerUpdate(page: Page, version: string, sessions: Session[]) {
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
          serverDeviceId: '00000000-0000-4000-8000-000000000001',
          version,
          connectionId: randomUUID(),
          adapter: 'claude-code',
          projects: [],
          sessions,
          update: { state: 'available', latest: '9.9.9', checkedAt: Date.now() },
        });
      if (message.type === 'service.update.install') installs.push(message);
      send({ type: 'response', requestId: message.requestId, ok: true });
    });
  });
  return installs;
}

async function connect(page: Page, version: string, sessions: Session[]) {
  const installs = await offerUpdate(page, version, sessions);
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

test('a Mac confirms and retries client installation from the workbench update menu', async ({
  page,
}) => {
  // The connection and its update announcement use the workbench's normal WebSocket flow.
  // The desktop bridge stands in for downloading, preparing and handing off to the installer.
  const version = '0.3.22';
  const serviceInstalls = await offerUpdate(page, version, []);
  await page.addInitScript((version) => {
    const downloads: string[] = [];
    let cancel = () => {};
    let progress = (_step: { source: 'github'; phase: 'preparing' | 'installing' }) => {};
    const desktop = {
      platform: 'darwin',
      version: async () => version,
      device: async () => ({ id: '00000000-0000-4000-8000-000000000002', name: 'Mac' }),
      loadLogin: async () => ({
        url: 'wss://service.test/ws',
        token: 'test-only-upgrade-token-with-enough-length',
        fingerprint: '',
        mode: 'remote',
      }),
      connectProxy: async () => ({ url: 'ws://127.0.0.1:18898/ws' }),
      workspaceRoots: async () => [],
      legacyProjects: async () => null,
      loadDrafts: async () => ({}),
      saveDrafts: async () => {},
      loadSchedules: async (text: string) => ({ path: '', text }),
      onSchedulesChanged: () => () => {},
      onSharedChanged: () => () => {},
      onUpdateProgress: (callback: typeof progress) => {
        progress = callback;
        return () => {};
      },
      onNotifyClicked: () => () => {},
      saveLogin: async () => {},
      setBusy: async () => {},
      installUpdate: async (target: string) => {
        downloads.push(target);
        if (downloads.length === 1)
          return new Promise((resolve) => {
            cancel = () => resolve({ cancelled: true });
          });
        progress({ source: 'github', phase: 'preparing' });
        if (downloads.length === 2) throw new Error('安装包校验失败。');
        progress({ source: 'github', phase: 'installing' });
        return {};
      },
      cancelUpdate: async () => cancel(),
    };
    Object.assign(window, { desktop, macDownloads: downloads });
  }, version);
  await page.goto('/');
  const connected = page.locator('.connection-status');
  await expect(connected).toContainText('已连接');
  const menu = page.getByRole('button', { name: '更新', exact: true });
  const action = page.getByRole('menuitem', { name: '升级客户端到 9.9.9', exact: true });
  const downloads = () =>
    page.evaluate(() => (window as unknown as { macDownloads: string[] }).macDownloads);
  async function chooseUpgrade(accept: boolean) {
    await menu.click();
    const answer = page.waitForEvent('dialog').then(async (dialog) => {
      const message = dialog.message();
      if (accept) await dialog.accept();
      else await dialog.dismiss();
      return message;
    });
    await action.click();
    return answer;
  }

  const confirmation = await chooseUpgrade(false);
  expect(confirmation).toContain('9.9.9');
  expect(confirmation).toContain('这份应用的所有连接');
  expect(confirmation).toContain('任务可能中断');
  expect(confirmation).toContain('自动重启');
  expect(await downloads()).toEqual([]);

  await chooseUpgrade(true);
  await menu.click();
  await page.getByRole('menuitem', { name: '取消客户端升级' }).click();
  await expect(connected).toContainText('已连接');

  await page.locator('.titlebar-menus').getByRole('button', { name: '帮助', exact: true }).click();
  await page.getByRole('menuitem', { name: '检查更新' }).click();
  const about = page.getByRole('region', { name: '关于与更新' });
  await expect(about).toBeVisible();
  await expect(about.getByRole('button', { name: /下载|macOS.*安装包|升级客户端/ })).toHaveCount(0);
  await chooseUpgrade(true);
  const failure = page.getByRole('dialog').filter({ hasText: '客户端升级失败' });
  await expect(failure.getByRole('alert')).toContainText('安装包校验失败');
  await failure.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(failure).toHaveCount(0);
  await expect(about).toBeVisible();
  await expect(connected).toContainText('已连接');
  await chooseUpgrade(true);
  await menu.click();
  await expect(
    page.getByRole('menuitem', { name: '正在安装，完成后客户端会自动打开' }),
  ).toBeDisabled();
  await expect(page.getByRole('menuitem', { name: '取消客户端升级' })).toHaveCount(0);
  expect(await downloads()).toEqual(['9.9.9', '9.9.9', '9.9.9']);
  expect(serviceInstalls).toEqual([]);
});
