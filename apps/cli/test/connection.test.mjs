import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WebSocketServer } from 'ws';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import { openConnection } from '../src/connection.mjs';

const CONNECTION = '33333333-3333-4333-8333-333333333333';
const SESSION = '11111111-1111-4111-8111-111111111111';

async function service(onMessage) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve) => server.once('listening', resolve));
  server.on('connection', (socket) =>
    socket.on('message', (raw) => onMessage(socket, JSON.parse(raw.toString()))),
  );
  return { url: `ws://127.0.0.1:${server.address().port}`, close: () => server.close() };
}
const ready = {
  type: 'ready',
  protocolVersion: PROTOCOL_VERSION,
  connectionId: CONNECTION,
  adapter: 'claude-code',
  version: '0.2.5',
  sessions: [],
};

test('connection authenticates, answers requests and passes terminal frames', async () => {
  const fake = await service((socket, message) => {
    if (message.type === 'auth') {
      assert.equal(message.protocolVersion, PROTOCOL_VERSION);
      assert.equal(message.token, 't'.repeat(30));
      socket.send(JSON.stringify(ready));
    } else if (message.type === 'terminal.open') {
      socket.send(
        JSON.stringify({
          type: 'response',
          requestId: message.requestId,
          ok: true,
          sessionId: SESSION,
        }),
      );
      socket.send(
        JSON.stringify({ type: 'terminal.opened', sessionId: SESSION, terminalId: CONNECTION }),
      );
    } else if (message.type === 'session.status') {
      socket.send(
        JSON.stringify({
          type: 'response',
          requestId: message.requestId,
          ok: false,
          code: 'native_busy',
          message: '忙',
        }),
      );
    }
  });
  try {
    const connection = await openConnection(fake.url, 't'.repeat(30));
    assert.equal(connection.ready.connectionId, CONNECTION);
    const frames = [];
    connection.onTerminal((message) => frames.push(message.type));
    await connection.request({ type: 'terminal.open', sessionId: SESSION, cols: 80, rows: 24 });
    await assert.rejects(connection.request({ type: 'session.status', sessionId: SESSION }), /忙/);
    assert.deepEqual(frames, ['terminal.opened']);
    connection.close();
    assert.equal(await connection.closed, null);
  } finally {
    fake.close();
  }
});

test('a refused connection reports the service reason', async () => {
  const fake = await service((socket) => {
    socket.send(
      JSON.stringify({
        type: 'connection.error',
        code: 'version_mismatch',
        message: 'x',
        service: '0.3.0',
      }),
    );
    socket.close();
  });
  try {
    await assert.rejects(openConnection(fake.url, 't'.repeat(30)), /0\.3\.0.*一起升级/);
  } finally {
    fake.close();
  }
});
