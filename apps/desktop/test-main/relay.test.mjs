import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { X509Certificate, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { WebSocket } from 'ws';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import { openProxyBridge } from '../electron/proxy-bridge.mjs';
import { startLinuxTunnel } from '../electron/linux-tunnel.mjs';

const execute = promisify(execFile);
// The daemon tests must not put notifications on the desktop.
process.env.CCDT_NOTIFY = '0';
const linux = { skip: process.platform !== 'linux', timeout: 60000 };

async function certificate(directory) {
  const keyPath = join(directory, 'key.pem');
  const certificatePath = join(directory, 'cert.pem');
  await execute('openssl', [
    'req',
    '-x509',
    '-newkey',
    'ec',
    '-pkeyopt',
    'ec_paramgen_curve:prime256v1',
    '-nodes',
    '-days',
    '1',
    '-subj',
    '/CN=localhost',
    '-keyout',
    keyPath,
    '-out',
    certificatePath,
  ]);
  return { cert: await readFile(certificatePath), key: await readFile(keyPath) };
}
// A native-mode service whose CLI is never started: sign-in, tunnel and relay are real.
async function service(t, extra = {}) {
  const { createProxyServer } = await import('../../server/src/server.ts');
  const directory = await mkdtemp(join(tmpdir(), 'relay-test-'));
  const tls = await certificate(directory);
  const token = `relay-test-${randomUUID()}`;
  const dataDir = join(directory, 'data');
  const server = createProxyServer({
    token,
    dataDir,
    tls,
    claude: { executable: '/bin/false' },
    tunnel: {
      executable: '/nonexistent/frps',
      publicHost: '127.0.0.1',
      port: 1,
      certificatePath: '',
      keyPath: '',
      serverName: 'localhost',
    },
    ...extra,
  });
  const url = (await server.listen(0)).replace('https:', 'wss:') + '/ws';
  t.after(async () => {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { url, token, dataDir, fingerprint: new X509Certificate(tls.cert).fingerprint256 };
}
function messages(socket) {
  const received = [];
  socket.on('message', (raw) => received.push(JSON.parse(raw.toString())));
  return async (type) => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const index = received.findIndex((message) => message.type === type);
      if (index >= 0) return received.splice(index, 1)[0];
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for ${type}: ${JSON.stringify(received)}`);
  };
}
async function signIn(bridge, token) {
  const local = new WebSocket(bridge.url);
  const next = messages(local);
  await new Promise((resolve, reject) => local.once('open', resolve).once('error', reject));
  local.send(
    JSON.stringify({ type: 'auth', protocolVersion: PROTOCOL_VERSION, token, deviceName: 'test' }),
  );
  return { local, next };
}
const ssh = (dataDir, connectionId, command) =>
  execute(
    'ssh',
    ['-F', join(dataDir, 'connections', connectionId, 'ssh_config'), 'windows', command],
    {
      timeout: 20000,
      maxBuffer: 16 * 1024 * 1024,
      encoding: 'buffer',
    },
  );

test(
  'the Linux desktop is reached through the WSS relay, with no frp and no extra port',
  linux,
  async (t) => {
    const { url, token, dataDir, fingerprint } = await service(t);
    const bridge = await openProxyBridge({ url, fingerprint }, { schedulesPath: '/tmp/计划.json' });
    t.after(() => bridge.close());
    const { next } = await signIn(bridge, token);
    // The bridge passes `ready` on only after the service probed SSH through the relay.
    const ready = await next('ready');
    assert.equal(ready.adapter, 'claude-code');
    const connectionId = ready.connectionId;

    const text = await ssh(dataDir, connectionId, "printf '中继 成功'; printf err >&2");
    assert.equal(text.stdout.toString(), '中继 成功');
    assert.equal(text.stderr.toString(), 'err');
    await assert.rejects(ssh(dataDir, connectionId, 'exit 7'), (error) => error.code === 7);

    // More concurrent commands than spare relay connections, and output well beyond the flow-control window.
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, index) => ssh(dataDir, connectionId, `printf ${index}`)),
    );
    assert.deepEqual(
      results.map((result) => result.stdout.toString()),
      ['0', '1', '2', '3', '4', '5'],
    );
    const large = await ssh(dataDir, connectionId, 'head -c 8388608 /dev/zero | tr "\\0" a');
    assert.equal(large.stdout.length, 8 * 1024 * 1024);
    assert.equal(
      large.stdout.every((byte) => byte === 0x61),
      true,
    );
    const echoed = await new Promise((resolve, reject) => {
      const child = execFile(
        'ssh',
        ['-F', join(dataDir, 'connections', connectionId, 'ssh_config'), 'windows', 'wc -c'],
        { timeout: 20000 },
        (error, stdout) => (error ? reject(error) : resolve(stdout.trim())),
      );
      child.stdin.end(Buffer.alloc(3 * 1024 * 1024, 1));
    });
    assert.equal(echoed, String(3 * 1024 * 1024));

    await bridge.close();
    const deadline = Date.now() + 5000;
    while (existsSync(join(dataDir, 'connections', connectionId)) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(existsSync(join(dataDir, 'connections', connectionId)), false);

    // The device slot is free again for the next connection.
    const again = await openProxyBridge({ url, fingerprint }, {});
    t.after(() => again.close());
    assert.equal((await (await signIn(again, token)).next('ready')).adapter, 'claude-code');
  },
);

test('relay connections without the right secret are refused and counted', linux, async (t) => {
  const { url, token, fingerprint } = await service(t);
  const bridge = await openProxyBridge({ url, fingerprint }, {});
  t.after(() => bridge.close());
  const { connectionId } = await (await signIn(bridge, token)).next('ready');
  for (const attach of [
    { type: 'tunnel.attach', connectionId, secret: 'A'.repeat(43) },
    { type: 'tunnel.attach', connectionId: randomUUID(), secret: 'A'.repeat(43) },
  ]) {
    const socket = new WebSocket(url, { rejectUnauthorized: false });
    await new Promise((resolve, reject) => socket.once('open', resolve).once('error', reject));
    socket.send(JSON.stringify(attach));
    assert.equal(await new Promise((resolve) => socket.once('close', resolve)), 4001);
  }
});

test('a cancelled Linux tunnel start leaves nothing running', linux, async () => {
  await assert.rejects(
    startLinuxTunnel({ connectionId: 'x', secret: 'x' }, {}, AbortSignal.abort(), () => {}),
    /abort/i,
  );
});

// A TCP forwarder between the bridge and the service. `drop()` cuts every connection through it and refuses new ones
// until `restore()`, like a network outage: neither end gets a close frame.
async function outage(t, target) {
  const { hostname, port } = new URL(target);
  const sockets = new Set();
  let down = false;
  const server = createServer((client) => {
    if (down) return client.destroy();
    const upstream = connect(Number(port), hostname);
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on('error', () => {});
      socket.once('close', () => sockets.delete(socket));
    }
    client.once('close', () => upstream.destroy());
    upstream.once('close', () => client.destroy());
    client.pipe(upstream);
    upstream.pipe(client);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });
  return {
    url: `wss://127.0.0.1:${server.address().port}/ws`,
    drop() {
      down = true;
      for (const socket of sockets) socket.destroy();
    },
    restore() {
      down = false;
    },
  };
}
// A plain signed-in client of the same service, whose changes reach every connection.
async function observer(url, token) {
  const socket = new WebSocket(url, { rejectUnauthorized: false });
  const next = messages(socket);
  await new Promise((resolve, reject) => socket.once('open', resolve).once('error', reject));
  socket.send(
    JSON.stringify({
      type: 'auth',
      protocolVersion: PROTOCOL_VERSION,
      token,
      deviceName: 'observer',
    }),
  );
  await next('ready');
  return socket;
}
const createSession = (socket, title) =>
  socket.send(
    JSON.stringify({
      type: 'session.create',
      requestId: randomUUID(),
      title,
      projectPath: '/tmp',
    }),
  );

test(
  'a network drop is resumed: the same connection and tunnel, nothing lost either way',
  linux,
  async (t) => {
    const { url, token, dataDir, fingerprint } = await service(t);
    const network = await outage(t, url);
    const bridge = await openProxyBridge({ url: network.url, fingerprint }, {});
    t.after(() => bridge.close());
    const { local, next } = await signIn(bridge, token);
    const ready = await next('ready');
    assert.equal(ready.resume, undefined, 'the resume key stays in the bridge');
    const { connectionId } = ready;
    assert.equal((await ssh(dataDir, connectionId, 'printf before')).stdout.toString(), 'before');
    // Commands share one SSH connection.
    assert.equal(existsSync(join(dataDir, 'connections', connectionId, 'cm')), true);

    const other = await observer(url, token);
    t.after(() => other.close());
    network.drop();
    assert.equal((await next('connection.state')).state, 'reconnecting');
    // Both directions while the network is down: a change made elsewhere, a request from this client, and a
    // command Claude starts, which waits for the desktop instead of failing.
    createSession(other, '断网期间别处创建');
    const requestId = randomUUID();
    local.send(
      JSON.stringify({
        type: 'session.create',
        requestId,
        title: '断网期间本机创建',
        projectPath: '/tmp',
      }),
    );
    const during = ssh(dataDir, connectionId, 'printf during');
    await new Promise((resolve) => setTimeout(resolve, 1500));
    network.restore();

    assert.equal((await next('connection.state')).state, 'connected');
    const titles = [
      (await next('session.updated')).session.title,
      (await next('session.updated')).session.title,
    ].sort();
    assert.deepEqual(titles, ['断网期间别处创建', '断网期间本机创建'].sort());
    const response = await next('response');
    assert.equal(response.requestId, requestId);
    assert.equal(response.ok, true);
    assert.equal((await during).stdout.toString(), 'during');
    assert.equal((await ssh(dataDir, connectionId, 'printf after')).stdout.toString(), 'after');

    // Leaving on purpose ends the connection at once, without a grace period.
    await bridge.close();
    const deadline = Date.now() + 5000;
    while (existsSync(join(dataDir, 'connections', connectionId)) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(existsSync(join(dataDir, 'connections', connectionId)), false);
  },
);

test(
  'a connection not back within the grace period is given up on both sides',
  linux,
  async (t) => {
    const { url, token, dataDir, fingerprint } = await service(t, { resumeGraceMs: 1500 });
    const network = await outage(t, url);
    let closed = false;
    const bridge = await openProxyBridge(
      { url: network.url, fingerprint },
      {},
      () => (closed = true),
    );
    t.after(() => bridge.close());
    const { next } = await signIn(bridge, token);
    const { connectionId } = await next('ready');
    network.drop();
    assert.equal((await next('connection.state')).state, 'reconnecting');
    const error = await next('connection.error');
    assert.match(error.message, /网络中断/);
    const deadline = Date.now() + 5000;
    while (
      (!closed || existsSync(join(dataDir, 'connections', connectionId))) &&
      Date.now() < deadline
    )
      await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(closed, true);
    assert.equal(existsSync(join(dataDir, 'connections', connectionId)), false);
  },
);

test(
  'a new sign-in takes over a device that dropped instead of being told it is busy',
  linux,
  async (t) => {
    const { url, token, fingerprint } = await service(t);
    const network = await outage(t, url);
    const dropped = await openProxyBridge({ url: network.url, fingerprint }, {});
    t.after(() => dropped.close());
    const first = await signIn(dropped, token);
    await first.next('ready');
    network.drop();
    assert.equal((await first.next('connection.state')).state, 'reconnecting');

    const again = await openProxyBridge({ url, fingerprint }, {});
    t.after(() => again.close());
    assert.equal((await (await signIn(again, token)).next('ready')).adapter, 'claude-code');
    // The dropped one learns its connection is gone once the network is back.
    network.restore();
    assert.equal((await first.next('connection.error')).code, 'tunnel_failed');
  },
);

test('resuming an unknown connection is refused', linux, async (t) => {
  const { url, token } = await service(t);
  const socket = new WebSocket(url, { rejectUnauthorized: false });
  const next = messages(socket);
  const closed = new Promise((resolve) => socket.once('close', resolve));
  await new Promise((resolve, reject) => socket.once('open', resolve).once('error', reject));
  socket.send(
    JSON.stringify({
      type: 'auth',
      protocolVersion: PROTOCOL_VERSION,
      token,
      deviceName: 'test',
      resume: { connectionId: randomUUID(), key: 'A'.repeat(43), received: 0 },
    }),
  );
  assert.equal((await next('connection.error')).code, 'resume_failed');
  assert.equal(await closed, 4004);
});

// A stand-in for the CLI in a native terminal: it reports its state through the hook address like the real hooks do.
const FAKE_CLI = `#!/bin/bash
post() { curl -fsS -m 2 -o /dev/null -X POST "$CC_DESK_TUNNEL_HOOK/$1"; }
echo "fake-cli ready"
post idle
while IFS= read -r line; do
  case "$line" in
    ask) post waiting; echo "asking you";;
    quit) exit 3;;
    *) echo "got $line";;
  esac
done
`;
async function until(next, type, accept) {
  for (;;) {
    const message = await next(type);
    if (accept(message)) return message;
  }
}

test(
  'several agents run at once, report their state, and show their screen again when reopened',
  linux,
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'fake-cli-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const executable = join(directory, 'claude');
    await writeFile(executable, FAKE_CLI);
    await chmod(executable, 0o755);
    const { url, token, fingerprint } = await service(t, { claude: { executable } });
    const bridge = await openProxyBridge({ url, fingerprint }, {});
    t.after(() => bridge.close());
    const { local, next } = await signIn(bridge, token);
    await next('ready');
    const request = async (command) => {
      const requestId = randomUUID();
      local.send(JSON.stringify({ ...command, requestId }));
      const response = await until(next, 'response', (message) => message.requestId === requestId);
      assert.equal(response.ok, true, response.message);
      return response;
    };
    const create = (title) => request({ type: 'session.create', title, projectPath: directory });
    const first = (await create('一号')).sessionId;
    const second = (await create('二号')).sessionId;
    const screen = (terminalId) => {
      let text = '';
      return async (expected) => {
        while (!expected.test(text))
          text += (await until(next, 'terminal.data', (m) => m.terminalId === terminalId)).data;
        return text;
      };
    };
    const state = (accept) => until(next, 'terminals.state', (m) => accept(m.terminals));

    await request({ type: 'terminal.open', sessionId: first, cols: 80, rows: 24 });
    const { terminalId: one } = await until(next, 'terminal.opened', (m) => m.sessionId === first);
    await screen(one)(/fake-cli ready/);
    await state((list) => list.some((item) => item.terminalId === one && item.status === 'idle'));
    local.send(
      JSON.stringify({ type: 'terminal.input', sessionId: first, terminalId: one, data: 'ask\r' }),
    );
    await state((list) =>
      list.some((item) => item.terminalId === one && item.status === 'waiting'),
    );

    // Leaving it: it keeps running while the other one starts.
    await request({ type: 'terminal.detach', sessionId: first, terminalId: one });
    await request({ type: 'terminal.open', sessionId: second, cols: 80, rows: 24 });
    const { terminalId: two } = await until(next, 'terminal.opened', (m) => m.sessionId === second);
    const both = await state(
      (list) => list.length === 2 && list.some((item) => item.terminalId === two),
    );
    assert.equal(both.terminals.find((item) => item.terminalId === one).attached, false);

    // Opening the first again draws its screen as it was.
    await request({ type: 'terminal.open', sessionId: first, cols: 100, rows: 30 });
    const again = await until(next, 'terminal.opened', (m) => m.sessionId === first);
    assert.equal(again.terminalId, one, 'the same running terminal');
    // Output sent before the detach may still be queued; the screen starts with the clearing sequence.
    const snapshot = await until(
      next,
      'terminal.data',
      (m) => m.terminalId === one && m.data.startsWith('\x1b[?25h'),
    );
    assert.match(snapshot.data, /fake-cli ready/);
    assert.match(snapshot.data, /asking you/);

    local.send(
      JSON.stringify({
        type: 'terminal.input',
        sessionId: second,
        terminalId: two,
        data: 'quit\r',
      }),
    );
    const closed = await until(next, 'terminal.closed', (m) => m.terminalId === two);
    assert.equal(closed.exitCode, 3);
    await state((list) => list.length === 1);
  },
);

test(
  'the background daemon keeps agents running between terminals and hands them to the next one',
  linux,
  async (t) => {
    const { openConnection } = await import('../../cli/src/connection.mjs');
    const { startDaemon, unitFile } = await import('../../cli/src/daemon.mjs');
    const directory = await mkdtemp(join(tmpdir(), 'daemon-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const executable = join(directory, 'claude');
    await writeFile(executable, FAKE_CLI);
    await chmod(executable, 0o755);
    const { url, token, fingerprint } = await service(t, { claude: { executable } });
    const socketPath = join(directory, 'ccdt.sock');
    const daemon = await startDaemon({ url, fingerprint, token, socketPath }, () => {});
    t.after(() => daemon.stop());
    await assert.rejects(
      startDaemon({ url, fingerprint, token, socketPath }, () => {}),
      /已在运行/,
      'one daemon per socket',
    );

    const view = async () => {
      const connection = await openConnection(`ws+unix://${socketPath}:/`, null);
      const frames = [];
      connection.onMessage((message) => frames.push(message));
      const next = async (accept) => {
        for (let waited = 0; waited < 20000; waited += 10) {
          const index = frames.findIndex(accept);
          if (index >= 0) return frames.splice(index, 1)[0];
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw new Error(`Timed out: ${JSON.stringify(frames)}`);
      };
      return { connection, next };
    };
    const first = await view();
    const { sessionId } = await first.connection.request({
      type: 'session.create',
      title: '后台',
      projectPath: directory,
    });
    await first.connection.request({ type: 'terminal.open', sessionId, cols: 80, rows: 24 });
    const { terminalId } = await first.next((m) => m.type === 'terminal.opened');
    let seen = '';
    while (!/fake-cli ready/.test(seen))
      seen += (await first.next((m) => m.type === 'terminal.data')).data;
    first.connection.control({ type: 'terminal.input', sessionId, terminalId, data: 'hello\r' });
    while (!/got hello/.test(seen))
      seen += (await first.next((m) => m.type === 'terminal.data')).data;

    // The first terminal goes away; the agent stays, no longer shown.
    first.connection.close();
    const second = await view();
    assert.ok(
      second.connection.ready.sessions.some((session) => session.id === sessionId),
      'a new view starts from the sessions as they are now',
    );
    await second.connection.request({ type: 'terminal.list' });
    await second.next(
      (m) =>
        m.type === 'terminals.state' &&
        m.terminals.some((item) => item.terminalId === terminalId && !item.attached),
    );
    await second.connection.request({ type: 'terminal.open', sessionId, cols: 80, rows: 24 });
    assert.equal((await second.next((m) => m.type === 'terminal.opened')).terminalId, terminalId);
    const snapshot = await second.next(
      (m) => m.type === 'terminal.data' && m.data.startsWith('\x1b[?25h'),
    );
    assert.match(snapshot.data, /got hello/);
    second.connection.close();

    const unit = unitFile({
      execPath: '/opt/CC Desk Tunnel/cc-desk-tunnel',
      script: '/opt/x/ccdt.mjs',
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        PATH: '/home/u/.local/bin:/usr/bin',
        https_proxy: 'http://u:p@h',
      },
    });
    assert.match(
      unit,
      /Environment="PATH=\/home\/u\/.local\/bin:\/usr\/bin"\nEnvironment=ELECTRON_RUN_AS_NODE=1\nExecStart="\/opt\/CC Desk Tunnel\/cc-desk-tunnel" "\/opt\/x\/ccdt.mjs" daemon run/,
    );
    assert.doesNotMatch(unit, /proxy/, 'no proxy credentials in the unit file');
  },
);
