import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';

const filename = fileURLToPath(new URL('../electron/main.cjs', import.meta.url));
const require = createRequire(filename);
const source = readFileSync(filename, 'utf8');
const config = { url: 'wss://service.example/ws', fingerprint: '', token: 'short' };
const nextTurn = () => new Promise(setImmediate);
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// Execute the production handlers with in-memory host dependencies. The loader substitution avoids
// experimental VM module flags; no Electron window, socket, subprocess or user profile is opened.
function fixture() {
  const handlers = new Map();
  const events = new Map();
  const files = new Map();
  const imported = [];
  const order = [];
  const bridges = [];
  const listeners = [];
  const awake = new Set();
  const messages = [];
  const marks = [];
  let openGate;
  let listenerFailure;
  let quits = 0;
  const profile = join(dirname(filename), 'memory-profile');
  const sender = { isDestroyed: () => false, send: (...args) => messages.push(args) };
  const electron = {
    app: {
      getPath: () => profile,
      requestSingleInstanceLock: () => true,
      isPackaged: false,
      whenReady: () => new Promise(() => {}),
      setAppUserModelId() {},
      getVersion: () => '0.3.2',
      on: (name, listener) => events.set(name, listener),
      quit: () => quits++,
    },
    ipcMain: {
      handle: (name, listener) => handlers.set(name, listener),
      on() {},
    },
    BrowserWindow: { getAllWindows: () => [{ webContents: sender }] },
    session: { defaultSession: { resolveProxy: async () => 'DIRECT' } },
    powerSaveBlocker: {
      start: () => {
        const id = Symbol();
        awake.add(id);
        return id;
      },
      stop: (id) => awake.delete(id),
    },
  };
  const mockRequire = (name) => {
    if (name === 'electron') return electron;
    if (name === 'node:fs')
      return {
        existsSync: (path) => files.has(path),
        readFileSync: (path) => {
          if (!files.has(path)) throw new Error('ENOENT');
          return files.get(path);
        },
        writeFileSync: (path, text) => files.set(path, text),
      };
    if (name === './connections.cjs')
      return {
        requested: () => '',
        list: () => [{ id: '', name: '主连接' }],
        busy: () => [],
        readShared: () => undefined,
        mark: (...args) => marks.push(args),
      };
    if (name === './client-log.cjs') return { openLog: () => ({ write() {} }) };
    if (name === './web-auth.cjs')
      return {
        atomicPrivateWrite: (path, text) => files.set(path, text),
        createWebAuthStore: () => ({ token: 'pairing-code', list: () => [], subscribe() {} }),
      };
    if (name === './git-branch.cjs') return { gitBranch: async () => null };
    if (name === './disk-path.cjs') return { asOnDisk: async (path) => path };
    if (name.startsWith('node:')) return require(name);
    throw new Error(`Unexpected dependency: ${name}`);
  };
  const load = async (name) => {
    imported.push(name);
    if (name.endsWith('proxy-bridge.mjs'))
      return {
        openProxyBridge: async (configuration, options, onClosed) => {
          const gate = openGate;
          openGate = undefined;
          const bridge = {
            config: configuration,
            options,
            onClosed,
            url: `ws://127.0.0.1/bridge-${bridges.length}`,
            closed: 0,
            closeGate: undefined,
            async close() {
              order.push('bridge:close');
              bridge.closed++;
              await bridge.closeGate?.promise;
            },
          };
          order.push('bridge:open');
          bridges.push(bridge);
          await gate?.promise;
          return bridge;
        },
      };
    if (name === './desktop-web.mjs')
      return {
        async startWebServer(options) {
          if (listenerFailure) {
            const error = listenerFailure;
            listenerFailure = undefined;
            throw error;
          }
          const listener = {
            options,
            port: options.port,
            closed: 0,
            async close() {
              listener.closed++;
            },
          };
          listeners.push(listener);
          return listener;
        },
        createWebControl() {
          throw new Error('No browser has attached in this lifecycle test');
        },
      };
    throw new Error(`Unexpected import: ${name}`);
  };
  const execute = new Script(
    `(function(require, __dirname, __import, process) {\n${source.replace(/\bimport\(/g, '__import(')}\n})`,
    { filename },
  ).runInThisContext();
  execute(mockRequire, dirname(filename), load, { ...process, argv: [] });
  const event = { senderFrame: { url: 'file:///desktop/index.html' }, sender };
  return {
    call: (name, ...args) => handlers.get(name)(event, ...args),
    emit: (name, ...args) => events.get(name)(...args),
    imported,
    order,
    bridges,
    listeners,
    awake,
    messages,
    marks,
    quits: () => quits,
    holdOpen: (gate) => (openGate = gate),
    failListener: () => (listenerFailure = new Error('EADDRINUSE')),
  };
}

test('Web disabled keeps the original bridge endpoint and reconnects even for the same configuration', async () => {
  const host = fixture();
  const first = await host.call('proxy:connect', config);
  assert.equal(first.url, host.bridges[0].url);
  assert.equal(host.bridges[0].config.token, 'short');
  const second = await host.call('proxy:connect', { ...config });
  assert.equal(second.url, host.bridges[1].url);
  assert.deepEqual(host.order, ['bridge:open', 'bridge:close', 'bridge:open']);
  assert.equal(host.bridges[0].closed, 1);
  assert.equal(host.bridges[1].closed, 0);
  assert.equal(host.listeners.length, 0);
  assert.ok(host.imported.every((name) => name.endsWith('proxy-bridge.mjs')));
  await host.call('proxy:disconnect');
  assert.equal(host.bridges[1].closed, 1);
  assert.equal(host.awake.size, 0);
});

test('enabling, changing the port and disabling Web never replace or close the desktop bridge', async () => {
  const host = fixture();
  await host.call('proxy:connect', config);
  await host.call('remote:configure', { enabled: true, port: 17890 });
  await host.call('remote:configure', { enabled: true, port: 17891 });
  assert.equal(host.listeners[0].closed, 1);
  assert.equal(host.listeners[1].closed, 0);
  host.failListener();
  await assert.rejects(host.call('remote:configure', { enabled: true, port: 17892 }), /EADDRINUSE/);
  assert.equal(host.call('remote:status').port, 17891);
  assert.equal(host.listeners[1].closed, 0);
  await host.call('remote:configure', { enabled: false });
  assert.equal(host.listeners[1].closed, 1);
  assert.equal(host.bridges.length, 1);
  assert.equal(host.bridges[0].closed, 0);
  assert.equal(host.awake.size, 1);
  assert.deepEqual(
    host.messages.filter(([name]) => name === 'remote:enabled-changed'),
    [
      ['remote:enabled-changed', true],
      ['remote:enabled-changed', false],
    ],
  );
});

test('disconnect still cancels an in-flight bridge and closes its late result', async () => {
  const host = fixture();
  const gate = deferred();
  host.holdOpen(gate);
  const connecting = host.call('proxy:connect', config);
  const cancelled = assert.rejects(connecting, /Connection cancelled/);
  await nextTurn();
  assert.equal(host.bridges.length, 1);
  await host.call('proxy:disconnect');
  gate.resolve();
  await cancelled;
  assert.equal(host.bridges[0].closed, 1);
  assert.equal(host.awake.size, 0);
});

test('a stale bridge close callback cannot disconnect the replacement bridge', async () => {
  const host = fixture();
  await host.call('proxy:connect', config);
  await host.call('proxy:connect', config);
  host.bridges[0].onClosed();
  assert.equal(host.awake.size, 1);
  assert.deepEqual(host.messages, []);
  host.bridges[1].onClosed();
  assert.equal(host.awake.size, 0);
  assert.deepEqual(host.messages, [['proxy:closed']]);
});

test('quit waits for the original bridge close, then closes the optional Web listener on exit', async () => {
  const host = fixture();
  await host.call('proxy:connect', config);
  await host.call('remote:configure', { enabled: true });
  const gate = deferred();
  host.bridges[0].closeGate = gate;
  let prevented = false;
  host.emit('before-quit', { preventDefault: () => (prevented = true) });
  assert.equal(prevented, true);
  assert.equal(host.bridges[0].closed, 1);
  assert.equal(host.quits(), 0);
  gate.resolve();
  await nextTurn();
  assert.equal(host.quits(), 1);
  host.emit('quit');
  assert.equal(host.listeners[0].closed, 1);
  assert.equal(host.marks.at(-1)[2], false);
});

test('without a bridge, quit is not delayed by the optional Web listener', async () => {
  const host = fixture();
  await host.call('remote:configure', { enabled: true });
  let prevented = false;
  host.emit('before-quit', { preventDefault: () => (prevented = true) });
  assert.equal(prevented, false);
  host.emit('quit');
  assert.equal(host.listeners[0].closed, 1);
});
