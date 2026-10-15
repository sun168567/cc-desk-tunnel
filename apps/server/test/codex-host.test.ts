import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { PROTOCOL_VERSION, serverMessageSchema } from '@cc-desk-tunnel/protocol';
import type { ServerMessage } from '@cc-desk-tunnel/protocol';
import { createCodexHost, type CodexServiceOptions } from '../src/codex-host.ts';
import { createProxyServer } from '../src/server.ts';

const token = 'codex-host-' + randomUUID();
const claudeWorker = fileURLToPath(new URL('./fixtures/claude-worker.ts', import.meta.url));
const codexApp = fileURLToPath(
  new URL('../../codex/test/fixtures/app-server.mjs', import.meta.url),
);
const exitApp = fileURLToPath(new URL('./fixtures/exit.mjs', import.meta.url));
const crashApp = fileURLToPath(new URL('./fixtures/crash-loop.mjs', import.meta.url));
const hangWorker = fileURLToPath(new URL('./fixtures/hang-worker.ts', import.meta.url));
const malformedWorker = fileURLToPath(new URL('./fixtures/malformed-worker.ts', import.meta.url));
const floodWorker = fileURLToPath(new URL('./fixtures/flood-worker.ts', import.meta.url));
const modelErrorWorker = fileURLToPath(new URL('./fixtures/model-error-worker.ts', import.meta.url));

test('a dead Codex worker leaves Claude history and settings usable', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'cc-desk-tunnel-codex-host-'));
  const server = createProxyServer({
    token,
    dataDir: directory,
    reverseProxy: true,
    tunnel: {},
    claude: {
      executable: 'claude',
      worker: claudeWorker,
      failureLimit: 1,
      restartDelayMs: [60_000],
      openMs: 60_000,
    },
    codex: {
      executable: codexApp,
      profileId: 'test',
      failureLimit: 1,
      restartDelayMs: [60_000],
      openMs: 60_000,
    },
  });
  const url = await server.listen(0);
  t.after(async () => {
    await server.close();
    rmSync(directory, { recursive: true, force: true });
  });
  assert.ok(server.codex);
  assert.ok(server.native);
  await server.codex.whenReady();
  await server.native.ready();
  const login = await server.codex.login();
  assert.equal(login.url, 'https://auth.openai.com/codex/device');

  const messages: ServerMessage[] = [];
  const socket = new WebSocket(url.replace('http', 'ws') + '/ws');
  socket.on('message', (raw) =>
    messages.push(serverMessageSchema.parse(JSON.parse(raw.toString()))),
  );
  t.after(() => socket.terminate());
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  socket.send(
    JSON.stringify({
      type: 'auth',
      token,
      protocolVersion: PROTOCOL_VERSION,
      deviceName: '测试设备',
    }),
  );
  socket.send(JSON.stringify({ type: 'device', id: randomUUID() }));
  async function wait(predicate: (message: ServerMessage) => boolean) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const index = messages.findIndex(predicate);
      if (index >= 0) return messages.splice(index, 1)[0]!;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Timed out waiting for server message');
  }
  async function request(command: object) {
    const requestId = randomUUID();
    socket.send(JSON.stringify({ ...command, requestId }));
    const message = await wait((item) => item.type === 'response' && item.requestId === requestId);
    assert.equal(message.type, 'response');
    return message;
  }

  assert.equal((await wait((item) => item.type === 'ready')).type, 'ready');
  const created = await request({
    type: 'session.create',
    title: '仍是 Claude',
    projectPath: 'D:\\work',
  });
  assert.equal(created.ok, true);
  const sessionId = created.sessionId!;
  server.store.append(sessionId, randomUUID(), {
    type: 'message.user',
    messageId: randomUUID(),
    text: '仍在',
    scenario: 'chat',
  });

  const exited = server.codex.exited();
  server.codex.terminate();
  await exited;

  const history = await request({ type: 'session.subscribe', sessionId, afterSequence: 0 });
  assert.equal(history.ok, true);
  const page = await wait(
    (item) => item.type === 'session.snapshot' && item.session.id === sessionId,
  );
  assert.equal(page.type, 'session.snapshot');
  assert.ok(
    page.events.some(
      (event) => event.payload.type === 'message.user' && event.payload.text === '仍在',
    ),
  );
  const settings = await request({ type: 'settings.get' });
  assert.equal(settings.ok, true);
  await assert.rejects(
    server.codex.accountStatus(),
    (error: { code?: string }) => error.code === 'openai_unavailable',
  );
});

test('an OpenAI session records Codex text and approvals while Claude stays up', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'cc-desk-tunnel-codex-route-'));
  const server = createProxyServer({
    token,
    dataDir: directory,
    reverseProxy: true,
    tunnel: {},
    claude: {
      executable: 'claude',
      worker: claudeWorker,
      failureLimit: 1,
      restartDelayMs: [60_000],
      openMs: 60_000,
    },
    codex: {
      executable: codexApp,
      profileId: 'test',
      failureLimit: 1,
      restartDelayMs: [60_000],
      openMs: 60_000,
    },
  });
  const url = await server.listen(0);
  t.after(async () => {
    await server.close();
    rmSync(directory, { recursive: true, force: true });
  });
  assert.ok(server.codex);
  await server.codex.whenReady();
  const messages: ServerMessage[] = [];
  const socket = new WebSocket(url.replace('http', 'ws') + '/ws');
  socket.on('message', (raw) =>
    messages.push(serverMessageSchema.parse(JSON.parse(raw.toString()))),
  );
  t.after(() => socket.terminate());
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  socket.send(
    JSON.stringify({
      type: 'auth',
      token,
      protocolVersion: PROTOCOL_VERSION,
      deviceName: '测试设备',
    }),
  );
  socket.send(JSON.stringify({ type: 'device', id: randomUUID() }));
  async function wait(predicate: (message: ServerMessage) => boolean) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const index = messages.findIndex(predicate);
      if (index >= 0) return messages.splice(index, 1)[0]!;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Timed out waiting for server message');
  }
  async function request(command: object) {
    const requestId = randomUUID();
    socket.send(JSON.stringify({ ...command, requestId }));
    const message = await wait((item) => item.type === 'response' && item.requestId === requestId);
    assert.equal(message.type, 'response');
    return message;
  }
  function event(
    sessionId: string,
    type: string,
    extra?: (payload: Extract<ServerMessage, { type: 'session.event' }>['event']['payload']) => boolean,
  ) {
    return (item: ServerMessage) =>
      item.type === 'session.event' &&
      item.event.sessionId === sessionId &&
      item.event.payload.type === type &&
      (!extra || extra(item.event.payload));
  }

  assert.equal((await wait((item) => item.type === 'ready')).type, 'ready');
  const claude = await request({
    type: 'session.create',
    title: '仍是 Claude',
    projectPath: 'D:\\work',
  });
  assert.equal(claude.ok, true);
  const claudeId = claude.sessionId!;
  const claudeUpdated = await wait(
    (item) => item.type === 'session.updated' && item.session.id === claudeId,
  );
  assert.equal(claudeUpdated.type, 'session.updated');
  assert.equal(claudeUpdated.session.provider, 'claude');
  server.store.append(claudeId, randomUUID(), {
    type: 'message.user',
    messageId: randomUUID(),
    text: '仍在',
    scenario: 'chat',
  });

  const missing = await request({
    type: 'session.create',
    title: '新会话',
    projectPath: 'D:\\work',
    provider: 'openai',
    profileId: 'other',
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'not_found');

  const created = await request({
    type: 'session.create',
    title: '新会话',
    projectPath: 'D:\\openai',
    provider: 'openai',
    profileId: 'test',
  });
  assert.equal(created.ok, true);
  const sessionId = created.sessionId!;
  const updated = await wait(
    (item) => item.type === 'session.updated' && item.session.id === sessionId,
  );
  assert.equal(updated.type, 'session.updated');
  assert.equal(updated.session.provider, 'openai');
  assert.equal(updated.session.profileId, 'test');

  const models = await request({ type: 'model.list', provider: 'openai', profileId: 'test' });
  assert.equal(models.ok, true);
  const catalog = await wait((item) => item.type === 'models' && item.requestId === models.requestId);
  assert.equal(catalog.type, 'models');
  assert.deepEqual(catalog.models, [{ id: 'gpt-test', displayName: 'Test' }]);

  const sent = await request({
    type: 'message.send',
    sessionId,
    text: '你好',
    scenario: 'chat',
  });
  assert.equal(sent.ok, true);
  const fragment = await wait(
    (item) =>
      item.type === 'session.fragment' &&
      item.sessionId === sessionId &&
      item.payload.type === 'text.delta' &&
      item.payload.text === 'pong',
  );
  assert.equal(fragment.type, 'session.fragment');
  await wait(
    event(sessionId, 'run.status', (payload) => payload.type === 'run.status' && payload.status === 'completed'),
  );
  const configured = await request({
    type: 'session.configure',
    sessionId,
    permissionMode: 'auto',
    model: 'gpt-test',
  });
  assert.equal(configured.ok, true);
  const echoed = await request({
    type: 'message.send',
    sessionId,
    text: 'echo-model',
    scenario: 'chat',
  });
  assert.equal(echoed.ok, true);
  await wait(
    (item) =>
      item.type === 'session.fragment' &&
      item.sessionId === sessionId &&
      item.payload.type === 'text.delta' &&
      item.payload.text === 'gpt-test',
  );
  await wait(
    event(sessionId, 'run.status', (payload) => payload.type === 'run.status' && payload.status === 'completed'),
  );

  const denied = await request({
    type: 'message.send',
    sessionId,
    text: 'please deny',
    scenario: 'chat',
  });
  assert.equal(denied.ok, true);
  const approval = await wait(event(sessionId, 'approval.requested'));
  assert.equal(approval.type, 'session.event');
  if (approval.event.payload.type !== 'approval.requested') throw new Error('expected approval');
  const reply = await request({
    type: 'approval.reply',
    sessionId,
    runId: approval.event.runId,
    approvalId: approval.event.payload.approvalId,
    allowed: false,
  });
  assert.equal(reply.ok, true);
  await wait(
    event(
      sessionId,
      'tool.result',
      (payload) => payload.type === 'tool.result' && payload.status === 'denied',
    ),
  );
  await wait(
    event(sessionId, 'run.status', (payload) => payload.type === 'run.status' && payload.status === 'completed'),
  );

  const edited = await request({
    type: 'message.send',
    sessionId,
    text: 'please edit',
    scenario: 'chat',
  });
  assert.equal(edited.ok, true);
  const fileAsk = await wait(
    event(sessionId, 'tool.requested', (payload) => payload.type === 'tool.requested' && payload.name === 'Edit'),
  );
  assert.equal(fileAsk.type, 'session.event');
  const fileApproval = await wait(event(sessionId, 'approval.requested'));
  assert.equal(fileApproval.type, 'session.event');
  if (fileApproval.event.payload.type !== 'approval.requested') throw new Error('expected file approval');
  const fileReply = await request({
    type: 'approval.reply',
    sessionId,
    runId: fileApproval.event.runId,
    approvalId: fileApproval.event.payload.approvalId,
    allowed: false,
  });
  assert.equal(fileReply.ok, true);
  await wait(
    event(sessionId, 'run.status', (payload) => payload.type === 'run.status' && payload.status === 'completed'),
  );

  const accepting = await request({
    type: 'session.configure',
    sessionId,
    permissionMode: 'acceptEdits',
  });
  assert.equal(accepting.ok, true);
  const accepted = await request({
    type: 'message.send',
    sessionId,
    text: 'please edit',
    scenario: 'chat',
  });
  assert.equal(accepted.ok, true);
  await wait(
    event(
      sessionId,
      'tool.result',
      (payload) => payload.type === 'tool.result' && payload.status === 'completed',
    ),
  );
  await wait(
    event(sessionId, 'run.status', (payload) => payload.type === 'run.status' && payload.status === 'completed'),
  );
  assert.equal(
    messages.some(
      (item) =>
        item.type === 'session.event' &&
        item.event.sessionId === sessionId &&
        item.event.payload.type === 'approval.requested',
    ),
    false,
  );

  const sleeping = await request({
    type: 'message.send',
    sessionId,
    text: 'sleep',
    scenario: 'chat',
  });
  assert.equal(sleeping.ok, true);
  await wait(
    event(sessionId, 'run.status', (payload) => payload.type === 'run.status' && payload.status === 'running'),
  );
  const settings = await request({ type: 'settings.get' });
  assert.equal(settings.ok, true);

  const exited = server.codex.exited();
  server.codex.terminate();
  await exited;
  await wait(
    event(
      sessionId,
      'run.error',
      (payload) => payload.type === 'run.error' && payload.code === 'openai_unavailable',
    ),
  );
  await wait(
    event(sessionId, 'run.status', (payload) => payload.type === 'run.status' && payload.status === 'failed'),
  );

  const history = await request({ type: 'session.subscribe', sessionId: claudeId, afterSequence: 0 });
  assert.equal(history.ok, true);
  const page = await wait(
    (item) => item.type === 'session.snapshot' && item.session.id === claudeId,
  );
  assert.equal(page.type, 'session.snapshot');
  assert.equal(page.session.provider, 'claude');
  assert.ok(
    page.events.some(
      (row) => row.payload.type === 'message.user' && row.payload.text === '仍在',
    ),
  );
  const again = await request({ type: 'settings.get' });
  assert.equal(again.ok, true);
});

async function serve(t: TestContext, codex: CodexServiceOptions) {
  const directory = mkdtempSync(join(tmpdir(), 'cc-desk-tunnel-codex-fault-'));
  const server = createProxyServer({
    token,
    dataDir: directory,
    reverseProxy: true,
    tunnel: {},
    claude: {
      executable: 'claude',
      worker: claudeWorker,
      failureLimit: 1,
      restartDelayMs: [60_000],
      openMs: 60_000,
    },
    codex,
  });
  const url = await server.listen(0);
  t.after(async () => {
    await server.close();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        rmSync(directory, { recursive: true, force: true });
        return;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
  });
  const messages: ServerMessage[] = [];
  const socket = new WebSocket(url.replace('http', 'ws') + '/ws');
  socket.on('message', (raw) =>
    messages.push(serverMessageSchema.parse(JSON.parse(raw.toString()))),
  );
  t.after(() => socket.terminate());
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  socket.send(
    JSON.stringify({
      type: 'auth',
      token,
      protocolVersion: PROTOCOL_VERSION,
      deviceName: '测试设备',
    }),
  );
  socket.send(JSON.stringify({ type: 'device', id: randomUUID() }));
  async function wait(predicate: (message: ServerMessage) => boolean) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const index = messages.findIndex(predicate);
      if (index >= 0) return messages.splice(index, 1)[0]!;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Timed out waiting for server message');
  }
  async function request(command: object) {
    const requestId = randomUUID();
    socket.send(JSON.stringify({ ...command, requestId }));
    const message = await wait((item) => item.type === 'response' && item.requestId === requestId);
    assert.equal(message.type, 'response');
    return message;
  }
  assert.equal((await wait((item) => item.type === 'ready')).type, 'ready');
  const created = await request({
    type: 'session.create',
    title: '仍是 Claude',
    projectPath: 'D:\\work',
  });
  assert.equal(created.ok, true);
  const claudeId = created.sessionId!;
  server.store.append(claudeId, randomUUID(), {
    type: 'message.user',
    messageId: randomUUID(),
    text: '仍在',
    scenario: 'chat',
  });
  async function claudeStillWorks() {
    const settings = await request({ type: 'settings.get' });
    assert.equal(settings.ok, true);
    const history = await request({
      type: 'session.subscribe',
      sessionId: claudeId,
      afterSequence: 0,
    });
    assert.equal(history.ok, true);
    const page = await wait(
      (item) => item.type === 'session.snapshot' && item.session.id === claudeId,
    );
    assert.equal(page.type, 'session.snapshot');
    assert.ok(
      page.events.some((row) => row.payload.type === 'message.user' && row.payload.text === '仍在'),
    );
  }
  return { server, url, directory, request, wait, claudeStillWorks };
}

test('a Codex executable that exits leaves Claude usable', async (t) => {
  const { server, url, claudeStillWorks } = await serve(t, {
    executable: exitApp,
    profileId: 'test',
    failureLimit: 1,
    restartDelayMs: [60_000],
    openMs: 60_000,
    readyMs: 2_000,
  });
  await server.native!.ready();
  await assert.rejects(server.codex!.whenReady(), (error: { code?: string }) => error.code === 'openai_unavailable');
  const health = await fetch(url + '/health');
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), {
    status: 'ok',
    protocolVersion: PROTOCOL_VERSION,
    adapter: 'claude-code',
    providers: { claude: 'ready', openai: 'unavailable' },
  });
  await claudeStillWorks();
});

test('a Codex worker that never becomes ready does not block Claude', async (t) => {
  const { server, claudeStillWorks } = await serve(t, {
    executable: 'codex',
    profileId: 'test',
    worker: hangWorker,
    failureLimit: 1,
    restartDelayMs: [60_000],
    openMs: 60_000,
    readyMs: 4_000,
  });
  const pending = server.codex!.whenReady();
  await claudeStillWorks();
  await assert.rejects(pending, (error: { code?: string }) => error.code === 'openai_unavailable');
});

test('a hung Codex turn ends unknown and Claude stays readable', async (t) => {
  const { server, request, wait, claudeStillWorks } = await serve(t, {
    executable: codexApp,
    profileId: 'test',
    failureLimit: 1,
    restartDelayMs: [60_000],
    openMs: 60_000,
    turnTimeoutMs: 500,
  });
  await server.codex!.whenReady();
  const created = await request({
    type: 'session.create',
    title: '挂起',
    projectPath: 'D:\\openai',
    provider: 'openai',
    profileId: 'test',
  });
  assert.equal(created.ok, true);
  const sessionId = created.sessionId!;
  const sent = await request({
    type: 'message.send',
    sessionId,
    text: 'sleep',
    scenario: 'chat',
  });
  assert.equal(sent.ok, true);
  const during = await request({ type: 'settings.get' });
  assert.equal(during.ok, true);
  const error = await wait(
    (item) =>
      item.type === 'session.event' &&
      item.event.sessionId === sessionId &&
      item.event.payload.type === 'run.error' &&
      item.event.payload.code === 'result_unknown',
  );
  assert.equal(error.type, 'session.event');
  await wait(
    (item) =>
      item.type === 'session.event' &&
      item.event.sessionId === sessionId &&
      item.event.payload.type === 'run.status' &&
      item.event.payload.status === 'failed',
  );
  await claudeStillWorks();
});

test('repeated Codex crashes open the circuit', async (t) => {
  const { server, directory, claudeStillWorks } = await serve(t, {
    executable: crashApp,
    profileId: 'test',
    failureLimit: 2,
    restartDelayMs: [30],
    openMs: 60_000,
    readyMs: 2_000,
  });
  const launches = join(directory, 'providers', 'openai', 'test', 'launches');
  const deadline = Date.now() + 8_000;
  let count = '';
  while (Date.now() < deadline) {
    try {
      count = readFileSync(launches, 'utf8');
    } catch {
      count = '';
    }
    if (count.length >= 2) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(count.length, 2);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(readFileSync(launches, 'utf8').length, 2);
  const started = Date.now();
  await assert.rejects(server.codex!.whenReady(), (error: { code?: string }) => error.code === 'openai_unavailable');
  assert.ok(Date.now() - started < 400);
  assert.equal(readFileSync(launches, 'utf8').length, 2);
  await claudeStillWorks();
});

test('a malformed Codex event is dropped and Claude history stays', async (t) => {
  const { request, wait, claudeStillWorks } = await serve(t, {
    executable: 'codex',
    profileId: 'test',
    worker: malformedWorker,
    failureLimit: 1,
    restartDelayMs: [60_000],
    openMs: 60_000,
  });
  const created = await request({
    type: 'session.create',
    title: '畸形',
    projectPath: 'D:\\openai',
    provider: 'openai',
    profileId: 'test',
  });
  assert.equal(created.ok, true);
  const sessionId = created.sessionId!;
  const sent = await request({
    type: 'message.send',
    sessionId,
    text: '你好',
    scenario: 'chat',
  });
  assert.equal(sent.ok, true);
  await wait(
    (item) =>
      item.type === 'session.event' &&
      item.event.sessionId === sessionId &&
      item.event.payload.type === 'run.status' &&
      item.event.payload.status === 'completed',
  );
  const history = await request({ type: 'session.subscribe', sessionId, afterSequence: 0 });
  assert.equal(history.ok, true);
  const page = await wait(
    (item) => item.type === 'session.snapshot' && item.session.id === sessionId,
  );
  assert.equal(page.type, 'session.snapshot');
  assert.ok(page.events.some((row) => row.payload.type === 'text.delta' && row.payload.text === '合法'));
  assert.equal(JSON.stringify(page.events).includes('not-an-event'), false);
  await claudeStillWorks();
});

test('a throwing Codex event handler drops that event and keeps the next', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'cc-desk-tunnel-codex-throw-'));
  const seen: string[] = [];
  let finished = false;
  const host = createCodexHost(
    {
      executable: 'codex',
      profileId: 'test',
      worker: malformedWorker,
      failureLimit: 1,
      restartDelayMs: [60_000],
      openMs: 60_000,
    },
    directory,
    {
      event(_sessionId, payload) {
        if (payload.type === 'text.delta' && payload.text === 'boom') throw new Error('boom');
        if (payload.type === 'text.delta') seen.push(payload.text);
      },
      approvalRequested() {},
      runFinished() {
        finished = true;
      },
      loginExit() {},
      terminalData() {},
      terminalExit() {},
      terminalFault() {},
      exited() {},
    },
  );
  t.after(async () => {
    await host.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  await host.whenReady();
  host.startRun({
    sessionId: randomUUID(),
    runId: randomUUID(),
    messageId: randomUUID(),
    text: '你好',
  });
  const deadline = Date.now() + 3_000;
  while (!finished && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(finished, true);
  assert.deepEqual(seen, ['合法']);
});

test('an OpenAI session resumes its Codex thread and drops a missing id', async (t) => {
  const { server, request, wait } = await serve(t, {
    executable: codexApp,
    profileId: 'test',
    failureLimit: 1,
    restartDelayMs: [60_000],
    openMs: 60_000,
  });
  await server.codex!.whenReady();
  const created = await request({
    type: 'session.create',
    title: '续上',
    projectPath: 'D:\\openai',
    provider: 'openai',
    profileId: 'test',
  });
  assert.equal(created.ok, true);
  const sessionId = created.sessionId!;
  assert.equal(server.store.get(sessionId).session.codexThreadId, undefined);
  const first = await request({
    type: 'message.send',
    sessionId,
    text: '你好',
    scenario: 'chat',
  });
  assert.equal(first.ok, true);
  await wait(
    (item) =>
      item.type === 'session.fragment' &&
      item.sessionId === sessionId &&
      item.payload.type === 'text.delta' &&
      item.payload.text === 'pong',
  );
  await wait(
    (item) =>
      item.type === 'session.event' &&
      item.event.sessionId === sessionId &&
      item.event.payload.type === 'run.status' &&
      item.event.payload.status === 'completed',
  );
  assert.equal(server.store.get(sessionId).session.codexThreadId, 'thr_test');

  const second = await request({
    type: 'message.send',
    sessionId,
    text: '再来',
    scenario: 'chat',
  });
  assert.equal(second.ok, true);
  await wait(
    (item) =>
      item.type === 'session.fragment' &&
      item.sessionId === sessionId &&
      item.payload.type === 'text.delta' &&
      item.payload.text === 'resumed',
  );
  await wait(
    (item) =>
      item.type === 'session.event' &&
      item.event.sessionId === sessionId &&
      item.event.payload.type === 'run.status' &&
      item.event.payload.status === 'completed',
  );
  assert.equal(server.store.get(sessionId).session.codexThreadId, 'thr_test');

  server.store.rememberCodexThread(sessionId, 'thr_gone');
  const missed = await request({
    type: 'message.send',
    sessionId,
    text: '找不到',
    scenario: 'chat',
  });
  assert.equal(missed.ok, true);
  await wait(
    (item) =>
      item.type === 'session.event' &&
      item.event.sessionId === sessionId &&
      item.event.payload.type === 'run.error' &&
      item.event.payload.code === 'codex_failed',
  );
  await wait(
    (item) =>
      item.type === 'session.event' &&
      item.event.sessionId === sessionId &&
      item.event.payload.type === 'run.status' &&
      item.event.payload.status === 'failed',
  );
  assert.equal(server.store.get(sessionId).session.codexThreadId, undefined);
  const again = await request({
    type: 'message.send',
    sessionId,
    text: '你好',
    scenario: 'chat',
  });
  assert.equal(again.ok, true);
  await wait(
    (item) =>
      item.type === 'session.fragment' &&
      item.sessionId === sessionId &&
      item.payload.type === 'text.delta' &&
      item.payload.text === 'pong',
  );
});

test('a forked OpenAI session continues Codex’s own thread and can compact', async (t) => {
  const { server, request, wait } = await serve(t, {
    executable: codexApp,
    profileId: 'test',
    failureLimit: 1,
    restartDelayMs: [60_000],
    openMs: 60_000,
  });
  await server.codex!.whenReady();
  const created = await request({
    type: 'session.create',
    title: '原来',
    projectPath: 'D:\\openai',
    provider: 'openai',
    profileId: 'test',
  });
  assert.equal(created.ok, true);
  const sessionId = created.sessionId!;
  const sent = await request({
    type: 'message.send',
    sessionId,
    text: '灯塔',
    scenario: 'chat',
  });
  assert.equal(sent.ok, true);
  await wait(
    (item) =>
      item.type === 'session.fragment' &&
      item.sessionId === sessionId &&
      item.payload.type === 'text.delta' &&
      item.payload.text === 'pong',
  );
  await wait(
    (item) =>
      item.type === 'session.event' &&
      item.event.sessionId === sessionId &&
      item.event.payload.type === 'run.status' &&
      item.event.payload.status === 'completed',
  );
  assert.equal(server.store.get(sessionId).session.codexThreadId, 'thr_test');
  server.store.append(sessionId, randomUUID(), {
    type: 'tool.requested',
    toolId: 'item-edit',
    name: 'Edit',
    input: JSON.stringify({ file_path: 'D:\\openai\\a.ts', old_string: 'a', new_string: 'b' }),
    target: 'Linux',
  });
  server.store.append(sessionId, randomUUID(), {
    type: 'tool.result',
    toolId: 'item-edit',
    status: 'completed',
    output: '--- a.ts\n+++ a.ts\n',
    exitCode: 0,
  });

  const forked = await request({
    type: 'session.fork',
    sessionId,
    projectPath: 'D:\\openai',
  });
  assert.equal(forked.ok, true);
  const forkId = forked.sessionId!;
  assert.equal(server.store.get(forkId).session.codexThreadId, 'thr_fork');
  const echoed = await request({
    type: 'message.send',
    sessionId: forkId,
    text: 'echo-input',
    scenario: 'chat',
  });
  assert.equal(echoed.ok, true);
  const carried = await wait(
    (item) =>
      item.type === 'session.fragment' &&
      item.sessionId === forkId &&
      item.payload.type === 'text.delta',
  );
  assert.equal(carried.type, 'session.fragment');
  if (carried.payload.type !== 'text.delta') throw new Error('expected the carried turn');
  assert.match(carried.payload.text, /echo-input/);
  assert.doesNotMatch(carried.payload.text, /灯塔/);
  await wait(
    (item) =>
      item.type === 'session.event' &&
      item.event.sessionId === forkId &&
      item.event.payload.type === 'run.status' &&
      item.event.payload.status === 'completed',
  );
  const users = server.store
    .snapshot(forkId)
    .events.filter((event) => event.payload.type === 'message.user');
  const lastUser = users.at(-1)?.payload;
  assert.equal(lastUser?.type === 'message.user' ? lastUser.text : '', 'echo-input');

  const compact = await request({ type: 'session.compact', sessionId: forkId });
  assert.equal(compact.ok, true);
  await wait(
    (item) =>
      item.type === 'session.event' &&
      item.event.sessionId === forkId &&
      item.event.payload.type === 'native.compact',
  );
  await wait(
    (item) =>
      item.type === 'session.event' &&
      item.event.sessionId === forkId &&
      item.event.payload.type === 'run.status' &&
      item.event.payload.status === 'completed',
  );
});

test('an older Codex keeps a text copy and says it is not its own thread', async (t) => {
  const { server, request, wait } = await serve(t, {
    executable: codexApp,
    profileId: 'test',
    failureLimit: 1,
    restartDelayMs: [60_000],
    openMs: 60_000,
  });
  await server.codex!.whenReady();
  const created = await request({
    type: 'session.create',
    title: '原来',
    projectPath: 'D:\\openai',
    provider: 'openai',
    profileId: 'test',
  });
  assert.equal(created.ok, true);
  const sessionId = created.sessionId!;
  const sent = await request({
    type: 'message.send',
    sessionId,
    text: '灯塔',
    scenario: 'chat',
  });
  assert.equal(sent.ok, true);
  await wait(
    (item) =>
      item.type === 'session.event' &&
      item.event.sessionId === sessionId &&
      item.event.payload.type === 'run.status' &&
      item.event.payload.status === 'completed',
  );
  server.store.rememberCodexThread(sessionId, 'thr_copy');
  const forked = await request({ type: 'session.fork', sessionId, projectPath: 'D:\\openai' });
  assert.equal(forked.ok, true);
  const forkId = forked.sessionId!;
  assert.equal(server.store.get(forkId).session.codexThreadId, undefined);
  const notice = server.store
    .snapshot(forkId)
    .events.find((event) => event.payload.type === 'native.notice');
  assert.equal(
    notice?.payload.type === 'native.notice' ? notice.payload.text : '',
    '这一份是文字副本，不是 Codex 自己的线程。',
  );
  const echoed = await request({
    type: 'message.send',
    sessionId: forkId,
    text: 'echo-input',
    scenario: 'chat',
  });
  assert.equal(echoed.ok, true);
  const carried = await wait(
    (item) =>
      item.type === 'session.fragment' &&
      item.sessionId === forkId &&
      item.payload.type === 'text.delta',
  );
  assert.equal(carried.type, 'session.fragment');
  if (carried.payload.type !== 'text.delta') throw new Error('expected the carried turn');
  assert.match(carried.payload.text, /灯塔/);
  assert.match(carried.payload.text, /echo-input/);
});

test('an OpenAI session without a thread is copied as text and does not claim a fork', async (t) => {
  const { server, request } = await serve(t, {
    executable: codexApp,
    profileId: 'test',
    failureLimit: 1,
    restartDelayMs: [60_000],
    openMs: 60_000,
  });
  await server.codex!.whenReady();
  const created = await request({
    type: 'session.create',
    title: '还没有线程',
    projectPath: 'D:\\openai',
    provider: 'openai',
    profileId: 'test',
  });
  assert.equal(created.ok, true);
  const forked = await request({
    type: 'session.fork',
    sessionId: created.sessionId,
    projectPath: 'D:\\openai',
  });
  assert.equal(forked.ok, true);
  const copy = server.store.get(forked.sessionId!).session;
  assert.equal(copy.codexThreadId, undefined);
  assert.equal(
    server.store.snapshot(copy.id).events.some((event) => event.payload.type === 'native.notice'),
    false,
  );
});

test('an OpenAI turn records tokens and a full quota stops the next send', async (t) => {
  const { server, request, wait, claudeStillWorks } = await serve(t, {
    executable: codexApp,
    profileId: 'test',
    failureLimit: 1,
    restartDelayMs: [60_000],
    openMs: 60_000,
  });
  await server.codex!.whenReady();
  const created = await request({
    type: 'session.create',
    title: '用量',
    projectPath: 'D:\\openai',
    provider: 'openai',
    profileId: 'test',
  });
  assert.equal(created.ok, true);
  const sessionId = created.sessionId!;
  const sent = await request({
    type: 'message.send',
    sessionId,
    text: 'usage',
    scenario: 'chat',
  });
  assert.equal(sent.ok, true);
  await wait(
    (item) =>
      item.type === 'session.event' &&
      item.event.sessionId === sessionId &&
      item.event.payload.type === 'native.metrics' &&
      item.event.payload.rateLimits?.available === true,
  );
  await wait(
    (item) =>
      item.type === 'session.event' &&
      item.event.sessionId === sessionId &&
      item.event.payload.type === 'run.status' &&
      item.event.payload.status === 'completed',
  );
  const queried = await request({ type: 'usage.query', limit: 10, bucketMinutes: 60, offsetMinutes: 0 });
  assert.equal(queried.ok, true);
  const page = await wait((item) => item.type === 'usage.page' && item.requestId === queried.requestId);
  assert.equal(page.type, 'usage.page');
  assert.equal(page.rows[0]?.provider, 'openai');
  assert.equal(page.rows[0]?.inputTokens, 12);
  assert.equal(page.rows[0]?.outputTokens, 4);
  const blocked = await request({
    type: 'message.send',
    sessionId,
    text: '你好',
    scenario: 'chat',
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'quota_exceeded');
  await claudeStillWorks();
});

test('an OpenAI run accepts another message before the turn ends', async (t) => {
  const { request, wait } = await serve(t, {
    executable: codexApp,
    profileId: 'test',
    failureLimit: 1,
    restartDelayMs: [60_000],
    openMs: 60_000,
  });
  const created = await request({
    type: 'session.create',
    title: '追加',
    projectPath: 'D:\\openai',
    provider: 'openai',
    profileId: 'test',
  });
  assert.equal(created.ok, true);
  const sessionId = created.sessionId!;
  const sent = await request({
    type: 'message.send',
    sessionId,
    text: 'sleep',
    scenario: 'chat',
  });
  assert.equal(sent.ok, true);
  await wait(
    (item) =>
      item.type === 'session.event' &&
      item.event.sessionId === sessionId &&
      item.event.payload.type === 'run.status' &&
      item.event.payload.status === 'running',
  );
  const extra = await request({
    type: 'message.send',
    sessionId,
    text: '继续写',
    scenario: 'chat',
  });
  assert.equal(extra.ok, true);
  const steered = await wait(
    (item) =>
      item.type === 'session.fragment' &&
      item.sessionId === sessionId &&
      item.payload.type === 'text.delta',
  );
  assert.equal(steered.type, 'session.fragment');
  if (steered.payload.type !== 'text.delta') throw new Error('expected the steered text');
  assert.match(steered.payload.text, /steered:继续写/);
  await wait(
    (item) =>
      item.type === 'session.event' &&
      item.event.sessionId === sessionId &&
      item.event.payload.type === 'run.status' &&
      item.event.payload.status === 'completed',
  );
});

test('refreshing an OpenAI session reads its quota', async (t) => {
  const { request, wait } = await serve(t, {
    executable: codexApp,
    profileId: 'test',
    failureLimit: 1,
    restartDelayMs: [60_000],
    openMs: 60_000,
  });
  const created = await request({
    type: 'session.create',
    title: '额度',
    projectPath: 'D:\\openai',
    provider: 'openai',
    profileId: 'test',
  });
  assert.equal(created.ok, true);
  const sessionId = created.sessionId!;
  const status = await request({ type: 'session.status', sessionId });
  assert.equal(status.ok, true);
  const metrics = await wait(
    (item) =>
      item.type === 'session.event' &&
      item.event.sessionId === sessionId &&
      item.event.payload.type === 'native.metrics',
  );
  assert.equal(metrics.type, 'session.event');
  if (metrics.event.payload.type !== 'native.metrics') throw new Error('expected metrics');
  assert.equal(metrics.event.payload.rateLimits?.windows[0]?.utilization, 40);
});

test('an OpenAI turn waits for the execution channel its connection opened', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'cc-desk-tunnel-codex-channel-'));
  const server = createProxyServer({
    token,
    dataDir: directory,
    reverseProxy: true,
    tunnel: {},
    codex: {
      executable: codexApp,
      profileId: 'test',
      failureLimit: 1,
      restartDelayMs: [60_000],
      openMs: 60_000,
    },
  });
  const url = await server.listen(0);
  t.after(async () => {
    await server.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const messages: ServerMessage[] = [];
  const socket = new WebSocket(url.replace('http', 'ws') + '/ws');
  socket.on('message', (raw) =>
    messages.push(serverMessageSchema.parse(JSON.parse(raw.toString()))),
  );
  t.after(() => socket.terminate());
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  socket.send(
    JSON.stringify({
      type: 'auth',
      token,
      protocolVersion: PROTOCOL_VERSION,
      deviceName: '测试设备',
      tunnel: true,
    }),
  );
  async function wait(predicate: (message: ServerMessage) => boolean) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const index = messages.findIndex(predicate);
      if (index >= 0) return messages.splice(index, 1)[0]!;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Timed out waiting for server message');
  }
  async function request(command: object) {
    const requestId = randomUUID();
    socket.send(JSON.stringify({ ...command, requestId }));
    const message = await wait((item) => item.type === 'response' && item.requestId === requestId);
    assert.equal(message.type, 'response');
    return message;
  }
  assert.equal((await wait((item) => item.type === 'ready')).type, 'ready');
  socket.send(JSON.stringify({ type: 'device', id: randomUUID() }));
  const created = await request({
    type: 'session.create',
    title: '通道',
    projectPath: 'D:\\openai',
    provider: 'openai',
    profileId: 'test',
  });
  assert.equal(created.ok, true);
  const sent = await request({
    type: 'message.send',
    sessionId: created.sessionId,
    text: '你好',
    scenario: 'chat',
  });
  assert.equal(sent.ok, false);
  assert.equal(sent.code, 'execution_offline');
  const status = await request({ type: 'account.status', provider: 'openai', profileId: 'test' });
  assert.equal(status.ok, true);
  const state = await wait((item) => item.type === 'account.state' && item.provider === 'openai');
  assert.equal(state.type, 'account.state');
  assert.equal(state.runtime, 'ready');
  assert.equal(state.limits?.kind, 'none');
});

test('OpenAI reports itself absent when no Codex executable is configured', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'cc-desk-tunnel-codex-absent-'));
  const server = createProxyServer({ token, dataDir: directory, reverseProxy: true });
  const url = await server.listen(0);
  t.after(async () => {
    await server.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const messages: ServerMessage[] = [];
  const socket = new WebSocket(url.replace('http', 'ws') + '/ws');
  socket.on('message', (raw) =>
    messages.push(serverMessageSchema.parse(JSON.parse(raw.toString()))),
  );
  t.after(() => socket.terminate());
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  socket.send(
    JSON.stringify({
      type: 'auth',
      token,
      protocolVersion: PROTOCOL_VERSION,
      deviceName: '测试设备',
    }),
  );
  async function wait(predicate: (message: ServerMessage) => boolean) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const index = messages.findIndex(predicate);
      if (index >= 0) return messages.splice(index, 1)[0]!;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Timed out waiting for server message');
  }
  assert.equal((await wait((item) => item.type === 'ready')).type, 'ready');
  const requestId = randomUUID();
  socket.send(JSON.stringify({ type: 'account.status', requestId, provider: 'openai' }));
  const response = await wait((item) => item.type === 'response' && item.requestId === requestId);
  assert.equal(response.type, 'response');
  assert.equal(response.ok, true);
  const state = await wait((item) => item.type === 'account.state');
  assert.equal(state.type, 'account.state');
  assert.equal(state.runtime, 'absent');
  assert.equal(state.loggedIn, false);
});

test('a model error stays on the OpenAI session', async (t) => {
  const { request, wait, claudeStillWorks } = await serve(t, {
    executable: 'codex',
    profileId: 'test',
    worker: modelErrorWorker,
    failureLimit: 1,
    restartDelayMs: [60_000],
    openMs: 60_000,
  });
  const created = await request({
    type: 'session.create',
    title: '模型',
    projectPath: 'D:\\openai',
    provider: 'openai',
    profileId: 'test',
  });
  assert.equal(created.ok, true);
  const sent = await request({
    type: 'message.send',
    sessionId: created.sessionId,
    text: 'hi',
    scenario: 'chat',
  });
  assert.equal(sent.ok, true);
  await wait(
    (item) =>
      item.type === 'session.event' &&
      item.event.payload.type === 'run.error' &&
      item.event.payload.code === 'model_error',
  );
  await claudeStillWorks();
});

test('an OpenAI event flood stops that run and Claude can still be read', async (t) => {
  const { request, wait, claudeStillWorks } = await serve(t, {
    executable: 'codex',
    profileId: 'test',
    worker: floodWorker,
    failureLimit: 1,
    restartDelayMs: [60_000],
    openMs: 60_000,
  });
  const created = await request({
    type: 'session.create',
    title: '洪泛',
    projectPath: 'D:\\openai',
    provider: 'openai',
    profileId: 'test',
  });
  assert.equal(created.ok, true);
  const sent = await request({
    type: 'message.send',
    sessionId: created.sessionId,
    text: 'hi',
    scenario: 'chat',
  });
  assert.equal(sent.ok, true);
  await wait(
    (item) =>
      item.type === 'session.event' &&
      item.event.payload.type === 'run.error' &&
      item.event.payload.code === 'codex_limited',
  );
  await wait(
    (item) =>
      item.type === 'session.event' &&
      item.event.payload.type === 'run.status' &&
      item.event.payload.status === 'failed',
  );
  await claudeStillWorks();
});

test('logging out of OpenAI does not start Claude again', async (t) => {
  const { server, directory, request, claudeStillWorks } = await serve(t, {
    executable: codexApp,
    profileId: 'test',
    failureLimit: 1,
    restartDelayMs: [60_000],
    openMs: 60_000,
  });
  await server.codex!.whenReady();
  await server.native!.ready();
  const starts = readFileSync(join(directory, 'claude-starts'), 'utf8');
  const logged = await request({ type: 'account.logout', provider: 'openai' });
  assert.equal(logged.ok, true);
  assert.equal(readFileSync(join(directory, 'claude-starts'), 'utf8'), starts);
  await claudeStillWorks();
});

test('a running Codex command is a background task and can be stopped on its own', async (t) => {
  const { server, request, wait } = await serve(t, {
    executable: codexApp,
    profileId: 'test',
    failureLimit: 1,
    restartDelayMs: [60_000],
    openMs: 60_000,
  });
  await server.codex!.whenReady();
  const created = await request({
    type: 'session.create',
    title: '命令',
    projectPath: 'D:\\openai',
    provider: 'openai',
    profileId: 'test',
  });
  assert.equal(created.ok, true);
  const sessionId = created.sessionId!;
  const sent = await request({
    type: 'message.send',
    sessionId,
    text: 'background-cmd',
    scenario: 'chat',
  });
  assert.equal(sent.ok, true);
  const listed = await wait(
    (item) =>
      item.type === 'session.event' &&
      item.event.sessionId === sessionId &&
      item.event.payload.type === 'native.tasks' &&
      item.event.payload.tasks.length === 1,
  );
  assert.equal(listed.type, 'session.event');
  if (listed.event.payload.type !== 'native.tasks') throw new Error('expected the command');
  assert.equal(listed.event.payload.tasks[0]?.description, 'sleep 30');
  const run = server.store.get(sessionId).session.activeRun;
  assert.equal(run?.waiting, 'background');
  const stopped = await request({
    type: 'run.task.stop',
    sessionId,
    runId: run!.id,
    taskId: 'cmd_1',
  });
  assert.equal(stopped.ok, true);
  await wait(
    (item) =>
      item.type === 'session.event' &&
      item.event.sessionId === sessionId &&
      item.event.payload.type === 'run.status' &&
      item.event.payload.status === 'completed',
  );
});

test('a Codex that cannot cancel one command says the whole turn can still stop', async (t) => {
  const { server, request, wait } = await serve(t, {
    executable: codexApp,
    profileId: 'test',
    failureLimit: 1,
    restartDelayMs: [60_000],
    openMs: 60_000,
  });
  await server.codex!.whenReady();
  const created = await request({
    type: 'session.create',
    title: '停不了',
    projectPath: 'D:\\openai',
    provider: 'openai',
    profileId: 'test',
  });
  assert.equal(created.ok, true);
  const sessionId = created.sessionId!;
  const sent = await request({
    type: 'message.send',
    sessionId,
    text: 'background-stuck',
    scenario: 'chat',
  });
  assert.equal(sent.ok, true);
  await wait(
    (item) =>
      item.type === 'session.event' &&
      item.event.sessionId === sessionId &&
      item.event.payload.type === 'native.tasks',
  );
  const run = server.store.get(sessionId).session.activeRun;
  assert.ok(run);
  const stopped = await request({
    type: 'run.task.stop',
    sessionId,
    runId: run.id,
    taskId: 'cmd_stuck',
  });
  assert.equal(stopped.ok, true);
  const notice = await wait(
    (item) =>
      item.type === 'session.event' &&
      item.event.sessionId === sessionId &&
      item.event.payload.type === 'native.notice',
  );
  assert.equal(notice.type, 'session.event');
  if (notice.event.payload.type !== 'native.notice') throw new Error('expected the stop notice');
  assert.match(notice.event.payload.text, /不能单独停止/);
  assert.equal(server.store.get(sessionId).session.activeRun?.id, run.id);
  const cancelled = await request({ type: 'run.cancel', sessionId, runId: run.id });
  assert.equal(cancelled.ok, true);
});

test('the Codex path can change without restarting Claude, and a missing path keeps the last one', async (t) => {
  const { server, directory, request, wait, claudeStillWorks } = await serve(t, {
    executable: codexApp,
    profileId: 'test',
    failureLimit: 1,
    restartDelayMs: [60_000],
    openMs: 60_000,
  });
  await server.codex!.whenReady();
  await server.native!.ready();
  const starts = readFileSync(join(directory, 'claude-starts'), 'utf8');
  const missing = await request({
    type: 'openai.path',
    path: join(directory, 'missing-codex'),
  });
  assert.equal(missing.ok, false);
  assert.match(missing.type === 'response' ? (missing.message ?? '') : '', /找不到/);
  assert.equal(server.codex!.availability(), 'ready');
  const slash = codexApp.replaceAll('\\', '/');
  const saved = await request({ type: 'openai.path', path: slash === codexApp ? codexApp : slash });
  assert.equal(saved.ok, true);
  assert.equal(readFileSync(join(directory, 'CODEX_PATH'), 'utf8').trim(), slash === codexApp ? codexApp : slash);
  await server.codex!.whenReady();
  const created = await request({
    type: 'session.create',
    title: '换路径',
    projectPath: 'D:\\openai',
    provider: 'openai',
    profileId: 'test',
  });
  assert.equal(created.ok, true);
  const sent = await request({
    type: 'message.send',
    sessionId: created.sessionId,
    text: '你好',
    scenario: 'chat',
  });
  assert.equal(sent.ok, true);
  await wait(
    (item) =>
      item.type === 'session.fragment' &&
      item.sessionId === created.sessionId &&
      item.payload.type === 'text.delta' &&
      item.payload.text === 'pong',
  );
  const cleared = await request({ type: 'openai.path', path: '  ' });
  assert.equal(cleared.ok, true);
  const state = await wait((item) => item.type === 'account.state' && item.runtime === 'absent');
  assert.equal(state.type, 'account.state');
  assert.equal(state.runtime, 'absent');
  assert.equal(readFileSync(join(directory, 'CODEX_PATH'), 'utf8').trim(), '');
  assert.equal(readFileSync(join(directory, 'claude-starts'), 'utf8'), starts);
  await claudeStillWorks();
});

test('an empty session takes its vendor from the model, and a started one does not', async (t) => {
  const { server, request } = await serve(t, {
    executable: codexApp,
    profileId: 'test',
    failureLimit: 1,
    restartDelayMs: [60_000],
    openMs: 60_000,
  });
  await server.codex!.whenReady();
  const created = await request({
    type: 'session.create',
    title: '新会话',
    projectPath: 'D:\\work',
  });
  assert.equal(created.ok, true);
  const sessionId = created.sessionId!;
  const switched = await request({
    type: 'session.configure',
    sessionId,
    permissionMode: 'auto',
    provider: 'openai',
    model: 'gpt-test',
  });
  assert.equal(switched.ok, true);
  const session = server.store.get(sessionId).session;
  assert.equal(session.provider, 'openai');
  assert.equal(session.model, 'gpt-test');
  assert.equal(session.profileId, 'test');
  server.store.append(sessionId, randomUUID(), {
    type: 'message.user',
    messageId: randomUUID(),
    text: '已经开始',
    scenario: 'chat',
  });
  const denied = await request({
    type: 'session.configure',
    sessionId,
    permissionMode: 'auto',
    provider: 'claude',
  });
  assert.equal(denied.ok, false);
  assert.match(denied.message ?? '', /已经有对话/);
  assert.equal(server.store.get(sessionId).session.provider, 'openai');
});
