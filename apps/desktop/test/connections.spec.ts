import { test, expect, _electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { connection, send, settled } from './helpers.ts';

const section = (page: Page, name: string) =>
  page
    .getByRole('navigation', { name: '设置分类' })
    .getByRole('button', { name, exact: true })
    .click();
async function settings(page: Page, name: string) {
  await page.getByRole('button', { name: '设置与账号', exact: true }).click();
  await page.getByRole('menuitem', { name: '设置', exact: true }).click();
  await section(page, name);
}
const title = (application: ElectronApplication) =>
  application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle());
const heading = (page: Page) => page.getByRole('heading', { name: '连接代理服务', exact: true });
const connected = (page: Page) =>
  expect(page.locator('.connection-status')).toContainText('已连接');
// A sign-in window goes by itself once the window it started runs. That window inherits Playwright's pipe to
// it, which stays open, so the application's own close event does not come until that one goes too.
const exited = (application: ElectronApplication) =>
  new Promise<void>((done) => {
    const child = application.process();
    if (child.exitCode !== null) done();
    else child.once('exit', () => done());
  });
const shown = (url: string) => url.replace(/^\w+:\/\//, '');
// A file the program may be replacing at this moment, which Windows answers by refusing to read it.
function json(file: string) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

// One profile directory, the program started on it as the user and as its own windows start it.
function program(name: string) {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined && key !== 'ELECTRON_RUN_AS_NODE') env[key] = value;
  const profile = resolve('.local/ui-test', name);
  rmSync(profile, { recursive: true, force: true });
  const args = [resolve('apps/desktop'), '--smoke-test', `--user-data-dir=${profile}`];
  const opened: ElectronApplication[] = [];
  return {
    profile,
    async start(...extra: string[]) {
      const application = await _electron.launch({ args: [...args, ...extra], env });
      opened.push(application);
      return application;
    },
    // What the program starts by itself is not Playwright's to close: it is asked to go as an upgrade asks the
    // other windows.
    dismiss(id: string) {
      execFileSync(
        createRequire(import.meta.url)('electron') as unknown as string,
        [...args, `--connection=${id}`, '--quit-connection'],
        { env },
      );
    },
    settingsOf: (id: string) => json(resolve(profile, 'connections', id, 'settings.json')) ?? {},
    ids: () =>
      ((json(resolve(profile, 'shared/connections.json')) ?? []) as { id: string }[]).map(
        (entry) => entry.id,
      ),
    running: (id: string) => existsSync(resolve(profile, 'connections', id, 'instance.json')),
    // The windows the program started go first, as each holds Playwright's pipe to the one that started it.
    async close() {
      for (const id of existsSync(resolve(profile, 'connections'))
        ? readdirSync(resolve(profile, 'connections'))
        : [])
        if (existsSync(resolve(profile, 'connections', id, 'instance.json'))) this.dismiss(id);
      // One closed already has no process to ask about; closing it again does nothing.
      for (const application of opened.reverse()) {
        let running = false;
        try {
          running = application.process().exitCode === null;
        } catch {}
        if (running)
          await Promise.race([
            application.close().catch(() => {}),
            new Promise((done) => setTimeout(done, 15_000)),
          ]);
      }
    },
  };
}
// Signs in on a sign-in window or a connection's, as the user does.
async function signIn(page: Page, values: { url?: string; token?: string }) {
  const localMode = page.getByRole('button', { name: '本地模拟', exact: true });
  if (await localMode.isVisible()) await localMode.click();
  if (values.url !== undefined) await page.getByLabel('服务地址').fill(values.url);
  if (values.token !== undefined) await page.getByLabel('服务凭据').fill(values.token);
  await page.getByRole('button', { name: '连接', exact: true }).click();
}

test('Electron: a sign-in window starts each service’s window, one window to a service', async () => {
  test.skip(process.platform !== 'win32', 'Windows desktop smoke test');
  // Starts of the program one after another, each some seconds.
  test.setTimeout(300_000);
  const desk = program('profile-connections');
  const { serverUrl, token } = connection();
  // The same service under another address is another service to the client.
  const elsewhere = serverUrl.replace('127.0.0.1', 'localhost');
  try {
    // The user's start: a sign-in window, with a profile of its own that keeps nothing.
    const first = await desk.start();
    const launcher = await first.firstWindow();
    await expect(heading(launcher)).toBeVisible();
    expect(await first.evaluate(({ app }) => app.getPath('userData'))).toContain(
      resolve(desk.profile, 'launchers'),
    );
    await expect(launcher.getByRole('button', { name: '登录过的服务', exact: true })).toHaveCount(
      0,
    );
    await expect(launcher.getByLabel('服务地址')).toHaveValue('');
    // Its defaults are not the computer's preferences: the first connection's own are.
    expect(existsSync(resolve(desk.profile, 'shared', 'prefs.json'))).toBe(false);
    // Signing in starts the service's window, made for it, and the sign-in window goes once that runs.
    await signIn(launcher, { url: serverUrl, token });
    await exited(first);
    const [id] = desk.ids();
    expect(desk.running(id)).toBe(true);
    await expect.poll(() => desk.settingsOf(id).login?.usedAt, { timeout: 30000 }).toBeTruthy();
    expect(desk.settingsOf(id).pending).toBeUndefined();
    expect(desk.settingsOf(id).login.token).toBeUndefined();
    desk.dismiss(id);
    await expect.poll(() => desk.running(id), { timeout: 30000 }).toBe(false);

    // The connection's own window keeps to its service.
    const work = await desk.start(`--connection=${id}`);
    const page = await work.firstWindow();
    await expect(heading(page)).toBeVisible();
    await expect(page.getByLabel('服务地址')).toHaveValue(serverUrl);
    await expect(page.getByLabel('服务地址')).toHaveAttribute('readonly', '');
    await expect(page.getByRole('button', { name: '换个服务登录', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '登录过的服务', exact: true })).toHaveCount(0);
    await signIn(page, { token });
    await connected(page);
    await expect.poll(() => title(work)).toBe(`CC Desk Tunnel · ${shown(serverUrl)}`);
    await expect(page.locator('.connection-name')).toHaveCount(0);

    // Another sign-in window offers the service, which is that window's: it is shown, and this one stays.
    const second = await desk.start();
    const other = await second.firstWindow();
    await expect(heading(other)).toBeVisible();
    await other.getByRole('button', { name: '登录过的服务', exact: true }).click();
    const records = other.getByRole('list', { name: '登录过的服务', exact: true });
    // A service without a name is listed by its address alone.
    await expect(
      records.getByRole('button', { name: shown(serverUrl), exact: true }),
    ).toBeVisible();
    await records.getByRole('button', { name: new RegExp(`^${shown(serverUrl)}`) }).click();
    await expect(other.getByLabel('服务地址')).toHaveValue(serverUrl);
    await signIn(other, { token });
    await expect(other.getByRole('alert')).toContainText('已在另一个窗口登录');
    await expect(heading(other)).toBeVisible();

    // Another service, remembered and chosen to sign in by itself.
    await other.getByLabel('自动登录').check();
    await expect(other.getByLabel('记住凭据')).toBeChecked();
    await signIn(other, { url: elsewhere });
    await exited(second);
    const id2 = desk.ids().find((item) => item !== id)!;
    await expect.poll(() => desk.settingsOf(id2).login?.url, { timeout: 30000 }).toBe(elsewhere);
    // Kept once its window has signed in, the token with it.
    await expect.poll(() => desk.settingsOf(id2).login?.usedAt, { timeout: 30000 }).toBeTruthy();
    expect(desk.settingsOf(id2).login.token).toBeTruthy();
    expect(desk.settingsOf(id2).pending).toBeUndefined();
    await expect
      .poll(() => json(resolve(desk.profile, 'shared/autoLogin.json')))
      .toEqual({ id: id2 });
    desk.dismiss(id2);
    await expect.poll(() => desk.running(id2), { timeout: 30000 }).toBe(false);

    // Its window, started to sign in, does so with the token it keeps.
    const home = await desk.start(`--connection=${id2}`, '--sign-in');
    const second2 = await home.firstWindow();
    await connected(second2);
    await expect.poll(() => title(home)).toBe(`CC Desk Tunnel · ${shown(elsewhere)}`);
    const device = (target: Page) => target.evaluate(() => window.desktop!.device());
    expect(await device(second2)).toEqual(await device(page));
    // Two services: each window names its own.
    await expect(second2.locator('.connection-name')).toHaveText(shown(elsewhere));
    await expect(page.locator('.connection-name')).toHaveText(shown(serverUrl));

    // What runs here is told with its folder. Another connection's session in that folder, or above it, is
    // warned of over the conversation.
    const instance = resolve(desk.profile, 'connections', id2, 'instance.json');
    const runs = () =>
      (JSON.parse(readFileSync(instance, 'utf8')).runs as { folder: string }[]).map(
        (run) => run.folder,
      );
    // This repository stands in for the user's project.
    const repository = resolve('.');
    await home.evaluate(({ dialog }, chosen) => {
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [chosen],
      })) as unknown as typeof dialog.showOpenDialog;
    }, repository);
    await second2.getByRole('button', { name: '添加项目', exact: true }).click();
    await second2.getByRole('button', { name: `新建会话 · ${repository}`, exact: true }).click();
    await send(second2, '检查目录', 'tool');
    await expect.poll(runs).toEqual([repository]);
    await second2.getByRole('button', { name: '停止运行', exact: true }).click();
    await settled(second2);
    await expect.poll(runs).toEqual([]);
    await expect(second2.locator('.elsewhere-bar')).toHaveCount(0);
    await page.evaluate(
      (folder) => window.desktop!.setBusy([{ id: 'another', folder }]),
      resolve('..'),
    );
    await expect(second2.locator('.elsewhere-bar')).toContainText(
      `连接“${shown(serverUrl)}”里有会话正在这个文件夹里运行`,
    );
    await page.evaluate(() => window.desktop!.setBusy([]));
    await expect(second2.locator('.elsewhere-bar')).toHaveCount(0);

    // A choice made in one window is the other's within seconds; how the window closes is the computer's.
    await settings(second2, '外观');
    const stats = (target: Page) =>
      target.getByRole('switch', { name: '显示回复小结', exact: true });
    await expect(stats(second2)).not.toBeChecked();
    await settings(page, '外观');
    await stats(page).click();
    await expect(stats(second2)).toBeChecked();
    await section(second2, '常规');
    await second2.getByRole('switch', { name: '关闭窗口时留在后台', exact: true }).click();
    await expect
      .poll(
        () => JSON.parse(readFileSync(resolve(desk.profile, 'settings.json'), 'utf8')).closeToTray,
      )
      .toBe(false);

    // The settings list the services; a name given there replaces the address.
    await section(page, '连接');
    const row = page
      .locator('.setting-row')
      .filter({ has: page.getByText(shown(elsewhere), { exact: true }) });
    await expect(row).toBeVisible();
    // An open connection is not removed from under its window.
    page.once('dialog', (dialog) => void dialog.accept());
    await page.getByRole('button', { name: `删除 ${shown(elsewhere)}`, exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('还开着');
    await page.getByRole('button', { name: `备注名 ${shown(elsewhere)}`, exact: true }).click();
    await page.getByRole('textbox', { name: '备注名', exact: true }).fill('工作');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await expect.poll(() => title(home)).toBe('CC Desk Tunnel · 工作');

    // Started with no window open, the program signs in to the service chosen for it, without a window of its own.
    await home.close();
    await work.close();
    const used = desk.settingsOf(id2).login.usedAt;
    const third = await desk.start();
    await exited(third);
    await expect
      .poll(() => desk.settingsOf(id2).login.usedAt, { timeout: 30000 })
      .toBeGreaterThan(used);

    // A window open, the program starts to a sign-in window, offering the latest service not open.
    const fourth = await desk.start();
    const choose = await fourth.firstWindow();
    await expect(heading(choose)).toBeVisible();
    await expect(choose.getByLabel('服务地址')).toHaveValue(serverUrl);
    await choose.getByRole('button', { name: '登录过的服务', exact: true }).click();
    // A remembered token stays with its connection, whose window signs in with it.
    await choose
      .getByRole('list', { name: '登录过的服务', exact: true })
      .getByRole('button', { name: /^工作/ })
      .click();
    const kept = choose.getByLabel('服务凭据');
    await expect(kept).toHaveValue('\u2022'.repeat(10));
    // Emptied, the field asks for a token again.
    await kept.press('End');
    await kept.press('Backspace');
    await expect(kept).toHaveValue('');
    // A token typed for a service not remembered goes to the window started for it.
    await choose.getByRole('button', { name: '登录过的服务', exact: true }).click();
    await choose
      .getByRole('list', { name: '登录过的服务', exact: true })
      .getByRole('button', { name: new RegExp(`^${shown(serverUrl)}`) })
      .click();
    const before = desk.settingsOf(id).login.usedAt;
    await signIn(choose, { token });
    await exited(fourth);
    await expect
      .poll(() => desk.settingsOf(id).login.usedAt, { timeout: 30000 })
      .toBeGreaterThan(before);
    expect(desk.settingsOf(id).login.token).toBeUndefined();
    desk.dismiss(id);
    await expect.poll(() => desk.running(id), { timeout: 30000 }).toBe(false);

    // A record forgotten from a sign-in window goes with its connection's directory.
    const fifth = await desk.start();
    const forget = await fifth.firstWindow();
    await forget.getByRole('button', { name: '登录过的服务', exact: true }).click();
    forget.once('dialog', (dialog) => void dialog.accept());
    await forget
      .getByRole('button', { name: `删除 ${shown(serverUrl)} 的登录记录`, exact: true })
      .click();
    await expect(forget.getByRole('list', { name: '登录过的服务', exact: true })).not.toContainText(
      shown(serverUrl),
    );
    expect(existsSync(resolve(desk.profile, 'connections', id))).toBe(false);
    expect(desk.ids()).toEqual([id2]);
  } finally {
    await desk.close();
  }
});

test('Electron: an earlier version’s first connection moves to a directory of its own and still signs in', async () => {
  test.skip(process.platform !== 'win32', 'Windows desktop smoke test');
  test.setTimeout(180_000);
  const desk = program('profile-connections-moved');
  const { serverUrl, token } = connection();
  try {
    // An earlier version's profile: the first connection's own files in the program's directory, its token
    // remembered with the key there, and chosen to sign in by itself. Made here by a window of this version,
    // moved into place as that version kept it.
    mkdirSync(resolve(desk.profile, 'connections', 'made0000'), { recursive: true });
    mkdirSync(resolve(desk.profile, 'shared'), { recursive: true });
    writeFileSync(
      resolve(desk.profile, 'shared/connections.json'),
      JSON.stringify([{ id: 'made0000', name: '' }]),
    );
    const made = await desk.start('--connection=made0000');
    const page = await made.firstWindow();
    await page.getByLabel('记住凭据').check();
    await signIn(page, { url: serverUrl, token });
    await connected(page);
    await expect.poll(() => desk.settingsOf('made0000').login?.token).toBeTruthy();
    await made.close();
    const own = resolve(desk.profile, 'connections', 'made0000');
    const login = { ...desk.settingsOf('made0000').login, autoLogin: true };
    rmSync(resolve(own, 'settings.json'));
    rmSync(resolve(own, 'instance.json'), { force: true });
    for (const name of readdirSync(own))
      await expect
        .poll(() => {
          try {
            renameSync(resolve(own, name), resolve(desk.profile, name));
            return true;
          } catch {
            return false;
          }
        })
        .toBe(true);
    rmSync(own, { recursive: true });
    rmSync(resolve(desk.profile, 'shared/autoLogin.json'), { force: true });
    const computer = JSON.parse(readFileSync(resolve(desk.profile, 'settings.json'), 'utf8'));
    writeFileSync(resolve(desk.profile, 'settings.json'), JSON.stringify({ ...computer, login }));
    writeFileSync(
      resolve(desk.profile, 'shared/connections.json'),
      JSON.stringify([{ id: '', name: '主连接' }]),
    );

    // The new version's first start moves it, and signs in to it with the token kept there.
    const first = await desk.start();
    await exited(first);
    const [id] = desk.ids();
    expect(id).toMatch(/^[a-z0-9]{8}$/);
    await expect
      .poll(() => desk.settingsOf(id).login.usedAt, { timeout: 30000 })
      .toBeGreaterThan(login.usedAt);
    expect(existsSync(resolve(desk.profile, 'Local State'))).toBe(false);
    expect(existsSync(resolve(desk.profile, 'connections', id, 'Local State'))).toBe(true);
    expect(JSON.parse(readFileSync(resolve(desk.profile, 'settings.json'), 'utf8'))).toEqual(
      computer,
    );
  } finally {
    await desk.close();
  }
});
