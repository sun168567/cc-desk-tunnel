import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID, X509Certificate } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:https';
import { connect, createServer as createRelay } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import {
  certificateMatches,
  connectionWaits,
  controlTlsOptions,
  openProxyBridge,
} from '../electron/proxy-bridge.mjs';
import { Sender, WebSocket, WebSocketServer } from 'ws';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import { defaultCertificate } from '../../server/test/fixtures/web-certificates.ts';

test('WSS pin comparison rejects empty, malformed and mismatched fingerprints', () => {
  const pin = Array(32).fill('AB').join(':');
  assert.equal(certificateMatches(pin, pin.toLowerCase().replaceAll(':', '')), true);
  assert.equal(certificateMatches(pin, 'invalid'), false);
  assert.equal(certificateMatches(undefined, pin), false);
  assert.equal(certificateMatches('CD'.repeat(32), pin), false);
  assert.equal(certificateMatches(':'.repeat(64), ':'.repeat(64)), false);
});
test('native desktop refuses plaintext control connections', async () => {
  await assert.rejects(
    openProxyBridge({ url: 'ws://example.com/ws', fingerprint: 'AB'.repeat(32) }, {}),
    /WSS/,
  );
});
test('empty certificate pin enables strict CA verification; malformed pins never disable verification', () => {
  assert.deepEqual(controlTlsOptions({ fingerprint: '' }), { rejectUnauthorized: true });
  assert.deepEqual(controlTlsOptions({}), { rejectUnauthorized: true });
  assert.deepEqual(controlTlsOptions({ fingerprint: 'AB'.repeat(32) }), {
    rejectUnauthorized: false,
  });
  assert.throws(() => controlTlsOptions({ fingerprint: 'invalid' }), /SHA256/);
});
test('local browser test bridge only accepts its explicitly configured origin', async () => {
  const bridge = await openProxyBridge(
    { url: 'wss://127.0.0.1:1/ws', fingerprint: 'AB'.repeat(32) },
    {},
    () => {},
    ['http://127.0.0.1:15873'],
  );
  try {
    const socket = new WebSocket(bridge.url, { origin: 'http://untrusted.example' });
    await assert.rejects(
      new Promise((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
      }),
      /403/,
    );
  } finally {
    await bridge.close();
  }
});

test('connection waits take the defaults unless given sensible seconds, and the whole outlasts SSH', () => {
  assert.deepEqual(connectionWaits(undefined), { connect: 15000, ssh: 10000, ready: 45000 });
  assert.deepEqual(connectionWaits({ connect: 4, ssh: '30', ready: 601 }), {
    connect: 15000,
    ssh: 10000,
    ready: 45000,
  });
  assert.deepEqual(connectionWaits({ connect: 30, ssh: 40, ready: 50 }), {
    connect: 30000,
    ssh: 40000,
    ready: 75000,
  });
});

test(
  'an incomplete history frame reports local byte progress and stays alive; silence still times out',
  { timeout: 10000 },
  async (t) => {
    const service = createServer(defaultCertificate);
    // The service sends no pong; only the incoming frame bytes can keep the bridge alive.
    const wss = new WebSocketServer({ server: service, autoPong: false });
    let bridge;
    t.after(async () => {
      for (const socket of wss.clients) socket.terminate();
      await bridge?.close();
      await new Promise((resolve) => wss.close(resolve));
      await new Promise((resolve) => service.close(resolve));
    });
    service.listen(0, '127.0.0.1');
    await once(service, 'listening');
    const lines = [];
    bridge = await openProxyBridge(
      {
        url: `wss://127.0.0.1:${service.address().port}/ws`,
        fingerprint: new X509Certificate(defaultCertificate.cert).fingerprint256,
      },
      { heartbeatMs: 200, log: (line) => lines.push(line) },
    );
    const connection = once(wss, 'connection');
    const local = new WebSocket(bridge.url);
    await once(local, 'open');
    const [remote] = await connection;
    let pings = 0;
    let pongs = 0;
    remote.on('ping', () => pings++);
    remote.on('pong', () => pongs++);
    const ready = once(local, 'message');
    remote.send(
      JSON.stringify({
        type: 'ready',
        protocolVersion: PROTOCOL_VERSION,
        version: '0.3.14',
        connectionId: randomUUID(),
        adapter: 'simulation',
        sessions: [],
      }),
    );
    await ready;
    // Receiving data without a pending history request must not add unsolicited pongs.
    await delay(240);
    assert.equal(pongs, 0);

    const sessionId = randomUUID(),
      now = new Date().toISOString();
    const page = {
      type: 'session.snapshot',
      requestId: randomUUID(),
      session: {
        id: sessionId,
        title: 'slow history',
        projectPath: 'D:\\test',
        permissionMode: 'auto',
        createdAt: now,
        updatedAt: now,
        activeRun: null,
      },
      mode: 'replace',
      firstSequence: 1,
      lastSequence: 1,
      hasEarlier: false,
      events: [
        {
          sessionId,
          runId: randomUUID(),
          sequence: 1,
          createdAt: now,
          payload: { type: 'text.delta', messageId: randomUUID(), text: 'a'.repeat(128 * 1024) },
        },
      ],
    };
    // Send one unfragmented WebSocket frame slowly over TLS, as a large snapshot travels on a slow connection.
    const frame = Buffer.concat(
      Sender.frame(Buffer.from(JSON.stringify(page)), { fin: true, opcode: 1, mask: false }),
    );
    const command = {
      type: 'session.history',
      requestId: page.requestId,
      sessionId,
      beforeSequence: 2,
    };
    const commands = [];
    remote.on('message', (raw) => commands.push(JSON.parse(String(raw))));
    const requested = once(remote, 'message');
    local.send(JSON.stringify(command));
    await requested;
    const progress = [];
    const received = new Promise((resolve) => {
      local.on('message', (raw) => {
        const message = JSON.parse(String(raw));
        if (message.type === 'client.history.progress') progress.push(message);
        if (message.type === 'session.snapshot') resolve(message);
      });
    });
    for (let offset = 0; offset < frame.length; offset += 4096) {
      remote._socket.write(frame.subarray(offset, offset + 4096));
      await delay(40);
    }
    assert.deepEqual(await received, page);
    assert.ok(
      progress.some(
        (item) => !item.processing && item.received > 0 && item.received < frame.length,
      ),
    );
    assert.equal(progress.at(-1).received, frame.length);
    assert.equal(progress.at(-1).historyReceived, Buffer.byteLength(JSON.stringify(page)));
    assert.equal(progress.at(-1).processing, true);
    assert.ok(
      progress.every((item) => item.requestId === page.requestId && item.sessionId === sessionId),
    );
    assert.deepEqual(commands, [command]);
    assert.ok(pings >= 2);
    assert.ok(pongs >= 2);
    const completedPongs = pongs;
    assert.equal(
      lines.some((line) => line.startsWith('Connection given up')),
      false,
    );

    // No further data or pong: the existing silence detection must still end the connection.
    const [raw] = await once(local, 'message');
    assert.equal(JSON.parse(String(raw)).code, 'connection_lost');
    assert.match(String(raw), /没有收到服务端的任何数据/);
    assert.equal(pongs, completedPongs);
  },
);

for (const [type, stalled] of [
  ['session.subscribe', false],
  ['session.history', false],
  ['session.history', true],
]) {
  test(
    `${type}: unsolicited pongs ${stalled ? 'stop when history bytes stop arriving' : 'keep a slow history frame past the service heartbeat deadline'}`,
    { timeout: 10000 },
    async (t) => {
      const service = createServer(defaultCertificate);
      const wss = new WebSocketServer({ server: service });
      const links = [];
      let throttled = false;
      let delivered = 0;
      let serviceTimedOut = false;
      // Slow only the service-to-client direction, leaving the return path free for control frames.
      const relay = createRelay((downstream) => {
        const upstream = connect(service.address().port, '127.0.0.1');
        links.push([downstream, upstream]);
        const queued = [];
        downstream.pipe(upstream);
        upstream.on('data', (chunk) => (throttled ? queued.push(chunk) : downstream.write(chunk)));
        const timer = setInterval(() => {
          if (!queued.length || downstream.destroyed || (stalled && delivered >= 32768)) return;
          const chunk = queued[0].subarray(0, 4096);
          delivered += chunk.length;
          downstream.write(chunk);
          if (chunk.length === queued[0].length) queued.shift();
          else queued[0] = queued[0].subarray(chunk.length);
        }, 10);
        const stop = () => {
          clearInterval(timer);
          downstream.destroy();
          upstream.destroy();
        };
        downstream.on('close', stop).on('error', stop);
        upstream.on('close', stop).on('error', stop);
      });
      let bridge;
      t.after(async () => {
        for (const socket of wss.clients) socket.terminate();
        await bridge?.close();
        for (const pair of links) for (const socket of pair) socket.destroy();
        await new Promise((resolve) => relay.close(resolve));
        await new Promise((resolve) => wss.close(resolve));
        await new Promise((resolve) => service.close(resolve));
      });
      service.listen(0, '127.0.0.1');
      await once(service, 'listening');
      relay.listen(0, '127.0.0.1');
      await once(relay, 'listening');
      bridge = await openProxyBridge(
        {
          url: `wss://127.0.0.1:${relay.address().port}/ws`,
          fingerprint: new X509Certificate(defaultCertificate.cert).fingerprint256,
        },
        { heartbeatMs: 100, historyIdleMs: 400 },
      );
      const connection = once(wss, 'connection');
      const local = new WebSocket(bridge.url);
      await once(local, 'open');
      const [remote] = await connection;
      const ready = once(local, 'message');
      remote.send(
        JSON.stringify({
          type: 'ready',
          protocolVersion: PROTOCOL_VERSION,
          version: '0.3.14',
          connectionId: randomUUID(),
          adapter: 'simulation',
          sessions: [],
        }),
      );
      await ready;
      const command = {
        type,
        requestId: randomUUID(),
        sessionId: randomUUID(),
        ...(type === 'session.history' ? { beforeSequence: 2 } : { afterSequence: 0 }),
      };
      const commands = [];
      remote.on('message', (raw) => commands.push(JSON.parse(String(raw))));
      const requested = once(remote, 'message');
      local.send(JSON.stringify(command));
      await requested;

      // The production service's missed-pong rule, with 15 seconds scaled down to 100 ms.
      let missed = 0;
      let ticks = 0;
      let unsolicited = 0;
      remote.on('pong', (data) => {
        missed = 0;
        if (!data.length) unsolicited++;
      });
      const heartbeat = setInterval(() => {
        ticks++;
        if (missed >= 2) {
          serviceTimedOut = true;
          remote.terminate();
          return;
        }
        missed++;
        remote.ping('service-check');
      }, 100);
      remote.once('close', () => clearInterval(heartbeat));
      t.after(() => clearInterval(heartbeat));
      const done = new Promise((resolve) => {
        local.on('message', (raw) => {
          const message = JSON.parse(String(raw));
          if (message.type === 'session.snapshot') resolve(message);
        });
        local.on('close', () => resolve(null));
      });
      throttled = true;
      const now = new Date().toISOString();
      const page = {
        type: 'session.snapshot',
        requestId: command.requestId,
        session: {
          id: command.sessionId,
          title: 'slow history',
          projectPath: 'D:\\test',
          permissionMode: 'auto',
          createdAt: now,
          updatedAt: now,
          activeRun: null,
        },
        mode: 'replace',
        firstSequence: 1,
        lastSequence: 1,
        hasEarlier: false,
        events: [
          {
            sessionId: command.sessionId,
            runId: randomUUID(),
            sequence: 1,
            createdAt: now,
            payload: { type: 'text.delta', messageId: randomUUID(), text: 'a'.repeat(256 * 1024) },
          },
        ],
      };
      remote.send(JSON.stringify(page));
      assert.deepEqual(await done, stalled ? null : page);
      if (!stalled) assert.equal(serviceTimedOut, false);
      assert.ok(delivered > 16384);
      if (!stalled) {
        assert.ok(ticks >= 4);
        assert.ok(unsolicited >= 3);
      }
      assert.deepEqual(commands, [command]);
    },
  );
}
