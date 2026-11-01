import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { Config, directories } from '../src/config.mjs';
import { proxyFor } from '../src/connection.mjs';
import { RESTORE, relay } from '../src/terminal.mjs';
import { readKeys } from '../src/keys.mjs';
import { fit } from '../src/picker.mjs';
import { protect, reveal } from '../src/secret.mjs';

test('settings live where each system keeps them, beside the desktop client’s', () => {
  assert.deepEqual(directories({ APPDATA: 'C:\\A' }, 'win32', 'C:\\H'), {
    cli: join('C:\\A', 'ccdt'),
    desktop: join('C:\\A', 'CC Desk Tunnel'),
  });
  assert.equal(
    directories({}, 'darwin', '/h').cli,
    join('/h', 'Library', 'Application Support', 'ccdt'),
  );
  assert.equal(directories({}, 'linux', '/h').desktop, join('/h', '.config', 'CC Desk Tunnel'));
  assert.equal(directories({ CCDT_CONFIG_DIR: '/c' }, 'linux', '/h').cli, '/c');
});

test('the desktop client’s device ID is the computer’s; without one ccdt keeps its own', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ccdt-config-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = { cli: join(root, 'cli'), desktop: join(root, 'desktop') };
  const own = new Config(paths).device();
  assert.equal(new Config(paths).device(), own);
  if (process.platform !== 'win32')
    assert.equal(statSync(join(paths.cli, 'config.json')).mode & 0o777, 0o600);
  mkdirSync(paths.desktop);
  const desktop = '11111111-2222-4333-8444-555555555555';
  writeFileSync(join(paths.desktop, 'settings.json'), JSON.stringify({ deviceId: desktop }));
  assert.equal(new Config(paths).device(), desktop);
  const config = new Config(paths);
  config.remember({ url: 'wss://a/ws', fingerprint: '' });
  config.remember({ url: 'wss://b/ws', fingerprint: '' });
  assert.equal(new Config(paths).server().url, 'wss://b/ws');
  config.forget('wss://b/ws');
  assert.equal(new Config(paths).server().url, 'wss://a/ws');
  assert.equal(
    JSON.parse(readFileSync(join(paths.cli, 'config.json'), 'utf8')).current,
    'wss://a/ws',
  );
});

test('a proxy from the environment, except for loopback and no_proxy addresses', () => {
  const env = { https_proxy: 'http://127.0.0.1:7890', no_proxy: 'internal.example,.lan' };
  assert.equal(proxyFor('wss://example.com/ws', env), 'PROXY 127.0.0.1:7890');
  assert.equal(proxyFor('wss://a.internal.example/ws', env), 'DIRECT');
  assert.equal(proxyFor('wss://box.lan/ws', env), 'DIRECT');
  assert.equal(proxyFor('wss://127.0.0.1:8787/ws', env), 'DIRECT');
  assert.equal(
    proxyFor('wss://example.com/ws', { https_proxy: 'socks5://127.0.0.1:1080' }),
    'DIRECT',
  );
  assert.equal(proxyFor('wss://example.com/ws', {}), 'DIRECT');
});

function fakes() {
  const service = new EventEmitter();
  const sent = [];
  const requests = [];
  service.send = (message) => sent.push(message);
  service.request = async (command) => {
    requests.push(command);
    return { type: 'response', ok: true };
  };
  const input = new PassThrough();
  input.setRawMode = (on) => (input.raw = on);
  const output = new PassThrough();
  output.columns = 120;
  output.rows = 30;
  let shown = '';
  output.on('data', (chunk) => (shown += chunk));
  return { service, sent, requests, input, output, shown: () => shown };
}

test('the terminal is shown as it is: output acknowledged once written, keys and size passed on', async () => {
  const f = fakes();
  const sessionId = 's';
  const ended = relay(f.service, sessionId, {}, f.input, f.output);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.requests[0], {
    type: 'terminal.open',
    sessionId,
    continueSession: true,
    cols: 120,
    rows: 30,
  });
  assert.equal(f.input.raw, true);
  f.service.emit('message', {
    type: 'terminal.data',
    sessionId,
    terminalId: 'early',
    data: 'x',
    bytes: 1,
  });
  f.service.emit('message', { type: 'terminal.opened', sessionId, terminalId: 't' });
  f.service.emit('message', {
    type: 'terminal.data',
    sessionId,
    terminalId: 't',
    data: '画面',
    bytes: 6,
  });
  f.input.write('hi');
  f.output.columns = 100;
  f.output.emit('resize');
  await new Promise((resolve) => setImmediate(resolve));
  f.service.emit('message', { type: 'terminal.closed', sessionId, terminalId: 't', exitCode: 3 });
  assert.deepEqual(await ended, { how: 'exited', code: 3 });
  assert.equal(f.shown(), `画面${RESTORE}`);
  // The acknowledgment follows the write, so it may come after what was typed meanwhile.
  const byType = (a, b) => a.type.localeCompare(b.type);
  assert.deepEqual(f.sent.toSorted(byType), [
    { type: 'terminal.ack', sessionId, terminalId: 't', bytes: 6 },
    { type: 'terminal.input', sessionId, terminalId: 't', data: 'hi' },
    { type: 'terminal.resize', sessionId, terminalId: 't', cols: 100, rows: 30 },
  ]);
  assert.equal(f.input.raw, false);
});

test('a lost connection, a terminal taken elsewhere and output left behind end the showing, not the terminal', async () => {
  const lost = fakes();
  const one = relay(lost.service, 's', {}, lost.input, lost.output);
  lost.service.emit('end', true);
  assert.deepEqual(await one, { how: 'lost' });
  const taken = fakes();
  const two = relay(taken.service, 's', {}, taken.input, taken.output);
  taken.service.emit('message', { type: 'terminal.opened', sessionId: 's', terminalId: 't' });
  taken.service.emit('message', {
    type: 'terminal.detached',
    sessionId: 's',
    terminalId: 't',
    reason: 'taken',
  });
  assert.deepEqual(await two, { how: 'taken' });
  const stalled = fakes();
  const three = relay(stalled.service, 's', {}, stalled.input, stalled.output);
  stalled.service.emit('message', { type: 'terminal.opened', sessionId: 's', terminalId: 't' });
  stalled.service.emit('message', {
    type: 'terminal.detached',
    sessionId: 's',
    terminalId: 'other',
    reason: 'stalled',
  });
  stalled.service.emit('message', {
    type: 'terminal.detached',
    sessionId: 's',
    terminalId: 't',
    reason: 'stalled',
  });
  assert.deepEqual(await three, { how: 'stalled' });
});

test('ccdt login offers the services the desktop client signs in to, without their tokens', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ccdt-logins-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = { cli: join(root, 'cli'), desktop: join(root, 'desktop') };
  mkdirSync(join(paths.desktop, 'connections', 'abcdefgh'), { recursive: true });
  const login = (url, fingerprint) =>
    JSON.stringify({ login: { url, fingerprint, token: 'encrypted' } });
  writeFileSync(join(paths.desktop, 'settings.json'), login('wss://main/ws', 'AA:BB'));
  writeFileSync(
    join(paths.desktop, 'connections', 'abcdefgh', 'settings.json'),
    login('wss://other/ws', ''),
  );
  assert.deepEqual(new Config(paths).desktopLogins(), [
    { url: 'wss://main/ws', fingerprint: 'AA:BB' },
    { url: 'wss://other/ws', fingerprint: '' },
  ]);
});

test('reading keys leaves the input open for the terminal shown next', async () => {
  const input = new PassThrough();
  input.setRawMode = (on) => (input.raw = on);
  const reading = readKeys(input, (key) => (key === '\r' ? 'chosen' : undefined));
  input.write('a');
  input.write('\r');
  assert.equal(await reading, 'chosen');
  assert.equal(input.raw, false);
  assert.equal(input.destroyed, false);
  const again = readKeys(input, (key) => key);
  input.write('b');
  assert.equal(await again, 'b');
});

// A Linux server over SSH has the Secret Service's command at times, but no desktop session for it to work in.
test(
  'a token goes to the Secret Service where it works, and to the settings file where it does not',
  {
    skip: process.platform === 'win32',
  },
  (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'ccdt-secret-'));
    const path = process.env.PATH;
    t.after(() => {
      process.env.PATH = path;
      rmSync(directory, { recursive: true, force: true });
    });
    const tool = join(directory, 'secret-tool');
    process.env.PATH = `${directory}:${path}`;
    writeFileSync(
      tool,
      '#!/bin/sh\necho "Cannot autolaunch D-Bus without X11 $DISPLAY" >&2\nexit 1\n',
    );
    chmodSync(tool, 0o755);
    assert.deepEqual(protect('wss://a.test/ws', 'token-1', 'linux'), {
      store: 'file',
      data: 'token-1',
    });
    const kept = join(directory, 'kept');
    writeFileSync(
      tool,
      `#!/bin/sh\ncase "$1" in store) cat > '${kept}';; lookup) cat '${kept}';; esac\n`,
    );
    const stored = protect('wss://a.test/ws', 'token-2', 'linux');
    assert.deepEqual(stored, { store: 'secret-service' });
    assert.equal(reveal('wss://a.test/ws', stored), 'token-2');
  },
);

test('a list entry is cut to the terminal, Chinese taking two columns and colours none', () => {
  assert.equal(fit('今天 10:00  会话', 40), '今天 10:00  会话');
  assert.equal(fit('项目项目项目', 8), '项目项\x1b[0m…');
  assert.equal(fit('ab\x1b[2mcdef\x1b[0m', 5), 'ab\x1b[2mcd\x1b[0m…');
});
