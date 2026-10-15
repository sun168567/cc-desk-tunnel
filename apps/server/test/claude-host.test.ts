import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { PROTOCOL_VERSION, serverMessageSchema } from '@cc-desk-tunnel/protocol';
import type { ServerMessage } from '@cc-desk-tunnel/protocol';
import { createProxyServer } from '../src/server.ts';

const token = 'claude-host-' + randomUUID();
const worker = fileURLToPath(new URL('./fixtures/claude-worker.ts', import.meta.url));

test('a dead Claude worker leaves history readable and rejects new native commands', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'cc-desk-tunnel-claude-host-'));
  const server = createProxyServer({
    token,
    dataDir: directory,
    reverseProxy: true,
    tunnel: {},
    claude: {
      executable: 'claude',
      worker,
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
  assert.ok(server.native);
  await server.native.ready();

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
    title: '保留的会话',
    projectPath: 'D:\\work',
  });
  assert.equal(created.ok, true);
  const sessionId = created.sessionId!;
  const settings = await request({ type: 'settings.get' });
  assert.equal(settings.ok, true);
  server.store.append(sessionId, randomUUID(), {
    type: 'message.user',
    messageId: randomUUID(),
    text: '仍在',
    scenario: 'chat',
  });

  const exited = server.native.exited();
  server.native.terminate();
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
  const denied = await request({ type: 'settings.get' });
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.code, 'native_unavailable');
});
