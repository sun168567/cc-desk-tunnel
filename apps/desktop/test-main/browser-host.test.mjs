import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { installBrowserHost } from '../src/browser-host.ts';

test('the browser host keeps login-time service upgrade on the desktop', async (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'window', original);
    else delete globalThis.window;
  });
  const fetch = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('A browser must not create a service upgrade connection.');
  });
  installBrowserHost({
    kind: 'desktop-web',
    device: { id: randomUUID(), name: '桌面电脑' },
    platform: 'win32',
    version: '0.3.4',
    connected: true,
  });
  assert.equal(typeof window.desktop.upgradeService, 'function');
  assert.equal(typeof window.desktop.onServiceUpgrade, 'function');
  await assert.rejects(
    window.desktop.upgradeService({
      url: 'wss://service.invalid/ws',
      fingerprint: '',
      token: 'test-only-token',
      deviceName: '桌面电脑',
      service: '0.3.3',
    }),
    /请在桌面客户端执行这项系统操作。/,
  );
  const progress = t.mock.fn();
  const unsubscribe = window.desktop.onServiceUpgrade(progress);
  unsubscribe();
  unsubscribe();
  assert.equal(progress.mock.callCount(), 0);
  assert.equal(fetch.mock.callCount(), 0);
});
