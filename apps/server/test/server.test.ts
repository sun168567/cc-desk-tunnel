import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { WebSocket } from 'ws';
import { PROTOCOL_VERSION, serverMessageSchema } from '@cc-desk-tunnel/protocol';
import type { ServerMessage, SessionEvent } from '@cc-desk-tunnel/protocol';
import { createProxyServer } from '../src/server.ts';
import { SessionStore } from '../src/store.ts';
import { serviceVersion } from '../src/updates.ts';

const token = 'offline-test-' + randomUUID();
class Client {
  socket: WebSocket;
  messages: ServerMessage[] = [];
  constructor(url: string, origin?: string) {
    this.socket = new WebSocket(url.replace('http', 'ws') + '/ws', { origin });
    this.socket.on('message', (raw) =>
      this.messages.push(serverMessageSchema.parse(JSON.parse(raw.toString()))),
    );
  }
  async open(authToken = token, protocolVersion = PROTOCOL_VERSION) {
    await new Promise<void>((resolve, reject) => {
      this.socket.once('open', resolve);
      this.socket.once('error', reject);
    });
    this.socket.send(
      JSON.stringify({ type: 'auth', token: authToken, protocolVersion, deviceName: '测试设备' }),
    );
    return this.wait((message) => message.type === 'ready' || message.type === 'connection.error');
  }
  send(command: object) {
    this.socket.send(JSON.stringify(command));
  }
  async request(command: object) {
    const requestId = randomUUID();
    this.send({ ...command, requestId });
    return this.wait((message) => message.type === 'response' && message.requestId === requestId);
  }
  async wait(predicate: (message: ServerMessage) => boolean): Promise<ServerMessage> {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const index = this.messages.findIndex(predicate);
      if (index >= 0) return this.messages.splice(index, 1)[0];
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('Timed out waiting for server message');
  }
  event(type: SessionEvent['payload']['type']) {
    return this.wait(
      (message) => message.type === 'session.event' && message.event.payload.type === type,
    );
  }
}

async function fixture(t: TestContext, stepMs = 2) {
  const directory = mkdtempSync(join(tmpdir(), 'cc-desk-tunnel-test-'));
  const server = createProxyServer({ token, dataDir: directory, stepMs });
  const url = await server.listen(0);
  const clients: Client[] = [];
  t.after(async () => {
    for (const client of clients) client.socket.terminate();
    await server.close();
    rmSync(directory, { recursive: true, force: true });
  });
  async function connect() {
    const client = new Client(url);
    clients.push(client);
    assert.equal((await client.open()).type, 'ready');
    return client;
  }
  async function create(client: Client) {
    const response = await client.request({
      type: 'session.create',
      title: '中文会话',
      projectPath: 'D:\\工作\\测试',
    });
    assert.equal(response.type, 'response');
    assert.ok(response.type === 'response' && response.ok && response.sessionId);
    return response.sessionId;
  }
  return { directory, server, url, clients, connect, create };
}

test('requires authentication, rejects wrong token/version/origin and accepts health', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await (await fetch(f.url + '/health')).json(), {
    status: 'ok',
    protocolVersion: PROTOCOL_VERSION,
    adapter: 'simulation',
  });
  for (const [badToken, version, code] of [
    ['wrong-token-with-enough-length', 1, 'unauthorized'],
    [token, 9999, 'version_mismatch'],
  ] as const) {
    const client = new Client(f.url);
    f.clients.push(client);
    const message = await client.open(badToken, version);
    assert.ok(message.type === 'connection.error' && message.code === code);
    // Only a client holding the token learns which version runs here.
    assert.equal(message.service, code === 'unauthorized' ? undefined : serviceVersion());
  }
  const denied = new Client(f.url, 'https://untrusted.example');
  f.clients.push(denied);
  await assert.rejects(denied.open(), /403/);
});

test('repeated wrong tokens block the address; an outdated client with the right token is not counted', async (t) => {
  const f = await fixture(t);
  for (let attempt = 0; attempt < 8; attempt++) {
    const client = new Client(f.url);
    f.clients.push(client);
    await client.open(token, 9999);
  }
  for (let attempt = 0; attempt < 6; attempt++) {
    const client = new Client(f.url);
    f.clients.push(client);
    await client.open('wrong-token-with-enough-length');
  }
  const blocked = new Client(f.url);
  f.clients.push(blocked);
  await assert.rejects(blocked.open(), /429/);
  assert.equal(
    (await fetch(f.url + '/client/installer', { headers: { Authorization: `Bearer ${token}` } }))
      .status,
    429,
  );
});

test('malformed frames and invalid commands never create sessions', async (t) => {
  const f = await fixture(t);
  const client = await f.connect();
  client.send({
    type: 'session.create',
    requestId: randomUUID(),
    title: '',
    projectPath: 'D:\\测试',
  });
  assert.equal(
    (await client.wait((message) => message.type === 'connection.error')).type,
    'connection.error',
  );
  assert.equal(f.server.store.list().length, 0);
  client.socket.send('not JSON');
  const error = await client.wait((message) => message.type === 'connection.error');
  assert.ok(error.type === 'connection.error' && error.code === 'invalid_json');
});

test('streams ordered multi-turn UTF-8 events and persists without credentials', async (t) => {
  const f = await fixture(t);
  const client = await f.connect();
  const sessionId = await f.create(client);
  for (const text of ['你好，检查项目', '第二轮']) {
    await client.request({ type: 'message.send', sessionId, text, scenario: 'chat' });
    await client.wait(
      (message) =>
        message.type === 'session.event' &&
        message.event.payload.type === 'run.status' &&
        message.event.payload.status === 'completed',
    );
  }
  const snapshot = f.server.store.snapshot(sessionId);
  assert.equal(snapshot.events.filter((event) => event.payload.type === 'message.user').length, 2);
  assert.ok(
    snapshot.events.some(
      (event) => event.payload.type === 'text.delta' && event.payload.text.includes('离线'),
    ),
  );
  assert.deepEqual(
    snapshot.events.map((event) => event.sequence),
    snapshot.events.map((_, index) => index + 1),
  );
  assert.equal(
    readFileSync(join(f.directory, 'sessions.sqlite')).includes(Buffer.from(token)),
    false,
  );
  const restored = new SessionStore(f.directory);
  assert.equal(restored.list()[0].projectPath, 'D:\\工作\\测试');
  restored.close();
});

for (const allowed of [true, false]) {
  test(`approval ${allowed ? 'allow' : 'deny'} produces a single simulated tool result`, async (t) => {
    const f = await fixture(t);
    const client = await f.connect();
    const sessionId = await f.create(client);
    await client.request({ type: 'message.send', sessionId, text: '查看目录', scenario: 'tool' });
    const approval = await client.event('approval.requested');
    assert.ok(
      approval.type === 'session.event' && approval.event.payload.type === 'approval.requested',
    );
    const { runId, payload } = approval.event;
    await client.request({
      type: 'approval.reply',
      sessionId,
      runId,
      approvalId: payload.approvalId,
      allowed,
    });
    const result = await client.event('tool.result');
    assert.ok(result.type === 'session.event' && result.event.payload.type === 'tool.result');
    assert.equal(result.event.payload.status, allowed ? 'completed' : 'denied');
    await client.wait(
      (message) =>
        message.type === 'session.event' &&
        message.event.payload.type === 'run.status' &&
        message.event.payload.status === 'completed',
    );
    assert.equal(
      f.server.store
        .snapshot(sessionId)
        .events.filter((event) => event.payload.type === 'tool.result').length,
      1,
    );
  });
}

test('cancel during streaming stops events and never restarts the run', async (t) => {
  const f = await fixture(t, 20);
  const client = await f.connect();
  const sessionId = await f.create(client);
  await client.request({ type: 'message.send', sessionId, text: '停止测试', scenario: 'chat' });
  const runId = f.server.store.get(sessionId).session.activeRun!.id;
  await client.request({ type: 'run.cancel', sessionId, runId });
  const length = f.server.store.snapshot(sessionId).events.length;
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.equal(f.server.store.snapshot(sessionId).events.length, length);
  assert.equal(f.server.store.get(sessionId).session.activeRun, null);
  const late = await client.request({ type: 'run.cancel', sessionId, runId });
  assert.ok(late.type === 'response' && !late.ok && late.code === 'run_inactive');
});

test('disconnect while awaiting approval cancels, cursor replay restores history and does not execute', async (t) => {
  const f = await fixture(t);
  const client = await f.connect();
  const sessionId = await f.create(client);
  await client.request({ type: 'message.send', sessionId, text: '断线测试', scenario: 'tool' });
  const approval = await client.event('approval.requested');
  assert.ok(
    approval.type === 'session.event' && approval.event.payload.type === 'approval.requested',
  );
  const cursor = approval.event.sequence;
  const closed = new Promise((resolve) => client.socket.once('close', resolve));
  client.socket.terminate();
  await closed;
  const next = await f.connect();
  await next.request({ type: 'session.subscribe', sessionId, afterSequence: cursor });
  const history = await next.wait((message) => message.type === 'session.snapshot');
  assert.ok(history.type === 'session.snapshot');
  assert.ok(history.events.every((event) => event.sequence > cursor));
  assert.equal(history.session.activeRun, null);
  assert.ok(
    history.events.some(
      (event) => event.payload.type === 'tool.result' && event.payload.status === 'cancelled',
    ),
  );
  const late = await next.request({
    type: 'approval.reply',
    sessionId,
    runId: approval.event.runId,
    approvalId: approval.event.payload.approvalId,
    allowed: true,
  });
  assert.ok(late.type === 'response' && !late.ok);
});

test('another connection cannot approve or cancel a run', async (t) => {
  const f = await fixture(t);
  const owner = await f.connect();
  const observer = await f.connect();
  const sessionId = await f.create(owner);
  await owner.request({ type: 'message.send', sessionId, text: '权限测试', scenario: 'tool' });
  const approval = await owner.event('approval.requested');
  assert.ok(
    approval.type === 'session.event' && approval.event.payload.type === 'approval.requested',
  );
  for (const command of [
    { type: 'run.cancel', sessionId, runId: approval.event.runId },
    {
      type: 'approval.reply',
      sessionId,
      runId: approval.event.runId,
      approvalId: approval.event.payload.approvalId,
      allowed: true,
    },
  ]) {
    const response = await observer.request(command);
    assert.ok(response.type === 'response' && !response.ok && response.code === 'not_owner');
  }
});

test('busy sessions, invalid history cursor and stale approval are rejected without effects', async (t) => {
  const f = await fixture(t);
  const client = await f.connect();
  const sessionId = await f.create(client);
  await client.request({ type: 'message.send', sessionId, text: '保持运行', scenario: 'tool' });
  const approval = await client.event('approval.requested');
  assert.ok(
    approval.type === 'session.event' && approval.event.payload.type === 'approval.requested',
  );
  const cases = [
    {
      command: { type: 'message.send', sessionId, text: '重复并发', scenario: 'chat' },
      code: 'run_active',
    },
    { command: { type: 'session.delete', sessionId }, code: 'run_active' },
    {
      command: { type: 'session.subscribe', sessionId, afterSequence: 99999 },
      code: 'invalid_cursor',
    },
    {
      command: {
        type: 'approval.reply',
        sessionId,
        runId: approval.event.runId,
        approvalId: randomUUID(),
        allowed: true,
      },
      code: 'approval_inactive',
    },
  ];
  const count = f.server.store.snapshot(sessionId).events.length;
  for (const { command, code } of cases) {
    const response = await client.request(command);
    assert.ok(response.type === 'response' && !response.ok && response.code === code);
  }
  assert.equal(f.server.store.snapshot(sessionId).events.length, count);
  assert.equal(f.server.store.get(sessionId).session.activeRun!.status, 'awaiting_approval');
});

test('duplicate message and create request IDs survive reconnect without replay', async (t) => {
  const f = await fixture(t);
  const client = await f.connect();
  const requestId = randomUUID();
  const create = { type: 'session.create', requestId, title: '幂等', projectPath: 'D:\\项目' };
  client.send(create);
  const created = await client.wait(
    (message) => message.type === 'response' && message.requestId === requestId,
  );
  assert.ok(created.type === 'response' && created.sessionId);
  const command = {
    type: 'message.send',
    requestId: randomUUID(),
    sessionId: created.sessionId,
    text: '只运行一次',
    scenario: 'chat',
  };
  client.send(command);
  client.send(command);
  await client.wait(
    (message) =>
      message.type === 'session.event' &&
      message.event.payload.type === 'run.status' &&
      message.event.payload.status === 'completed',
  );
  const count = f.server.store.snapshot(created.sessionId).events.length;
  const next = await f.connect();
  next.send(create);
  next.send(command);
  await next.wait(
    (message) => message.type === 'response' && message.requestId === command.requestId,
  );
  assert.equal(f.server.store.list().length, 1);
  assert.equal(f.server.store.snapshot(created.sessionId).events.length, count);
  next.send({ ...command, text: 'different' });
  const conflict = await next.wait(
    (message) => message.type === 'response' && message.requestId === command.requestId,
  );
  assert.ok(conflict.type === 'response' && !conflict.ok && conflict.code === 'request_conflict');
});

test('simulated upstream errors are terminal and session deletion removes history only', async (t) => {
  const f = await fixture(t);
  const client = await f.connect();
  const sessionId = await f.create(client);
  await client.request({ type: 'message.send', sessionId, text: '失败测试', scenario: 'error' });
  await client.event('run.error');
  await client.wait(
    (message) =>
      message.type === 'session.event' &&
      message.event.payload.type === 'run.status' &&
      message.event.payload.status === 'failed',
  );
  await client.request({ type: 'session.delete', sessionId });
  assert.equal(f.server.store.list().length, 0);
});

test('restart recovery closes interrupted tools and does not replay side effects', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'cc-desk-tunnel-recovery-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new SessionStore(directory);
  const session = store.create(randomUUID(), '重启', 'D:\\项目');
  const runId = randomUUID();
  const toolId = randomUUID();
  const connectionId = randomUUID();
  store.append(session.id, runId, { type: 'run.status', status: 'running', connectionId });
  store.append(session.id, runId, {
    type: 'tool.requested',
    toolId,
    name: 'PowerShell',
    input: 'Get-Location',
    target: 'Windows (simulation)',
  });
  store.append(session.id, runId, {
    type: 'run.status',
    status: 'awaiting_approval',
    connectionId,
  });
  store.close();
  const restarted = new SessionStore(directory);
  const recovered = restarted.snapshot(session.id);
  restarted.close();
  assert.equal(recovered.session.activeRun, null);
  assert.ok(
    recovered.events.some(
      (event) => event.payload.type === 'tool.result' && event.payload.status === 'cancelled',
    ),
  );
  assert.equal(recovered.events.at(-1)?.payload.type, 'run.status');
  const second = new SessionStore(directory);
  assert.equal(second.snapshot(session.id).events.length, recovered.events.length);
  second.close();
});
test('native permission preference defaults to auto and persists; changing a running session is rejected', async (t) => {
  const f = await fixture(t);
  const client = await f.connect();
  const sessionId = await f.create(client);
  assert.equal(f.server.store.get(sessionId).session.permissionMode, 'auto');
  const response = await client.request({
    type: 'session.configure',
    sessionId,
    permissionMode: 'default',
  });
  assert.ok(response.type === 'response' && response.ok);
  const restored = new SessionStore(f.directory);
  assert.equal(restored.get(sessionId).session.permissionMode, 'default');
  restored.close();
  await client.request({ type: 'message.send', sessionId, text: '等待审批', scenario: 'tool' });
  await client.event('approval.requested');
  const busy = await client.request({
    type: 'session.configure',
    sessionId,
    permissionMode: 'auto',
  });
  assert.ok(busy.type === 'response' && !busy.ok && busy.code === 'run_active');
});

test('session directory does not push history; switching subscribes to only the current session', async (t) => {
  const f = await fixture(t);
  const owner = await f.connect();
  const first = await f.create(owner);
  const second = await f.create(owner);
  const observer = await f.connect();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(!observer.messages.some((message) => message.type === 'session.snapshot'));
  await observer.request({ type: 'session.subscribe', sessionId: first });
  const snapshot = await observer.wait((message) => message.type === 'session.snapshot');
  assert.ok(snapshot.type === 'session.snapshot' && snapshot.mode === 'replace');
  await observer.request({ type: 'session.subscribe', sessionId: second });
  await observer.wait((message) => message.type === 'session.snapshot');
  await owner.request({
    type: 'message.send',
    sessionId: first,
    text: '背景内容',
    scenario: 'chat',
  });
  await owner.wait(
    (message) =>
      message.type === 'session.event' &&
      message.event.payload.type === 'run.status' &&
      message.event.payload.status === 'completed',
  );
  assert.ok(
    !observer.messages.some(
      (message) => message.type === 'session.event' && message.event.sessionId === first,
    ),
  );
  assert.ok(
    observer.messages.some(
      (message) => message.type === 'session.updated' && message.session.id === first,
    ),
  );
});

test('native model, effort and plan preferences persist while offline compact is rejected', async (t) => {
  const f = await fixture(t);
  const client = await f.connect();
  const sessionId = await f.create(client);
  const response = await client.request({
    type: 'session.configure',
    sessionId,
    permissionMode: 'plan',
    model: 'deepseek-chat',
    effort: 'high',
  });
  assert.ok(response.type === 'response' && response.ok);
  const settings = f.server.store.get(sessionId).session;
  assert.equal(settings.model, 'deepseek-chat');
  assert.equal(settings.effort, 'high');
  assert.equal(settings.permissionMode, 'plan');
  const unavailable = await client.request({ type: 'session.compact', sessionId });
  assert.ok(
    unavailable.type === 'response' && !unavailable.ok && unavailable.code === 'native_unavailable',
  );
  await client.request({
    type: 'session.configure',
    sessionId,
    permissionMode: 'auto',
    model: null,
    effort: null,
  });
  assert.equal(f.server.store.get(sessionId).session.model, null);
  assert.equal(f.server.store.get(sessionId).session.effort, null);
});

test('renaming persists, duplicate asynchronous requests are deduped and running sessions cannot be renamed', async (t) => {
  const f = await fixture(t);
  const client = await f.connect();
  const sessionId = await f.create(client);
  const command = { type: 'session.rename', requestId: randomUUID(), sessionId, title: '重命名后' };
  client.send(command);
  client.send(command);
  for (let index = 0; index < 2; index++) {
    const response = await client.wait(
      (message) => message.type === 'response' && message.requestId === command.requestId,
    );
    assert.ok(response.type === 'response' && response.ok);
  }
  assert.equal(f.server.store.get(sessionId).session.title, '重命名后');
  await client.request({ type: 'message.send', sessionId, text: '等待审批', scenario: 'tool' });
  await client.event('approval.requested');
  const busy = await client.request({ type: 'session.rename', sessionId, title: '不能改名' });
  assert.ok(busy.type === 'response' && !busy.ok && busy.code === 'run_active');
});

test('forking copies a session whole or up to a message, and leaves the original alone', async (t) => {
  const f = await fixture(t);
  const client = await f.connect();
  const sessionId = await f.create(client);
  const texts = ['第一问', '第二问', '第三问'];
  const ids: string[] = [];
  const completed = (id: string) =>
    client.wait(
      (message) =>
        message.type === 'session.event' &&
        message.event.sessionId === id &&
        message.event.payload.type === 'run.status' &&
        message.event.payload.status === 'completed',
    );
  for (const text of texts) {
    const requestId = randomUUID();
    ids.push(requestId);
    client.send({ type: 'message.send', requestId, sessionId, text, scenario: 'chat' });
    await completed(sessionId);
  }
  const questions = (id: string) =>
    f.server.store
      .get(id)
      .events.flatMap((event) =>
        event.payload.type === 'message.user' ? [event.payload.text] : [],
      );
  const original = f.server.store.get(sessionId).events.length;
  const command = { type: 'session.fork', requestId: randomUUID(), sessionId };
  client.send(command);
  client.send(command);
  const copies = new Set<string>();
  for (let index = 0; index < 2; index++) {
    const response = await client.wait(
      (message) => message.type === 'response' && message.requestId === command.requestId,
    );
    assert.ok(response.type === 'response' && response.ok && response.sessionId);
    copies.add(response.sessionId);
  }
  assert.equal(copies.size, 1);
  const [whole] = [...copies];
  assert.notEqual(whole, sessionId);
  assert.deepEqual(questions(whole!), texts);
  const copy = f.server.store.get(whole!);
  assert.equal(copy.session.title, `${f.server.store.get(sessionId).session.title}（分叉）`);
  assert.equal(copy.session.projectPath, f.server.store.get(sessionId).session.projectPath);
  assert.ok(
    copy.events.every((event, index) => event.sessionId === whole && event.sequence === index + 1),
  );
  const cut = await client.request({ type: 'session.fork', sessionId, beforeMessageId: ids[2] });
  assert.ok(cut.type === 'response' && cut.ok && cut.sessionId);
  assert.deepEqual(questions(cut.sessionId), texts.slice(0, 2));
  assert.equal(f.server.store.get(cut.sessionId).session.activeRun, null);
  const first = await client.request({ type: 'session.fork', sessionId, beforeMessageId: ids[0] });
  assert.ok(first.type === 'response' && first.ok && first.sessionId);
  assert.equal(f.server.store.get(first.sessionId).events.length, 0);
  // The fork continues on its own.
  await client.request({
    type: 'message.send',
    sessionId: cut.sessionId,
    text: '另一条路',
    scenario: 'chat',
  });
  await completed(cut.sessionId);
  assert.deepEqual(questions(cut.sessionId), [...texts.slice(0, 2), '另一条路']);
  assert.equal(f.server.store.get(sessionId).events.length, original);
  const missing = await client.request({
    type: 'session.fork',
    sessionId,
    beforeMessageId: randomUUID(),
  });
  assert.ok(missing.type === 'response' && !missing.ok && missing.code === 'not_found');
  await client.request({ type: 'message.send', sessionId, text: '等待审批', scenario: 'tool' });
  await client.event('approval.requested');
  const busy = await client.request({ type: 'session.fork', sessionId });
  assert.ok(busy.type === 'response' && !busy.ok && busy.code === 'run_active');
});

test('offline mode cannot open a native terminal or accept unauthenticated terminal controls', async (t) => {
  const f = await fixture(t);
  const client = await f.connect();
  const sessionId = await f.create(client);
  const result = await client.request({ type: 'terminal.open', sessionId, cols: 80, rows: 24 });
  assert.ok(result.type === 'response' && !result.ok && result.code === 'native_unavailable');
  client.send({ type: 'terminal.input', sessionId, terminalId: randomUUID(), data: '/config\r' });
  const error = await client.wait((message) => message.type === 'connection.error');
  assert.ok(error.type === 'connection.error' && error.code === 'terminal_inactive');
});

test('restart marks pending native sends unconfirmed and never queues them again', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'cc-desk-tunnel-input-recovery-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new SessionStore(directory);
  const session = store.create(randomUUID(), '消息恢复', 'D:\\项目');
  const runId = randomUUID(),
    connectionId = randomUUID();
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  store.append(session.id, runId, { type: 'run.status', status: 'running', connectionId });
  ids.forEach((messageId, index) => {
    store.append(session.id, runId, {
      type: 'message.user',
      messageId,
      text: '补充',
      scenario: 'chat',
    });
    store.append(session.id, runId, {
      type: 'message.delivery',
      messageId,
      status: index === 0 ? 'submitted' : index === 1 ? 'queued' : 'received',
    });
  });
  store.close();
  const restarted = new SessionStore(directory);
  const events = restarted.snapshot(session.id).events;
  assert.deepEqual(
    events
      .filter((event) => event.payload.type === 'message.delivery')
      .slice(-2)
      .map((event) => event.payload),
    [
      { type: 'message.delivery', messageId: ids[0], status: 'not_sent' },
      { type: 'message.delivery', messageId: ids[1], status: 'unconfirmed' },
    ],
  );
  assert.equal(restarted.get(session.id).session.activeRun, null);
  const count = events.length;
  restarted.close();
  const second = new SessionStore(directory);
  assert.equal(second.snapshot(session.id).events.length, count);
  second.close();
});

test('native titles update only automatic names; a user rename remains authoritative', async (t) => {
  const f = await fixture(t);
  const requestId = randomUUID();
  const automatic = f.server.store.create(requestId, '新会话', 'D:\\项目');
  assert.equal(automatic.autoTitle, true);
  f.server.store.renameNative(automatic.id, '原生标题');
  assert.equal(f.server.store.create(requestId, '新会话', 'D:\\项目').id, automatic.id);
  assert.throws(() => f.server.store.create(requestId, '不同请求', 'D:\\项目'), {
    code: 'request_conflict',
  });
  f.server.store.rename(automatic.id, '用户标题');
  assert.equal(f.server.store.get(automatic.id).session.autoTitle, false);
});

test('a service that follows no releases says so and reports its version at sign-in', async (t) => {
  const f = await fixture(t);
  const client = new Client(f.url);
  f.clients.push(client);
  const ready = await client.open();
  assert.ok(ready.type === 'ready' && ready.version === serviceVersion() && !ready.update);
  const response = await client.request({ type: 'service.update.check' });
  assert.ok(
    response.type === 'response' && !response.ok && response.code === 'updates_unavailable',
  );
});

test('the newest client installer is announced on sign-in and downloads only with the token', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'cc-desk-tunnel-test-'));
  mkdirSync(join(directory, 'client'));
  writeFileSync(join(directory, 'client', 'CC-Desk-Tunnel-Setup-0.9.0-x64.exe'), 'old');
  writeFileSync(
    join(directory, 'client', 'CC-Desk-Tunnel-Setup-0.10.1-x64.exe'),
    'installer bytes',
  );
  writeFileSync(join(directory, 'client', 'notes.txt'), 'ignored');
  const server = createProxyServer({ token, dataDir: directory });
  const url = await server.listen(0);
  const client = new Client(url);
  t.after(async () => {
    client.socket.terminate();
    await server.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const ready = await client.open();
  assert.ok(ready.type === 'ready' && ready.client);
  assert.equal(ready.client.version, '0.10.1');
  assert.equal(ready.client.sha256, createHash('sha256').update('installer bytes').digest('hex'));
  assert.equal((await fetch(`${url}/client/installer`)).status, 401);
  assert.equal(
    (await fetch(`${url}/client/installer`, { headers: { Authorization: 'Bearer wrong' } })).status,
    401,
  );
  const download = await fetch(`${url}/client/installer`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(download.status, 200);
  assert.equal(await download.text(), 'installer bytes');
});
