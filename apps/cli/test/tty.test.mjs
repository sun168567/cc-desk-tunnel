import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const terminal = pathToFileURL(join(import.meta.dirname, '../src/terminal.mjs')).href;
const secret = pathToFileURL(join(import.meta.dirname, '../src/secret.mjs')).href;

// What only a real terminal shows, on Linux and macOS: keys arrive as they are typed, Ctrl+C among them as a key for
// Claude Code rather than a signal that ends ccdt, and a change of the window's size is passed on. The terminal shown
// is a stand-in service's. Windows' console was checked end to end instead.
test(
  'in a real terminal, keys go through raw and a resize is passed on',
  { skip: process.platform === 'win32' },
  async (t) => {
    const pty = require('node-pty');
    // npm unpacks node-pty 1.1.0's helper for macOS without its execute bit, and spawning fails without it.
    if (process.platform === 'darwin')
      for (const folder of ['prebuilds/darwin-arm64', 'prebuilds/darwin-x64', 'build/Release'])
        try {
          chmodSync(
            join(dirname(require.resolve('node-pty/package.json')), folder, 'spawn-helper'),
            0o755,
          );
        } catch {}
    const directory = mkdtempSync(join(tmpdir(), 'ccdt-tty-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const sent = join(directory, 'sent.jsonl');
    const script = join(directory, 'shown.mjs');
    writeFileSync(
      script,
      `import { appendFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { relay } from ${JSON.stringify(terminal)};
const service = new EventEmitter();
const at = { sessionId: 's', terminalId: 't' };
service.send = (message) => {
  appendFileSync(${JSON.stringify(sent)}, JSON.stringify(message) + '\\n');
  if (message.type === 'terminal.input' && message.data.includes('q'))
    service.emit('message', { type: 'terminal.closed', ...at, exitCode: 0 });
};
service.request = async (command) => {
  service.emit('message', { type: 'terminal.opened', ...at });
  service.emit('message', { type: 'terminal.data', ...at, data: 'READY\\r\\n', bytes: 7 });
  return { type: 'response', ok: true };
};
const result = await relay(service, 's');
process.stdout.write('DONE ' + result.how + '\\r\\n');
`,
    );
    const child = pty.spawn(process.execPath, [script], {
      cols: 80,
      rows: 24,
      cwd: directory,
      env: process.env,
      name: 'xterm-256color',
    });
    let screen = '';
    child.onData((data) => (screen += data));
    const exited = new Promise((resolve) => child.onExit(resolve));
    // A test that fails part way leaves no terminal behind to keep the run going.
    t.after(() => child.kill('SIGKILL'));
    const until = async (pattern) => {
      for (let i = 0; i < 100 && !pattern.test(screen); i++)
        await new Promise((r) => setTimeout(r, 100));
      assert.match(screen, pattern);
    };
    const sentOf = () =>
      readFileSync(sent, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
    await until(/READY/);
    child.write('a');
    child.write('\x03');
    child.resize(100, 30);
    for (let i = 0; i < 50 && !sentOf().some((m) => m.type === 'terminal.resize'); i++)
      await new Promise((r) => setTimeout(r, 100));
    child.write('q');
    await until(/DONE exited/);
    assert.equal((await exited).exitCode, 0);
    const messages = sentOf();
    const typed = messages.filter((m) => m.type === 'terminal.input').map((m) => m.data);
    // Keys typed together may arrive together.
    assert.equal(typed.join(''), 'a\x03q');
    assert.ok(messages.some((m) => m.type === 'terminal.ack' && m.bytes === 7));
    assert.ok(
      messages.some((m) => m.type === 'terminal.resize' && m.cols === 100 && m.rows === 30),
    );
  },
);

// `ccdt config` in a terminal, without a service to reach: this computer's settings are gone through with the arrow
// keys, a wait typed in and kept.
test(
  'in a real terminal, ccdt config changes a setting typed in',
  { skip: process.platform === 'win32' },
  async (t) => {
    const pty = require('node-pty');
    const directory = mkdtempSync(join(tmpdir(), 'ccdt-config-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const child = pty.spawn(
      process.execPath,
      [join(import.meta.dirname, '../bin/ccdt.mjs'), 'config'],
      {
        cols: 110,
        rows: 20,
        cwd: directory,
        env: { ...process.env, CCDT_CONFIG_DIR: directory, CCDT_TOKEN: '' },
        name: 'xterm-256color',
      },
    );
    let screen = '';
    child.onData((data) => (screen += data));
    const exited = new Promise((resolve) => child.onExit(resolve));
    // A test that fails part way leaves no terminal behind to keep the run going.
    t.after(() => child.kill('SIGKILL'));
    const until = async (pattern) => {
      for (let i = 0; i < 100 && !pattern.test(screen); i++)
        await new Promise((r) => setTimeout(r, 100));
      assert.match(screen, pattern);
    };
    await until(/ccdt 设置/);
    assert.match(screen, /只能改本机的设置/);
    child.write('\x1b[B');
    await new Promise((r) => setTimeout(r, 200));
    child.write('\r');
    await until(/本机 SSH 服务启动（写 default/);
    child.write('30');
    await new Promise((r) => setTimeout(r, 200));
    child.write('\r');
    await until(/30 秒/);
    child.write('\x1b');
    assert.equal((await exited).exitCode, 0);
    assert.deepEqual(JSON.parse(readFileSync(join(directory, 'config.json'), 'utf8')).waits, {
      ssh: 30,
    });
  },
);

// The login keychain of a macOS machine on GitHub, which the token goes to and comes back from. Not run on a
// developer's Mac, to leave its keychain alone.
test(
  'on macOS the token goes to the keychain and back',
  {
    skip: process.platform !== 'darwin' || !process.env.CI,
  },
  async () => {
    const { protect, reveal, discard } = await import(secret);
    const server = `wss://ccdt-test-${process.pid}.invalid/ws`;
    const kept = protect(server, 'keychain-token');
    try {
      assert.deepEqual(kept, { store: 'keychain' });
      assert.equal(reveal(server, kept), 'keychain-token');
    } finally {
      discard(server, kept);
    }
    assert.equal(reveal(server, kept), undefined);
  },
);
