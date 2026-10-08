import { test, expect, _electron } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  connection,
  createSession,
  expandActivity,
  login,
  screenshots,
  search,
  send,
  sessionAction,
  settled,
} from './helpers.ts';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

async function noOverflowX(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  expect(
    await page
      .locator('.conversation')
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
}

test('desktop login, chat, allow/deny, stop, errors and delete', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page.getByLabel('服务地址').fill(connection().serverUrl);
  await page.getByLabel('服务凭据').fill('incorrect-test-token-with-enough-length');
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('服务凭据不正确');
  await login(page);
  const title = await createSession(page, '开发会话');
  await send(page, '梳理当前项目');
  await settled(page);
  await expect(page.locator('.message.assistant strong')).toContainText('离线模拟回复');
  await send(page, '检查目录', 'tool');
  await expect(page.getByRole('button', { name: '允许', exact: true })).toBeVisible();
  await page.screenshot({ path: resolve(screenshots, 'desktop-approval.png') });
  await page.getByRole('button', { name: '允许', exact: true }).click();
  await settled(page);
  await expandActivity(page);
  await expect(page.locator('.tool-output').first()).toContainText('未执行真实命令');
  await send(page, '拒绝测试', 'tool');
  await expect(page.getByRole('button', { name: '拒绝', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '拒绝', exact: true }).click();
  await settled(page);
  // The refused tool's row may arrive after the run has settled; expand again until it shows.
  await expect(async () => {
    await expandActivity(page);
    await expect(page.locator('.tool-output').last()).toContainText('用户拒绝', { timeout: 1000 });
  }).toPass();
  await send(page, '停止测试');
  await page.getByRole('button', { name: '停止运行', exact: true }).click();
  await expect(page.getByText('用户停止', { exact: true })).toBeVisible();
  await settled(page);
  await send(page, '错误测试', 'error');
  await expect(
    page.getByText('模拟上游连接失败；没有执行本机命令。', { exact: true }),
  ).toBeVisible();
  await settled(page);
  await noOverflow(page);
  await page.screenshot({ path: resolve(screenshots, 'desktop.png') });
  const row = page.locator('.session-row').filter({ hasText: title });
  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '删除', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '删除', exact: true }).click();
  await expect(row).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('narrow screen, safe Markdown, switching and cancellation while awaiting approval', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await login(page);
  await page.getByRole('button', { name: '展开会话列表' }).click();
  const title = await createSession(page, '窄屏会话');
  await send(page, '```html\n<script>window.untrusted = true</script>\n```');
  await settled(page);
  expect(await page.evaluate(() => 'untrusted' in window)).toBe(false);
  await expandActivity(page);
  await expect(page.locator('.message.assistant pre')).toBeVisible();
  await send(page, '取消审批', 'tool');
  await expect(page.getByRole('button', { name: '允许', exact: true })).toBeVisible();
  await noOverflow(page);
  await page.screenshot({ path: resolve(screenshots, 'mobile-approval.png') });
  await page.getByRole('button', { name: '停止运行', exact: true }).click();
  await settled(page);
  await expect(page.getByRole('button', { name: '允许', exact: true })).not.toBeVisible();
  await page.getByRole('button', { name: '展开会话列表' }).click();
  await page.getByRole('button', { name: title, exact: false }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
  await page.screenshot({ path: resolve(screenshots, 'mobile.png') });
  expect(errors).toEqual([]);
});

test('reconnect replays history without repeating a request or keeping stale approval', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const Original = window.WebSocket;
    const sockets: WebSocket[] = [];
    Object.assign(window, { testSockets: sockets });
    window.WebSocket = class extends Original {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        sockets.push(this);
      }
    };
  });
  await page.goto('/');
  await login(page);
  await createSession(page, '恢复会话');
  await send(page, '断线时不能重放', 'tool');
  await expect(page.getByRole('button', { name: '允许', exact: true })).toBeVisible();
  await page.evaluate(() =>
    (window as unknown as { testSockets: WebSocket[] }).testSockets.at(-1)!.close(),
  );
  await expect(page.getByText('连接中断，等待恢复', { exact: true })).toBeVisible();
  await expect(page.getByText('已连接', { exact: true })).toBeVisible();
  await expect(page.getByText('连接断开，运行未重放。', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '允许', exact: true })).not.toBeVisible();
  await expect(page.locator('.message.user')).toHaveCount(1);
  await settled(page);
});

test('Electron loads the built UI with sandbox and closes its execution connection', async () => {
  test.skip(process.platform !== 'win32', 'Windows desktop smoke test');
  // An unseen window settles each action slowly.
  test.slow();
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env))
    if (value !== undefined && name !== 'ELECTRON_RUN_AS_NODE') env[name] = value;
  const application = await _electron.launch({
    args: [resolve('apps/desktop'), '--smoke-test'],
    env,
  });
  let sessionTitle = '';
  try {
    const page = await application.firstWindow();
    await expect(page.getByRole('heading', { name: '连接代理服务', exact: true })).toBeVisible();
    const security = await application.evaluate(({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents as unknown as {
        getLastWebPreferences: () => {
          nodeIntegration: boolean;
          contextIsolation: boolean;
          sandbox: boolean;
        };
      };
      const preferences = contents.getLastWebPreferences();
      return {
        nodeIntegration: preferences.nodeIntegration,
        contextIsolation: preferences.contextIsolation,
        sandbox: preferences.sandbox,
      };
    });
    expect(security).toEqual({ nodeIntegration: false, contextIsolation: true, sandbox: true });
    const documents = resolve('.local/ui-test/documents');
    rmSync(documents, { recursive: true, force: true });
    mkdirSync(documents, { recursive: true });
    await application.evaluate(
      ({ app }, directory) => app.setPath('documents', directory),
      documents,
    );
    await login(page);
    await page.locator('.new-session').click();
    const plain = page.locator('.session-list > .session-row.selected');
    await expect(plain.locator('strong')).toHaveText('新会话');
    const [day] = readdirSync(resolve(documents, 'CC Desk Tunnel'));
    expect(day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(readdirSync(resolve(documents, 'CC Desk Tunnel', day))).toHaveLength(1);
    await plain.click({ button: 'right' });
    await page.getByRole('menuitem', { name: '删除', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '删除', exact: true }).click();
    await expect(plain).toHaveCount(0);
    await expect.poll(() => existsSync(resolve(documents, 'CC Desk Tunnel', day))).toBe(false);
    await application.evaluate(({ dialog }) => {
      dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
    });
    await page.getByRole('button', { name: '添加项目', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await application.evaluate(({ dialog }) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: ['D:\\工作\\中文项目'] });
    });
    await page.getByRole('button', { name: '添加项目', exact: true }).click();
    await page.getByRole('button', { name: '新建会话 · D:\\工作\\中文项目', exact: true }).click();
    sessionTitle = `Electron 会话 ${Date.now()}`;
    await sessionAction(page, '重命名');
    await page.getByRole('dialog').getByLabel('名称', { exact: true }).fill(sessionTitle);
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await send(page, '桌面审批测试', 'tool');
    await expect(page.getByRole('button', { name: '允许', exact: true })).toBeVisible();
    expect(
      await page.evaluate(() => typeof (window as unknown as { require?: unknown }).require),
    ).toBe('undefined');
    await page.screenshot({ path: resolve(screenshots, 'electron.png') });
  } finally {
    await application.close();
  }
  const directory = resolve('.local/ui-test/sessions');
  await expect
    .poll(() => {
      const database = new DatabaseSync(resolve(directory, 'sessions.sqlite'), { readOnly: true });
      try {
        const row = database
          .prepare("SELECT metadata FROM sessions WHERE json_extract(metadata, '$.title') = ?")
          .get(sessionTitle);
        return row ? JSON.parse(String(row.metadata)).activeRun : undefined;
      } finally {
        database.close();
      }
    })
    .toBeNull();
});

test('login loads the directory only; project search and session rename do not fetch unrelated history', async ({
  page,
}) => {
  const requests: string[] = [];
  page.on('websocket', (socket) =>
    socket.on('framesent', ({ payload }) => {
      const message = JSON.parse(String(payload));
      if (message.type === 'session.subscribe') requests.push(message.sessionId);
    }),
  );
  await page.goto('/');
  await login(page);
  await expect(page.getByRole('textbox', { name: '消息' })).toHaveCount(0);
  expect(requests).toEqual([]);
  const title = await createSession(page, '会话索引');
  await search(page, title);
  await expect(page.locator('.session-row')).toHaveCount(1);
  await expect(page.locator('.project-group > h2')).toContainText('中文项目');
  await sessionAction(page, '重命名');
  const renamed = `${title} 已改名`;
  await page.getByRole('dialog').getByLabel('名称', { exact: true }).fill(renamed);
  await page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.locator('.session-row.selected strong')).toHaveText(renamed);
  await search(page, 'no-matching-session');
  await expect(page.locator('.session-row')).toHaveCount(0);
  await page.reload();
  await login(page);
  await expect(page.getByRole('textbox', { name: '消息' })).toHaveCount(0);
  await search(page, renamed);
  await page.locator('.session-select').click();
  await expect(page.locator('.session-row.selected strong')).toHaveText(renamed);
});

test('message box grows with the draft and scrolls past its limit', async ({ page }) => {
  await page.goto('/');
  await login(page);
  await createSession(page, '输入框');
  const box = page.getByRole('textbox', { name: '消息' });
  const height = () => box.evaluate((element) => element.getBoundingClientRect().height);
  const empty = await height();
  await box.fill(Array(8).fill('行').join('\n'));
  expect(await height()).toBeGreaterThan(empty + 60);
  await box.fill(Array(80).fill('行').join('\n'));
  expect(await height()).toBeLessThanOrEqual(420);
  expect(await box.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await box.fill('');
  expect(await height()).toBe(empty);
});

test('a session forks whole, and an earlier message is edited in a fork that leaves the original alone', async ({
  page,
}) => {
  await page.goto('/');
  await login(page);
  const title = await createSession(page, '分叉');
  for (const text of ['第一问', '第二问']) {
    await send(page, text);
    await settled(page);
  }
  const questions = page.locator('.message.user .message-content');
  const box = page.getByRole('textbox', { name: '消息' });
  await questions.nth(1).hover();
  await page.getByRole('button', { name: '编辑重发', exact: true }).nth(1).click();
  await expect(page.locator('.session-row.selected strong')).toHaveText(`${title}（分叉）`);
  await expect(questions).toHaveText(['第一问']);
  await expect(box).toHaveValue('第二问');
  await box.fill('改过的第二问');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await settled(page);
  await expect(questions).toHaveText(['第一问', '改过的第二问']);
  await sessionAction(page, '分叉会话');
  await expect(page.locator('.session-row.selected strong')).toHaveText(`${title}（分叉）（分叉）`);
  await expect(questions).toHaveText(['第一问', '改过的第二问']);
  await expect(box).toHaveValue('');
  await page
    .locator('.session-select')
    .filter({ has: page.getByText(title, { exact: true }) })
    .click();
  await expect(questions).toHaveText(['第一问', '第二问']);
});

test('a scheduled task is edited, sent to its session when due, and can open a session of its own', async ({
  page,
}) => {
  await page.clock.install();
  await page.goto('/');
  await login(page);
  const title = await createSession(page, '定时');
  const name = `巡检 ${Date.now()}`;
  const openTasks = async () => {
    await page.getByRole('button', { name: '定时任务', exact: true }).click();
  };
  await openTasks();
  await page.getByRole('button', { name: '新建任务', exact: true }).first().click();
  await page.getByRole('button', { name: '保存任务', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('name');
  await page.getByLabel('任务名称').fill(name);
  await page.getByLabel('提示词').fill('检查项目状态');
  await page.getByLabel('重复规则').selectOption('once');
  await page.getByLabel('目标会话').selectOption({ label: `${title} · 中文项目` });
  await page.getByLabel('重复规则').selectOption('weekly');
  await page.screenshot({ path: resolve(screenshots, 'schedule-editor.png') });
  await page.getByLabel('重复规则').selectOption('once');
  await page.getByRole('button', { name: '保存任务', exact: true }).click();
  const row = page.locator('.schedule-row');
  await expect(row).toContainText(name);
  await expect(row).toContainText('下次');
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem('proxy-schedules')!).说明.length),
  ).toBeGreaterThan(0);
  // Nothing is sent early; an hour later the task is due.
  await page.clock.fastForward('30:00');
  await expect(row).not.toContainText('已发送');
  await page.clock.fastForward('31:00');
  await expect(row).toContainText('已发送');
  await expect(row).toContainText('不会再运行');
  await page.screenshot({ path: resolve(screenshots, 'schedule-list.png') });
  await page.getByRole('button', { name: '会话', exact: true }).click();
  await settled(page);
  await expect(page.locator('.message.user .message-content')).toHaveText(
    new RegExp(`^\\[定时任务「${name}」· 计划时间 .+\\]\\s+检查项目状态$`),
  );
  await openTasks();
  await page.getByRole('button', { name: `编辑 ${name}`, exact: true }).click();
  await page.getByLabel('发送到').selectOption('new');
  await page.getByLabel('项目目录').fill('D:\\工作\\中文项目');
  await page.getByRole('button', { name: '保存任务', exact: true }).click();
  await expect(row).toContainText('新会话 · 中文项目');
  await page.getByRole('button', { name: `立即运行 ${name}`, exact: true }).click();
  await expect(row).toContainText('已发送');
  // The session being read keeps its place.
  await page.getByRole('button', { name: '会话', exact: true }).click();
  await expect(
    page.locator('.session-select').filter({ has: page.getByText(name, { exact: true }) }),
  ).toHaveCount(1);
  await expect(page.locator('.session-row.selected strong')).toHaveText(title);
  await openTasks();
  await page.getByRole('button', { name: `删除 ${name}`, exact: true }).click();
  await page.getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(row).toHaveCount(0);
});

test('unsent text stays with its session across switching and a restart', async ({ page }) => {
  await page.goto('/');
  await login(page);
  const box = page.getByRole('textbox', { name: '消息' });
  const first = await createSession(page, '草稿甲');
  await box.fill('甲的草稿\n第二行');
  const second = await createSession(page, '草稿乙');
  await expect(box).toHaveValue('');
  await box.fill('乙的草稿');
  await page.getByRole('button', { name: first, exact: false }).first().click();
  await expect(box).toHaveValue('甲的草稿\n第二行');
  // The page goes away without any orderly shutdown.
  await page.waitForTimeout(500);
  await page.goto('about:blank');
  await page.goto('/');
  await login(page);
  await page.getByRole('button', { name: second, exact: false }).first().click();
  await expect(box).toHaveValue('乙的草稿');
  await page.getByRole('button', { name: first, exact: false }).first().click();
  await expect(box).toHaveValue('甲的草稿\n第二行');
  // Sending takes the text out of the saved drafts.
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await settled(page);
  await expect(box).toHaveValue('');
  await page.waitForTimeout(500);
  await page.reload();
  await login(page);
  await page.getByRole('button', { name: first, exact: false }).first().click();
  await expect(box).toHaveValue('');
  await page.getByRole('button', { name: second, exact: false }).first().click();
  await expect(box).toHaveValue('乙的草稿');
});

test('usage log: period-independent totals, chart hover, model filter and table', async ({
  page,
}) => {
  const database = new DatabaseSync(resolve('.local/ui-test/sessions/sessions.sqlite'));
  try {
    database.exec('DELETE FROM api_requests');
    const insert = database.prepare(`INSERT INTO api_requests
      (at, session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd, duration_ms, ttft_ms, source, request_id)
      VALUES (?, NULL, ?, 100, 400, 20000, 1500, ?, 5000, 1000, 'sdk', ?)`);
    insert.run(Date.now() - 60_000, 'claude-opus-5-5', 0.75, `ui-${Date.now()}-a`);
    insert.run(Date.now() - 30_000, 'claude-opus-5-5', 0.5, `ui-${Date.now()}-b`);
    insert.run(Date.now() - 10_000, 'claude-haiku-4-5', 0.0123, `ui-${Date.now()}-c`);
  } finally {
    database.close();
  }
  await page.goto('/');
  await login(page);
  await page.getByRole('button', { name: '设置与账号', exact: true }).click();
  await page.getByRole('menuitem', { name: /^账号/ }).click();
  await page.getByRole('button', { name: '调用日志', exact: true }).click();
  await page.getByRole('button', { name: '24 小时', exact: true }).click();
  const tiles = page.locator('.usage-tiles');
  await expect(tiles).toContainText('请求数3');
  await expect(tiles).toContainText('$1.26');
  await expect(tiles).toContainText('100.0 tok/s');
  await expect(page.locator('.usage-table tbody tr')).toHaveCount(3);
  await page.locator('.usage-bars > div').last().hover();
  await expect(page.getByRole('tooltip')).toContainText('3 次请求');
  await noOverflowX(page);
  await page.screenshot({ path: resolve(screenshots, 'usage.png') });
  await page.getByLabel('模型').selectOption('claude-haiku-4-5');
  await expect(page.locator('.usage-table tbody tr')).toHaveCount(1);
  await expect(tiles).toContainText('请求数1');
  await page.getByRole('button', { name: '返回账号', exact: true }).click();
  await expect(page.getByRole('heading', { name: '账号', exact: true })).toBeVisible();
});

test('Electron remembers the sign-in, connects on the next launch and stays in the tray when closed', async () => {
  test.skip(process.platform !== 'win32', 'Windows desktop smoke test');
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env))
    if (value !== undefined && name !== 'ELECTRON_RUN_AS_NODE') env[name] = value;
  const profile = resolve('.local/ui-test/profile-remember');
  rmSync(profile, { recursive: true, force: true });
  const launch = () =>
    _electron.launch({
      args: [resolve('apps/desktop'), '--smoke-test', `--user-data-dir=${profile}`],
      env,
    });
  let application = await launch();
  try {
    const page = await application.firstWindow();
    await page.getByLabel('自动登录', { exact: true }).check();
    await expect(page.getByLabel('记住凭据', { exact: true })).toBeChecked();
    await login(page);
  } finally {
    await application.close();
  }
  const saved = readFileSync(resolve(profile, 'settings.json'), 'utf8');
  expect(saved).not.toContain(connection().token);
  application = await launch();
  try {
    const page = await application.firstWindow();
    await expect(page.locator('.connection-status')).toContainText('已连接');
    // Closing the window keeps the application and its connection alive.
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    expect(
      await application.evaluate(({ BrowserWindow }) => {
        const [window] = BrowserWindow.getAllWindows();
        return !!window && !window.isVisible();
      }),
    ).toBe(true);
    await expect(page.locator('.connection-status')).toContainText('已连接');
    await page.getByRole('button', { name: '设置与账号', exact: true }).click();
    await page.getByRole('menuitem', { name: '断开连接', exact: true }).click();
    await expect(page.getByLabel('服务凭据')).toHaveValue(connection().token);
  } finally {
    await application.close();
  }
  // Drafts are on disk as soon as they are saved: killing the process does not lose them.
  application = await launch();
  const page = await application.firstWindow();
  await page.evaluate(() => window.desktop!.saveDrafts({ 会话: '写了很久的草稿' }));
  execFileSync('taskkill', ['/pid', String(application.process().pid), '/t', '/f']);
  application = await launch();
  try {
    const page = await application.firstWindow();
    expect(await page.evaluate(() => window.desktop!.loadDrafts())).toEqual({
      会话: '写了很久的草稿',
    });
    // The schedule file exists from the first launch, and an edit made outside the window reaches it,
    // byte-order mark or not.
    const file = resolve(profile, 'schedules.json');
    // The window reads the file itself as it starts; the edit below has to come after that.
    await expect(page.getByLabel('服务凭据')).toBeVisible();
    const loaded = await page.evaluate(() => window.desktop!.loadSchedules(''));
    expect(loaded.path).toBe(file);
    expect(JSON.parse(loaded.text).tasks).toEqual([]);
    await page.evaluate(() => {
      window.desktop!.onSchedulesChanged((text) => {
        (window as unknown as { edited: string }).edited = text;
      });
    });
    writeFileSync(file, '\uFEFF{"tasks":[{"id":"外部"}]}');
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { edited?: string }).edited), {
        timeout: 15000,
      })
      .toBe('{"tasks":[{"id":"外部"}]}');
  } finally {
    await application.close();
  }
});
