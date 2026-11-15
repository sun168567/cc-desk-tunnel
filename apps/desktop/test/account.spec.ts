import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import type { AccountState } from '@cc-desk-tunnel/protocol';
import { screenshots } from './helpers.ts';

test('setup token can be configured before any session, stays masked, and ordinary browser login still works after logout', async ({
  page,
}) => {
  let account: AccountState = { loggedIn: false, authMethod: 'none', login: null };
  const received: { type: string; token?: string; code?: string; method?: string }[] = [];
  let failSave = true;
  await page.routeWebSocket('ws://127.0.0.1:18921/ws', (route) => {
    const reply = (value: unknown) => route.send(JSON.stringify(value));
    route.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === 'device') return;
      if (message.type === 'auth') {
        reply({
          type: 'ready',
          protocolVersion: PROTOCOL_VERSION,
          version: '0.3.14',
          connectionId: randomUUID(),
          adapter: 'claude-code',
          sessions: [],
        });
        return;
      }
      if (message.type.startsWith('account.')) received.push(message);
      if (message.type === 'account.token') {
        if (failSave) {
          reply({
            type: 'response',
            requestId: message.requestId,
            ok: false,
            message: '测试保存失败',
          });
          return;
        }
        account = { loggedIn: true, authMethod: 'oauth_token', login: null };
      }
      if (message.type === 'account.logout')
        account = { loggedIn: false, authMethod: 'none', login: null };
      if (message.type === 'account.login')
        account = {
          ...account,
          login: { url: 'https://claude.ai/oauth/authorize?test=fixture', method: message.method },
        };
      if (message.type === 'account.code') {
        if (account.login?.method === 'setup-token')
          reply({ type: 'account.token.created', token: 'generated-token-fixture', saved: true });
        account =
          account.login?.method === 'setup-token'
            ? { loggedIn: true, authMethod: 'oauth_token', login: null }
            : {
                loggedIn: true,
                authMethod: 'claude.ai',
                email: 'fixture@example.invalid',
                login: null,
              };
      }
      if (message.type.startsWith('account.')) reply({ type: 'account.state', ...account });
      reply({ type: 'response', requestId: message.requestId, ok: true });
    });
  });
  await page.goto('/');
  await page.getByLabel('服务地址', { exact: true }).fill('ws://127.0.0.1:18921/ws');
  await page.getByLabel('服务凭据', { exact: true }).fill('test-only-account-connection-token');
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await page.getByRole('button', { name: '设置与账号', exact: true }).click();
  await page.getByRole('menuitem', { name: '设置', exact: true }).click();
  await page
    .getByRole('navigation', { name: '设置分类' })
    .getByRole('button', { name: '账号与额度', exact: true })
    .click();
  await expect(page.getByRole('button', { name: '普通登录', exact: true })).toBeVisible();
  await page.screenshot({ path: resolve(screenshots, 'account-login-options.png') });
  await page.getByRole('button', { name: 'Setup token 登录', exact: true }).click();
  const form = page.getByRole('form', { name: '使用 setup token', exact: true });
  const token = form.getByLabel('Setup token', { exact: true });
  await expect(token).toHaveAttribute('type', 'password');
  await token.fill('cancelled-token');
  await form.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: 'Setup token 登录', exact: true }).click();
  await expect(token).toHaveValue('');
  await token.fill('test-only-setup-token');
  await page.screenshot({ path: resolve(screenshots, 'setup-token-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: resolve(screenshots, 'setup-token-narrow.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await form.getByRole('button', { name: '保存并使用', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('测试保存失败');
  await expect(token).toHaveValue('test-only-setup-token');
  failSave = false;
  await form.getByRole('button', { name: '保存并使用', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Setup token 已配置', exact: true }),
  ).toBeVisible();
  await expect(form).toHaveCount(0);
  expect(
    received.filter((item) => item.type === 'account.token').map((item) => item.token),
  ).toEqual(['test-only-setup-token', 'test-only-setup-token']);
  expect(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]))).not.toContain(
    'test-only-setup-token',
  );
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  const confirm = page.getByRole('group', { name: '确认退出登录', exact: true });
  await expect(confirm).toContainText('移除服务端保存的 setup token');
  await confirm.getByRole('button', { name: '退出登录', exact: true }).click();
  await page.getByRole('button', { name: 'Setup token 登录', exact: true }).click();
  await page.getByRole('button', { name: '生成 setup token', exact: true }).click();
  const generated = page.getByRole('form', { name: '登录 Claude 账号', exact: true });
  await expect(generated).toContainText('正在通过服务端生成 setup token');
  await generated.getByLabel('授权码', { exact: true }).fill('generated#fixture-state');
  await generated.getByRole('button', { name: '完成登录', exact: true }).click();
  const tokenDialog = page.getByRole('dialog');
  await expect(
    tokenDialog.getByRole('heading', { name: 'Setup token 已生成', exact: true }),
  ).toBeVisible();
  await expect(tokenDialog.getByLabel('生成的 setup token')).toHaveValue('generated-token-fixture');
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await tokenDialog.getByRole('button', { name: '复制 token', exact: true }).click();
  await expect(tokenDialog.getByRole('button', { name: '已复制', exact: true })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('generated-token-fixture');
  expect(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]))).not.toContain(
    'generated-token-fixture',
  );
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: resolve(screenshots, 'setup-token-created.png') });
  await tokenDialog.getByRole('button', { name: '关闭', exact: true }).last().click();
  await expect(tokenDialog).toHaveCount(0);
  await page
    .getByRole('navigation', { name: '设置分类' })
    .getByRole('button', { name: 'CLI 设置', exact: true })
    .click();
  await page
    .getByRole('navigation', { name: '设置分类' })
    .getByRole('button', { name: '账号与额度', exact: true })
    .click();
  await expect(page.getByLabel('生成的 setup token')).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: 'Setup token 已配置', exact: true }),
  ).toBeVisible();
  expect(
    received.some((item) => item.type === 'account.login' && item.method === 'setup-token'),
  ).toBe(true);
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await confirm.getByRole('button', { name: '退出登录', exact: true }).click();
  await page.getByRole('button', { name: '普通登录', exact: true }).click();
  const login = page.getByRole('form', { name: '登录 Claude 账号', exact: true });
  await expect(login.getByRole('button', { name: '打开授权页', exact: true })).toBeVisible();
  await login.getByLabel('授权码', { exact: true }).fill('code#fixture-state');
  await login.getByRole('button', { name: '完成登录', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'fixture@example.invalid', exact: true }),
  ).toBeVisible();
  expect(received.filter((item) => item.type === 'account.code').map((item) => item.code)).toEqual([
    'generated#fixture-state',
    'code#fixture-state',
  ]);
});
