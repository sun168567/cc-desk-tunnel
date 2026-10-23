import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type { WebAuthnCredential } from '@simplewebauthn/server';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';

const secureOrigin = 'https://web.example.test';
const entry = `${secureOrigin}/entry/`;
const rpID = 'web.example.test';

// Exercise the shipped browser adapter with Chromium's authenticator and real signature verification.
// Only the transport is isolated; the WebAuthn ceremony and UV requirement are not replaced.
async function passkeyFixture(page: Page, origin = secureOrigin) {
  const entry = `${origin}/entry/`;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  let ceremonyRpID = rpID;
  let credential: WebAuthnCredential | undefined;
  let passkeyAvailable = false;
  let authenticated = false;
  let expired = false;
  let registrations = 0;
  let keyName = '旅行备用';
  let freshProof: unknown;
  let registrationStarts = 0;
  let failSettingsGet = false;
  let registrationOptionsRequests = 0;
  let expiresAt = new Date(Date.now() + 600000).toISOString();
  let optionsReady: Promise<void> = Promise.resolve();
  let releaseOptions = () => {};
  let verificationReady: Promise<void> = Promise.resolve();
  let releaseVerification = () => {};
  const challenges = new Map<string, { value: string; kind: string }>();
  const sessionId = randomUUID();
  const serverDeviceId = randomUUID();
  const passkeyId = randomUUID();
  const now = new Date().toISOString();
  const session = {
    id: sessionId,
    name: '测试浏览器',
    createdAt: now,
    lastActiveAt: now,
    expiresAt: new Date(Date.now() + 7200000).toISOString(),
  };
  const state = () => ({
    authenticated,
    passkeyAvailable: !!credential || passkeyAvailable,
    totpEnabled: true,
    ...(authenticated ? { session } : {}),
  });
  const requests: string[] = [];
  await page.route(`${origin}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname.slice('/entry/'.length);
    if (!path.startsWith('api/'))
      return route.fulfill({ path: resolve('apps/desktop/dist', path || 'index.html') });
    const name = path.slice('api/'.length);
    requests.push(name);
    if (name === 'session') return route.fulfill({ json: state() });
    if (name === 'logout') {
      authenticated = false;
      return route.fulfill({ json: state() });
    }
    const body = route.request().postDataJSON();
    if (name.endsWith('/options')) {
      if (expired)
        return route.fulfill({ status: 410, json: { error: '授权已过期，请重新发起。' } });
      const challengeId = randomUUID();
      const kind = name.split('/')[1];
      if (kind === 'register') {
        registrationOptionsRequests++;
        for (const [id, challenge] of challenges)
          if (challenge.kind === 'register') challenges.delete(id);
      }
      const options =
        kind === 'register'
          ? await generateRegistrationOptions({
              rpName: 'CC Desk Tunnel',
              rpID: ceremonyRpID,
              userName: 'workbench',
              userID: new Uint8Array(32).fill(7),
              authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
            })
          : await generateAuthenticationOptions({
              rpID: ceremonyRpID,
              userVerification: 'required',
            });
      challenges.set(challengeId, { value: options.challenge, kind });
      await optionsReady;
      return route.fulfill({
        json: {
          challengeId,
          options,
          name: '旅行备用',
          expiresAt,
        },
      });
    }
    if (name.endsWith('/verify')) {
      const challenge = challenges.get(body.challengeId);
      expect(challenge).toBeDefined();
      challenges.delete(body.challengeId);
      if (challenge!.kind === 'register') {
        const result = await verifyRegistrationResponse({
          response: body.response,
          expectedChallenge: challenge!.value,
          expectedOrigin: origin,
          expectedRPID: rpID,
          requireUserVerification: true,
        });
        expect(result.verified).toBe(true);
        credential = result.registrationInfo!.credential;
        registrations++;
        await verificationReady;
        return route.fulfill({ json: { registered: true, id: passkeyId } });
      }
      const result = await verifyAuthenticationResponse({
        response: body.response,
        expectedChallenge: challenge!.value,
        expectedOrigin: origin,
        expectedRPID: rpID,
        credential: credential!,
        requireUserVerification: true,
      });
      expect(result.verified).toBe(true);
      credential!.counter = result.authenticationInfo.newCounter;
      if (challenge!.kind === 'proof') return route.fulfill({ json: { proof: 'p'.repeat(43) } });
      authenticated = true;
      return route.fulfill({ json: state() });
    }
    return route.fulfill({ status: 404, json: { error: '未找到接口。' } });
  });
  await page.routeWebSocket(`${entry.replace(/^http/, 'ws')}api/ws`, (socket) => {
    socket.onMessage((raw) => {
      const command = JSON.parse(String(raw));
      if (command.type === 'web.settings.get' && failSettingsGet) {
        failSettingsGet = false;
        socket.send(
          JSON.stringify({
            type: 'response',
            requestId: command.requestId,
            ok: false,
            code: 'read_failed',
            message: '读取失败，请重试。',
          }),
        );
        return;
      }
      if (command.type === 'web.passkeys.start') {
        registrationStarts++;
        keyName = command.name;
        socket.send(
          JSON.stringify({
            type: 'web.passkey.registration',
            requestId: command.requestId,
            registrationId: randomUUID(),
            status: 'pending',
            url: `${entry}#passkey-register=browser-grant`,
            expiresAt: new Date(Date.now() + 600000).toISOString(),
          }),
        );
        socket.send(JSON.stringify({ type: 'response', requestId: command.requestId, ok: true }));
        return;
      }
      if (command.type === 'web.auth')
        socket.send(
          JSON.stringify({
            type: 'ready',
            protocolVersion: PROTOCOL_VERSION,
            version: '0.3.6',
            connectionId: randomUUID(),
            adapter: 'claude-code',
            sessions: [],
            browser: { sessionId, serverDeviceId },
          }),
        );
      else if (command.type === 'web.settings.get' || command.type === 'web.passkeys.rename') {
        if (command.type === 'web.passkeys.rename') {
          keyName = command.name;
          freshProof = command.proof;
        }
        socket.send(
          JSON.stringify({
            type: 'web.settings.state',
            requestId: command.requestId,
            values: {
              enabled: true,
              domain: rpID,
              publicOrigin: new URL(entry).origin,
              path: 'entry',
              idleMinutes: 120,
              proxyEnabled: false,
              trustedProxies: [],
              totpEnabled: true,
              passkeyAvailable: true,
              passkeys: [
                { id: passkeyId, name: keyName, rpId: rpID, available: true, createdAt: now },
              ],
              sessions: [session],
              url: entry,
            },
          }),
        );
        socket.send(JSON.stringify({ type: 'response', requestId: command.requestId, ok: true }));
      } else if (command.requestId)
        socket.send(JSON.stringify({ type: 'response', requestId: command.requestId, ok: true }));
    });
  });
  return {
    requests,
    advertisePasskey: () => {
      passkeyAvailable = true;
    },
    useWrongRpId: () => {
      ceremonyRpID = 'unrelated.example.test';
    },
    registrationStarts: () => registrationStarts,
    failNextSettingsGet: () => {
      failSettingsGet = true;
    },
    freshProof: () => freshProof,
    registrations: () => registrations,
    registrationOptionsRequests: () => registrationOptionsRequests,
    setExpiry: (value: string) => {
      expiresAt = value;
    },
    authenticated: () => authenticated,
    expire: () => {
      expired = true;
    },
    holdOptions: () => {
      optionsReady = new Promise<void>((resolve) => {
        releaseOptions = resolve;
      });
    },
    releaseOptions: () => releaseOptions(),
    holdVerification: () => {
      verificationReady = new Promise<void>((resolve) => {
        releaseVerification = resolve;
      });
    },
    releaseVerification: () => releaseVerification(),
  };
}

test('an authorized page starts registration once while login still requires a user action', async ({
  page,
}) => {
  const fixture = await passkeyFixture(page);
  fixture.holdVerification();
  await page.goto(`${entry}#passkey-register=short-lived-authorization`);
  await expect(page.getByText('旅行备用', { exact: true })).toBeVisible();
  await expect(page).toHaveURL(entry);
  fixture.releaseVerification();
  await expect(page.getByRole('status')).toContainText('通行密钥已保存');
  expect(fixture.registrations()).toBe(1);
  expect(fixture.registrationOptionsRequests()).toBe(1);
  await expect(page.getByRole('button', { name: '创建通行密钥', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '取消验证', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(
    'short-lived-authorization',
  );
  await page.goto(entry);
  await expect(page.getByLabel('服务凭据', { exact: true })).toBeVisible();
  expect(fixture.requests).not.toContain('passkey/login/options');
  await page.getByRole('button', { name: '使用通行密钥登录' }).click();
  await expect(page.locator('.shell')).toBeVisible();
  expect(fixture.authenticated()).toBe(true);
  expect(fixture.requests).not.toContain('login');
  await page.getByRole('button', { name: '设置与账号', exact: true }).click();
  await page.getByRole('menuitem', { name: '设置', exact: true }).click();
  await page.locator('.web-passkeys summary').click();
  await page.getByRole('button', { name: '重命名 旅行备用' }).click();
  await page.getByLabel('名称', { exact: true }).fill('新的名称');
  await page.getByRole('button', { name: '改用通行密钥验证' }).click();
  await expect(page.getByLabel('服务凭据', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '确认', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(fixture.freshProof()).toEqual({ passkey: 'p'.repeat(43) });
  await expect(page.getByRole('button', { name: '重命名 新的名称' })).toBeVisible();
});

test('cancelled system verification stays on the authorization page and can be retried', async ({
  page,
}) => {
  const fixture = await passkeyFixture(page);
  await page.addInitScript(() => {
    const create = navigator.credentials.create.bind(navigator.credentials);
    let cancelled = false;
    navigator.credentials.create = async (options) => {
      if (!cancelled) {
        cancelled = true;
        throw new DOMException('User cancelled', 'NotAllowedError');
      }
      return create(options);
    };
  });
  await page.clock.install();
  await page.goto(`${entry}#passkey-register=short-lived-authorization`);
  await expect(page.getByRole('alert')).toContainText('创建未完成或已取消');
  await page.clock.runFor(60000);
  expect(fixture.registrations()).toBe(0);
  expect(fixture.registrationOptionsRequests()).toBe(1);
  await expect(page.getByRole('button', { name: '取消验证', exact: true })).toHaveCount(0);
  const retry = page.getByRole('button', { name: '重新创建', exact: true });
  await expect(retry).toBeVisible();
  await expect(retry).toBeEnabled();
  await retry.click();
  await expect(page.getByRole('status')).toContainText('通行密钥已保存');
  expect(fixture.registrations()).toBe(1);
  expect(fixture.registrationOptionsRequests()).toBe(2);
});

test('an expired registration never starts a system ceremony or reports a successful setting', async ({
  page,
}) => {
  const fixture = await passkeyFixture(page);
  fixture.expire();
  await page.goto(`${entry}#passkey-register=expired-authorization`);
  await expect(page.getByRole('alert')).toContainText('授权已过期');
  await expect(page.getByRole('button', { name: '重新创建', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '创建通行密钥', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '创建通行密钥', exact: true })).toBeDisabled();
  await expect(page.getByRole('heading', { name: '设置完成' })).toHaveCount(0);
  expect(fixture.registrations()).toBe(0);
});

test('the creation button stays visible but disabled until authorization details arrive', async ({
  page,
}) => {
  const fixture = await passkeyFixture(page);
  let releaseDescription = () => {};
  const descriptionReady = new Promise<void>((resolve) => {
    releaseDescription = resolve;
  });
  await page.route(
    `${entry}api/passkey/register/options`,
    async (route) => {
      await descriptionReady;
      await route.fallback();
    },
    { times: 1 },
  );
  await page.goto(`${entry}#passkey-register=loading-description`);
  const create = page.getByRole('button', { name: '创建通行密钥', exact: true });
  await expect(create).toBeVisible();
  await expect(create).toBeDisabled();
  await expect(page.getByRole('status')).toHaveText('正在读取授权请求…');
  await expect(page.getByRole('button', { name: '取消验证', exact: true })).toHaveCount(0);
  expect(fixture.registrationOptionsRequests()).toBe(0);
  releaseDescription();
  await expect(page.getByRole('status')).toContainText('通行密钥已保存');
  expect(fixture.registrations()).toBe(1);
  expect(fixture.registrationOptionsRequests()).toBe(1);
});

test('leaving while options are loading prevents a late system ceremony', async ({ page }) => {
  const fixture = await passkeyFixture(page);
  fixture.holdOptions();
  await page.goto(`${entry}#passkey-register=short-lived-authorization`);
  await expect(page.getByRole('status')).toHaveText('正在读取授权请求…');
  const waiting = page.getByRole('button', { name: '创建通行密钥', exact: true });
  await expect(waiting).toBeVisible();
  await expect(waiting).toBeDisabled();
  await expect.poll(() => fixture.registrationOptionsRequests()).toBe(1);
  await expect(page.getByRole('button', { name: '取消验证', exact: true })).toHaveCount(0);
  await page.goto(entry);
  fixture.releaseOptions();
  await expect(page.getByLabel('服务凭据', { exact: true })).toBeVisible();
  expect(fixture.registrations()).toBe(0);
  expect(fixture.requests).not.toContain('passkey/register/verify');
});

test('an authorization that expired before its details arrived never starts registration', async ({
  page,
}) => {
  const fixture = await passkeyFixture(page);
  fixture.setExpiry(new Date(Date.now() - 1000).toISOString());
  await page.goto(`${entry}#passkey-register=expired-in-transit`);
  await expect(page.getByRole('alert')).toHaveText('授权已过期，请返回客户端重新发起。');
  const create = page.getByRole('button', { name: '创建通行密钥', exact: true });
  await expect(create).toBeVisible();
  await expect(create).toBeDisabled();
  await expect(page.getByRole('button')).toHaveCount(1);
  expect(fixture.registrationOptionsRequests()).toBe(1);
  expect(fixture.registrations()).toBe(0);
});

test('expiry aborts a pending system prompt without automatically retrying', async ({ page }) => {
  const fixture = await passkeyFixture(page);
  const now = new Date();
  fixture.setExpiry(new Date(now.getTime() + 5000).toISOString());
  await page.clock.install({ time: now });
  await page.addInitScript(() => {
    navigator.credentials.create = (options) =>
      new Promise((_, reject) => {
        options!.signal!.addEventListener(
          'abort',
          () => {
            document.documentElement.dataset.ceremonyAborted = 'true';
            reject(new DOMException('Aborted', 'AbortError'));
          },
          { once: true },
        );
        document.documentElement.dataset.ceremonyStarted = 'true';
      });
  });
  await page.goto(`${entry}#passkey-register=expires-during-prompt`);
  await expect(page.locator('html')).toHaveAttribute('data-ceremony-started', 'true');
  await expect(page.getByRole('status')).toHaveText('等待系统验证…');
  await expect(page.getByRole('button', { name: '等待系统验证…', exact: true })).toBeDisabled();
  await page.clock.runFor(6000);
  await expect(page.locator('html')).toHaveAttribute('data-ceremony-aborted', 'true');
  await expect(page.getByRole('alert')).toHaveText('授权已过期，请返回客户端重新发起。');
  const create = page.getByRole('button', { name: '创建通行密钥', exact: true });
  await expect(create).toBeVisible();
  await expect(create).toBeDisabled();
  await expect(page.getByRole('button')).toHaveCount(1);
  expect(fixture.registrationOptionsRequests()).toBe(1);
  expect(fixture.requests).not.toContain('passkey/register/verify');
});

test('failed registration options can be reread and then start registration exactly once', async ({
  page,
}) => {
  const fixture = await passkeyFixture(page);
  await page.route(
    `${entry}api/passkey/register/options`,
    (route) =>
      route.fulfill({
        status: 503,
        json: { error: '暂时未能读取授权，请重试。' },
      }),
    { times: 1 },
  );
  await page.goto(`${entry}#passkey-register=retry-description`);
  await expect(page.getByRole('alert')).toContainText('暂时未能读取授权');
  await expect(page.getByRole('button', { name: '创建通行密钥', exact: true })).toBeDisabled();
  expect(fixture.registrations()).toBe(0);
  await page.getByRole('button', { name: '重新读取', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('通行密钥已保存');
  expect(fixture.registrations()).toBe(1);
  expect(fixture.registrationOptionsRequests()).toBe(1);
});

for (const width of [1280, 390])
  test(`registration waiting and retry remain usable at ${width}px`, async ({ page }, testInfo) => {
    await passkeyFixture(page);
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(() => {
      navigator.credentials.create = () =>
        new Promise((_, reject) => {
          window.addEventListener(
            'test-cancel-registration',
            () => reject(new DOMException('User cancelled', 'NotAllowedError')),
            { once: true },
          );
          document.documentElement.dataset.ceremonyStarted = 'true';
        });
    });
    await page.goto(`${entry}#passkey-register=layout-grant`);
    await expect(page.locator('html')).toHaveAttribute('data-ceremony-started', 'true');
    await expect(page.getByRole('status')).toHaveText('等待系统验证…');
    const waiting = page.getByRole('button', { name: '等待系统验证…', exact: true });
    await expect(waiting).toBeVisible();
    await expect(waiting).toBeDisabled();
    await expect(waiting.getByRole('status')).toHaveText('等待系统验证…');
    await expect(page.getByRole('button')).toHaveCount(1);
    await page.screenshot({ path: testInfo.outputPath('waiting.png') });
    await page.evaluate(() => window.dispatchEvent(new Event('test-cancel-registration')));
    await expect(page.getByRole('button', { name: '重新创建', exact: true })).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: '重新创建', exact: true })).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: testInfo.outputPath('retry.png') });
  });

test('a confirmed browser registration only rereads settings after its first refresh fails', async ({
  page,
}) => {
  const fixture = await passkeyFixture(page);
  await page.goto(`${entry}#passkey-register=first-grant`);
  await expect(page.getByRole('status')).toContainText('通行密钥已保存');
  await page.goto(entry);
  await page.getByRole('button', { name: '使用通行密钥登录' }).click();
  await expect(page.locator('.shell')).toBeVisible();
  await page.getByRole('button', { name: '设置与账号', exact: true }).click();
  await page.getByRole('menuitem', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '添加', exact: true }).click();
  await page.getByLabel('名称', { exact: true }).fill('新的密钥');
  await page.getByRole('button', { name: '改用通行密钥验证' }).click();
  fixture.failNextSettingsGet();
  await page.getByRole('button', { name: '创建通行密钥', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('status')).toContainText('通行密钥已创建');
  await expect(page.getByRole('alert')).toContainText('读取失败');
  expect(fixture.registrations()).toBe(2);
  expect(fixture.registrationStarts()).toBe(1);
  await expect(page.getByLabel('服务凭据', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '重新读取', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(fixture.registrations()).toBe(2);
  expect(fixture.registrationStarts()).toBe(1);
});

test('a submitted verification has no redundant cancel or retry action and waits for confirmation', async ({
  page,
}) => {
  const fixture = await passkeyFixture(page);
  fixture.holdVerification();
  await page.goto(`${entry}#passkey-register=short-lived-authorization`);
  await expect(page.getByText('旅行备用', { exact: true })).toBeVisible();
  await expect.poll(() => fixture.registrations()).toBe(1);
  await expect(page.getByRole('status')).toHaveText('等待系统验证…');
  const waiting = page.getByRole('button', { name: '等待系统验证…', exact: true });
  await expect(waiting).toBeVisible();
  await expect(waiting).toBeDisabled();
  await expect(waiting.getByRole('status')).toHaveText('等待系统验证…');
  await expect(page.getByRole('button')).toHaveCount(1);
  await expect(page.getByRole('heading', { name: '设置完成' })).toHaveCount(0);
  fixture.releaseVerification();
  await expect(page.getByRole('status')).toContainText('通行密钥已保存');
  expect(fixture.registrations()).toBe(1);
});

test('an unsupported browser disables Passkey without treating the HTTPS context as untrusted', async ({
  page,
}) => {
  const fixture = await passkeyFixture(page);
  await page.goto(`${entry}#passkey-register=first-grant`);
  await expect(page.getByRole('status')).toContainText('通行密钥已保存');
  await page.addInitScript(() => {
    Object.defineProperty(window, 'PublicKeyCredential', { configurable: true, value: undefined });
  });
  await page.goto(entry);
  expect(await page.evaluate(() => window.isSecureContext)).toBe(true);
  await expect(page.locator('.web-context-warning')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '使用通行密钥登录' })).toBeDisabled();
  await expect(page.getByLabel('服务凭据', { exact: true })).toBeEnabled();
  expect(fixture.requests).not.toContain('passkey/login/options');
  await page.goto(`${entry}#passkey-register=second-grant`);
  await expect(page.getByRole('alert')).toContainText('当前浏览器不支持通行密钥');
  await expect(page.getByRole('button', { name: '重新创建', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '创建通行密钥', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '创建通行密钥', exact: true })).toBeDisabled();
  expect(fixture.registrations()).toBe(1);
});

for (const kind of ['register', 'login'])
  test(`the browser's real RP ID SecurityError is reported for Passkey ${kind}`, async ({
    page,
  }) => {
    const fixture = await passkeyFixture(page);
    if (kind === 'login') {
      await page.goto(`${entry}#passkey-register=first-grant`);
      await expect(page.getByRole('status')).toContainText('通行密钥已保存');
    }
    fixture.useWrongRpId();
    await page.goto(kind === 'register' ? `${entry}#passkey-register=invalid-rp-grant` : entry);
    expect(await page.evaluate(() => window.isSecureContext)).toBe(true);
    await expect(page.locator('.web-context-warning')).toHaveCount(0);
    if (kind === 'login') await page.getByRole('button', { name: '使用通行密钥登录' }).click();
    await expect(page.getByRole('alert')).toContainText('请确认当前域名和 HTTPS 证书有效');
    expect(fixture.requests).not.toContain(`passkey/${kind}/verify`);
    expect(fixture.authenticated()).toBe(false);
  });

test('a real insecure HTTP context disables advertised Passkeys for login and registration', async ({
  page,
}) => {
  const insecureOrigin = 'http://web.example.test';
  const insecureEntry = `${insecureOrigin}/entry/`;
  const fixture = await passkeyFixture(page, insecureOrigin);
  fixture.advertisePasskey();
  await page.goto(insecureEntry);
  expect(await page.evaluate(() => window.isSecureContext)).toBe(false);
  expect(await page.evaluate(() => typeof window.PublicKeyCredential)).toBe('undefined');
  await expect(page.locator('.web-context-warning')).toBeVisible();
  await expect(page.getByRole('button', { name: '使用通行密钥登录' })).toBeDisabled();
  await expect(page.getByRole('status')).toContainText('当前页面未处于安全上下文');
  expect(fixture.requests).not.toContain('passkey/login/options');
  await page.goto(`${insecureEntry}#passkey-register=insecure-context-grant`);
  await expect(page.getByText('旅行备用', { exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('当前页面未处于安全上下文');
  await expect(page.getByRole('button', { name: '重新创建', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '创建通行密钥', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '创建通行密钥', exact: true })).toBeDisabled();
  expect(fixture.requests).not.toContain('passkey/register/verify');
  expect(fixture.requests).not.toContain('passkey/login/verify');
  expect(fixture.registrations()).toBe(0);
  expect(fixture.authenticated()).toBe(false);
});
