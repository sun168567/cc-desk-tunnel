import { test, expect, _electron } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createProxyServer } from '../../server/src/server.ts';
import type { Session } from '@cc-desk-tunnel/protocol';
import { connectionArgs, connectionWindow, screenshots, sessionAction } from './helpers.ts';

// About 320 KB of reply: a page of history holds one or two such turns.
const long = 'history '.repeat(40000);

test('history read before shows from disk, the service sends only what came since, and what it deleted goes', async () => {
  test.skip(process.platform !== 'win32', 'Windows desktop');
  test.setTimeout(120000);
  mkdirSync(resolve('.local'), { recursive: true });
  const directory = mkdtempSync(join(resolve('.local'), 'history-cache-'));
  const folder = join(directory, 'project');
  mkdirSync(folder);
  const token = `cache-${randomUUID()}`;
  const server = createProxyServer({
    host: '127.0.0.1',
    token,
    dataDir: join(directory, 'server'),
  });
  const url = (await server.listen(0)).replace('http:', 'ws:') + '/ws';
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env))
    if (value !== undefined && name !== 'ELECTRON_RUN_AS_NODE') env[name] = value;
  const profile = join(directory, 'profile');
  const launch = (fresh = false) =>
    _electron.launch({
      args: [resolve('apps/desktop'), '--smoke-test', ...connectionArgs(profile, fresh)],
      env,
    });
  // What the window asks the service for.
  let sent: {
    type?: string;
    sessionId?: string;
    afterSequence?: number;
    afterCreatedAt?: string;
  }[] = [];
  const watch = (page: Page) =>
    page.on('websocket', (socket) =>
      socket.on('framesent', (frame) => {
        try {
          sent.push(JSON.parse(String(frame.payload)));
        } catch {
          // Not a frame of the protocol.
        }
      }),
    );
  const asked = (type: string) => sent.filter((frame) => frame.type === type);
  const signIn = async (page: Page, again = false) => {
    const simulated = page.getByRole('button', { name: '本地模拟', exact: true });
    if (await simulated.isVisible()) await simulated.click();
    // A connection signed in before keeps to its service.
    if (again) await expect(page.getByLabel('服务地址')).toHaveValue(url);
    else await page.getByLabel('服务地址').fill(url);
    await page.getByLabel('服务凭据').fill(token);
    await page.getByRole('button', { name: '连接', exact: true }).click();
    const signedIn = await connectionWindow(application);
    await expect(signedIn.locator('.connection-status')).toContainText('已连接');
    return signedIn;
  };
  const turn = (session: Session, index: number) => {
    const run = randomUUID();
    server.store.append(session.id, run, {
      type: 'message.user',
      messageId: randomUUID(),
      scenario: 'chat',
      text: `缓存问题${index}`,
    });
    server.store.append(session.id, run, {
      type: 'text.delta',
      messageId: randomUUID(),
      text: `缓存回答${index}\n${long}`,
    });
  };
  const readBack = async (page: Page) => {
    const earlier = page.getByRole('button', { name: '加载更早记录', exact: true });
    for (let i = 0; i < 5 && (await earlier.isVisible()); i++) {
      await earlier.click();
      await expect(page.getByRole('button', { name: '加载中', exact: true })).not.toBeVisible();
    }
    await expect(page.getByText('缓存问题0', { exact: true })).toBeVisible();
  };

  let application = await launch(true);
  try {
    // The sign-in window, then the connection's window it signs in to, which the frames are watched on.
    application.on('window', watch);
    let page = await application.firstWindow();
    const device = await page.evaluate(() => window.desktop!.device());
    const session = server.store.create(randomUUID(), '缓存会话', folder, device);
    const other = server.store.create(randomUUID(), '别处删除的会话', folder, device);
    for (let i = 0; i < 3; i++) turn(session, i);
    turn(other, 9);
    page = await signIn(page);
    await page.locator('.session-select').filter({ hasText: '别处删除的会话' }).click();
    await expect(page.getByText('缓存问题9', { exact: true })).toBeVisible();
    await page.locator('.session-select').filter({ hasText: '缓存会话' }).click();
    await expect(page.getByText('缓存问题2', { exact: true })).toBeVisible();
    await readBack(page);
    expect(asked('session.history').length).toBeGreaterThan(0);
    await application.close();

    // While the window is closed, the session goes on and another computer deletes the other one.
    turn(session, 3);
    server.store.delete(other.id);
    sent = [];
    application = await launch();
    application.on('window', watch);
    page = await signIn(await application.firstWindow(), true);
    await page.locator('.session-select').filter({ hasText: '缓存会话' }).click();
    await expect(page.getByText('缓存问题3', { exact: true })).toBeVisible();
    const [subscribe] = asked('session.subscribe');
    expect(subscribe?.sessionId).toBe(session.id);
    expect(subscribe?.afterSequence).toBeGreaterThan(0);
    expect(subscribe?.afterCreatedAt).toBeTruthy();
    // Every earlier page is read from disk.
    await readBack(page);
    expect(asked('session.history')).toHaveLength(0);

    // One session read again from the service.
    sent = [];
    await sessionAction(page, '重新同步');
    await expect.poll(() => asked('session.subscribe').at(-1)?.afterSequence).toBe(0);
    await expect(page.getByText('缓存问题3', { exact: true })).toBeVisible();
    await readBack(page);

    await page.getByRole('button', { name: '设置与账号', exact: true }).click();
    await page.getByRole('menuitem', { name: '设置', exact: true }).click();
    await page
      .getByRole('navigation', { name: '设置分类' })
      .getByRole('button', { name: '常规', exact: true })
      .click();
    await expect(page.getByText(/^(约 .+ · )?1 个会话$/)).toBeVisible();
    await page.screenshot({ path: resolve(screenshots, 'history-cache-settings.png') });
    // Clearing reads the shown session from the service again, from its start.
    sent = [];
    await page.getByRole('button', { name: '清理', exact: true }).click();
    await expect.poll(() => asked('session.subscribe').at(-1)?.afterSequence).toBe(0);
  } finally {
    await application.close();
    await server.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
