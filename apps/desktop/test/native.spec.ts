import { test, expect, _electron } from '@playwright/test';
import type { Page } from '@playwright/test';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

test.use({ trace: 'off' });
const project = resolve('.local/gui-subscription/中文 项目');
function config() {
  return JSON.parse(readFileSync(resolve(process.env.NATIVE_TEST_CONFIG!), 'utf8')) as {
    url: string;
    token: string;
    fingerprint?: string;
  };
}
async function settled(page: Page) {
  await expect(page.getByRole('button', { name: '停止运行', exact: true })).toHaveCount(0, {
    timeout: 90000,
  });
  await expect(page.getByRole('textbox', { name: '消息' })).toBeEnabled({ timeout: 20000 });
}
async function send(page: Page, text: string) {
  await expect(page.getByRole('textbox', { name: '消息' })).toBeEnabled({ timeout: 20000 });
  const before = await page.locator('.message.user').count();
  await page.getByRole('textbox', { name: '消息' }).fill(text);
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.locator('.message.user')).toHaveCount(before + 1);
}
async function rename(page: Page, title: string) {
  await settled(page);
  const row = page.locator('.session-row.selected');
  await row.hover();
  await row.getByRole('button', { name: '会话操作', exact: true }).click();
  await page.getByRole('menuitem', { name: '重命名', exact: true }).click();
  await page.getByRole('dialog').getByLabel('名称', { exact: true }).fill(title);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(row.locator('strong')).toHaveText(title);
}
async function drive(page: Page, decision: '允许' | '拒绝' = '允许') {
  const deadline = Date.now() + 90000;
  let approvals = 0;
  while (Date.now() < deadline) {
    const button = page.getByRole('button', { name: decision, exact: true }).first();
    if ((await button.isVisible()) && (await button.isEnabled())) {
      try {
        await button.click({ timeout: 10000 });
        approvals++;
      } catch (error) {
        if ((await button.isVisible()) && (await button.isEnabled())) throw error;
      }
    }
    if (!(await page.getByRole('button', { name: '停止运行', exact: true }).count())) {
      await settled(page);
      return approvals;
    }
    await page.waitForTimeout(100);
  }
  throw new Error('Native run timeout');
}

// Finished turns, runs of tool calls and each call are folded; open them all to inspect the details.
async function expandActivity(page: Page) {
  for (const selector of ['.turn-process', '.work', '.tool'])
    while (await page.locator(`${selector}:not([open]) > summary`).count())
      await page.locator(`${selector}:not([open]) > summary`).first().click();
}

test('official subscription: account metrics, Windows execution, running input, native compact, stop and resume', async () => {
  test.skip(
    !process.env.NATIVE_TEST_CONFIG,
    'Explicit opt-in: official subscription and real Windows SSH execution.',
  );
  test.setTimeout(360000);
  mkdirSync(project, { recursive: true });
  mkdirSync(resolve('.local/screenshots'), { recursive: true });
  const connection = config();
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE',
    ),
  );
  const app = await _electron.launch({ args: [resolve('apps/desktop'), '--smoke-test'], env });
  const errors: string[] = [];
  try {
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, project);
    const page = await app.firstWindow();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.getByRole('button', { name: '远程代理', exact: true }).click();
    async function connect() {
      await page.getByLabel('服务地址', { exact: true }).fill(connection.url);
      await page.getByLabel('服务证书指纹', { exact: true }).fill(connection.fingerprint ?? '');
      await page.getByLabel('服务凭据', { exact: true }).fill(connection.token);
      await page.getByRole('button', { name: '连接', exact: true }).click();
      await expect(page.locator('.sidebar-footer')).toContainText('已连接', { timeout: 45000 });
    }
    await connect();
    await page.getByRole('button', { name: '添加项目', exact: true }).click();
    await page.getByRole('button', { name: `新建会话 · ${project}`, exact: true }).click();
    await settled(page);
    const marker = `PRO-STREAM-${Date.now()}`;
    await rename(page, marker);

    await page.locator('.account-entry').click();
    const account = page.getByRole('region', { name: '账号信息' });
    await expect(account.locator('.account-identity')).toContainText(/pro/i);
    await expect(account.locator('.quota-row')).not.toHaveCount(0);
    await expect(account.locator('.quota-row').first()).toContainText('重置');
    await page.screenshot({ path: resolve('.local/screenshots/subscription-account.png') });
    await page.getByRole('button', { name: '关闭账号信息', exact: true }).click();

    await page.getByRole('button', { name: '模型与推理强度', exact: true }).click();
    await expect(
      page.getByRole('listbox', { name: '模型', exact: true }).getByRole('option'),
    ).not.toHaveCount(0);
    await page.keyboard.press('Escape');
    await send(page, `请记住唯一标记 ${marker}，不调用工具，只回复标记。`);
    await settled(page);
    await expect(page.locator('.message.assistant').last()).toContainText(marker);
    await page.getByRole('button', { name: '上下文窗口', exact: true }).hover();
    await expect(page.getByRole('tooltip')).toContainText('tokens');
    await page.mouse.move(10, 10);

    await page.getByLabel('审批模式').selectOption('default');
    await expect(page.getByLabel('审批模式')).toHaveValue('default');
    await send(
      page,
      '仅调用一次 Bash，通过 SSH 在 Windows PowerShell 执行 Start-Sleep -Seconds 5，然后回复完成。不要读写任何文件。',
    );
    await expect(page.getByRole('button', { name: '允许', exact: true }).first()).toBeVisible({
      timeout: 45000,
    });
    await expect(page.getByRole('textbox', { name: '消息' })).toBeEnabled();
    await page.getByRole('button', { name: '允许', exact: true }).first().click();
    await expect(page.getByRole('button', { name: '停止运行', exact: true })).toBeVisible();
    await send(page, `运行中补充：回复时附加 ${marker}-MID，不执行其他操作。`);
    await drive(page);
    await expect(page.locator('.message.user').last()).toContainText('原生已接收');
    await expect(page.locator('.message.assistant').last()).toContainText(`${marker}-MID`);
    await expandActivity(page);
    await expect(page.locator('.tool-input').filter({ hasText: 'ssh' })).not.toHaveCount(0);
    await expect(page.locator('.tool-heading').filter({ hasText: 'mcp__' })).toHaveCount(0);
    await page.screenshot({ path: resolve('.local/screenshots/subscription-intervention.png') });

    await page.getByLabel('审批模式').selectOption('auto');
    await expect(page.getByLabel('审批模式')).toHaveValue('auto');
    await page.getByRole('textbox', { name: '消息' }).fill('/');
    await expect(page.getByRole('listbox', { name: '会话命令' })).toBeVisible();
    await page.getByRole('option', { name: '压缩上下文', exact: false }).click();
    await expect(page.locator('.message.user').last()).toContainText('/compact');
    await settled(page);
    await expect(page.getByText(/原生上下文已压缩/)).toBeVisible();
    await send(page, '不调用任何工具，只回复本会话最初的唯一标记。');
    await settled(page);
    await expect(page.locator('.message.assistant').last()).toContainText(marker);

    await page.getByLabel('审批模式').selectOption('default');
    const file = `${marker}-denied.txt`;
    await send(page, `仅通过一次 Bash / SSH 在 Windows 项目创建 ${file}。用户拒绝后不得重试。`);
    expect(await drive(page, '拒绝')).toBeGreaterThan(0);
    expect(existsSync(join(project, file))).toBe(false);
    await send(page, `通过 Bash / SSH 在 Windows 项目创建 ${marker}-stop.txt。`);
    await expect(page.getByRole('button', { name: '允许', exact: true }).first()).toBeVisible({
      timeout: 45000,
    });
    await page.getByRole('button', { name: '停止运行', exact: true }).click();
    await settled(page);
    expect(existsSync(join(project, `${marker}-stop.txt`))).toBe(false);

    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.getByRole('button', { name: '上下文窗口', exact: true }).click();
    const tip = await page.getByRole('tooltip').boundingBox();
    expect(tip && tip.x >= 0 && tip.x + tip.width <= 390).toBeTruthy();
    await page.keyboard.press('Escape');
    await page.screenshot({ path: resolve('.local/screenshots/subscription-mobile.png') });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole('button', { name: '连接', exact: true }).click();
    await page.getByRole('menuitem', { name: '断开连接', exact: true }).click();
    await connect();
    await page.locator('.session-select').filter({ hasText: marker }).click();
    await settled(page);
    await send(page, '不调用工具，只回复最初的唯一标记。');
    await settled(page);
    await expect(page.locator('.message.assistant').last()).toContainText(marker);
    await expect(page.locator('.tool-heading').filter({ hasText: '等待审批' })).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
