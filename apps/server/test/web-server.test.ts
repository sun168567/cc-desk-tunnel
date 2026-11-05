import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { WebSocket } from 'ws';
import {
  PROTOCOL_VERSION,
  commandSchema,
  serverMessageSchema,
  type ServerMessage,
} from '@cc-desk-tunnel/protocol';
import { createProxyServer } from '../src/server.ts';
import { browserActivity, browserCommands } from '../src/web-commands.ts';
import { terminalArguments } from '../src/native-terminal.ts';
import { totp } from '../src/web-totp.ts';

const token = 'web-integration-token-' + randomUUID();
class Client {
  messages: ServerMessage[] = [];
  socket: WebSocket;
  constructor(url: string, browser?: { cookie: string; path?: string; origin?: string }) {
    this.socket = new WebSocket(
      url.replace('http', 'ws') + (browser ? `${browser.path ?? ''}/api/ws` : '/ws'),
      {
        ...(browser ? { origin: browser.origin ?? url, headers: { Cookie: browser.cookie } } : {}),
      },
    );
    this.socket.on('message', (raw) =>
      this.messages.push(serverMessageSchema.parse(JSON.parse(raw.toString()))),
    );
  }
  async open(browser = false, password = token) {
    await once(this.socket, 'open');
    this.send(
      browser
        ? { type: 'web.auth', protocolVersion: PROTOCOL_VERSION }
        : {
            type: 'auth',
            protocolVersion: PROTOCOL_VERSION,
            token: password,
            deviceName: '桌面测试',
          },
    );
    if (!browser) this.send({ type: 'device', id: randomUUID(), platform: 'win32' });
    return this.wait((value) => value.type === 'ready');
  }
  send(value: object) {
    this.socket.send(JSON.stringify(value));
  }
  async wait(predicate: (value: ServerMessage) => boolean) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const index = this.messages.findIndex(predicate);
      if (index >= 0) return this.messages.splice(index, 1)[0];
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('Missing server message: ' + JSON.stringify(this.messages));
  }
  async request(value: object) {
    const requestId = randomUUID();
    this.send({ ...value, requestId });
    const result = await this.wait(
      (message) => message.type === 'response' && message.requestId === requestId,
    );
    assert.equal(result.type, 'response');
    return result;
  }
}
async function fixture(t: TestContext, stepMs = 1) {
  const dataDir = mkdtempSync(join(tmpdir(), 'cc-web-server-'));
  const webDirectory = join(dataDir, 'frontend');
  mkdirSync(webDirectory);
  writeFileSync(join(webDirectory, 'index.html'), '<!doctype html><title>Workbench</title>');
  let server = createProxyServer({ token, dataDir, webDirectory, stepMs });
  let url = await server.listen(0);
  const clients: Client[] = [];
  t.after(async () => {
    for (const client of clients) client.socket.terminate();
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  async function desktop(password = token) {
    const client = new Client(url);
    clients.push(client);
    await client.open(false, password);
    return client;
  }
  async function login(path = '', password = token) {
    const response = await fetch(url + path + '/api/login', {
      method: 'POST',
      headers: { Origin: url, 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    assert.equal(response.status, 200);
    return {
      cookie: response.headers.get('set-cookie')!.split(';')[0],
      data: (await response.json()) as { session: { id: string } },
    };
  }
  async function browser(cookie: string, path = '') {
    const client = new Client(url, { cookie, path });
    clients.push(client);
    const ready = await client.open(true);
    return { client, ready };
  }
  return {
    dataDir,
    get server() {
      return server;
    },
    get url() {
      return url;
    },
    clients,
    desktop,
    login,
    browser,
    async restart(password = token) {
      for (const client of clients) client.socket.terminate();
      await server.close();
      server = createProxyServer({ token: password, dataDir, webDirectory, stepMs });
      url = await server.listen(0);
    },
  };
}

test('desktop explicitly enables Web, disabling only ends browsers, and desktop behavior stays intact', async (t) => {
  const f = await fixture(t);
  const desktop = await f.desktop();
  assert.equal((await fetch(f.url + '/')).status, 404);
  assert.equal((await fetch(f.url + '/health')).status, 200);
  const old = await desktop.request({
    type: 'session.create',
    title: '桌面会话',
    projectPath: 'C:\\project',
  });
  assert.equal(old.ok, true);
  const enabled = await desktop.request({ type: 'web.settings.update', values: { enabled: true } });
  assert.equal(enabled.ok, true);
  assert.equal((await fetch(f.url + '/')).status, 200);
  const signed = await f.login();
  const { client } = await f.browser(signed.cookie);
  assert.equal(
    (await client.request({ type: 'web.settings.update', values: { enabled: false } })).code,
    'web_desktop_only',
  );
  const closed = once(client.socket, 'close');
  assert.equal(
    (await desktop.request({ type: 'web.settings.update', values: { enabled: false } })).ok,
    true,
  );
  await closed;
  assert.equal((await fetch(f.url + '/')).status, 404);
  assert.equal(
    (await desktop.request({ type: 'session.rename', sessionId: old.sessionId, title: '仍可操作' }))
      .ok,
    true,
  );
  await f.restart();
  assert.equal((await fetch(f.url + '/')).status, 404);
});

test('wrong browser sign-ins never lock out a desktop at the same address', async (t) => {
  const f = await fixture(t);
  const desktop = await f.desktop();
  await desktop.request({ type: 'web.settings.update', values: { enabled: true } });
  const attempt = () =>
    fetch(f.url + '/api/login', {
      method: 'POST',
      headers: { Origin: f.url, 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'wrong' }),
    });
  for (let index = 0; index < 6; index++) assert.equal((await attempt()).status, 401);
  assert.equal((await attempt()).status, 429);
  await f.desktop();
});

test('browser sessions belong to the stable server device, survive restart, and remain operable from desktop', async (t) => {
  const f = await fixture(t);
  let desktop = await f.desktop();
  await desktop.request({ type: 'web.settings.update', values: { enabled: true } });
  const signed = await f.login();
  const { client, ready } = await f.browser(signed.cookie);
  assert.equal(ready.type, 'ready');
  assert.ok(ready.browser);
  const serverId = ready.browser.serverDeviceId;
  const created = await client.request({ type: 'server.session.create', title: '服务端普通会话' });
  assert.ok(created.ok && created.sessionId);
  const session = f.server.store.get(created.sessionId).session;
  assert.equal(session.device?.id, serverId);
  assert.ok(session.nativeRoot);
  assert.equal(session.projectPath, join(f.dataDir, 'native', session.nativeRoot));
  // The service is listed once it holds a session.
  const inventory = await client.wait(
    (message) =>
      message.type === 'devices' && message.devices.some((device) => device.id === serverId),
  );
  assert.equal(inventory.type, 'devices');
  assert.equal(
    inventory.devices.filter((device) => device.id === serverId && device.ready).length,
    1,
  );
  assert.equal(inventory.devices.find((device) => device.id === serverId)?.server, true);
  const desktops = inventory.devices.filter((device) => device.id !== serverId);
  assert.ok(desktops.length > 0);
  assert.ok(desktops.every((device) => !('server' in device)));
  assert.equal(
    inventory.devices.some((device) => device.id === signed.data.session.id),
    false,
  );
  await client.request({ type: 'message.send', sessionId: session.id, text: 'hello' });
  await client.wait(
    (message) =>
      message.type === 'session.event' &&
      message.event.payload.type === 'run.status' &&
      message.event.payload.status === 'completed',
  );
  await f.restart();
  assert.equal((await fetch(f.url + '/')).status, 200, 'enabled state survives restart');
  desktop = await f.desktop();
  assert.equal(
    (await desktop.request({ type: 'message.send', sessionId: session.id, text: '桌面继续' })).ok,
    true,
  );
  await desktop.wait(
    (message) =>
      message.type === 'session.event' &&
      message.event.payload.type === 'run.status' &&
      message.event.payload.status === 'completed',
  );
  const browser = await f.browser(signed.cookie);
  assert.equal(browser.ready.type, 'ready');
  assert.equal(browser.ready.browser?.serverDeviceId, serverId);
  const restored = await browser.client.wait((message) => message.type === 'devices');
  assert.equal(restored.type, 'devices');
  assert.equal(restored.devices.find((device) => device.id === serverId)?.server, true);
  assert.ok(
    restored.devices
      .filter((device) => device.id !== serverId)
      .every((device) => !('server' in device)),
  );
  const replacement = 'new-service-token-' + randomUUID();
  await f.restart(replacement);
  const state = (await (
    await fetch(f.url + '/api/session', { headers: { Cookie: signed.cookie } })
  ).json()) as { authenticated: boolean };
  assert.equal(state.authenticated, false);
});

test('browser controls an existing device session but cannot claim a device or invoke desktop-only commands', async (t) => {
  const f = await fixture(t);
  const desktop = await f.desktop();
  const created = await desktop.request({
    type: 'session.create',
    title: '项目',
    projectPath: 'C:\\project',
  });
  await desktop.request({ type: 'web.settings.update', values: { enabled: true } });
  const signed = await f.login();
  const { client } = await f.browser(signed.cookie);
  assert.equal(
    (
      await client.request({
        type: 'message.send',
        sessionId: created.sessionId,
        text: '检查',
        scenario: 'tool',
      })
    ).ok,
    true,
  );
  const approval = await client.wait(
    (message) =>
      message.type === 'session.event' && message.event.payload.type === 'approval.requested',
  );
  assert.equal(approval.type, 'session.event');
  assert.equal(approval.event.payload.type, 'approval.requested');
  assert.equal(
    (
      await client.request({
        type: 'approval.reply',
        sessionId: created.sessionId,
        runId: approval.event.runId,
        approvalId: approval.event.payload.approvalId,
        allowed: false,
      })
    ).ok,
    true,
  );
  for (const command of [
    { type: 'session.create', title: 'forbidden', projectPath: '/tmp' },
    { type: 'session.fork', sessionId: created.sessionId },
    { type: 'session.move', sessionId: created.sessionId, projectPath: '/tmp' },
    { type: 'project.move', from: 'C:\\project', to: 'C:\\other' },
    { type: 'account.logout' },
    { type: 'web.certificate.get' },
    { type: 'service.update.check' },
  ])
    assert.equal((await client.request(command)).code, 'web_forbidden', command.type);
  const closed = once(client.socket, 'close');
  client.send({ type: 'device', id: randomUUID(), platform: 'linux' });
  assert.equal((await closed)[0], 4003);
  const channel = new Client(f.url, { cookie: signed.cookie });
  f.clients.push(channel);
  await once(channel.socket, 'open');
  const refused = once(channel.socket, 'close');
  channel.send({
    type: 'tunnel.attach',
    connectionId: randomUUID(),
    channelId: randomUUID(),
    secret: 'a'.repeat(64),
  });
  assert.equal(
    (await refused)[0],
    4001,
    'browser first frame must authenticate as web, never attach an execution tunnel',
  );
});

test('server directories reuse the project root mapping and creation stays idempotent across restart', async (t) => {
  const f = await fixture(t);
  const device = { id: randomUUID(), name: '服务端', platform: 'linux' as const };
  const requestId = randomUUID();
  const first = f.server.store.createOnServer(requestId, '普通会话', device);
  const another = f.server.store.createOnServer(randomUUID(), '另一个会话', device);
  assert.equal(first.projectPath, join(f.dataDir, 'native', first.nativeRoot!));
  assert.notEqual(another.nativeRoot, first.nativeRoot);
  assert.equal(
    f.server.store.create(randomUUID(), '同目录会话', first.projectPath, device).nativeRoot,
    first.nativeRoot,
  );
  await f.restart();
  assert.deepEqual(f.server.store.createOnServer(requestId, '普通会话', device), first);
  assert.throws(
    () => f.server.store.createOnServer(requestId, '不同标题', device),
    /请求 ID 已被其他内容使用/,
  );
  assert.throws(
    () => f.server.store.createOnServer(requestId, '普通会话', { ...device, id: randomUUID() }),
    /请求 ID 已被其他内容使用/,
  );
  assert.equal(
    f.server.store.database.prepare('SELECT count(*) AS count FROM native_roots').get()!.count,
    2,
  );
});

test('disabling Web closes its connection but leaves its running server session available to desktop', async (t) => {
  const f = await fixture(t, 30);
  const desktop = await f.desktop();
  await desktop.request({ type: 'web.settings.update', values: { enabled: true } });
  const signed = await f.login();
  const { client } = await f.browser(signed.cookie);
  const created = await client.request({ type: 'server.session.create', title: '继续运行' });
  await desktop.request({ type: 'session.subscribe', sessionId: created.sessionId });
  await client.request({ type: 'message.send', sessionId: created.sessionId, text: '继续运行' });
  await client.wait(
    (message) => message.type === 'session.event' && message.event.payload.type === 'run.status',
  );
  const closed = once(client.socket, 'close');
  await desktop.request({ type: 'web.settings.update', values: { enabled: false } });
  await closed;
  await desktop.wait(
    (message) =>
      message.type === 'session.event' &&
      message.event.payload.type === 'run.status' &&
      message.event.payload.status === 'completed',
  );
  assert.equal(f.server.store.get(created.sessionId!).session.activeRun, null);
});

test('sensitive settings require reauthentication, move the whole entry, and leave the desktop route unchanged', async (t) => {
  const f = await fixture(t);
  const desktop = await f.desktop();
  await desktop.request({ type: 'web.settings.update', values: { enabled: true } });
  assert.equal(
    (await desktop.request({ type: 'web.settings.update', values: { idleMinutes: 60 } })).ok,
    true,
  );
  const signed = await f.login();
  const { client } = await f.browser(signed.cookie);
  assert.equal(
    (await client.request({ type: 'web.settings.update', values: { path: 'private' } })).code,
    'web_unauthorized',
  );
  const changed = await client.request({
    type: 'web.settings.update',
    values: { path: 'private' },
    proof: { password: token },
  });
  assert.equal(changed.ok, true);
  assert.equal((await fetch(f.url + '/')).status, 404);
  assert.equal((await fetch(f.url + '/api/session')).status, 404);
  assert.equal((await fetch(f.url + '/private/')).status, 200);
  assert.equal((await fetch(f.url + '/health')).status, 200);
  const next = await f.login('/private');
  const browser = await f.browser(next.cookie, '/private');
  assert.equal(browser.ready.type, 'ready');
  assert.equal((await desktop.request({ type: 'web.settings.get' })).ok, true);
  const foreign = new Client(f.url, {
    cookie: next.cookie,
    path: '/private',
    origin: 'https://foreign.test',
  });
  f.clients.push(foreign);
  await assert.rejects(foreign.open(true), /401/);
});

test('authenticated desktop TOTP commands omit proof; a browser needs it to set up, and a code alone enables nothing', async (t) => {
  const f = await fixture(t);
  const desktop = await f.desktop();
  await desktop.request({ type: 'web.settings.update', values: { enabled: true } });
  const signed = await f.login();
  const { client } = await f.browser(signed.cookie);
  assert.equal((await client.request({ type: 'web.totp.setup' })).code, 'web_unauthorized');
  assert.equal(
    (await client.request({ type: 'web.totp.enable', code: '123456' })).code,
    'web_totp_invalid',
  );
  assert.equal((await desktop.request({ type: 'web.totp.setup' })).ok, true);
  const setup = await desktop.wait((message) => message.type === 'web.totp.setup');
  assert.equal(setup.type, 'web.totp.setup');
  const code = totp(setup.secret, Math.floor(Date.now() / 30_000));
  const closed = once(client.socket, 'close');
  assert.equal((await desktop.request({ type: 'web.totp.enable', code })).ok, true);
  await closed;
  const state = await desktop.wait(
    (message) => message.type === 'web.settings.state' && message.values.totpEnabled,
  );
  assert.equal(state.type, 'web.settings.state');
  assert.equal(state.values.sessions.length, 0);
  assert.equal((await desktop.request({ type: 'web.totp.disable' })).ok, true);
});

test('background read types do not renew activity; a browser opens no terminal; the server terminal has no remote SSH instructions', () => {
  for (const command of [
    'session.subscribe',
    'session.history',
    'session.status',
    'usage.summary',
    'web.settings.get',
  ] as const) {
    assert.equal(browserCommands.has(command), true);
    assert.equal(browserActivity.has(command), false);
  }
  assert.equal(browserActivity.has('message.send'), true);
  assert.equal(browserCommands.has('terminal.open'), false);
  const args = terminalArguments(
    { executable: 'claude' },
    { permissionMode: 'auto' } as never,
    undefined,
    {
      resume: false,
      settingsPath: '/t.json',
    },
  );
  assert.equal(args.includes('--append-system-prompt'), false);
  assert.equal(
    args.some((arg) => /SSH|device-script/.test(arg)),
    false,
  );
});

test('browser activity renews idle time while reads, reconnects and desktop frames do not', async (t) => {
  const f = await fixture(t);
  const desktop = await f.desktop();
  await desktop.request({ type: 'web.settings.update', values: { enabled: true } });
  const signed = await f.login();
  let { client } = await f.browser(signed.cookie);
  const created = await client.request({ type: 'server.session.create', title: '阅读活动' });
  assert.ok(created.ok && created.sessionId);
  const sessionId = created.sessionId;
  const database = f.server.store.database;
  const before = Date.now() - 60_000;
  const reset = () =>
    database
      .prepare('UPDATE web_sessions SET active = ? WHERE id = ?')
      .run(before, signed.data.session.id);
  const active = () =>
    database.prepare('SELECT active FROM web_sessions WHERE id = ?').get(signed.data.session.id)
      ?.active;
  for (const command of [
    { type: 'session.subscribe', sessionId },
    { type: 'session.history', sessionId, beforeSequence: 1 },
    { type: 'session.status', sessionId },
    { type: 'web.settings.get' },
  ]) {
    reset();
    await client.request(command);
    assert.equal(active(), before, `${command.type}: a read does not renew`);
  }
  client.send({ type: 'web.activity' });
  await client.request({ type: 'web.settings.get' });
  assert.ok(Number(active()) > before, 'activity renews');
  reset();
  await fetch(f.url + '/api/session', { headers: { Cookie: signed.cookie } });
  client.socket.terminate();
  ({ client } = await f.browser(signed.cookie));
  assert.equal(active(), before, 'cookie checks and reconnects do not renew');
  desktop.send({ type: 'web.activity' });
  const invalid = await desktop.wait((message) => message.type === 'connection.error');
  assert.equal(invalid.type, 'connection.error');
  assert.equal(invalid.code, 'invalid_command');
  assert.equal(active(), before, 'a desktop cannot renew a browser login');
});

test('activity cannot revive an idle-expired or absolutely expired browser session', async (t) => {
  const f = await fixture(t);
  const desktop = await f.desktop();
  await desktop.request({ type: 'web.settings.update', values: { enabled: true } });
  for (const expiry of ['idle', 'absolute']) {
    const signed = await f.login();
    const { client } = await f.browser(signed.cookie);
    const database = f.server.store.database;
    if (expiry === 'idle')
      database
        .prepare('UPDATE web_sessions SET active = ? WHERE id = ?')
        .run(Date.now() - 121 * 60_000, signed.data.session.id);
    else
      database
        .prepare('UPDATE web_sessions SET expires = ? WHERE id = ?')
        .run(Date.now() - 1, signed.data.session.id);
    const closed = once(client.socket, 'close');
    client.send({ type: 'web.activity' });
    const [code] = await closed;
    assert.equal(code, 4001);
    assert.equal(
      database.prepare('SELECT id FROM web_sessions WHERE id = ?').get(signed.data.session.id),
      undefined,
    );
  }
});
