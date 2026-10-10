import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sshConfig, sessionSsh, Tunnel } from '../src/tunnel.ts';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:net';
import type { Socket } from 'node:net';
import { once } from 'node:events';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket, WebSocketServer } from 'ws';
import type { TestContext } from 'node:test';
import { remotePrompt } from '../src/claude.ts';

// A tunnel whose device is this test: each request for a channel is recorded, and `device.open` answers one
// with a real WebSocket pair, handing the service's end to the tunnel as the service would.
async function harness(t: TestContext, pairMs = 5000) {
  const directory = mkdtempSync(join(tmpdir(), 'claude-tunnel-'));
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(wss, 'listening');
  const requests: string[] = [];
  let accept = true;
  let unexpected = 0;
  const tunnel = new Tunnel(
    { pairMs },
    directory,
    randomUUID(),
    (channelId) => {
      requests.push(channelId);
      return accept;
    },
    () => unexpected++,
  );
  const offer = await tunnel.start();
  t.after(async () => {
    await tunnel.close();
    for (const client of wss.clients) client.terminate();
    await new Promise((resolve) => wss.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  });
  const url = `ws://127.0.0.1:${(wss.address() as { port: number }).port}`;
  // Several channels may be opened at once: each is told apart by the path its device end asked for.
  const arrivals = new Map<string, (service: WebSocket) => void>();
  wss.on('connection', (service, request) => arrivals.get(request.url ?? '')?.(service));
  return {
    tunnel,
    offer,
    requests,
    refuseRequests: () => (accept = false),
    unexpected: () => unexpected,
    ssh: () => connect(tunnel.port, '127.0.0.1'),
    // Waits until the tunnel has asked for `count` channels.
    async requested(count: number) {
      for (let attempt = 0; requests.length < count; attempt++) {
        assert.ok(attempt < 500, `only ${requests.length} of ${count} channels were requested`);
        await delay(10);
      }
      return requests;
    },
    // Opens the device's end of a channel and attaches the service's end; resolves to the device's end.
    async open(channelId: string) {
      const path = `/${randomUUID()}`;
      const accepted = new Promise<WebSocket>((resolve) => arrivals.set(path, resolve));
      const device = new WebSocket(url + path);
      const service = await accepted;
      await once(device, 'open');
      return { device, service, attached: tunnel.attach(channelId, service) };
    },
  };
}
const closed = (socket: Socket) =>
  socket.destroyed ? Promise.resolve() : once(socket, 'close').then(() => undefined);
function collect(socket: Socket) {
  const chunks: Buffer[] = [];
  socket.on('data', (chunk) => chunks.push(chunk));
  return () => Buffer.concat(chunks);
}

test('SSH config pins loopback target and host key, disallows interactive/agent forwarding', () => {
  const files = sshConfig('/tmp/private', 32123, 'user', 'ssh-ed25519 AAAATEST');
  assert.match(files.config, /^Host device windows$/m);
  assert.match(files.config, /HostName 127\.0\.0\.1/);
  assert.match(files.config, /StrictHostKeyChecking yes/);
  assert.match(files.config, /BatchMode yes/);
  assert.match(files.config, /ForwardAgent no/);
  assert.equal(files.knownHosts, '[127.0.0.1]:32123 ssh-ed25519 AAAATEST\n');
});
test('commands share one SSH connection where the platform and the length of the path allow it', () => {
  const config = (directory: string, platform: NodeJS.Platform) =>
    sshConfig(directory, 32123, 'user', 'ssh-ed25519 AAAATEST', platform).config;
  const shared = config('/data/state/connections/0d0c6a0e-6a53-4a0c-9d3a-2f6f5f3f7b11', 'linux');
  assert.match(shared, /ControlMaster auto/);
  assert.match(shared, /ControlPath ".*0d0c6a0e-6a53-4a0c-9d3a-2f6f5f3f7b11[\\/]mux"/);
  assert.match(shared, /ControlPersist \d+/);
  assert.doesNotMatch(config('/tmp/private', 'win32'), /Control/);
  assert.doesNotMatch(config(`/srv/${'long-name/'.repeat(9)}connections/id`, 'linux'), /Control/);
});
test('context references native SSH configuration without inventing execution tools', () => {
  const prompt = remotePrompt(
    "D:\\中文 空格\\it's",
    { configPath: '/private/ssh_config' },
    '0d0c6a0e-6a53-4a0c-9d3a-2f6f5f3f7b11',
  );
  assert.match(prompt, /ssh -F "\/private\/ssh_config" device /);
  assert.match(
    prompt,
    /"%CC_DESK_TUNNEL_PWSH%" -NoLogo -NoProfile -NonInteractive -EncodedCommand/,
  );
  assert.match(prompt, /CC_DESK_TUNNEL_SCHEDULES/);
  // Nothing of the device's own layout: where its programs and the client's files are is the device's to know.
  assert.doesNotMatch(prompt, /pwsh\.exe|APPDATA/);
  assert.match(prompt, /0d0c6a0e-6a53-4a0c-9d3a-2f6f5f3f7b11/);
  assert.match(prompt, /native Bash/);
  assert.match(prompt, /ssh -F/);
  assert.match(prompt, /it''s/);
  assert.doesNotMatch(prompt, /mcp__/);
});
test('a session keeps one SSH path, and so one system prompt, across reconnects', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'claude-session-ssh-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const session = '0d0c6a0e-6a53-4a0c-9d3a-2f6f5f3f7b11';
  const prompts = ['first', 'second'].map((connection) => {
    const configPath = join(directory, 'connections', connection, 'ssh_config');
    const ssh = sessionSsh(directory, session, { configPath });
    assert.equal(readFileSync(ssh.configPath, 'utf8'), `Include ${JSON.stringify(configPath)}\n`);
    return remotePrompt('D:\\work', ssh, session);
  });
  assert.equal(prompts[0], prompts[1]);
  assert.doesNotMatch(prompts[0]!, /connections/);
  assert.notEqual(
    sessionSsh(directory, randomUUID(), { configPath: '/x' }).configPath,
    sessionSsh(directory, session, { configPath: '/x' }).configPath,
  );
});
test('the tunnel offers a secret of its own and compares it without leaking its length', async (t) => {
  const first = await harness(t);
  const second = await harness(t);
  assert.equal(first.offer.type, 'tunnel.offer');
  assert.equal(first.offer.connectionId, first.tunnel.id);
  assert.ok(first.offer.secret.length >= 43);
  assert.notEqual(first.offer.secret, second.offer.secret);
  assert.equal(first.tunnel.matches(first.offer.secret), true);
  assert.equal(first.tunnel.matches(second.offer.secret), false);
  assert.equal(first.tunnel.matches(first.offer.secret.slice(1)), false);
  assert.equal(first.tunnel.matches(''), false);
});
test('an SSH connection asks for one channel and is joined to it byte for byte, both ways', async (t) => {
  const device = await harness(t);
  const ssh = device.ssh();
  const received = collect(ssh);
  // What `ssh` says before its channel exists waits on the connection; nothing is lost or read early.
  ssh.write('SSH-2.0-client\r\n');
  const [channelId] = await device.requested(1);
  const channel = await device.open(channelId!);
  assert.equal(channel.attached, true);
  const [greeting, binary] = (await once(channel.device, 'message')) as [Buffer, boolean];
  assert.equal(binary, true);
  assert.equal(greeting.toString(), 'SSH-2.0-client\r\n');
  // Well beyond every buffer on the way, so that flow control in both directions is exercised.
  const outbound = randomBytes(24 * 1024 * 1024);
  const inbound = randomBytes(24 * 1024 * 1024);
  const fromSsh = createHash('sha256');
  let fromSshBytes = 0;
  channel.device.on('message', (chunk: Buffer) => {
    fromSsh.update(chunk);
    fromSshBytes += chunk.length;
  });
  ssh.write(outbound);
  for (let offset = 0; offset < inbound.length; offset += 60000)
    channel.device.send(inbound.subarray(offset, offset + 60000));
  for (let attempt = 0; fromSshBytes < outbound.length || received().length < inbound.length;) {
    assert.ok(attempt++ < 3000, 'transfer stalled');
    await delay(10);
  }
  assert.equal(fromSsh.digest('hex'), createHash('sha256').update(outbound).digest('hex'));
  assert.equal(received().equals(inbound), true);
  assert.equal(device.requests.length, 1);
});
test('concurrent SSH connections each get their own channel, whatever order the device answers in', async (t) => {
  const device = await harness(t);
  const sockets = Array.from({ length: 20 }, () => device.ssh());
  // The tunnel names channels in the order connections arrive, which is not the order they were made in:
  // each connection says who it is, and its channel must hear exactly that.
  sockets.forEach((socket, index) => socket.write(`connection ${index}\n`));
  const requests = [...(await device.requested(20))].reverse();
  const outputs = sockets.map(collect);
  const heard = await Promise.all(
    requests.map(async (channelId) => {
      const channel = await device.open(channelId);
      assert.equal(channel.attached, true);
      const [said] = (await once(channel.device, 'message')) as [Buffer];
      channel.device.send(Buffer.from(`echo ${said}`));
      return said.toString();
    }),
  );
  assert.deepEqual([...heard].sort(), sockets.map((_, index) => `connection ${index}\n`).sort());
  for (let attempt = 0; outputs.some((output) => !output().length); attempt++) {
    assert.ok(attempt < 500);
    await delay(10);
  }
  outputs.forEach((output, index) =>
    assert.equal(output().toString(), `echo connection ${index}\n`),
  );
});
test('a channel is taken once; an unknown or repeated name is refused', async (t) => {
  const device = await harness(t);
  const ssh = device.ssh();
  const [channelId] = await device.requested(1);
  assert.equal((await device.open(randomUUID())).attached, false);
  assert.equal((await device.open(channelId!)).attached, true);
  assert.equal((await device.open(channelId!)).attached, false);
  ssh.destroy();
});
test('an SSH connection whose channel does not come in time is dropped, and its late channel refused', async (t) => {
  const device = await harness(t, 150);
  const ssh = device.ssh();
  const started = Date.now();
  const [channelId] = await device.requested(1);
  await closed(ssh);
  assert.ok(Date.now() - started >= 140 && Date.now() - started < 3000);
  assert.equal((await device.open(channelId!)).attached, false);
});
test('an SSH connection is dropped at once when the device cannot be asked', async (t) => {
  const device = await harness(t, 60000);
  device.refuseRequests();
  const ssh = device.ssh();
  const started = Date.now();
  await closed(ssh);
  assert.ok(Date.now() - started < 3000);
});
test('the end of an SSH connection closes its channel after delivering what was sent, and the reverse', async (t) => {
  const device = await harness(t);
  // ssh finishes: everything it wrote arrives, then the channel closes cleanly.
  const first = device.ssh();
  const channel = await device.open((await device.requested(1))[0]!);
  let bytes = 0;
  channel.device.on('message', (chunk: Buffer) => (bytes += chunk.length));
  first.end(Buffer.alloc(4 * 1024 * 1024, 7));
  const [code] = (await once(channel.device, 'close')) as [number];
  assert.equal(bytes, 4 * 1024 * 1024);
  assert.equal(code, 1005);
  await closed(first);
  // The device finishes: everything it sent arrives, then ssh sees the end.
  const second = device.ssh();
  const output = collect(second);
  const other = await device.open((await device.requested(2))[1]!);
  for (let sent = 0; sent < 64; sent++) other.device.send(Buffer.alloc(65536, 9));
  other.device.close();
  await once(second, 'end');
  assert.equal(output().length, 64 * 65536);
  await closed(second);
});
test('a channel cut without a goodbye ends its SSH connection, and others go on', async (t) => {
  const device = await harness(t);
  const [cut, kept] = [device.ssh(), device.ssh()];
  cut.write('cut');
  kept.write('kept');
  const requests = await device.requested(2);
  const channels = await Promise.all(requests.map((channelId) => device.open(channelId)));
  const said = await Promise.all(
    channels.map(async (channel) => ((await once(channel.device, 'message')) as [Buffer])[0]),
  );
  const index = said.findIndex((text) => text.toString() === 'cut');
  channels[index]!.device.terminate();
  await closed(cut);
  const output = collect(kept);
  channels[1 - index]!.device.send(Buffer.from('still here'));
  for (let attempt = 0; !output().length; attempt++) {
    assert.ok(attempt < 300);
    await delay(10);
  }
  assert.equal(output().toString(), 'still here');
});
test('more SSH connections than may wait at once are dropped instead of queued', async (t) => {
  const device = await harness(t, 60000);
  const sockets = Array.from({ length: 40 }, () => device.ssh());
  await device.requested(32);
  const dropped = sockets.map((socket) => {
    let done = false;
    void closed(socket).then(() => (done = true));
    return () => done;
  });
  for (let attempt = 0; dropped.filter((done) => done()).length < 8; attempt++) {
    assert.ok(attempt < 300, 'connections beyond the limit were kept');
    await delay(10);
  }
  await delay(100);
  assert.equal(dropped.filter((done) => done()).length, 8);
  assert.equal(device.requests.length, 32);
});
test('closing the tunnel ends waiting and joined SSH connections, their channels, the port and the directory', async (t) => {
  const device = await harness(t, 60000);
  const [joined, waiting] = [device.ssh(), device.ssh()];
  const requests = await device.requested(2);
  const channel = await device.open(requests[0]!);
  assert.equal(existsSync(device.tunnel.directory), true);
  const port = device.tunnel.port;
  const ended = Promise.all([closed(joined), closed(waiting), once(channel.device, 'close')]);
  await device.tunnel.close();
  await ended;
  assert.equal(existsSync(device.tunnel.directory), false);
  const late = connect(port, '127.0.0.1');
  const [error] = (await once(late, 'error')) as [NodeJS.ErrnoException];
  assert.equal(error.code, 'ECONNREFUSED');
  assert.equal((await device.open(requests[1]!)).attached, false);
  assert.equal(device.unexpected(), 0);
  // Closing twice is the same close.
  assert.equal(device.tunnel.close(), device.tunnel.close());
});
