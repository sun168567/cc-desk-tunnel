import { test, expect, _electron } from '@playwright/test';
import type { Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import type { Session } from '@cc-desk-tunnel/protocol';
import {
  createSession,
  expandActivity,
  login,
  screenshots,
  send,
  sessionAction,
  settled,
} from './helpers.ts';

const shot = (page: Page, name: string) =>
  page.screenshot({ path: resolve(screenshots, 'redesign', `${name}.png`) });
const project = 'D:\\工作\\中文项目';

test('pages, side column, menus, pins, export, settings and the notice list', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await login(page);
  const title = await createSession(page, '改版');
  await send(page, '梳理当前项目');
  await settled(page);
  await expect(page.locator('.composer-context')).toContainText('中文项目');
  await shot(page, '01-会话');

  // A pinned session moves under its own heading; a project gets a local name and a pin of its own.
  const row = page.locator('.session-row.selected');
  await row.hover();
  await row.getByRole('button', { name: '置顶', exact: true }).click();
  await expect(page.locator('.list-heading').first()).toHaveText('置顶');
  await page.getByRole('button', { name: `项目操作 · ${project}`, exact: true }).click();
  await shot(page, '02-项目菜单');
  await expect(page.getByRole('menuitem', { name: '移除项目' })).toHaveCount(0);
  await page.getByRole('menuitem', { name: '修改显示名称', exact: true }).click();
  await page.getByRole('dialog').getByLabel('显示名称').fill('我的项目');
  await page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click();
  const group = page.locator('.project-group > h2').filter({ hasText: '我的项目' });
  await expect(group).toHaveAttribute('title', project);
  await expect(page.locator('.composer-context')).toContainText('我的项目');
  await group.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '置顶', exact: true }).click();
  await expect(group.locator('.pin-mark')).toBeVisible();

  // The whole session leaves as one Markdown file.
  await row.hover();
  await row.getByRole('button', { name: '会话操作', exact: true }).click();
  await shot(page, '03-会话菜单');
  const download = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: '导出为 Markdown', exact: true }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe(`${title}.md`);
  const text = readFileSync(await file.path(), 'utf8');
  expect(text).toContain(`# ${title}`);
  expect(text).toContain('梳理当前项目');
  expect(text).toContain('离线模拟回复');

  // The title bar: menus, and the way back and forward through the places visited.
  await page.getByRole('button', { name: '文件', exact: true }).click();
  await shot(page, '04-文件菜单');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '视图', exact: true }).click();
  await page.getByRole('menuitemradio', { name: '定时任务', exact: true }).click();
  await expect(page.getByRole('heading', { name: '安排任务', exact: true })).toBeVisible();
  await shot(page, '05-定时任务');
  await page.getByRole('button', { name: '新建任务', exact: true }).first().click();
  await shot(page, '06-定时任务-编辑');
  await page.getByRole('button', { name: '后退', exact: true }).click();
  await expect(page.locator('.titlebar h1')).toHaveText(title);
  await page.getByRole('button', { name: '前进', exact: true }).click();
  await expect(page.locator('.titlebar h1')).toHaveText('定时任务');
  await page.keyboard.press('Control+b');
  await expect(page.locator('.sidebar')).toBeHidden();
  await page.keyboard.press('Control+b');
  await expect(page.locator('.sidebar')).toBeVisible();

  // Settings: reached from the rail's menu, sorted into sections, searchable, kept on this computer.
  await page.getByRole('button', { name: '设置与账号', exact: true }).click();
  await shot(page, '07-设置菜单');
  await page.getByRole('menuitem', { name: '设置', exact: true }).click();
  const sections = page.getByRole('navigation', { name: '设置分类' });
  for (const [name, heading] of [
    ['账号与额度', '账号'],
    ['Claude Code', 'Claude Code'],
    ['常规', '常规'],
    ['通知', '通知'],
    ['帮助', '帮助'],
    ['关于与更新', '关于与更新'],
  ]) {
    await sections.getByRole('button', { name, exact: true }).click();
    await expect(
      page.locator('.workspace').getByRole('heading', { level: 1, name: heading, exact: true }),
    ).toBeVisible();
    await shot(page, `08-设置-${name}`);
  }
  await page.getByLabel('搜索设置').fill('提示音');
  await expect(sections.getByRole('button')).toHaveText(['通知']);
  await sections.getByRole('button', { name: '通知', exact: true }).click();
  const done = page.getByRole('switch', { name: '任务完成', exact: true });
  await expect(done).toBeChecked();
  await done.click();
  await expect(done).not.toBeChecked();
  expect(await page.evaluate(() => JSON.parse(localStorage['proxy-prefs']).notify.done)).toBe(
    false,
  );
  await done.click();

  // With the window out of sight, a run that waits for an answer and one that ends are both noted.
  await page.getByRole('button', { name: '会话', exact: true }).click();
  await page.evaluate(() => {
    document.hasFocus = () => false;
  });
  await send(page, '检查目录', 'tool');
  const bell = page.getByRole('button', { name: /^通知/ });
  await expect(bell).toHaveAccessibleName('通知（1 条未读）');
  await page.getByRole('button', { name: '允许', exact: true }).click();
  await settled(page);
  await expect(bell).toHaveAccessibleName('通知（2 条未读）');
  await bell.click();
  const notices = page.getByRole('dialog', { name: '通知' });
  await expect(notices.locator('.notice strong')).toHaveText(['任务完成', '等待审批']);
  await expect(notices.locator('.notice').first()).toContainText(title);
  await shot(page, '09-通知列表');
  await notices.locator('.notice').first().click();
  await expect(notices).toHaveCount(0);
  await expect(bell).toHaveAccessibleName('通知');

  // The same window, narrow.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.sidebar')).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await shot(page, '10-窄屏');
  await page.getByRole('button', { name: '展开会话列表', exact: true }).click();
  await shot(page, '11-窄屏-侧栏');
  await page.setViewportSize({ width: 1280, height: 900 });
  await sessionAction(page, '删除');
  await page.getByRole('dialog').getByRole('button', { name: '删除', exact: true }).click();
  expect(errors).toEqual([]);
});

test('a question is answered with its choices, and a session or a whole project moves to another folder', async ({
  page,
}) => {
  await page.goto('/');
  await login(page);
  const title = await createSession(page, '提问');

  // Claude's question shows its choices instead of allow / deny; the answers go back by question.
  await send(page, '问我', 'question');
  const card = page.getByRole('form', { name: 'Claude 的提问' });
  await expect(card).toBeVisible();
  await expect(page.getByRole('button', { name: '允许', exact: true })).toHaveCount(0);
  await expect(page.locator('.session-row.selected')).toContainText('等待回答');
  const submit = card.getByRole('button', { name: '提交回答', exact: true });
  await card.getByRole('checkbox', { name: '界面', exact: true }).click();
  await card.getByRole('checkbox', { name: '文档', exact: true }).click();
  await expect(submit).toBeDisabled();
  await card.getByRole('radio', { name: '现在', exact: true }).click();
  await card.getByLabel('其他回答：什么时候开始？').fill('下周一');
  await expect(card.getByRole('radio', { name: '现在', exact: true })).not.toBeChecked();
  await shot(page, '17-提问卡片');
  await submit.click();
  await settled(page);
  await expect(page.locator('.message.assistant').last()).toContainText(
    '收到回答：界面, 文档；下周一',
  );
  await send(page, '再问一次', 'question');
  await card.getByRole('button', { name: '不回答', exact: true }).click();
  await settled(page);
  await expect(page.locator('.message.assistant').last()).toContainText('没有得到回答');

  // The session moves to another project from the chip above the message box.
  const other = 'D:\\工作\\另一个项目';
  await page.getByRole('button', { name: '添加项目', exact: true }).click();
  await page.getByLabel('Windows 项目目录').fill(other);
  await page.getByRole('button', { name: '添加', exact: true }).click();
  const chip = page.getByRole('button', { name: '会话所在的项目', exact: true });
  await expect(chip).toContainText('中文项目');
  await chip.click();
  await shot(page, '18-更换项目');
  await page.getByRole('menuitemradio', { name: '另一个项目', exact: true }).click();
  await expect(chip).toContainText('另一个项目');
  await expect(
    page.locator('.project-group').filter({ hasText: '另一个项目' }).locator('.session-row'),
  ).toContainText([title]);
  await send(page, '检查目录', 'tool');
  await page.getByRole('button', { name: '允许', exact: true }).click();
  await settled(page);
  await expandActivity(page);
  await expect(page.locator('.tool-output').last()).toContainText(other);

  // Pointing the project at another folder takes its sessions along.
  const moved = 'E:\\搬家后\\另一个项目';
  await page.getByRole('button', { name: `项目操作 · ${other}`, exact: true }).click();
  await page.getByRole('menuitem', { name: '更改文件夹…', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Windows 项目目录').fill(moved);
  await page.getByRole('dialog').getByRole('button', { name: '更改', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(chip).toHaveAttribute('title', moved);
  await expect(page.getByRole('button', { name: `项目操作 · ${other}`, exact: true })).toHaveCount(
    0,
  );
  await sessionAction(page, '删除');
  await page.getByRole('dialog').getByRole('button', { name: '删除', exact: true }).click();
});

test('approval modes are described where they are chosen, and models sit behind the effort slider', async ({
  page,
}) => {
  const now = new Date().toISOString();
  const session: Session = {
    id: randomUUID(),
    title: '输入区',
    autoTitle: false,
    projectPath: 'D:\\工作\\输入区',
    permissionMode: 'auto',
    model: 'test-model',
    effort: 'high',
    createdAt: now,
    updatedAt: now,
    activeRun: null,
  };
  const runId = randomUUID();
  const modes: string[] = [];
  await page.routeWebSocket('ws://127.0.0.1:18890/ws', (route) => {
    const reply = (value: unknown) => route.send(JSON.stringify(value));
    route.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === 'auth') {
        reply({
          type: 'ready',
          protocolVersion: PROTOCOL_VERSION,
          version: '0.0.1',
          connectionId: randomUUID(),
          adapter: 'claude-code',
          sessions: [session],
        });
        return;
      }
      if (message.type === 'session.subscribe')
        reply({
          type: 'session.snapshot',
          requestId: message.requestId,
          session,
          mode: 'replace',
          firstSequence: 1,
          lastSequence: 1,
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
                models: ['甲', '乙', '丙'].map((name, index) => ({
                  value: index ? `model-${index}` : 'test-model',
                  displayName: `测试模型${name}`,
                  description: '回归夹具',
                  source: 'native',
                  supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
                })),
              },
            },
          ],
        });
      if (message.type === 'session.configure') {
        modes.push(message.permissionMode);
        session.permissionMode = message.permissionMode;
        reply({ type: 'session.updated', session });
      }
      reply({ type: 'response', requestId: message.requestId, ok: true });
    });
  });
  await page.goto('/');
  await page.getByLabel('服务地址', { exact: true }).fill('ws://127.0.0.1:18890/ws');
  await page
    .getByLabel('服务凭据', { exact: true })
    .fill('test-only-layout-token-with-enough-length');
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await page.locator('.session-select').filter({ hasText: session.title }).click();

  const trigger = page.getByRole('button', { name: '审批模式', exact: true });
  await expect(trigger).toContainText('自动审批');
  await trigger.click();
  const menu = page.getByRole('menu', { name: '审批模式' });
  await expect(menu.getByRole('menuitemradio')).toHaveCount(4);
  await expect(menu.getByRole('menuitemradio', { name: '自动审批', exact: true })).toBeChecked();
  await expect(menu).toContainText('只调研并给出计划，不做改动');
  await shot(page, '12-审批模式');
  await menu.getByRole('menuitemradio', { name: '手动审批', exact: true }).click();
  await expect(trigger).toContainText('手动审批');
  expect(modes).toEqual(['default']);

  await page.getByRole('button', { name: '模型与推理强度', exact: true }).click();
  const models = page.getByRole('listbox', { name: '模型', exact: true });
  await expect(page.getByRole('slider', { name: '推理强度', exact: true })).toBeVisible();
  await expect(models).toHaveCount(0);
  await shot(page, '13-推理强度');
  await page.locator('.model-current').click();
  await expect(models.getByRole('option')).toHaveCount(4);
  await shot(page, '14-选择模型');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '设置与账号', exact: true }).click();
  await page.getByRole('menuitem', { name: '设置', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Claude Code 设置' })).toBeVisible();
});

test('Electron: frameless window, the project branch, files by path and window settings', async () => {
  test.skip(process.platform !== 'win32', 'Windows desktop smoke test');
  test.slow();
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env))
    if (value !== undefined && name !== 'ELECTRON_RUN_AS_NODE') env[name] = value;
  const profile = resolve('.local/ui-test/profile-layout');
  rmSync(profile, { recursive: true, force: true });
  const application = await _electron.launch({
    args: [resolve('apps/desktop'), '--smoke-test', `--user-data-dir=${profile}`],
    env,
  });
  try {
    const page = await application.firstWindow();
    await expect(page.getByRole('heading', { name: '连接代理服务', exact: true })).toBeVisible();
    await login(page);
    // This repository stands in for the user's project.
    const repository = resolve('.');
    const picked = resolve('package.json');
    await application.evaluate(
      ({ dialog }, paths) => {
        dialog.showOpenDialog = (async (_window: unknown, options: { properties?: string[] }) => ({
          canceled: false,
          filePaths: [options.properties?.includes('openDirectory') ? paths[0] : paths[1]],
        })) as typeof dialog.showOpenDialog;
      },
      [repository, picked],
    );
    await page.getByRole('button', { name: '添加项目', exact: true }).click();
    await page.getByRole('button', { name: `新建会话 · ${repository}`, exact: true }).click();
    const branch = execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim();
    await expect(page.locator('.composer-context')).toContainText(branch);
    await page.getByRole('button', { name: /^添加文件/ }).click();
    await expect(page.getByRole('textbox', { name: '消息' })).toHaveValue(`"${picked}" `);
    await page.screenshot({ path: resolve(screenshots, 'redesign', '15-桌面窗口.png') });

    await page.getByRole('button', { name: '设置与账号', exact: true }).click();
    await page.getByRole('menuitem', { name: '设置', exact: true }).click();
    await page
      .getByRole('navigation', { name: '设置分类' })
      .getByRole('button', { name: '常规', exact: true })
      .click();
    const tray = page.getByRole('switch', { name: '关闭窗口时留在后台', exact: true });
    await expect(tray).toBeChecked();
    await tray.click();
    await expect
      .poll(() => JSON.parse(readFileSync(resolve(profile, 'settings.json'), 'utf8')).closeToTray)
      .toBe(false);
    await page.screenshot({ path: resolve(screenshots, 'redesign', '16-桌面窗口-常规设置.png') });
    const frame = await application.evaluate(({ BrowserWindow }) => {
      const [window] = BrowserWindow.getAllWindows();
      // The content covers the whole window when the system draws no title bar of its own.
      return window.getContentSize()[1] === window.getSize()[1];
    });
    expect(frame).toBe(true);
  } finally {
    await application.close();
  }
});
