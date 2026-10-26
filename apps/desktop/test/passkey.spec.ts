import { expect, test } from '@playwright/test';
import type { Page, WebSocketRoute } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import { Passkeys } from '../../server/src/passkeys.ts';
import { DomainError } from '../../server/src/errors.ts';

const origin = 'https://web.example.test:1443';
const entry = `${origin}/entry/`;
const rpID = 'web.example.test';
const passkeyEntry = { rpId: rpID, origin };
const address = '127.0.0.1';

// Mock transport only: Chromium creates credentials; the application's service owns their lifecycle.
async function fixture(
  page: Page,
  {
    loggedIn = false,
    userVerification = true,
    passkeyAvailable = true,
    settingsFail = false,
  }: {
    loggedIn?: boolean;
    userVerification?: boolean;
    passkeyAvailable?: boolean;
    settingsFail?: boolean;
  } = {},
) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: userVerification,
      isUserVerified: userVerification,
      automaticPresenceSimulation: true,
    },
  });
  await page.addInitScript(() => {
    const create = navigator.credentials.create.bind(navigator.credentials);
    const get = navigator.credentials.get.bind(navigator.credentials);
    let getCalls = 0;
    navigator.credentials.create = (options) => {
      document.documentElement.dataset.createVerification =
        options?.publicKey?.authenticatorSelection?.userVerification;
      return create(options);
    };
    navigator.credentials.get = (options) => {
      document.documentElement.dataset.getCalls = String(++getCalls);
      document.documentElement.dataset.getVerification = options?.publicKey?.userVerification;
      return get(options);
    };
  });
  const db = new DatabaseSync(':memory:');
  page.once('close', () => db.close());
  let offset = 0;
  const keys = new Passkeys(db, 'test-token-hash', randomUUID(), () => Date.now() + offset);
  let authenticated = loggedIn;
  let passkeySession = false;
  let optionsGate: { kind: string; ready: Promise<void> } | undefined;
  const requests: string[] = [];
  const verified: string[] = [];
  const commands: string[] = [];
  const sockets: WebSocketRoute[] = [];
  const sessionId = randomUUID();
  const serverDeviceId = randomUUID();
  const now = new Date().toISOString();
  const session = {
    id: sessionId,
    name: '测试浏览器',
    createdAt: now,
    lastActiveAt: now,
    expiresAt: new Date(Date.now() + 7200000).toISOString(),
  };
  const loginState = () => ({
    authenticated,
    totpEnabled: true,
    selfSigned: true,
    passkeyAvailable: keys.list(rpID).length > 0,
    ...(authenticated ? { session } : {}),
  });
  const settings = () => ({
    enabled: true,
    domain: rpID,
    path: 'entry',
    idleMinutes: 120,
    proxyEnabled: false,
    trustedProxies: [],
    totpEnabled: true,
    selfSigned: true,
    passkeyAvailable,
    ...(!passkeyAvailable ? { passkeyReason: '请先设置 HTTPS 访问域名。' } : {}),
    passkeys: keys.list(rpID),
    sessions: [session],
    url: entry,
  });
  const validCredential = (proof: { password?: string; code?: string }) =>
    proof.password === 'test-password' && proof.code === '123456';
  const validProof = (proof: { password?: string; code?: string; passkey?: string }) => {
    if (!proof.passkey) return validCredential(proof);
    expect(proof).toEqual({ passkey: expect.any(String) });
    keys.consumeProof(proof.passkey, sessionId);
    return true;
  };
  await page.route(`${origin}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname.slice('/entry/'.length);
    if (!path.startsWith('api/'))
      return route.fulfill({ path: resolve('apps/desktop/dist', path || 'index.html') });
    const name = path.slice('api/'.length);
    requests.push(name);
    if (name === 'session') return route.fulfill({ json: loginState() });
    const body = route.request().postDataJSON();
    if (name === 'login') {
      if (!validCredential(body))
        return route.fulfill({ status: 401, json: { error: '凭据或动态码不正确。' } });
      authenticated = true;
      passkeySession = false;
      return route.fulfill({ json: loginState() });
    }
    if (name === 'logout') {
      authenticated = false;
      keys.revokeSession(sessionId);
      return route.fulfill({ json: loginState() });
    }
    const kind = name.split('/')[1];
    if (!['register', 'login', 'proof'].includes(kind)) return route.fulfill({ status: 404 });
    if (kind !== 'login' && !authenticated)
      return route.fulfill({ status: 401, json: { error: '请先登录。' } });
    const ceremony = kind as 'register' | 'login' | 'proof';
    const ownSession = ceremony === 'login' ? undefined : sessionId;
    try {
      if (name.endsWith('/cancel')) {
        keys.cancel(body.challengeId, ceremony, passkeyEntry, ownSession);
        return route.fulfill({ json: { cancelled: true } });
      }
      if (name.endsWith('/options')) {
        if (ceremony === 'register') expect(body).toEqual({ name: expect.any(String) });
        const options =
          ceremony === 'register'
            ? await keys.registrationOptions(body.name, sessionId, passkeyEntry, address)
            : await keys.authenticationOptions(ceremony, passkeyEntry, address, ownSession);
        if (optionsGate?.kind === ceremony) await optionsGate.ready;
        return route.fulfill({ json: options });
      }
      if (name.endsWith('/verify')) {
        if (ceremony === 'register') {
          const id = await keys.register(body.challengeId, body.response, passkeyEntry, sessionId);
          verified.push(ceremony);
          return route.fulfill({ json: { registered: true, id } });
        }
        const result = await keys.authenticate(
          ceremony,
          body.challengeId,
          body.response,
          passkeyEntry,
          ownSession,
          () => {
            verified.push(ceremony);
            if (ceremony === 'proof') return keys.proof(sessionId);
            authenticated = true;
            passkeySession = true;
            return loginState();
          },
        );
        return route.fulfill({ json: result });
      }
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      return route.fulfill({ status: 400, json: { error: error.message, code: error.code } });
    }
    return route.fulfill({ status: 404 });
  });
  await page.routeWebSocket(`${entry.replace(/^http/, 'ws')}api/ws`, (socket) => {
    sockets.push(socket);
    socket.onMessage((raw) => {
      const command = JSON.parse(String(raw));
      commands.push(command.type);
      if (command.type === 'web.auth') {
        socket.send(
          JSON.stringify({
            type: 'ready',
            protocolVersion: PROTOCOL_VERSION,
            version: '0.3.6',
            connectionId: randomUUID(),
            adapter: 'claude-code',
            sessions: [],
            browser: { sessionId, serverDeviceId, selfSigned: true },
          }),
        );
        return;
      }
      if (['web.passkeys.rename', 'web.passkeys.remove'].includes(command.type)) {
        expect(validProof(command.proof)).toBe(true);
        if (command.type === 'web.passkeys.rename') keys.rename(command.passkeyId, command.name);
        else keys.remove(command.passkeyId);
      }
      if (command.type === 'web.settings.get' && settingsFail) {
        socket.send(
          JSON.stringify({
            type: 'response',
            requestId: command.requestId,
            ok: false,
            message: '读取设置失败，请重试。',
          }),
        );
        return;
      }
      if (['web.settings.get', 'web.passkeys.rename', 'web.passkeys.remove'].includes(command.type))
        socket.send(
          JSON.stringify({
            type: 'web.settings.state',
            requestId: command.requestId,
            values: settings(),
          }),
        );
      if (command.requestId)
        socket.send(JSON.stringify({ type: 'response', requestId: command.requestId, ok: true }));
      if (command.type === 'web.passkeys.remove' && passkeySession) {
        authenticated = false;
        for (const own of sockets) own.close({ code: 4001, reason: 'Browser session ended' });
      }
    });
  });
  return {
    requests,
    commands,
    verified,
    advance: (ms: number) => {
      offset += ms;
    },
    pauseOptions: (kind: 'login' | 'register') => {
      let release!: () => void;
      optionsGate = { kind, ready: new Promise<void>((resolve) => (release = resolve)) };
      return () => {
        release();
        optionsGate = undefined;
      };
    },
    setSettingsFailure: (fail: boolean) => {
      settingsFail = fail;
    },
  };
}

async function login(page: Page) {
  await page.getByLabel('服务凭据', { exact: true }).fill('test-password');
  await page.getByLabel('验证器动态码', { exact: true }).fill('123456');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('.shell')).toBeVisible();
}

async function prepare(page: Page) {
  await page.getByLabel('名称', { exact: true }).fill('旅行备用');
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  await expect(page.getByRole('button', { name: '创建通行密钥', exact: true })).toBeEnabled();
}

async function addAndLogout(page: Page) {
  await page.goto(`${entry}#passkeys`);
  await prepare(page);
  await page.getByRole('button', { name: '创建通行密钥', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: '设置与账号', exact: true }).click();
  await page.getByRole('menuitem', { name: '退出登录', exact: true }).click();
  await expect(page.getByLabel('服务凭据', { exact: true })).toBeVisible();
}

test('the add link waits for login, then opens registration in the browser to create and manage its Passkey', async ({
  page,
}, testInfo) => {
  const { requests, commands, verified } = await fixture(page);
  await page.goto(`${entry}#passkeys`);
  await expect(page.getByLabel('服务凭据', { exact: true })).toBeVisible();
  expect(requests).toEqual(['session']);
  await expect(page).toHaveURL(`${entry}#passkeys`);
  await expect(page.getByRole('note')).toContainText('自签名证书');
  await login(page);
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('名称', { exact: true })).toHaveValue('日常使用');
  await expect(dialog.locator('input')).toHaveCount(1);
  await expect(page).toHaveURL(entry);
  expect(requests).not.toContain('passkey/register/options');
  await expect(page.locator('html')).not.toHaveAttribute('data-create-verification');
  await page.screenshot({ path: testInfo.outputPath('add-passkey-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath('add-passkey-mobile.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1280, height: 900 });
  await dialog.getByLabel('名称', { exact: true }).fill('旅行备用');
  await dialog.getByRole('button', { name: '下一步', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '创建通行密钥', exact: true })).toBeEnabled();
  expect(requests).not.toContain('passkey/register/verify');
  await page.getByRole('button', { name: '创建通行密钥', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('html')).toHaveAttribute('data-create-verification', 'preferred');
  await expect(page.getByRole('button', { name: '重命名 旅行备用' })).toBeVisible();
  expect(requests.filter((name) => name === 'passkey/register/verify')).toHaveLength(1);
  await page.getByRole('button', { name: '设置与账号', exact: true }).click();
  await page.getByRole('menuitem', { name: '退出登录', exact: true }).click();
  await expect(page.getByRole('button', { name: '使用通行密钥登录' })).toBeVisible();
  await page.getByRole('button', { name: '使用通行密钥登录' }).click();
  await expect(page.locator('.shell')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-get-verification', 'preferred');
  await page.goto(`${entry}#passkeys`);
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '重命名 旅行备用' }).click();
  await page.getByLabel('名称', { exact: true }).fill('日常使用');
  await page.getByRole('button', { name: '改用通行密钥验证' }).click();
  await page.getByRole('button', { name: '验证通行密钥', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('已通过通行密钥验证');
  await expect(page.locator('html')).toHaveAttribute('data-get-verification', 'preferred');
  await page.getByRole('button', { name: '确认', exact: true }).click();
  await expect(page.getByRole('button', { name: '重命名 日常使用' })).toBeVisible();
  await page.getByRole('button', { name: '删除 日常使用' }).click();
  await page.getByRole('button', { name: '改用通行密钥验证' }).click();
  await page.getByRole('button', { name: '验证通行密钥', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('已通过通行密钥验证');
  await page.getByRole('button', { name: '确认', exact: true }).click();
  await expect(page.getByLabel('服务凭据', { exact: true })).toBeVisible();
  expect(requests).toContain('passkey/login/verify');
  expect(commands).toContain('web.passkeys.remove');
  expect(verified).toEqual(['register', 'login', 'proof', 'proof']);
});

test('an authenticated add link opens only for a new navigation, not after cancel or reload', async ({
  page,
}) => {
  const { requests } = await fixture(page, { loggedIn: true });
  await page.goto(`${entry}#passkeys`);
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page).toHaveURL(entry);
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.reload();
  await expect(page.locator('.shell')).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.evaluate(() => {
    location.hash = '#passkeys';
  });
  await expect(page.locator('#passkeys')).toHaveAttribute('open', '');
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page).toHaveURL(entry);
  expect(requests).not.toContain('passkey/register/options');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('the add link waits for a failed settings read to be retried', async ({ page }) => {
  const { requests, setSettingsFailure } = await fixture(page, {
    loggedIn: true,
    settingsFail: true,
  });
  await page.goto(`${entry}#passkeys`);
  await expect(page.getByRole('alert')).toContainText('读取设置失败');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page).toHaveURL(`${entry}#passkeys`);
  setSettingsFailure(false);
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page).toHaveURL(entry);
  expect(requests).not.toContain('passkey/register/options');
});

test('a successful registration retries a failed settings read without creating another credential', async ({
  page,
}) => {
  const { requests, verified, setSettingsFailure } = await fixture(page, { loggedIn: true });
  await page.goto(`${entry}#passkeys`);
  await prepare(page);
  setSettingsFailure(true);
  await page.getByRole('button', { name: '创建通行密钥', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('读取设置失败');
  await expect(page.getByRole('status')).toContainText('通行密钥已创建');
  setSettingsFailure(false);
  await page.getByRole('button', { name: '重新读取', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '重命名 旅行备用', exact: true })).toBeVisible();
  expect(verified).toEqual(['register']);
  expect(requests.filter((name) => name === 'passkey/register/options')).toHaveLength(1);
  expect(requests.filter((name) => name === 'passkey/register/verify')).toHaveLength(1);
});

test('expired proof clears its success state and requires new verification before a sensitive command', async ({
  page,
}, testInfo) => {
  const { advance, commands } = await fixture(page, { loggedIn: true });
  await page.clock.install();
  await page.goto(`${entry}#passkeys`);
  await prepare(page);
  await page.getByRole('button', { name: '创建通行密钥', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: '重命名 旅行备用', exact: true }).click();
  await page.getByLabel('名称', { exact: true }).fill('日常使用');
  await page.getByRole('button', { name: '改用通行密钥验证', exact: true }).click();
  const verify = page.getByRole('button', { name: '验证通行密钥', exact: true });
  await verify.click();
  await expect(page.getByText('已通过通行密钥验证', { exact: true })).toBeVisible();
  advance(60001);
  await page.clock.fastForward(60001);
  await expect(page.getByText('已通过通行密钥验证', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('alert')).toContainText('过期');
  await page
    .getByRole('dialog')
    .screenshot({ path: testInfo.outputPath('expired-proof-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('expired-proof-mobile.png') });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole('button', { name: '确认', exact: true }).click();
  expect(commands).not.toContain('web.passkeys.rename');
  await verify.click();
  await expect(page.getByText('已通过通行密钥验证', { exact: true })).toBeVisible();
  // A suspended tab can miss the timer; submitting still must not send an expired proof.
  advance(60001);
  await page.clock.setSystemTime(new Date((await page.evaluate(() => Date.now())) + 60001));
  await page.getByRole('button', { name: '确认', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('过期');
  expect(commands).not.toContain('web.passkeys.rename');
  await page.getByRole('button', { name: '重新验证', exact: true }).click();
  await verify.click();
  await expect(page.getByText('已通过通行密钥验证', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '确认', exact: true }).click();
  await expect(page.getByRole('button', { name: '重命名 日常使用', exact: true })).toBeVisible();
  expect(commands.filter((name) => name === 'web.passkeys.rename')).toHaveLength(1);
});

test('the add link respects an unavailable service instead of opening registration', async ({
  page,
}) => {
  const { requests } = await fixture(page, { loggedIn: true, passkeyAvailable: false });
  await page.goto(`${entry}#passkeys`);
  await expect(page.getByText('请先设置 HTTPS 访问域名。', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '添加通行密钥', exact: true })).toBeDisabled();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page).toHaveURL(entry);
  expect(requests).not.toContain('passkey/register/options');
});

test('registration accepts an authenticator without UV within a logged-in browser session', async ({
  page,
}) => {
  const { verified } = await fixture(page, { loggedIn: true, userVerification: false });
  await page.goto(`${entry}#passkeys`);
  await prepare(page);
  await page.getByRole('button', { name: '创建通行密钥', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('html')).toHaveAttribute('data-create-verification', 'preferred');
  expect(verified).toEqual(['register']);
});

test('a logged-in browser with TOTP prepares another Passkey using only a name', async ({
  page,
}, testInfo) => {
  const { requests, verified } = await fixture(page, { loggedIn: true });
  await page.goto(`${entry}#passkeys`);
  await prepare(page);
  await page.getByRole('button', { name: '创建通行密钥', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(verified).toEqual(['register']);
  await page.getByRole('button', { name: '添加通行密钥', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const name = dialog.getByLabel('名称', { exact: true });
  const next = dialog.getByRole('button', { name: '下一步', exact: true });
  await expect(dialog.getByRole('button', { name: '改用通行密钥验证' })).toHaveCount(0);
  await expect(dialog.getByLabel('服务凭据', { exact: true })).toHaveCount(0);
  await expect(dialog.getByLabel('当前验证器动态码', { exact: true })).toHaveCount(0);
  await expect(dialog.locator('input')).toHaveCount(1);
  await dialog.screenshot({ path: testInfo.outputPath('session-registration-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath('session-registration-mobile.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1280, height: 900 });
  await name.fill('');
  await next.click();
  await expect(name).toBeFocused();
  expect(requests.filter((name) => name === 'passkey/register/options')).toHaveLength(1);
  await name.fill('备用设备');
  await next.click();
  await expect(dialog.getByRole('button', { name: '创建通行密钥', exact: true })).toBeEnabled();
  expect(requests).not.toContain('passkey/proof/options');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect
    .poll(() => requests.filter((name) => name === 'passkey/register/cancel').length)
    .toBeGreaterThan(0);
});

test('repeated system-prompt cancellation releases pending capacity and never retries automatically', async ({
  page,
}) => {
  const { requests } = await fixture(page, { loggedIn: true });
  await page.addInitScript(() => {
    const original = navigator.credentials.create.bind(navigator.credentials);
    let calls = 0;
    navigator.credentials.create = (options) => {
      document.documentElement.dataset.createCalls = String(++calls);
      if (calls <= 5) return Promise.reject(new DOMException('Cancelled', 'NotAllowedError'));
      return original(options);
    };
  });
  await page.goto(`${entry}#passkeys`);
  await prepare(page);
  await expect(page.locator('html')).not.toHaveAttribute('data-create-calls');
  for (let attempt = 1; attempt <= 5; attempt++) {
    await page.getByRole('button', { name: '创建通行密钥', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('取消');
    await expect(page.locator('html')).toHaveAttribute('data-create-calls', String(attempt));
    expect(requests).not.toContain('passkey/register/verify');
    await page.getByRole('button', { name: '下一步', exact: true }).click();
    await expect(page.getByRole('button', { name: '创建通行密钥', exact: true })).toBeEnabled();
    await expect(page.locator('html')).toHaveAttribute('data-create-calls', String(attempt));
  }
  await page.getByRole('button', { name: '创建通行密钥', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('html')).toHaveAttribute('data-create-calls', '6');
});

test('credential-login failures retain the prepared Passkey instead of filling pending capacity', async ({
  page,
}) => {
  const { requests } = await fixture(page, { loggedIn: true });
  await addAndLogout(page);
  const passkey = page.getByRole('button', { name: '使用通行密钥登录', exact: true });
  await expect(passkey).toBeEnabled();
  const prepared = requests.filter((name) => name === 'passkey/login/options').length;
  await page.getByLabel('服务凭据', { exact: true }).fill('wrong-password');
  await page.getByLabel('验证器动态码', { exact: true }).fill('123456');
  for (let attempt = 0; attempt < 5; attempt++) {
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('凭据或动态码不正确');
    await expect(page.getByRole('button', { name: '登录', exact: true })).toBeEnabled();
  }
  expect(requests.filter((name) => name === 'passkey/login/options')).toHaveLength(prepared);
  await passkey.click();
  await expect(page.locator('.shell')).toBeVisible();
});

test('expired login preparation never opens the authenticator and re-preparation needs a new click', async ({
  page,
}) => {
  const { advance, requests } = await fixture(page, { loggedIn: true });
  await page.clock.install();
  await addAndLogout(page);
  await expect(page.getByRole('button', { name: '使用通行密钥登录', exact: true })).toBeEnabled();
  advance(300001);
  await page.clock.fastForward(300001);
  const retry = page.getByRole('button', { name: '重新准备通行密钥', exact: true });
  await expect(retry).toBeEnabled();
  await expect(page.locator('html')).not.toHaveAttribute('data-get-calls');
  expect(requests).not.toContain('passkey/login/verify');
  await retry.click();
  const login = page.getByRole('button', { name: '使用通行密钥登录', exact: true });
  await expect(login).toBeEnabled();
  await expect(page.locator('html')).not.toHaveAttribute('data-get-calls');
  // A suspended tab can miss its expiry timer; the click must still reject stale options.
  advance(300001);
  await page.clock.setSystemTime(new Date((await page.evaluate(() => Date.now())) + 300001));
  await login.click();
  await expect(page.getByRole('alert')).toContainText('过期');
  await expect(page.locator('html')).not.toHaveAttribute('data-get-calls');
  await expect(login).toBeEnabled();
  await login.click();
  await expect(page.locator('.shell')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-get-calls', '1');
});

test('login options arriving after credential login are retired instead of retained by a disposed form', async ({
  page,
}) => {
  const { requests, pauseOptions } = await fixture(page, { loggedIn: true });
  const release = pauseOptions('login');
  await addAndLogout(page);
  await expect.poll(() => requests.includes('passkey/login/options')).toBe(true);
  await login(page);
  release();
  await expect.poll(() => requests.includes('passkey/login/cancel')).toBe(true);
  await expect(page.locator('html')).not.toHaveAttribute('data-get-calls');
});

test('registration options failure is retryable without showing a system prompt', async ({
  page,
}) => {
  const { requests } = await fixture(page, { loggedIn: true });
  await page.route(
    `${entry}api/passkey/register/options`,
    (route) =>
      route.fulfill({
        status: 503,
        json: { error: '暂时未能创建验证请求。' },
      }),
    { times: 1 },
  );
  await page.goto(`${entry}#passkeys`);
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('暂时未能创建');
  expect(requests).not.toContain('passkey/register/verify');
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  await expect(page.getByRole('button', { name: '创建通行密钥', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(requests).not.toContain('passkey/register/verify');
});

test('a browser without WebAuthn keeps credential and TOTP login and the certificate warning', async ({
  page,
}) => {
  const { requests } = await fixture(page);
  await page.addInitScript(() => {
    Object.defineProperty(window, 'PublicKeyCredential', { configurable: true, value: undefined });
  });
  await page.goto(`${entry}#passkeys`);
  await login(page);
  await expect(page.getByRole('note')).toContainText('自签名证书');
  await expect(page.getByText('当前浏览器不支持通行密钥', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: '添加通行密钥', exact: true })).toBeDisabled();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page).toHaveURL(entry);
  expect(requests).not.toContain('passkey/register/options');
});
