import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { commandSchema, serverMessageSchema, webProxyDetectSchema } from '../src/index.ts';

test('proxy detection accepts only a request ID, never a client-selected target or trust setting', () => {
  const command = { type: 'web.proxy.detect', requestId: randomUUID() };
  assert.deepEqual(commandSchema.parse(command), command);
  for (const extra of [
    { url: 'https://attacker.example.test' },
    { publicOrigin: 'https://attacker.example.test' },
    { path: 'another' },
    { trustedProxies: ['127.0.0.1'] },
    { proxyEnabled: true },
  ])
    assert.equal(webProxyDetectSchema.safeParse({ ...command, ...extra }).success, false);
});

test('proxy detection replies carry a valid observed IP and the saved public target', () => {
  const reply = {
    type: 'web.proxy.detected',
    requestId: randomUUID(),
    address: '172.26.0.1',
    publicOrigin: 'https://web.example.test:1443',
    path: 'private',
  };
  assert.deepEqual(serverMessageSchema.parse(reply), reply);
  assert.equal(serverMessageSchema.safeParse({ ...reply, address: '2001:db8::1' }).success, true);
  for (const address of ['invalid', '172.26.0.1, 127.0.0.1', '172.26.0.1/24'])
    assert.equal(serverMessageSchema.safeParse({ ...reply, address }).success, false);
  for (const publicOrigin of ['', 'http://web.example.test', 'https://web.example.test/path'])
    assert.equal(serverMessageSchema.safeParse({ ...reply, publicOrigin }).success, false);
});
