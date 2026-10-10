import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { execFile, spawn } from 'node:child_process';
import { X509Certificate, createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpsServer } from 'node:https';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { WebSocket, WebSocketServer } from 'ws';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import { openProxyBridge } from '../electron/proxy-bridge.mjs';

// The whole execution channel on one machine: the real service over TLS, the real connection bridge, the bundled
// OpenSSH as the device's SSH service and the system's `ssh` as the command the native CLI would run. Only the
// CLI itself is absent. Every connection of the bridge passes a forwarder here, which can cut or stall any of them.
const execute = promisify(execFile);
const vendor = resolve('apps/desktop/vendor');
const available =
  process.platform === 'win32' &&
  (await access(join(vendor, 'openssh/sshd.exe')).then(
    () => true,
    () => false,
  ));
const windows = (timeout = 60000) => ({ skip: !available, timeout });
// Run from inside an SSH session, as when Claude runs the tests on this computer, the environment carries the
// state of that session's descriptors for OpenSSH's own children. The `ssh` and `scp` started here are not
// those children, and would wait forever on descriptors they do not have.
for (const name of Object.keys(process.env))
  if (name.endsWith('_POSIX_FD_STATE')) delete process.env[name];
// Named by its identifier: a domain account's name cannot be looked up while the domain is out of reach.
const account =
  available &&
  (
    await execute('pwsh.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '[Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
    ])
  ).stdout.trim();

async function certificate(directory) {
  const keyPath = join(directory, 'key.pem');
  const certificatePath = join(directory, 'cert.pem');
  // .NET writes both files without touching a certificate store; Windows has no openssl of its own.
  const script = `
$key = [Security.Cryptography.ECDsa]::Create([Security.Cryptography.ECCurve+NamedCurves]::nistP256)
$request = [Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=localhost', $key, 'SHA256')
$certificate = $request.CreateSelfSigned([DateTimeOffset]::Now.AddDays(-1), [DateTimeOffset]::Now.AddDays(1))
[IO.File]::WriteAllText('${keyPath}', $key.ExportPkcs8PrivateKeyPem())
[IO.File]::WriteAllText('${certificatePath}', $certificate.ExportCertificatePem())`;
  await execute('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script]);
  return { cert: await readFile(certificatePath), key: await readFile(keyPath) };
}
// Passes TCP connections on to `route(index)`, a port, in the order they arrive. The first of a bridge is its
// control connection, the others its channels.
async function forwarder(route) {
  const links = [];
  const server = createServer((client) => {
    const upstream = connect(route(links.length), '127.0.0.1');
    const link = {
      client,
      upstream,
      cut() {
        client.destroy();
        upstream.destroy();
      },
      // Delivers nothing more in either direction, not even that the other side has closed, as a path that
      // silently drops packets does. Each side is left to find out by itself.
      stall() {
        stalled = true;
        client.unpipe(upstream);
        upstream.unpipe(client);
        client.resume();
        upstream.resume();
      },
      get open() {
        return !client.destroyed && !upstream.destroyed;
      },
    };
    let stalled = false;
    links.push(link);
    for (const socket of [client, upstream]) {
      socket.on('error', () => stalled || link.cut());
      socket.on('close', () => stalled || link.cut());
    }
    client.pipe(upstream);
    upstream.pipe(client);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    port: server.address().port,
    links,
    channels: () => links.slice(1).filter((link) => link.open),
    async close() {
      for (const link of links) link.cut();
      await new Promise((done) => server.close(done));
    },
  };
}
// A native-mode service whose CLI is never started: sign-in, tunnel and probe are real.
async function service() {
  const { createProxyServer } = await import('../../server/src/server.ts');
  const { sshProbe } = await import('../../server/src/tunnel.ts');
  const directory = await mkdtemp(join(tmpdir(), 'tunnel-test-'));
  const tls = await certificate(directory);
  const token = `tunnel-test-${randomUUID()}`;
  const dataDir = join(directory, 'data');
  const server = createProxyServer({
    token,
    dataDir,
    tls,
    claude: { executable: join(directory, 'no-cli') },
    tunnel: {
      // The service is made for Linux, where the login key it writes is private by its file mode. Here it runs
      // on Windows, whose `ssh` refuses a key that inherited access for anyone else from the temporary folder.
      async probe(configPath) {
        await execute(
          'icacls.exe',
          [join(dirname(configPath), 'identity'), '/inheritance:r', '/grant:r', `*${account}:F`],
          { windowsHide: true },
        );
        return sshProbe(configPath);
      },
    },
  });
  const port = Number(new URL(await server.listen(0)).port);
  return {
    port,
    token,
    dataDir,
    directory,
    fingerprint: new X509Certificate(tls.cert).fingerprint256,
    server,
    async close() {
      await server.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
const schedules = 'C:\\任务 目录\\schedules.json';
// A device connected to the service through a forwarder, and what `ssh` on the service's machine can do with it.
async function device(svc, { route = () => svc.port, binaries = {}, config = {} } = {}) {
  const forward = await forwarder(route);
  let closedByBridge = false;
  const bridge = await openProxyBridge(
    { url: `wss://127.0.0.1:${forward.port}/ws`, fingerprint: svc.fingerprint, ...config },
    {
      openssh: join(vendor, 'openssh'),
      powershell: 'pwsh.exe',
      environment: { CC_DESK_TUNNEL_SCHEDULES: schedules },
      ...binaries,
    },
    () => (closedByBridge = true),
  );
  const local = new WebSocket(bridge.url);
  const messages = [];
  local.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
  await once(local, 'open');
  local.send(
    JSON.stringify({
      type: 'auth',
      protocolVersion: PROTOCOL_VERSION,
      token: svc.token,
      deviceName: '测试设备',
    }),
  );
  local.send(JSON.stringify({ type: 'device', id: randomUUID() }));
  async function next(type, seconds = 40) {
    for (const deadline = Date.now() + seconds * 1000; Date.now() < deadline;) {
      const index = messages.findIndex((message) => message.type === type);
      if (index >= 0) return messages.splice(index, 1)[0];
      await delay(20);
    }
    throw new Error(`Timed out waiting for ${type}: ${JSON.stringify(messages)}`);
  }
  return {
    bridge,
    forward,
    local,
    messages,
    next,
    closedByBridge: () => closedByBridge,
    async close() {
      local.terminate();
      await bridge.close();
      await forward.close();
    },
  };
}
const ps = (script) =>
  `pwsh.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(
    `$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);${script}`,
    'utf16le',
  ).toString('base64')}`;
const configOf = (svc, connectionId) =>
  join(svc.dataDir, 'connections', connectionId, 'ssh_config');
function ssh(svc, connectionId, command, input) {
  return new Promise((done, fail) => {
    const child = execFile(
      'ssh',
      ['-F', configOf(svc, connectionId), 'windows', command],
      { timeout: 60000, maxBuffer: 64 * 1024 * 1024, encoding: 'buffer', windowsHide: true },
      (error, stdout, stderr) => (error ? fail(Object.assign(error, { stderr })) : done(stdout)),
    );
    if (input) child.stdin.end(input);
  });
}
// A command that says its process ID and then waits; resolves once it has said it. Both ends are ended with
// the test: the bundled SSH service leaves a command running when its connection goes, with or without a
// tunnel in between, and only ends it with the connection of the whole device.
async function sleeper(t, svc, connectionId) {
  const child = spawn(
    'ssh',
    ['-F', configOf(svc, connectionId), 'windows', ps('Write-Output $PID; Start-Sleep 120')],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const exited = new Promise((done) => child.once('close', (code) => done(code)));
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  for (let attempt = 0; !/\d+\r?\n/.test(output); attempt++) {
    assert.ok(attempt < 1000, 'the remote command did not start');
    await delay(20);
  }
  const pid = Number(output);
  t.after(() => {
    child.kill();
    if (alive(pid)) process.kill(pid);
  });
  return { child, exited, pid };
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function until(check, seconds, what) {
  for (const deadline = Date.now() + seconds * 1000; !(await check());) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await delay(50);
  }
}
const sha256 = (data) => createHash('sha256').update(data).digest('hex');

// Most tests share one service and one connected device; those that end either make their own.
const shared = {};
function connected() {
  // One attempt for all of them: a connection that fails once would only fail the same way for the next test.
  shared.ready ??= (async () => {
    shared.svc = await service();
    shared.dev = await device(shared.svc);
    const { connectionId } = await shared.dev.next('ready');
    return { svc: shared.svc, dev: shared.dev, connectionId };
  })();
  return shared.ready;
}
after(async () => {
  await shared.dev?.close();
  await shared.svc?.close();
});

test('commands reach the device over the service address alone', windows(), async () => {
  const { svc, dev, connectionId } = await connected();
  assert.equal(
    dev.messages.some((message) => message.type.startsWith('tunnel.')),
    false,
  );
  const output = await ssh(
    svc,
    connectionId,
    ps("Write-Output '通道 成功'; [Console]::Error.Write('err'); exit 0"),
  );
  assert.equal(output.toString().trim(), '通道 成功');
  await assert.rejects(
    ssh(svc, connectionId, ps("[Console]::Error.Write('坏了'); exit 7")),
    (error) => {
      assert.equal(error.code, 7);
      assert.match(error.stderr.toString(), /坏了/);
      return true;
    },
  );
  // What the client gave the SSH service for its commands to read is there for each of them.
  assert.equal(
    (await ssh(svc, connectionId, ps('Write-Output $env:CC_DESK_TUNNEL_SCHEDULES')))
      .toString()
      .trim(),
    schedules,
  );
  // Each command had a connection of its own, and none is kept once it has finished.
  assert.ok(dev.forward.links.length >= 3);
  await until(() => dev.forward.channels().length === 0, 10, 'finished channels to close');
});
test('commands started together each get through', windows(120000), async () => {
  const { svc, dev, connectionId } = await connected();
  // Four times what one address may hold in connections that have not signed in yet.
  const results = await Promise.all(
    Array.from({ length: 16 }, (_, index) => ssh(svc, connectionId, ps(`Write-Output ${index}`))),
  );
  assert.deepEqual(
    results.map((output) => output.toString().trim()),
    Array.from({ length: 16 }, (_, index) => String(index)),
  );
  await until(() => dev.forward.channels().length === 0, 10, 'finished channels to close');
});
test('large output and input pass unchanged', windows(180000), async () => {
  const { svc, connectionId } = await connected();
  // 48 MiB out of the device, each mebibyte filled with its own number.
  const megabytes = 48;
  const produced = await ssh(
    svc,
    connectionId,
    ps(
      `$out=[Console]::OpenStandardOutput(); $block=[byte[]]::new(1MB); for($i=0;$i -lt ${megabytes};$i++){ [Array]::Fill($block,[byte]($i+1)); $out.Write($block,0,$block.Length) }; $out.Flush()`,
    ),
  );
  const expected = Buffer.alloc(megabytes * 1024 * 1024);
  for (let index = 0; index < megabytes; index++)
    expected.fill(index + 1, index * 1024 * 1024, (index + 1) * 1024 * 1024);
  assert.equal(produced.length, expected.length);
  assert.equal(sha256(produced), sha256(expected));
  // 24 MiB of random bytes into the device, which reports their hash.
  const input = randomBytes(24 * 1024 * 1024);
  const reported = await ssh(
    svc,
    connectionId,
    ps(
      '$hash=[Security.Cryptography.SHA256]::Create().ComputeHash([Console]::OpenStandardInput()); Write-Output ([Convert]::ToHexString($hash).ToLowerInvariant())',
    ),
    input,
  );
  assert.equal(reported.toString().trim(), sha256(input));
});
test('files are copied both ways with scp', windows(180000), async (t) => {
  const { svc, connectionId } = await connected();
  const directory = await mkdtemp(join(tmpdir(), 'tunnel-scp-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const content = randomBytes(12 * 1024 * 1024);
  await writeFile(join(directory, 'source.bin'), content);
  const remote = (name) => `windows:${join(directory, name).replaceAll('\\', '/')}`;
  const scp = (from, to) =>
    execute('scp', ['-q', '-F', configOf(svc, connectionId), from, to], {
      timeout: 120000,
      windowsHide: true,
    });
  await scp(join(directory, 'source.bin'), remote('there 副本.bin'));
  await scp(remote('there 副本.bin'), join(directory, 'back.bin'));
  assert.equal(sha256(await readFile(join(directory, 'back.bin'))), sha256(content));
});
test('ending the ssh command closes its channel', windows(), async (t) => {
  const { svc, dev, connectionId } = await connected();
  await until(() => dev.forward.channels().length === 0, 10, 'earlier channels to close');
  const command = await sleeper(t, svc, connectionId);
  assert.equal(dev.forward.channels().length, 1);
  command.child.kill();
  await command.exited;
  await until(() => dev.forward.channels().length === 0, 10, 'its channel to close');
});
test(
  'a channel cut on the way fails its command only; the next command opens a new one',
  windows(),
  async (t) => {
    const { svc, dev, connectionId } = await connected();
    await until(() => dev.forward.channels().length === 0, 10, 'earlier channels to close');
    const cut = await sleeper(t, svc, connectionId);
    const [channel] = dev.forward.channels();
    const kept = await sleeper(t, svc, connectionId);
    channel.cut();
    assert.notEqual(await cut.exited, 0);
    assert.equal(
      (await ssh(svc, connectionId, ps('Write-Output again'))).toString().trim(),
      'again',
    );
    assert.equal(kept.child.exitCode, null);
    assert.equal(dev.forward.channels().length, 1);
    assert.equal(dev.local.readyState, WebSocket.OPEN);
  },
);
test(
  'a channel that goes silent is given up from both ends instead of hanging for good',
  windows(150000),
  async (t) => {
    const { svc, dev, connectionId } = await connected();
    await until(() => dev.forward.channels().length === 0, 10, 'earlier channels to close');
    const command = await sleeper(t, svc, connectionId);
    const [channel] = dev.forward.channels();
    const started = Date.now();
    channel.stall();
    // ssh asks for a sign of life every 10 seconds and gives up after two unanswered ones.
    assert.notEqual(await command.exited, 0);
    const seconds = (Date.now() - started) / 1000;
    assert.ok(seconds > 15 && seconds < 60, `ssh gave up after ${seconds}s`);
    assert.ok(channel.upstream.destroyed, 'the service closed its end once ssh was gone');
    // The device's end hears nothing of that: it gives up after 45 seconds without an answer to its own asking.
    await until(() => channel.client.destroyed, 90, 'the device to give up the silent channel');
    assert.equal(
      (await ssh(svc, connectionId, ps('Write-Output alive'))).toString().trim(),
      'alive',
    );
    assert.equal(dev.local.readyState, WebSocket.OPEN);
  },
);
test('channels take the system proxy the control connection takes', windows(), async (t) => {
  const svc = await service();
  t.after(() => svc.close());
  const targets = [];
  const proxy = createServer((socket) => {
    socket.once('data', (head) => {
      const target = /^CONNECT (\S+) HTTP/.exec(head.toString())?.[1];
      targets.push(target);
      const upstream = connect(Number(target.split(':')[1]), '127.0.0.1', () => {
        socket.write('HTTP/1.1 200 Connection established\r\n\r\n');
        socket.pipe(upstream);
        upstream.pipe(socket);
      });
      for (const end of [socket, upstream]) {
        end.on('error', () => {});
        end.on('close', () => (end === socket ? upstream : socket).destroy());
      }
    });
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  t.after(() => new Promise((done) => proxy.close(done)));
  const dev = await device(svc, {
    binaries: { resolveProxy: async () => `PROXY 127.0.0.1:${proxy.address().port}; DIRECT` },
  });
  t.after(() => dev.close());
  const { connectionId } = await dev.next('ready');
  const before = targets.length;
  assert.equal(
    (await ssh(svc, connectionId, ps('Write-Output proxied'))).toString().trim(),
    'proxied',
  );
  assert.ok(targets.length > before, 'the command channel did not pass the proxy');
  assert.ok(targets.length >= 3);
  assert.deepEqual([...new Set(targets)], [`127.0.0.1:${dev.forward.port}`]);
});
test(
  'a channel answered by another certificate ends the connection without seeing the secret',
  windows(),
  async (t) => {
    const svc = await service();
    t.after(() => svc.close());
    // Whoever answers the device's later connections in place of the service.
    const directory = await mkdtemp(join(tmpdir(), 'tunnel-impostor-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const impostor = createHttpsServer(await certificate(directory));
    const heard = [];
    new WebSocketServer({ server: impostor }).on('connection', (socket) =>
      socket.on('message', (data) => heard.push(data.toString())),
    );
    impostor.listen(0, '127.0.0.1');
    await once(impostor, 'listening');
    t.after(() => new Promise((done) => impostor.close(done)));
    const dev = await device(svc, {
      route: (index) => (index ? impostor.address().port : svc.port),
    });
    t.after(() => dev.close());
    const failure = await dev.next('connection.error');
    assert.equal(failure.code, 'tunnel_failed');
    assert.match(failure.message, /指纹不匹配；未发送任何凭据/);
    await until(() => dev.closedByBridge(), 20, 'the bridge to close');
    assert.deepEqual(heard, []);
    assert.equal(
      dev.messages.some((message) => message.type === 'ready'),
      false,
    );
  },
);
test(
  'disconnecting ends running commands and leaves nothing behind on either side',
  windows(),
  async (t) => {
    const svc = await service();
    t.after(() => svc.close());
    const dev = await device(svc);
    t.after(() => dev.close());
    const { connectionId } = await dev.next('ready');
    const command = await sleeper(t, svc, connectionId);
    const directory = join(svc.dataDir, 'connections', connectionId);
    assert.equal(existsSync(join(directory, 'identity')), true);
    await dev.bridge.close();
    assert.notEqual(await command.exited, 0);
    await until(() => !alive(command.pid), 20, 'the device command to end');
    await until(() => !existsSync(directory), 10, 'the connection directory to be removed');
    await until(
      () => dev.forward.links.every((link) => !link.open),
      10,
      'every connection to close',
    );
    // The device may connect again at once, and gets a tunnel of its own.
    const again = await device(svc);
    t.after(() => again.close());
    const ready = await again.next('ready');
    assert.notEqual(ready.connectionId, connectionId);
    assert.equal(
      (await ssh(svc, ready.connectionId, ps('Write-Output back'))).toString().trim(),
      'back',
    );
  },
);
test(
  'a service that stops ends the connection and the commands it carried',
  windows(),
  async (t) => {
    const svc = await service();
    t.after(() => rm(svc.directory, { recursive: true, force: true }));
    const dev = await device(svc);
    t.after(() => dev.close());
    const { connectionId } = await dev.next('ready');
    const command = await sleeper(t, svc, connectionId);
    await svc.server.close();
    assert.notEqual(await command.exited, 0);
    await until(() => dev.closedByBridge(), 20, 'the bridge to close');
    await until(() => !alive(command.pid), 20, 'the device command to end');
    await until(
      () => dev.local.readyState === WebSocket.CLOSED,
      10,
      'the page connection to close',
    );
  },
);
