import { test, expect, _electron } from '@playwright/test';
import type { Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import { login, screenshots } from './helpers.ts';

const shots = resolve(screenshots, 'settings-layout');
const every = [
  '常规',
  '外观',
  '连接',
  '通知',
  '快捷键',
  '上下文与缓存',
  '浏览器访问',
  '账号与额度',
  'CLI 设置',
  '全局说明',
  '帮助',
  '关于与更新',
];

// A service at `url` that answers what each settings page reads. With `shells`, it lists this computer with them, and
// keeps the shell chosen for it in `chosen`.
async function serve(page: Page, url: string, shells?: string[], chosen: unknown[] = []) {
  const now = new Date().toISOString();
  const hour = new Date(Date.now() + 3 * 3_600_000).toISOString();
  await page.routeWebSocket(url, (route) => {
    const send = (value: unknown) => route.send(JSON.stringify(value));
    let here: { id: string; name: string; ready: boolean; shells: string[]; shell?: string };
    route.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      const requestId = message.requestId;
      if (message.type === 'device') {
        here = { id: message.id, name: '这台电脑', ready: true, shells: shells ?? ['pwsh'] };
        if (shells) send({ type: 'devices', devices: [here] });
        return;
      }
      if (message.type === 'device.shell') {
        chosen.push(message.shell);
        const { shell: _, ...rest } = here;
        here = message.shell ? { ...rest, shell: message.shell } : rest;
        send({ type: 'devices', devices: [here] });
      }
      if (message.type === 'auth') {
        send({
          type: 'ready',
          protocolVersion: PROTOCOL_VERSION,
          version: '0.0.1',
          connectionId: randomUUID(),
          adapter: 'claude-code',
          sessions: [],
        });
        return;
      }
      if (message.type === 'account.status')
        send({
          type: 'account.state',
          loggedIn: true,
          authMethod: 'claude.ai',
          email: 'someone@example.com',
          subscriptionType: 'max',
          login: null,
        });
      if (message.type === 'usage.summary')
        send({
          type: 'usage.summary',
          requestId,
          retentionDays: 30,
          firstRecordAt: now,
          windows: [
            {
              name: 'five_hour',
              startedAt: now,
              resetsAt: hour,
              utilization: 0.32,
              requests: 41,
              inputTokens: 52_000,
              outputTokens: 18_000,
              cacheReadTokens: 2_400_000,
              cacheCreationTokens: 310_000,
              costUsd: 6.4,
            },
          ],
        });
      if (message.type === 'settings.get')
        send({
          type: 'settings.state',
          requestId,
          values: {
            autoCompactEnabled: null,
            autoCompactWindow: null,
            alwaysThinkingEnabled: null,
            showThinkingSummaries: null,
            fastMode: null,
            autoContinueAtUsageLimit: null,
            switchModelsOnFlag: null,
            autoMemoryEnabled: null,
            fileCheckpointingEnabled: null,
            promptCacheTtl: null,
            language: 'chinese',
            precomputeCompactionEnabled: null,
            autoDreamEnabled: null,
            subagentPromptCacheTtl: null,
            fallbackModel: null,
            askUserQuestionTimeout: null,
            bashOutputMaxChars: null,
            attribution: null,
            includeGitInstructions: null,
            toolSearch: null,
          },
        });
      if (message.type === 'compaction.get')
        send({
          type: 'compaction.state',
          requestId,
          values: { enabled: false, afterMinutes: 50, minTokens: 100_000 },
        });
      if (message.type === 'instructions.get')
        send({
          type: 'instructions.state',
          requestId,
          text: '回复用中文。\n改动前先说明打算怎么改。\n',
          version: 'v1',
        });
      if (message.type === 'web.settings.get')
        send({
          type: 'web.settings.state',
          requestId,
          values: {
            enabled: true,
            domain: 'work.example.com',
            path: 'desk',
            idleMinutes: 120,
            proxyEnabled: false,
            trustedProxies: [],
            totpEnabled: true,
            sessions: [],
            selfSigned: false,
            url: 'https://work.example.com/desk/',
          },
        });
      if (message.type === 'web.certificate.get')
        send({ type: 'web.certificate.state', requestId, mode: 'external', selfSigned: false });
      send({ type: 'response', requestId, ok: true });
    });
  });
}

// Opens the settings and pictures each of `names` into `folder`; the side list shows `shown`.
async function picture(page: Page, folder: string, shown: string[], names = shown) {
  mkdirSync(folder, { recursive: true });
  await page.getByRole('button', { name: '设置与账号', exact: true }).click();
  await page.getByRole('menuitem', { name: '设置', exact: true }).click();
  const sections = page.getByRole('navigation', { name: '设置分类' });
  await expect(sections.getByRole('button')).toHaveText(shown);
  for (const [index, name] of names.entries()) {
    await sections.getByRole('button', { name, exact: true }).click();
    await expect(page.getByRole('heading', { name, level: 1 }).last()).toBeVisible();
    await page.screenshot({
      path: resolve(folder, `${String(index + 1).padStart(2, '0')}-${name.replace(/ /g, '')}.png`),
    });
  }
}

// Served pages as in a browser, against a service that answers what each reads. The browser has no window of the
// computer's to set, nor connections to keep.
test('each settings page opens from its group in the side list', async ({ page }) => {
  const url = 'ws://127.0.0.1:18897/ws';
  await serve(page, url);
  await page.goto('/');
  await page.getByLabel('服务地址', { exact: true }).fill(url);
  await page
    .getByLabel('服务凭据', { exact: true })
    .fill('test-only-settings-layout-token-with-length');
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await picture(
    page,
    resolve(shots, 'browser'),
    every.filter((name) => name !== '连接'),
  );
});

// A Windows computer has a page for the shell Claude should prefer: Git Bash is listed, and chosen once it has it.
test('the shell Claude prefers on this computer is chosen there, Git Bash once it is found', async ({
  page,
}) => {
  const alone = 'ws://127.0.0.1:18899/ws';
  await serve(page, alone, ['pwsh']);
  await page.goto('/');
  await page.getByLabel('服务地址', { exact: true }).fill(alone);
  await page
    .getByLabel('服务凭据', { exact: true })
    .fill('test-only-settings-layout-token-with-length');
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await page.getByRole('button', { name: '设置与账号', exact: true }).click();
  await page.getByRole('menuitem', { name: '设置', exact: true }).click();
  await page
    .getByRole('navigation', { name: '设置分类' })
    .getByRole('button', { name: 'Shell', exact: true })
    .click();
  const missing = page.getByLabel('偏好的 Shell', { exact: true });
  await expect(missing.locator('option')).toHaveText([
    '不指定',
    'PowerShell 7',
    'Git Bash（未检测到）',
  ]);
  expect(
    await missing
      .locator('option[value="bash"]')
      .evaluate((option: HTMLOptionElement) => option.disabled),
  ).toBe(true);
  await expect(page.getByText(/没有检测到 Git Bash：安装 Git for Windows/)).toBeVisible();
  await page.screenshot({ path: resolve(shots, 'shell-without-git-bash.png') });
  await page.close();
  page = await page.context().newPage();
  const url = 'ws://127.0.0.1:18898/ws';
  const chosen: unknown[] = [];
  await serve(page, url, ['pwsh', 'bash'], chosen);
  await page.goto('/');
  await page.getByLabel('服务地址', { exact: true }).fill(url);
  await page
    .getByLabel('服务凭据', { exact: true })
    .fill('test-only-settings-layout-token-with-length');
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await page.getByRole('button', { name: '设置与账号', exact: true }).click();
  await page.getByRole('menuitem', { name: '设置', exact: true }).click();
  const sections = page.getByRole('navigation', { name: '设置分类' });
  await expect(sections.getByRole('button')).toHaveText(
    every.flatMap((name) =>
      name === '连接' ? [] : name === '上下文与缓存' ? [name, 'Shell'] : [name],
    ),
  );
  await sections.getByRole('button', { name: 'Shell', exact: true }).click();
  await expect(page.getByText('保存在服务端，只对这台电脑生效。')).toBeVisible();
  const choice = page.getByLabel('偏好的 Shell', { exact: true });
  await expect(choice).toHaveValue('');
  await expect(choice.locator('option')).toHaveText(['不指定', 'PowerShell 7', 'Git Bash']);
  await expect(page.getByText(/没有检测到 Git Bash/)).toHaveCount(0);
  await choice.selectOption('bash');
  await expect(choice).toHaveValue('bash');
  await choice.selectOption('');
  await expect(choice).toHaveValue('');
  expect(chosen).toEqual(['bash', null]);
  mkdirSync(resolve(shots, 'browser'), { recursive: true });
  await page.screenshot({ path: resolve(shots, 'shell.png') });
});

// This computer's pages as the desktop client shows them. It connects through its own tunnel, so to the simulated
// service, which keeps none of the service's settings.
test('Electron: this computer’s settings as the desktop client shows them', async () => {
  test.skip(process.platform !== 'win32', 'Windows desktop');
  test.slow();
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env))
    if (value !== undefined && name !== 'ELECTRON_RUN_AS_NODE') env[name] = value;
  const profile = resolve('.local/ui-test/profile-settings-layout');
  rmSync(profile, { recursive: true, force: true });
  const application = await _electron.launch({
    args: [resolve('apps/desktop'), '--smoke-test', `--user-data-dir=${profile}`],
    env,
  });
  try {
    const page = await application.firstWindow();
    await expect(page.getByRole('heading', { name: '连接代理服务', exact: true })).toBeVisible();
    await login(page);
    await picture(
      page,
      resolve(shots, 'desktop'),
      every.filter((name) => !['上下文与缓存', '浏览器访问'].includes(name)),
      ['常规', '外观', '连接', '通知', '快捷键'],
    );
  } finally {
    await application.close();
  }
});
