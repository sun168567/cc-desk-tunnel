import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clientInstallers, policies } from '../src/client-update-policy.ts';

const versions = { cachedInstaller: '1.1.0', serverVersion: '1.2.0', publishedVersion: '1.3.0' };

test('Windows prefers the cached installer and offers GitHub for the server version', () => {
  assert.deepEqual(clientInstallers(policies.win32, '1.0.0', versions), [
    { version: '1.1.0', source: 'service' },
    { version: '1.2.0', source: 'github' },
  ]);
  assert.deepEqual(clientInstallers(policies.win32, '1.1.0', versions), [
    { version: '1.2.0', source: 'github' },
  ]);
  // The sign-in page offers both download sources even for a single matching version.
  assert.deepEqual(
    clientInstallers(policies.win32, '1.0.0', { ...versions, cachedInstaller: '1.2.0' }),
    [
      { version: '1.2.0', source: 'service' },
      { version: '1.2.0', source: 'github' },
    ],
  );
  assert.deepEqual(clientInstallers(policies.win32, '1.2.0', versions), []);
});

test('macOS prefers the matching server release, then a newer published release', () => {
  assert.deepEqual(clientInstallers(policies.darwin, '1.0.0', versions), [
    { version: '1.2.0', source: 'github' },
    { version: '1.3.0', source: 'github' },
  ]);
  assert.deepEqual(clientInstallers(policies.darwin, '1.2.0', versions), [
    { version: '1.3.0', source: 'github' },
  ]);
  assert.deepEqual(clientInstallers(policies.darwin, '1.3.0', versions), []);
  assert.deepEqual(clientInstallers(policies.darwin, '1.0.0', { cachedInstaller: '1.1.0' }), []);
});

test('manual platforms and clients with an unknown version get no in-app installer', () => {
  assert.deepEqual(clientInstallers(policies.linux, '1.0.0', versions), []);
  assert.deepEqual(clientInstallers(policies.win32, '', versions), []);
});
