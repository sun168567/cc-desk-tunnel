import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  certificateMatches,
  controlTlsOptions,
  openProxyBridge,
} from '../electron/proxy-bridge.mjs';
import { WebSocket } from 'ws';

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
