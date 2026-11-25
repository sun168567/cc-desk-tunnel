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
import { connection, connectionWindow, endStrays, send, settled } from './helpers.ts';

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
// The titles of a process's windows: once signed in, its connection's window alone.
const titles = (application: ElectronApplication) =>
  application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((window) => window.getTitle()),
  );
const heading = (page: Page) => page.getByRole('heading', { name: '连接代理服务', exact: true });
const connected = (page: Page) =>
  expect(page.locator('.connection-status')).toContainText('已连接');
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

// One profile directory, the program started on it as the user starts it.
function program(name: string) {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined && key !== 'ELECTRON_RUN_AS_NODE') env[key] = value;
  const profile = resolve('.local/ui-test', name);
  rmSync(profile, { recursive: true, force: true });
  const args = [
    resolve('apps/desktop'),
    '--smoke-test',
    '--lang=zh-CN',
    `--user-data-dir=${profile}`,
  ];
  const opened: ElectronApplication[] = [];
  return {
    profile,
    env,
    async start(...extra: string[]) {
      const application = await _electron.launch({ args: [...args, ...extra], env });
      opened.push(application);
      return application;
    },
    // Asks a connection's process to go, as an upgrade asks the other ones.
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
    // What the program started by itself is not Playwright's: it is ended with the rest.
    async close() {
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
      endStrays(profile);
    },
  };
}
// Signs in on a sign-in window, as the user does.
async function signIn(page: Page, values: { url?: string; token?: string }) {
  const localMode = page.getByRole('button', { name: '本地模拟', exact: true });
  if (await localMode.isVisible()) await localMode.click();
  if (values.url !== undefined) await page.getByLabel('服务地址').fill(values.url);
  if (values.token !== undefined) await page.getByLabel('服务凭据').fill(values.token);
  await page.getByRole('button', { name: '连接', exact: true }).click();
}

test('Electron: a sign-in window signs in to a service in its own process, one window to a service', async () => {
  test.skip(process.platform !== 'win32', 'Windows desktop smoke test');
  // Starts of the program one after another, each some seconds.
  test.setTimeout(360_000);
  const desk = program('profile-connections');
  const { serverUrl, token } = connection();
  // The same service under another address is another service to the client.
  const elsewhere = serverUrl.replace('127.0.0.1', 'localhost');
  try {
    // The user's start: a sign-in window, on the profile every process of the program shares.
    const first = await desk.start();
    const launcher = await first.firstWindow();
    await expect(heading(launcher)).toBeVisible();
    expect(await first.evaluate(({ app }) => app.getPath('userData'))).toBe(desk.profile);
    await expect(launcher.getByRole('button', { name: '登录过的服务', exact: true })).toHaveCount(
      0,
    );
    await expect(launcher.getByLabel('服务地址')).toHaveValue('');
    // Its defaults are not the computer's preferences.
    expect(existsSync(resolve(desk.profile, 'shared', 'prefs.json'))).toBe(false);

    // A refusal is told on the sign-in window, which stays; the service is not offered as signed in to.
    await signIn(launcher, { url: serverUrl, token: 'x'.repeat(40) });
    await expect(launcher.getByRole('alert')).toContainText('服务凭据不正确');
    await expect(launcher.getByRole('button', { name: '连接', exact: true })).toBeEnabled();
    expect(await titles(first)).toEqual(['CC Desk Tunnel']);
    await expect(launcher.getByRole('button', { name: '登录过的服务', exact: true })).toHaveCount(
      0,
    );

    // Signed in, the service's window is shown and the sign-in window goes: the process is the connection's.
    await signIn(launcher, { token });
    const page = await connectionWindow(first);
    await connected(page);
    await expect.poll(() => titles(first)).toEqual([`CC Desk Tunnel · ${shown(serverUrl)}`]);
    const [id] = desk.ids();
    expect(desk.ids()).toEqual([id]);
    expect(desk.running(id)).toBe(true);
    await expect.poll(() => desk.settingsOf(id).login?.usedAt, { timeout: 30000 }).toBeTruthy();
    expect(desk.settingsOf(id).pending).toBeUndefined();
    expect(desk.settingsOf(id).login.token).toBeUndefined();
    // Its page keeps its storage apart, in its connection's partition.
    await expect
      .poll(() => existsSync(resolve(desk.profile, 'Partitions', id)), { timeout: 30000 })
      .toBe(true);
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
    await connected(await connectionWindow(second));
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
    await exited(second);
    expect(desk.running(id2)).toBe(false);

    // Started for it, the program signs in with the token it keeps.
    const home = await desk.start(`--connection=${id2}`, '--sign-in');
    const second2 = await connectionWindow(home);
    await connected(second2);
    await expect.poll(() => titles(home)).toEqual([`CC Desk Tunnel · ${shown(elsewhere)}`]);
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
      `连接“${shown(serverUrl)}”里也有会话在这个文件夹运行`,
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
    await expect.poll(() => titles(home)).toEqual(['CC Desk Tunnel · 工作']);

    // Started with no window open, the program signs in to the service chosen for it, from its sign-in window.
    await home.close();
    await first.close();
    const used = desk.settingsOf(id2).login.usedAt;
    const third = await desk.start();
    await connected(await connectionWindow(third));
    await expect
      .poll(() => desk.settingsOf(id2).login.usedAt, { timeout: 30000 })
      .toBeGreaterThan(used);

    // A window open, the program starts to a sign-in window, offering the latest service not open.
    const fourth = await desk.start();
    const choose = await fourth.firstWindow();
    await expect(heading(choose)).toBeVisible();
    await expect(choose.getByLabel('服务地址')).toHaveValue(serverUrl);
    await choose.getByRole('button', { name: '登录过的服务', exact: true }).click();
    // A remembered token is not read on the sign-in window: the field only shows there is one.
    await choose
      .getByRole('list', { name: '登录过的服务', exact: true })
      .getByRole('button', { name: /^工作/ })
      .click();
    const kept = choose.getByLabel('服务凭据');
    await expect(kept).toHaveValue('•'.repeat(10));
    // Emptied, the field asks for a token again.
    await kept.press('End');
    await kept.press('Backspace');
    await expect(kept).toHaveValue('');
    await choose.getByRole('button', { name: '登录过的服务', exact: true }).click();
    await choose
      .getByRole('list', { name: '登录过的服务', exact: true })
      .getByRole('button', { name: new RegExp(`^${shown(serverUrl)}`) })
      .click();
    const before = desk.settingsOf(id).login.usedAt;
    await signIn(choose, { token });
    const work = await connectionWindow(fourth);
    await connected(work);
    await expect
      .poll(() => desk.settingsOf(id).login.usedAt, { timeout: 30000 })
      .toBeGreaterThan(before);
    expect(desk.settingsOf(id).login.token).toBeUndefined();

    // Signing out ends the connection's process, which gives way to a sign-in window of a process of its own.
    await work.getByRole('button', { name: '设置与账号', exact: true }).click();
    await work.getByRole('menuitem', { name: '断开连接', exact: true }).click();
    await exited(fourth);
    await expect.poll(() => desk.running(id), { timeout: 30000 }).toBe(false);

    // A record forgotten from a sign-in window goes with its connection's directory and storage.
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
    expect(existsSync(resolve(desk.profile, 'Partitions', id))).toBe(false);
    expect(desk.ids()).toEqual([id2]);

    // A sign-in that failed has opened its service's storage in this process: another service is signed in to
    // by a process of its own, and this one goes.
    desk.dismiss(id2);
    await exited(third);
    await signIn(forget, { url: serverUrl, token: 'x'.repeat(40) });
    await expect(forget.getByRole('alert')).toContainText('服务凭据不正确');
    const again = desk.settingsOf(id2).login.usedAt;
    await signIn(forget, { url: elsewhere, token });
    await exited(fifth);
    await expect
      .poll(() => desk.settingsOf(id2).login.usedAt, { timeout: 30000 })
      .toBeGreaterThan(again);
  } finally {
    await desk.close();
  }
});

// Makes a connection's directory a profile as 0.3.16 kept it, by the program started on that directory alone: its
// remembered token encrypted with that profile's key, and its page's storage holding a value.
async function oldProfile(
  desk: ReturnType<typeof program>,
  id: string,
  login: Record<string, unknown>,
) {
  const folder = resolve(desk.profile, 'connections', id);
  mkdirSync(folder, { recursive: true });
  const page = resolve(desk.profile, '..', 'old-profile.html');
  writeFileSync(page, '<!doctype html><title>old</title>');
  const maker = await _electron.launch({
    args: [resolve('apps/desktop'), '--smoke-test', '--lang=zh-CN', `--user-data-dir=${folder}`],
    env: desk.env,
  });
  let token: string;
  try {
    await maker.firstWindow();
    token = await maker.evaluate(
      ({ safeStorage }, value) => safeStorage.encryptString(value).toString('base64'),
      String(login.token),
    );
    await maker.evaluate(async ({ BrowserWindow }, file) => {
      const window = new BrowserWindow({ show: false });
      await window.loadFile(file);
      await window.webContents.executeJavaScript("localStorage.setItem('kept', '旧的值')");
      window.destroy();
    }, page);
  } finally {
    await maker.close();
  }
  // What the program made there as its own directory is not the old profile's.
  for (const name of ['shared', 'logs', 'Partitions', 'settings.json'])
    rmSync(resolve(folder, name), { recursive: true, force: true });
  writeFileSync(resolve(folder, 'settings.json'), JSON.stringify({ login: { ...login, token } }));
  return token;
}

test('Electron: the profiles of earlier versions move into the shared one, remembered tokens and all', async () => {
  test.skip(process.platform !== 'win32', 'Windows desktop smoke test');
  test.setTimeout(240_000);
  const { serverUrl, token } = connection();
  const login = { url: serverUrl, fingerprint: '', mode: 'local', token, usedAt: 1 };

  // 0.3.16: each connection's directory a profile of its own.
  const desk = program('profile-connections-moved');
  try {
    const old = await oldProfile(desk, 'made0000', login);
    mkdirSync(resolve(desk.profile, 'shared'), { recursive: true });
    writeFileSync(
      resolve(desk.profile, 'shared/connections.json'),
      JSON.stringify([{ id: 'made0000', name: '' }]),
    );
    writeFileSync(
      resolve(desk.profile, 'shared/autoLogin.json'),
      JSON.stringify({ id: 'made0000' }),
    );
    // The new version's first start signs in to it by itself, with the token kept there.
    const first = await desk.start();
    const page = await connectionWindow(first);
    await connected(page);
    expect(await page.evaluate(() => localStorage.getItem('kept'))).toBe('旧的值');
    const own = resolve(desk.profile, 'connections', 'made0000');
    // Kept again with the shared key; what is left of the old profile goes.
    const now = desk.settingsOf('made0000').login.token;
    expect(now).toBeTruthy();
    expect(now).not.toBe(old);
    expect(existsSync(resolve(own, 'Local State'))).toBe(false);
    const ownFiles = ['settings.json', 'drafts.json', 'schedules.json', 'logs', 'pasted'];
    expect(
      readdirSync(own).filter((name) => ![...ownFiles, 'instance.json'].includes(name)),
    ).toEqual([]);
    await first.close();
    // Read with the shared key from now on: the old profile is not made again to read it.
    const next = await desk.start();
    await connected(await connectionWindow(next));
    expect(existsSync(resolve(own, 'Local State'))).toBe(false);
  } finally {
    await desk.close();
  }

  // 0.3.15: the first connection's own files in the program's directory, its token remembered with the key there,
  // and chosen to sign in by itself.
  const earlier = program('profile-connections-0315');
  try {
    await oldProfile(earlier, 'made0000', login);
    const own = resolve(earlier.profile, 'connections', 'made0000');
    const kept = JSON.parse(readFileSync(resolve(own, 'settings.json'), 'utf8'));
    rmSync(resolve(own, 'settings.json'));
    for (const name of readdirSync(own))
      await expect
        .poll(() => {
          try {
            renameSync(resolve(own, name), resolve(earlier.profile, name));
            return true;
          } catch {
            return false;
          }
        })
        .toBe(true);
    rmSync(resolve(earlier.profile, 'connections'), { recursive: true });
    writeFileSync(
      resolve(earlier.profile, 'settings.json'),
      JSON.stringify({ deviceId: 'computer', login: { ...kept.login, autoLogin: true } }),
    );
    mkdirSync(resolve(earlier.profile, 'shared'), { recursive: true });
    writeFileSync(
      resolve(earlier.profile, 'shared/connections.json'),
      JSON.stringify([{ id: '', name: '主连接' }]),
    );
    // The new version's first start moves it to a directory of its own, and signs in to it.
    const first = await earlier.start();
    const page = await connectionWindow(first);
    await connected(page);
    const [id] = earlier.ids();
    expect(id).toMatch(/^[a-z0-9]{8}$/);
    expect(await page.evaluate(() => localStorage.getItem('kept'))).toBe('旧的值');
    await expect
      .poll(() => earlier.settingsOf(id).login.usedAt, { timeout: 30000 })
      .toBeGreaterThan(1);
    expect(existsSync(resolve(earlier.profile, 'connections', id, 'Local State'))).toBe(false);
    expect(JSON.parse(readFileSync(resolve(earlier.profile, 'settings.json'), 'utf8'))).toEqual({
      deviceId: 'computer',
    });
  } finally {
    await earlier.close();
  }
});
