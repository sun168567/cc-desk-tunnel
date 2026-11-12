import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { connect } from 'node:net';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { PROTOCOL_VERSION, TUNNEL_CLOSE } from '@cc-desk-tunnel/protocol';

// Keep a native-mode run alive until cancelled, without starting Claude or reading its credentials.
const claudeStub = `
  export const quotas = {};
  export function runClaude(_options, run) {
    return new Promise(resolve => {
      if (run.signal.aborted) resolve('cancelled');
      else run.signal.addEventListener('abort', () => resolve('cancelled'), { once: true });
    });
  }
  export function nativeDirectory() { throw new Error('Unexpected native access'); }
  export function prepareNativeDirectory() { throw new Error('Unexpected native access'); }
  export function readNativeStatus() { throw new Error('Unexpected native access'); }
`;
const sdkStub = `
  const fail = () => { throw new Error('Unexpected SDK access'); };
  export const deleteSession = fail, forkSession = fail, getSessionInfo = fail,
    getSessionMessages = fail, renameSession = fail;
`;
const stub = (source: string) => `data:text/javascript,${encodeURIComponent(source)}`;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === './claude.ts' && context.parentURL?.endsWith('/server.ts'))
      return { url: stub(claudeStub), shortCircuit: true };
    if (specifier === '@anthropic-ai/claude-agent-sdk')
      return { url: stub(sdkStub), shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
const { createProxyServer } = await import('../src/server.ts');
hooks.deregister();

type Message = { type: string; [key: string]: any };
const token = `control-test-${randomUUID()}`;

async function fixture(t: TestContext, graceMs = 800) {
  const directory = mkdtempSync(join(tmpdir(), 'cc-desk-control-test-'));
  const server = createProxyServer({
    token,
    dataDir: directory,
    reverseProxy: true,
    claude: { executable: 'unused' },
    graceMs,
    tunnel: { probe: async () => {} },
  });
  const url = (await server.listen(0)).replace('http', 'ws') + '/ws';
  const sockets: (WebSocket | Socket)[] = [];
  t.after(async () => {
    for (const socket of sockets) 'terminate' in socket ? socket.terminate() : socket.destroy();
    await server.close();
    rmSync(directory, { recursive: true, force: true });
  });

  async function socket() {
    const ws = new WebSocket(url);
    sockets.push(ws);
    await once(ws, 'open');
    return ws;
  }
  async function signIn(device: string, tunnel: boolean, authToken = token) {
    const ws = await socket();
    const messages: Message[] = [];
    ws.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
    const next = async (predicate: (message: Message) => boolean) => {
      for (let attempt = 0; attempt < 600; attempt++) {
        const index = messages.findIndex(predicate);
        if (index >= 0) return messages.splice(index, 1)[0]!;
        await delay(5);
      }
      throw new Error(`Timed out waiting for message: ${JSON.stringify(messages)}`);
    };
    const send = (message: object) => ws.send(JSON.stringify(message));
    const request = async (command: object) => {
      const requestId = randomUUID();
      send({ ...command, requestId });
      return next((message) => message.type === 'response' && message.requestId === requestId);
    };
    send({
      type: 'auth',
      token: authToken,
      protocolVersion: PROTOCOL_VERSION,
      deviceName: 'test',
      tunnel,
    });
    const ready = await next(
      (message) => message.type === 'ready' || message.type === 'connection.error',
    );
    if (ready.type === 'ready') send({ type: 'device', id: device });
    return { ws, messages, next, send, request, ready, connectionId: ready.connectionId as string };
  }
  async function register(client: Awaited<ReturnType<typeof signIn>>, offer: Message) {
    client.send({
      type: 'tunnel.credentials',
      connectionId: client.connectionId,
      username: 'test',
      privateKey: 'unused',
      hostPublicKey: 'ssh-ed25519 AAAA',
    });
    await client.next((message) => message.type === 'tunnel.ready');
    return offer.secret as string;
  }
  async function device(id: string) {
    const client = await signIn(id, true);
    const offer = await client.next((message) => message.type === 'tunnel.offer');
    return { ...client, secret: await register(client, offer) };
  }
  async function create(client: Awaited<ReturnType<typeof signIn>>) {
    const result = await client.request({
      type: 'session.create',
      title: 'test',
      projectPath: 'D:\\test',
    });
    assert.equal(result.ok, true);
    return result.sessionId as string;
  }
  const message = (sessionId: string) => ({ type: 'message.send', sessionId, text: 'test' });
  return { directory, server, sockets, socket, signIn, register, device, create, message };
}

test('same-device control-only requests use the existing tunnel without taking it over', async (t) => {
  const f = await fixture(t);
  const id = randomUUID();
  const owner = await f.device(id);
  const control = await f.signIn(id, false);
  const sessionId = await f.create(control);
  assert.equal((await control.request(f.message(sessionId))).ok, true);

  const config = readFileSync(join(f.directory, 'devices', id, 'ssh_config'), 'utf8');
  const port = Number(/Port (\d+)/.exec(config)?.[1]);
  assert.ok(port > 0);
  const ssh = connect(port, '127.0.0.1');
  f.sockets.push(ssh);
  await once(ssh, 'connect');
  const open = await owner.next((message) => message.type === 'tunnel.open');
  assert.equal(open.connectionId, owner.connectionId);
  const wrong = await f.socket();
  wrong.send(
    JSON.stringify({
      type: 'tunnel.attach',
      connectionId: control.connectionId,
      channelId: open.channelId,
      secret: owner.secret,
    }),
  );
  assert.equal((await once(wrong, 'close'))[0], TUNNEL_CLOSE.unknown);
  const channel = await f.socket();
  channel.send(
    JSON.stringify({
      type: 'tunnel.attach',
      connectionId: owner.connectionId,
      channelId: open.channelId,
      secret: owner.secret,
    }),
  );
  const fromDevice = once(ssh, 'data');
  channel.send(Buffer.from('device'));
  assert.equal((await fromDevice)[0].toString(), 'device');
  const fromHost = once(channel, 'message');
  ssh.write('host');
  assert.equal((await fromHost)[0].toString(), 'host');
  assert.equal(
    control.messages.some((message) => message.type.startsWith('tunnel.')),
    false,
  );
});

test('a same-device peer requesting a tunnel must wait for its own tunnel', async (t) => {
  const f = await fixture(t);
  const id = randomUUID();
  const owner = await f.device(id);
  const sessionId = await f.create(owner);
  const pending = await f.signIn(id, true);
  const offer = await pending.next((message) => message.type === 'tunnel.offer');
  const denied = await pending.request(f.message(sessionId));
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'execution_offline');
  await f.register(pending, offer);
  assert.equal((await pending.request(f.message(sessionId))).ok, true);
});

test('another device still authenticates and can only use a ready target device', async (t) => {
  const f = await fixture(t);
  const owner = await f.device(randomUUID());
  const ownerSession = await f.create(owner);
  const rejected = await f.signIn(randomUUID(), false, 'wrong-token-with-enough-length');
  assert.equal(rejected.ready.type, 'connection.error');
  assert.equal(rejected.ready.code, 'unauthorized');
  const other = await f.signIn(randomUUID(), false);
  const otherSession = await f.create(other);
  const denied = await other.request(f.message(otherSession));
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'execution_offline');
  assert.equal((await other.request(f.message(ownerSession))).ok, true);
});

test('control-only peers do not hide a lost tunnel or prevent the grace period ending', async (t) => {
  const f = await fixture(t);
  const id = randomUUID();
  const owner = await f.device(id);
  const control = await f.signIn(id, false);
  const sessionId = await f.create(owner);
  const nextSession = await f.create(control);
  await control.request({ type: 'session.subscribe', sessionId, afterSequence: 0 });
  await control.next(
    (message) => message.type === 'session.snapshot' && message.session.id === sessionId,
  );
  assert.equal((await owner.request(f.message(sessionId))).ok, true);
  await control.next(
    (message) =>
      message.type === 'session.event' &&
      message.event.payload.type === 'run.status' &&
      message.event.payload.status === 'running',
  );
  control.messages.splice(
    0,
    control.messages.length,
    ...control.messages.filter((message) => message.type !== 'devices'),
  );
  owner.ws.terminate();
  await control.next(
    (message) =>
      message.type === 'devices' &&
      !message.devices.some(
        (device: { id: string; ready: boolean }) => device.id === id && device.ready,
      ),
  );
  const denied = await control.request(f.message(nextSession));
  assert.equal(denied.ok, false);
  assert.ok(['device_offline', 'execution_offline'].includes(denied.code));
  await control.request({ type: 'session.subscribe', sessionId, afterSequence: 0 });
  const snapshot = await control.next(
    (message) => message.type === 'session.snapshot' && message.session.id === sessionId,
  );
  assert.ok(snapshot.session.activeRun);
  const late = await f.signIn(id, false);
  assert.equal(late.ready.type, 'ready');
  const stopped = await control.next(
    (message) =>
      message.type === 'session.event' &&
      message.event.payload.type === 'run.status' &&
      message.event.payload.status === 'cancelled',
  );
  assert.match(stopped.event.payload.reason, /设备离线/);
  assert.equal(control.ws.readyState, WebSocket.OPEN);
});

test('an execution tunnel returning during grace keeps its existing run', async (t) => {
  const f = await fixture(t, 1200);
  const id = randomUUID();
  const owner = await f.device(id);
  const control = await f.signIn(id, false);
  const sessionId = await f.create(owner);
  await control.request({ type: 'session.subscribe', sessionId, afterSequence: 0 });
  await control.next(
    (message) => message.type === 'session.snapshot' && message.session.id === sessionId,
  );
  assert.equal((await owner.request(f.message(sessionId))).ok, true);
  await control.next(
    (message) =>
      message.type === 'session.event' &&
      message.event.payload.type === 'run.status' &&
      message.event.payload.status === 'running',
  );
  control.messages.splice(
    0,
    control.messages.length,
    ...control.messages.filter((message) => message.type !== 'devices'),
  );
  owner.ws.terminate();
  await control.next(
    (message) =>
      message.type === 'devices' &&
      !message.devices.some(
        (device: { id: string; ready: boolean }) => device.id === id && device.ready,
      ),
  );
  const reconnected = await f.device(id);
  await control.next(
    (message) =>
      message.type === 'devices' &&
      message.devices.some(
        (device: { id: string; ready: boolean }) => device.id === id && device.ready,
      ),
  );
  await delay(1400);
  await control.request({ type: 'session.subscribe', sessionId, afterSequence: 0 });
  const snapshot = await control.next(
    (message) => message.type === 'session.snapshot' && message.session.id === sessionId,
  );
  assert.ok(snapshot.session.activeRun);
  assert.equal(reconnected.ws.readyState, WebSocket.OPEN);
});
