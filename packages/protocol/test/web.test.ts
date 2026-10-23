import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  webPublicOriginSchema,
  webSettingsValuesSchema,
  webStoredSettingsSchema,
} from '../src/web.ts';

test('public Web origins preserve an explicit HTTPS port and reject non-origin input', () => {
  for (const [input, expected] of [
    ['', ''],
    [' HTTPS://WEB.EXAMPLE.TEST:1443/ ', 'https://web.example.test:1443'],
    ['https://web.example.test:443', 'https://web.example.test'],
    ['https://192.0.2.100:8787', 'https://192.0.2.100:8787'],
    ['https://[::1]:8787', 'https://[::1]:8787'],
  ])
    assert.equal(webPublicOriginSchema.parse(input), expected);
  for (const input of [
    'http://web.example.test',
    'wss://web.example.test',
    'https://web.example.test:0',
    'https://web.example.test:65536',
    'https://user:secret@web.example.test',
    'https://user@web.example.test',
    'https://web.example.test/path',
    'https://web.example.test/?token=secret',
    'https://web.example.test/#fragment',
    'https://web.example.test\\attacker.example',
    'https://web.example.test：1443',
  ])
    assert.equal(webPublicOriginSchema.safeParse(input).success, false, input);
});

test('released domain-only settings retain their constraint without guessing a public port', () => {
  const stored = {
    enabled: true,
    domain: 'web.example.test',
    path: '',
    idleMinutes: 120,
    proxyEnabled: false,
    trustedProxies: [],
  };
  assert.deepEqual(webStoredSettingsSchema.parse(stored), { ...stored, publicOrigin: '' });
  assert.deepEqual(webSettingsValuesSchema.parse({ enabled: false }), { enabled: false });
  assert.equal(
    webSettingsValuesSchema.safeParse({ domain: 'another.example.test' }).success,
    false,
  );
});
