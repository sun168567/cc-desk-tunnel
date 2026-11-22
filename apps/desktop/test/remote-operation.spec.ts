import { expect, test } from '@playwright/test';
import { resolve } from 'node:path';
import { createSession, login, screenshots, send, settled } from './helpers.ts';

test('a second press on an approval before it is over answers nothing and reports nothing', async ({
  page,
}) => {
  // The reply to the press comes back before the approval is seen to be over, as it can when the session's
  // events take long to arrive: they are held back here, in their order, and replies are not.
  let held = false;
  await page.routeWebSocket(/\/ws$/, (socket) => {
    const service = socket.connectToServer();
    service.onMessage((message) => {
      if (held && typeof message === 'string' && message.includes('"session.'))
        setTimeout(() => socket.send(message), 1500);
      else socket.send(message);
    });
  });
  await page.goto('/');
  await login(page);
  await createSession(page, '连点审批');
  await send(page, '连点', 'tool');
  const allow = page.getByRole('button', { name: '允许', exact: true });
  await expect(allow).toBeVisible();
  held = true;
  await allow.click();
  // A second press as soon as the button takes one again: it must not until the approval is over.
  await allow.click({ timeout: 2000 }).catch(() => {});
  await settled(page);
  await expect(page.locator('.error-banner')).toHaveCount(0);
});

test('another computer works on a session while its own is connected; both see the run and either answers', async ({
  page,
  browser,
  baseURL,
}) => {
  await page.goto('/');
  await login(page);
  const title = await createSession(page, '远程操作');
  // Another browser profile is another computer to the service.
  const context = await browser.newContext({ baseURL });
  const other = await context.newPage();
  await other.goto('/');
  await login(other);
  await other.getByRole('button', { name: '展开其他设备的会话', exact: true }).click();
  // Computers of earlier tests are gone; the first one of this test is connected.
  await expect(other.locator('.device-state.online')).toHaveCount(1);
  await other.locator('.session-row').filter({ hasText: title }).click();
  const bar = other.locator('.elsewhere-bar');
  await expect(bar).toContainText('在这里发的消息');
  await send(other, '从另一台电脑发的话', 'tool');
  // The run is the first computer's: it shows there as well, and either window answers its approval.
  await expect(page.getByText('从另一台电脑发的话', { exact: true })).toBeVisible();
  const allow = (window: typeof page) => window.getByRole('button', { name: '允许', exact: true });
  await expect(allow(other)).toBeVisible();
  await expect(allow(page)).toBeVisible();
  await other.screenshot({ path: resolve(screenshots, 'desktop-remote.png') });
  await allow(page).click();
  await expect(allow(other)).not.toBeVisible();
  await settled(other);
  await settled(page);
  // With its computer gone, the session can only be read again.
  await page.close();
  await expect(other.locator('.device-state.online')).toHaveCount(0);
  await expect(other.locator('.composer')).toHaveCount(0);
  await expect(bar).toContainText('不在线');
  await context.close();
});

test('a session is started in, or moved to, a project of another connected computer', async ({
  page,
  browser,
  baseURL,
}) => {
  await page.goto('/');
  await login(page);
  const title = await createSession(page, '移到另一台');
  // Sessions of earlier runs stay with their computers, which are gone; this project is new.
  const name = `远程项目${Date.now()}`;
  const path = `E:\\另一台\\${name}`;
  // Another browser profile is another computer, with a project of its own.
  const context = await browser.newContext({ baseURL });
  const other = await context.newPage();
  await other.goto('/');
  await login(other);
  await other.getByRole('button', { name: '添加项目', exact: true }).click();
  await other.getByLabel('本机项目目录').fill(path);
  await other.getByRole('button', { name: '添加', exact: true }).click();
  // It is listed here with that project once it says it has it, sessions or not.
  await page.getByRole('button', { name: '展开其他设备的会话', exact: true }).click();
  const project = page.locator('.elsewhere-project').filter({ hasText: name });
  await project.hover();
  await project.getByRole('button', { name: /^新建会话 · / }).click();
  // The new session is the other computer's, worked on from here.
  await expect(page.locator('.elsewhere-bar')).toBeVisible();
  const there = other.locator('.project-group').filter({ hasText: name }).locator('.session-row');
  await expect(there).toHaveCount(1);
  await page.screenshot({ path: resolve(screenshots, 'remote-new-session.png') });
  // A session of this computer moves into that project.
  const row = page.locator('.session-row').filter({ hasText: title });
  await row.hover();
  await row.getByRole('button', { name: '会话操作', exact: true }).click();
  await page.getByRole('menuitem', { name: '移到项目…', exact: true }).click();
  await page.screenshot({ path: resolve(screenshots, 'remote-move-menu.png') });
  await page.getByRole('menuitemradio', { name, exact: true }).click();
  await expect(there.filter({ hasText: title })).toBeVisible();
  await expect(there).toHaveCount(2);
  await context.close();
});
