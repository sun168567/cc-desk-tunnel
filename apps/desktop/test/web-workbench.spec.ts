import { test as base, expect, _electron } from '@playwright/test';
import type { Browser, BrowserContext, ElectronApplication, Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { nativeSettingsSchema, PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import type { Session } from '@cc-desk-tunnel/protocol';
import { DomainError } from '../../server/src/errors.ts';
import { readInstructions, writeInstructions } from '../../server/src/native-instructions.ts';
import { login, send, sessionAction, settled } from './helpers.ts';

type Desktop = {
  application: ElectronApplication;
  page: Page;
  profile: string;
  project: string;
};
const test = base.extend<{ desktop: Desktop }>({
  desktop: async ({}, use) => {
    const profiles = resolve('.local/ui-test');
    const profile = mkdtempSync(join(profiles, 'web-profile-'));
    const project = join(profile, 'project');
    mkdirSync(project);
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] =>
          entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE',
      ),
    );
    const application = await _electron.launch({
      args: [resolve('apps/desktop'), '--smoke-test', `--user-data-dir=${profile}`],
      env,
    });
    try {
      const page = await application.firstWindow();
      await expect(page.getByRole('heading', { name: '连接代理服务', exact: true })).toBeVisible();
      await login(page);
      // Only the native directory picker is supplied a test folder. The real renderer, preload,
      // main process, Web listener and the existing development service handle all operations.
      await application.evaluate(({ dialog }, folder) => {
        dialog.showOpenDialog = (async () => ({
          canceled: false,
          filePaths: [folder],
        })) as typeof dialog.showOpenDialog;
      }, project);
      await page.getByRole('button', { name: '添加项目', exact: true }).click();
      await use({ application, page, profile, project });
    } finally {
      await application.close();
      const child = relative(profiles, resolve(profile));
      if (!child || child.startsWith('..') || isAbsolute(child))
        throw new Error('The test profile is not inside the UI test directory.');
      rmSync(profile, { recursive: true, force: true });
    }
  },
});

async function general(page: Page) {
  await page.getByRole('button', { name: '设置与账号', exact: true }).click();
  await page.getByRole('menuitem', { name: '设置', exact: true }).click();
  await page
    .getByRole('navigation', { name: '设置分类' })
    .getByRole('button', { name: '常规', exact: true })
    .click();
}

async function unusedPort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function enable(page: Page) {
  await general(page);
  await page
    .getByRole('spinbutton', { name: '监听端口', exact: true })
    .fill(String(await unusedPort()));
  await page.getByRole('spinbutton', { name: '监听端口', exact: true }).blur();
  await page.getByRole('switch', { name: '启用 Web 工作台', exact: true }).click();
  await expect(page.locator('.remote-address-text')).toHaveText(/^http:\/\/127\.0\.0\.1:/);
  const status = await page.evaluate(() => window.desktop!.remoteStatus!());
  expect(status.enabled).toBe(true);
  return { url: status.url!, token: status.token! };
}

async function pair(browser: Browser, access: { url: string; token: string }, other = false) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    ...(other
      ? { userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0' }
      : {}),
  });
  try {
    const page = await context.newPage();
    await page.goto(access.url);
    await page.getByLabel('配对码', { exact: true }).fill(access.token);
    await page.getByRole('button', { name: '连接工作台', exact: true }).click();
    await expect(page.locator('.connection-status')).toContainText('已连接');
    return { context, page };
  } catch (error) {
    await context.close();
    throw error;
  }
}

async function create(page: Page, project: string, title: string) {
  await page.getByRole('button', { name: `新建会话 · ${project}`, exact: true }).click();
  await expect(page.locator('.session-row.selected strong')).toHaveText('新会话');
  await sessionAction(page, '重命名');
  await page.getByRole('dialog').getByLabel('名称', { exact: true }).fill(title);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('.session-row.selected strong')).toHaveText(title);
}

async function select(page: Page, title: string) {
  await page
    .locator('.session-row')
    .filter({ has: page.getByText(title, { exact: true }) })
    .locator('.session-select')
    .click();
}

test.describe('Electron Web workbench', () => {
  test.skip(process.platform !== 'win32', 'Windows Electron integration');
  test.setTimeout(120_000);

  test('browser session statistics and global instructions use the desktop connection and preserve conflicting drafts', async ({
    desktop,
    browser,
  }) => {
    const contexts: BrowserContext[] = [];
    // Only the service protocol is supplied here, as in settings.spec.ts. Both browsers use the real
    // Electron listener and renderer adapter. Instructions use the real file/CAS implementation,
    // with an explicit path in this test's profile rather than the user's Claude configuration.
    const instructions = join(desktop.profile, 'native-profile', 'CLAUDE.md');
    const original = writeInstructions(
      '回复用中文。\n',
      readInstructions(instructions).version,
      instructions,
    );
    const updates: { text: string; version: string }[] = [];
    let authentications = 0;
    let statistics = 0;
    const now = new Date().toISOString();
    const session: Session = {
      id: randomUUID(),
      title: 'Web 主线功能验收',
      autoTitle: false,
      projectPath: desktop.project,
      permissionMode: 'auto',
      model: null,
      effort: null,
      createdAt: now,
      updatedAt: now,
      activeRun: null,
    };
    // The desktop page already exists, so use a real listener rather than routeWebSocket's
    // new-document injection. The fixture owns only its ephemeral loopback port.
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.once('listening', resolve);
    });
    const address = `ws://127.0.0.1:${(server.address() as { port: number }).port}/ws`;
    server.on('connection', (socket) => {
      const reply = (value: unknown) => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
      };
      socket.on('message', (raw) => {
        const message = JSON.parse(String(raw));
        if (message.type === 'device' || message.type === 'leave') return;
        if (message.type === 'auth') {
          authentications++;
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
        try {
          if (message.type === 'session.subscribe')
            reply({
              type: 'session.snapshot',
              requestId: message.requestId,
              session,
              mode: 'replace',
              firstSequence: 0,
              lastSequence: 0,
              hasEarlier: false,
              events: [],
            });
          if (message.type === 'session.stats') {
            statistics++;
            reply({
              type: 'session.stats',
              requestId: message.requestId,
              sessionId: message.sessionId,
              turns: 3,
              requests: 7,
              inputTokens: 100,
              outputTokens: 2000,
              cacheReadTokens: 40000,
              cacheCreationTokens: 8000,
              modelMs: 28200,
              ttftMs: 952,
              outputPerSecond: 99.3,
              firstRecordAt: null,
            });
          }
          if (message.type === 'settings.get')
            reply({
              type: 'settings.state',
              requestId: message.requestId,
              values: Object.fromEntries(
                Object.keys(nativeSettingsSchema.shape).map((key) => [key, null]),
              ),
            });
          if (message.type === 'instructions.update') {
            updates.push({ text: message.text, version: message.version });
            writeInstructions(message.text, message.version, instructions);
          }
          if (message.type.startsWith('instructions.'))
            reply({
              type: 'instructions.state',
              requestId: message.requestId,
              ...readInstructions(instructions),
            });
          reply({ type: 'response', requestId: message.requestId, ok: true });
        } catch (error) {
          reply({
            type: 'response',
            requestId: message.requestId,
            ok: false,
            code: error instanceof DomainError ? error.code : 'fixture_error',
            message: error instanceof Error ? error.message : String(error),
          });
        }
      });
    });
    try {
      await desktop.page.getByRole('button', { name: '设置与账号', exact: true }).click();
      await desktop.page.getByRole('menuitem', { name: '断开连接', exact: true }).click();
      await desktop.page.getByLabel('服务地址', { exact: true }).fill(address);
      await desktop.page
        .getByLabel('服务凭据', { exact: true })
        .fill('test-only-native-web-token-with-enough-length');
      await desktop.page.getByRole('button', { name: '连接', exact: true }).click();
      await expect(desktop.page.locator('.connection-status')).toContainText('已连接');
      await select(desktop.page, session.title);
      const access = await enable(desktop.page);
      const first = await pair(browser, access);
      contexts.push(first.context);
      const second = await pair(browser, access, true);
      contexts.push(second.context);
      for (const page of [first.page, second.page]) {
        await general(page);
        await page.getByRole('switch', { name: '显示会话栏', exact: true }).click();
        await page.getByRole('button', { name: '会话', exact: true }).click();
        await expect(page.locator('.session-bar-part.session > button')).toHaveText(
          '3 轮 · 7 步 · 平均 99 tok/s',
        );
        await page.locator('.session-bar-part.session > button').click();
        await expect(
          page.getByRole('dialog', { name: '会话统计', exact: true }).locator('header'),
        ).toHaveText('会话统计3 轮');
        await page.locator('.session-bar-part.session > button').click();
      }
      expect(statistics).toBeGreaterThanOrEqual(2);
      for (const page of [desktop.page, first.page, second.page]) {
        await general(page);
        await page
          .getByRole('navigation', { name: '设置分类' })
          .getByRole('button', { name: 'Claude Code', exact: true })
          .click();
        await expect(
          page.locator('.instructions-card').getByLabel('全局说明', { exact: true }),
        ).toHaveValue(original.text);
      }
      const firstPanel = first.page.locator('.instructions-card');
      const secondPanel = second.page.locator('.instructions-card');
      const saved = '回复用中文。\n提交信息用中文。\n';
      const draft = '第二个浏览器尚未保存的说明。\n';
      await secondPanel.getByLabel('全局说明', { exact: true }).fill(draft);
      await firstPanel.getByLabel('全局说明', { exact: true }).fill(saved);
      await firstPanel.getByRole('button', { name: '保存', exact: true }).click();
      await expect(firstPanel.getByRole('status')).toHaveText('已保存，从下一次运行起生效');
      expect(readInstructions(instructions).text).toBe(saved);
      await secondPanel.getByRole('button', { name: '保存', exact: true }).click();
      await expect(secondPanel.getByRole('alert')).toContainText('已在别处修改');
      await expect(secondPanel.getByLabel('全局说明', { exact: true })).toHaveValue(draft);
      expect(readInstructions(instructions).text).toBe(saved);
      expect(updates).toEqual([
        { text: saved, version: original.version },
        { text: draft, version: original.version },
      ]);
      for (const page of [desktop.page, second.page]) {
        const panel = page.locator('.instructions-card');
        await panel.getByRole('button', { name: '重新载入', exact: true }).click();
        await expect(panel.getByLabel('全局说明', { exact: true })).toHaveValue(saved);
        await expect(panel.getByRole('alert')).toHaveCount(0);
      }
      expect(authentications).toBe(1);
      await expect(desktop.page.locator('.connection-status')).toContainText('已连接');
    } finally {
      try {
        await Promise.all(contexts.map((context) => context.close()));
      } finally {
        for (const socket of server.clients) socket.terminate();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    }
  });

  test('two browsers share desktop selection and commands without sharing drafts or disconnecting the desktop', async ({
    desktop,
    browser,
  }) => {
    const contexts: BrowserContext[] = [];
    try {
      const suffix = basename(desktop.profile).slice(-6);
      const firstTitle = `桌面会话甲 ${suffix}`;
      const secondTitle = `桌面会话乙 ${suffix}`;
      const createdTitle = `浏览器新建会话 ${suffix}`;
      await create(desktop.page, desktop.project, firstTitle);
      await create(desktop.page, desktop.project, secondTitle);
      const access = await enable(desktop.page);
      const first = await pair(browser, access);
      contexts.push(first.context);
      const second = await pair(browser, access, true);
      contexts.push(second.context);
      await desktop.page.getByRole('button', { name: '会话', exact: true }).click();
      const pages = [desktop.page, first.page, second.page];
      for (const page of pages)
        await expect(page.locator('.session-row.selected strong')).toHaveText(secondTitle);

      for (const [index, page] of pages.entries())
        await page.getByRole('textbox', { name: '消息' }).fill(`设备 ${index} 的未发送草稿`);
      await select(first.page, firstTitle);
      for (const page of pages)
        await expect(page.locator('.session-row.selected strong')).toHaveText(firstTitle);
      await select(second.page, secondTitle);
      for (const [index, page] of pages.entries()) {
        await expect(page.locator('.session-row.selected strong')).toHaveText(secondTitle);
        await expect(page.getByRole('textbox', { name: '消息' })).toHaveValue(
          `设备 ${index} 的未发送草稿`,
        );
      }

      await create(first.page, desktop.project, createdTitle);
      for (const page of pages)
        await expect(page.locator('.session-row.selected strong')).toHaveText(createdTitle);
      await send(first.page, '浏览器发起的工具审批', 'tool');
      await expect(desktop.page.getByRole('button', { name: '允许', exact: true })).toBeVisible();
      await second.page.getByRole('button', { name: '允许', exact: true }).click();
      for (const page of pages) {
        await settled(page);
        await expect(page.locator('.message.user')).toContainText('浏览器发起的工具审批');
      }
      await first.page.reload();
      await expect(first.page.locator('.connection-status')).toContainText('已连接');
      await expect(first.page.locator('.session-row.selected strong')).toHaveText(createdTitle);
      await expect(first.page.locator('.message.user')).toContainText('浏览器发起的工具审批');

      await general(desktop.page);
      await desktop.page.getByRole('switch', { name: '启用 Web 工作台', exact: true }).click();
      await expect(
        desktop.page.getByRole('switch', { name: '启用 Web 工作台', exact: true }),
      ).not.toBeChecked();
      await desktop.page.getByRole('button', { name: '会话', exact: true }).click();
      await expect(desktop.page.locator('.connection-status')).toContainText('已连接');
      await send(desktop.page, 'Web 关闭后桌面继续发送');
      await settled(desktop.page);
      await expect(desktop.page.locator('.message.user').last()).toContainText(
        'Web 关闭后桌面继续发送',
      );
      await expect(desktop.page.locator('.message.assistant').last()).toContainText('离线模拟回复');
    } finally {
      await Promise.all(contexts.map((context) => context.close()));
    }
  });

  test('tabs in one browser keep independent drafts after reload and recover other sessions in a new tab', async ({
    desktop,
    browser,
  }) => {
    let context: BrowserContext | undefined;
    try {
      const suffix = basename(desktop.profile).slice(-6);
      const one = `标签页草稿甲 ${suffix}`,
        two = `标签页草稿乙 ${suffix}`;
      await create(desktop.page, desktop.project, one);
      await create(desktop.page, desktop.project, two);
      const access = await enable(desktop.page);
      const first = await pair(browser, access);
      context = first.context;
      const second = await context.newPage();
      await second.goto(access.url);
      await expect(second.locator('.connection-status')).toContainText('已连接');
      const persisted = async (page: Page, text: string) => {
        await expect
          .poll(() =>
            page.evaluate(
              (text) =>
                Object.values(JSON.parse(sessionStorage.getItem('remote-drafts') ?? '{}')).includes(
                  text,
                ),
              text,
            ),
          )
          .toBe(true);
      };
      await select(first.page, one);
      for (const page of [first.page, second])
        await expect(page.locator('.session-row.selected strong')).toHaveText(one);
      await first.page.getByRole('textbox', { name: '消息' }).fill('第一页独立草稿');
      await persisted(first.page, '第一页独立草稿');
      await select(second, two);
      for (const page of [first.page, second])
        await expect(page.locator('.session-row.selected strong')).toHaveText(two);
      await second.getByRole('textbox', { name: '消息' }).fill('第二页另一会话草稿');
      await persisted(second, '第二页另一会话草稿');
      await first.page.reload();
      await expect(first.page.locator('.connection-status')).toContainText('已连接');
      await select(first.page, one);
      await expect(first.page.getByRole('textbox', { name: '消息' })).toHaveValue('第一页独立草稿');
      await expect(second.locator('.session-row.selected strong')).toHaveText(one);
      await second.getByRole('textbox', { name: '消息' }).fill('第二页同一会话草稿');
      await persisted(second, '第二页同一会话草稿');
      await first.page.reload();
      await expect(first.page.locator('.connection-status')).toContainText('已连接');
      await expect(first.page.getByRole('textbox', { name: '消息' })).toHaveValue('第一页独立草稿');
      await second.reload();
      await expect(second.locator('.connection-status')).toContainText('已连接');
      await expect(second.getByRole('textbox', { name: '消息' })).toHaveValue('第二页同一会话草稿');
      const recovered = await context.newPage();
      await recovered.goto(access.url);
      await expect(recovered.locator('.connection-status')).toContainText('已连接');
      await expect(recovered.getByRole('textbox', { name: '消息' })).toHaveValue(
        '第二页同一会话草稿',
      );
      await select(recovered, two);
      await expect(recovered.getByRole('textbox', { name: '消息' })).toHaveValue(
        '第二页另一会话草稿',
      );
    } finally {
      await context?.close();
    }
  });

  test('browser grants revoke independently and browser attachments and exports use the real desktop host', async ({
    desktop,
    browser,
  }, testInfo) => {
    const contexts: BrowserContext[] = [];
    try {
      await create(desktop.page, desktop.project, '附件与导出');
      const access = await enable(desktop.page);
      const first = await pair(browser, access);
      contexts.push(first.context);
      const second = await pair(browser, access, true);
      contexts.push(second.context);
      const anotherTab = await first.context.newPage();
      await anotherTab.goto(access.url);
      await expect(anotherTab.locator('.connection-status')).toContainText('已连接');

      const grants = desktop.page
        .locator('.remote-control')
        .getByRole('button', { name: /^撤销 / });
      await expect(grants).toHaveCount(2);
      await expect(desktop.page.locator('.remote-control')).toContainText('登录有效期为 30 天');
      await desktop.page
        .locator('.remote-control')
        .screenshot({ path: testInfo.outputPath('browser-grants-wide.png') });
      await desktop.application.evaluate(({ BrowserWindow }) => {
        const [window] = BrowserWindow.getAllWindows();
        window.setMinimumSize(640, 600);
        window.setSize(720, 900);
      });
      await desktop.page
        .locator('.remote-control')
        .screenshot({ path: testInfo.outputPath('browser-grants-narrow.png') });
      await expect
        .poll(() =>
          grants.first().evaluate((button) => {
            const text = document.createRange();
            text.selectNodeContents(button);
            return text.getClientRects().length;
          }),
        )
        .toBe(1);
      expect(
        await desktop.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      ).toBe(true);
      await desktop.application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].setSize(1280, 900),
      );

      await desktop.page.getByRole('button', { name: /^撤销 Chrome / }).click();
      for (const page of [first.page, anotherTab])
        await expect(
          page.getByRole('heading', { name: '连接桌面客户端的工作台', exact: true }),
        ).toBeVisible();
      await expect(grants).toHaveCount(1);
      await expect(second.page.locator('.connection-status')).toContainText('已连接');
      expect((await first.context.request.get(`${access.url}/api/info`)).status()).toBe(401);
      expect((await second.context.request.get(`${access.url}/api/info`)).status()).toBe(200);

      const content = 'Web upload round-trip\n中文附件内容\n';
      const chooser = second.page.waitForEvent('filechooser');
      await second.page.getByRole('button', { name: /^添加文件/ }).click();
      await (
        await chooser
      ).setFiles({
        name: 'web-attachment.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from(content),
      });
      const composer = second.page.getByRole('textbox', { name: '消息' });
      await expect(composer).toHaveValue(/web-attachment\.txt/);
      const attached = await composer.inputValue();
      const uploaded = /^"([^"]+)"/.exec(attached)![1];
      const uploadRoot = join(desktop.profile, 'uploads');
      const child = relative(uploadRoot, uploaded);
      expect(child.startsWith('..')).toBe(false);
      expect(isAbsolute(child)).toBe(false);
      expect(readFileSync(uploaded, 'utf8')).toBe(content);
      await composer.fill(`${attached}请检查这个附件`);
      await second.page.getByRole('button', { name: '发送消息', exact: true }).click();
      await settled(second.page);
      const downloaded = second.page.waitForEvent('download');
      await sessionAction(second.page, '导出为 Markdown');
      const file = await downloaded;
      const exported = testInfo.outputPath('conversation.md');
      await file.saveAs(exported);
      expect(file.suggestedFilename()).toBe('附件与导出.md');
      expect(readFileSync(exported, 'utf8')).toContain(uploaded);
      expect(readFileSync(exported, 'utf8')).toContain('请检查这个附件');
      await desktop.page.getByRole('button', { name: '会话', exact: true }).click();
      await expect(desktop.page.locator('.message.user').last()).toContainText('请检查这个附件');
      await send(desktop.page, '撤销其他浏览器后桌面仍可发送');
      await settled(desktop.page);
      await expect(second.page.locator('.message.user').last()).toContainText(
        '撤销其他浏览器后桌面仍可发送',
      );
      await second.page.setViewportSize({ width: 390, height: 844 });
      expect(
        await second.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      ).toBe(true);
      await second.page.screenshot({ path: testInfo.outputPath('browser-workbench-narrow.png') });
    } finally {
      await Promise.all(contexts.map((context) => context.close()));
    }
  });
});
