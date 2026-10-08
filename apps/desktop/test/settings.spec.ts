import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import type { NativeSettings } from '@cc-desk-tunnel/protocol';

test('Claude Code settings load from the service and save each change at once', async ({
  page,
}) => {
  const values: NativeSettings = {
    autoCompactEnabled: null,
    autoCompactWindow: 250_000,
    alwaysThinkingEnabled: null,
    fastMode: false,
    autoContinueAtUsageLimit: null,
    switchModelsOnFlag: null,
    autoMemoryEnabled: null,
    fileCheckpointingEnabled: null,
    promptCacheTtl: null,
    language: null,
    precomputeCompactionEnabled: null,
    autoDreamEnabled: null,
    subagentPromptCacheTtl: null,
    fallbackModel: null,
    askUserQuestionTimeout: null,
    bashOutputMaxChars: 45_000,
    attribution: null,
    includeGitInstructions: null,
  };
  const updates: unknown[] = [];
  await page.routeWebSocket('ws://127.0.0.1:18889/ws', (route) => {
    const send = (value: unknown) => route.send(JSON.stringify(value));
    route.onMessage((raw) => {
      const message = JSON.parse(String(raw));
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
      if (message.type === 'settings.update') {
        updates.push(message.values);
        Object.assign(values, message.values);
      }
      if (message.type.startsWith('settings.'))
        send({ type: 'settings.state', requestId: message.requestId, values });
      send({ type: 'response', requestId: message.requestId, ok: true });
    });
  });
  await page.goto('/');
  await page.getByLabel('服务地址', { exact: true }).fill('ws://127.0.0.1:18889/ws');
  await page
    .getByLabel('服务凭据', { exact: true })
    .fill('test-only-settings-token-with-enough-length');
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await page.getByRole('button', { name: '设置与账号', exact: true }).click();
  await page.getByRole('menuitem', { name: '设置', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Claude Code 设置' });
  await expect(panel.getByLabel('自动压缩窗口', { exact: true })).toHaveValue('250000');
  await expect(panel.getByLabel('快速模式', { exact: true })).toHaveValue('false');
  await panel.getByLabel('自动压缩窗口', { exact: true }).selectOption('1000000');
  await panel.getByLabel('额度用尽后自动继续', { exact: true }).selectOption('true');
  await panel.getByLabel('快速模式', { exact: true }).selectOption('');
  await panel.getByLabel('回复语言', { exact: true }).fill('chinese');
  await panel.getByLabel('回复语言', { exact: true }).press('Enter');
  // A value set by hand that is not among the choices is still shown.
  await expect(panel.getByLabel('命令输出上限', { exact: true })).toHaveValue('45000');
  await panel.getByLabel('提交与 PR 的署名', { exact: true }).selectOption('false');
  await panel.getByLabel('备用模型', { exact: true }).fill('sonnet， haiku');
  await panel.getByLabel('备用模型', { exact: true }).press('Enter');
  await expect(panel.getByLabel('备用模型', { exact: true })).toHaveValue('sonnet, haiku');
  await panel.getByLabel('提问无人回答时', { exact: true }).selectOption('5m');
  await panel.getByLabel('备用模型', { exact: true }).fill('');
  await panel.getByLabel('备用模型', { exact: true }).press('Enter');
  await expect
    .poll(() => updates)
    .toEqual([
      { autoCompactWindow: 1_000_000 },
      { autoContinueAtUsageLimit: true },
      { fastMode: null },
      { language: 'chinese' },
      { attribution: false },
      { fallbackModel: ['sonnet', 'haiku'] },
      { askUserQuestionTimeout: '5m' },
      { fallbackModel: null },
    ]);
  await expect(panel.getByLabel('自动压缩窗口', { exact: true })).toHaveValue('1000000');
  await page.screenshot({ path: resolve('.local/screenshots/settings.png') });
});
