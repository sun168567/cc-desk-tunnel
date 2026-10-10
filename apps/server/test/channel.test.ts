import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { PROTOCOL_VERSION, TUNNEL_CLOSE } from '@cc-desk-tunnel/protocol';
import { createProxyServer } from '../src/server.ts';

const token = 'channel-test-' + randomUUID();
type Message = { type: string; [key: string]: unknown };

// A service with the execution channel, and a device that signs in to it. The SSH probe is replaced: these
// tests are about how connections are admitted and joined, and play both `ssh` and the SSH service themselves.
async function fixture(t: TestContext, pairMs = 5000) {
  const directory = mkdtempSync(join(tmpdir(), 'cc-desk-tunnel-channel-'));
  const server = createProxyServer({
    token,
    dataDir: directory,
    tunnel: { pairMs, probe: async () => {} },
  });
  const url = (await server.listen(0)).replace('http', 'ws') + '/ws';
  const sockets: (WebSocket | Socket)[] = [];
  t.after(async () => {
    for (const socket of sockets) 'terminate' in socket ? socket.terminate() : socket.destroy();
    await server.close();
    rmSync(directory, { recursive: true, force: true });
  });
  async function socket() {
    const created = new WebSocket(url);
    sockets.push(created);
    await once(created, 'open');
    return created;
  }
  // Signs in on a control connection; `next` waits for a message of one type.
  async function signIn(tunnel = true) {
    const control = await socket();
    const messages: Message[] = [];
    control.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
    async function next(type: string) {
      for (let attempt = 0; attempt < 600; attempt++) {
        const index = messages.findIndex((message) => message.type === type);
        if (index >= 0) return messages.splice(index, 1)[0]!;
        await delay(5);
      }
      throw new Error(`No ${type}: ${JSON.stringify(messages)}`);
    }
    control.send(
      JSON.stringify({
        type: 'auth',
        token,
        protocolVersion: PROTOCOL_VERSION,
        deviceName: '测试',
        tunnel,
      }),
    );
    control.send(JSON.stringify({ type: 'device', id: randomUUID() }));
    const ready = await next('ready');
    return { control, messages, next, connectionId: ready.connectionId as string };
  }
  // A device whose tunnel is ready; `ssh()` connects as `ssh` on the service's machine would.
  async function device() {
    const signed = await signIn();
    const offer = await signed.next('tunnel.offer');
    signed.control.send(
      JSON.stringify({
        type: 'tunnel.credentials',
        connectionId: signed.connectionId,
        username: 'user',
        privateKey: 'unused',
        hostPublicKey: 'ssh-ed25519 AAAA',
      }),
    );
    await signed.next('tunnel.ready');
    const config = readFileSync(
      join(directory, 'connections', signed.connectionId, 'ssh_config'),
      'utf8',
    );
    const port = Number(/Port (\d+)/.exec(config)![1]);
    function ssh() {
      const created = connect(port, '127.0.0.1');
      sockets.push(created);
      return created;
    }
    // Opens the channel the service asked for; resolves to the close code, or to the channel once bytes may flow.
    async function attach(
      channelId: unknown,
      secret: unknown = offer.secret,
      id = signed.connectionId,
    ) {
      const channel = await socket();
      channel.send(JSON.stringify({ type: 'tunnel.attach', connectionId: id, channelId, secret }));
      return channel;
    }
    return { ...signed, secret: offer.secret as string, port, ssh, attach };
  }
  const closeCode = async (channel: WebSocket) => ((await once(channel, 'close')) as [number])[0];
  return { directory, server, url, socket, signIn, device, closeCode };
}
function collect(socket: Socket) {
  const chunks: Buffer[] = [];
  socket.on('data', (chunk) => chunks.push(chunk));
  return async (length: number) => {
    for (let attempt = 0; Buffer.concat(chunks).length < length; attempt++) {
      assert.ok(attempt < 600, `received ${Buffer.concat(chunks).length} of ${length} bytes`);
      await delay(5);
    }
    return Buffer.concat(chunks);
  };
}

test('a device signing in is offered a tunnel; its SSH connections are announced to it alone and joined', async (t) => {
  const f = await fixture(t);
  const device = await f.device();
  const viewer = await f.signIn(false);
  assert.equal(
    viewer.messages.some((message) => message.type.startsWith('tunnel.')),
    false,
  );

  const ssh = device.ssh();
  const output = collect(ssh);
  ssh.write('from ssh');
  const open = await device.next('tunnel.open');
  assert.equal(open.connectionId, device.connectionId);
  const channel = await device.attach(open.channelId);
  const frames: { data: Buffer; binary: boolean }[] = [];
  channel.on('message', (data: Buffer, binary: boolean) => frames.push({ data, binary }));
  channel.send(Buffer.from('from device'));
  assert.equal((await output(11)).toString(), 'from device');
  for (let attempt = 0; !frames.length; attempt++) {
    assert.ok(attempt < 600);
    await delay(5);
  }
  // Something every signed-in connection is told about: the channel must hear none of it.
  const requestId = randomUUID();
  viewer.control.send(
    JSON.stringify({ type: 'session.create', requestId, title: '广播', projectPath: 'D:\\work' }),
  );
  await viewer.next('response');
  await device.next('session.updated');
  // Whatever a channel carries is bytes for SSH: a sign-in sent over it reaches `ssh` and nothing answers.
  channel.send(
    JSON.stringify({ type: 'auth', token, protocolVersion: PROTOCOL_VERSION, deviceName: 'x' }),
  );
  assert.match((await output(40)).toString(), /^from device\{"type":"auth"/);
  await delay(100);
  assert.deepEqual(
    frames.map((frame) => [frame.data.toString(), frame.binary]),
    [['from ssh', true]],
  );
  assert.equal(
    viewer.messages.some((message) => message.type === 'tunnel.open'),
    false,
  );
});
test('a channel is admitted only with the secret of a live tunnel and the name of a waiting connection', async (t) => {
  const f = await fixture(t);
  const device = await f.device();
  const other = await f.signIn(false);
  device.ssh();
  const { channelId } = await device.next('tunnel.open');
  // A tunnel that does not exist, a connection without a tunnel, and a malformed request: turned away, not counted.
  for (let attempt = 0; attempt < 4; attempt++) {
    assert.equal(
      await f.closeCode(await device.attach(channelId, device.secret, randomUUID())),
      TUNNEL_CLOSE.unknown,
    );
    assert.equal(
      await f.closeCode(await device.attach(channelId, device.secret, other.connectionId)),
      TUNNEL_CLOSE.unknown,
    );
    assert.equal(await f.closeCode(await device.attach(channelId, 'short')), TUNNEL_CLOSE.unknown);
    assert.equal(await f.closeCode(await device.attach('not-a-uuid')), TUNNEL_CLOSE.unknown);
    assert.equal(await f.closeCode(await device.attach(randomUUID())), TUNNEL_CLOSE.unknown);
  }
  // The right secret still gets in after all of that, and only once.
  const channel = await device.attach(channelId);
  channel.send(Buffer.from('x'));
  await delay(50);
  assert.equal(channel.readyState, WebSocket.OPEN);
  assert.equal(await f.closeCode(await device.attach(channelId)), TUNNEL_CLOSE.unknown);
});
test('wrong secrets for a live tunnel count against the address like wrong tokens', async (t) => {
  const f = await fixture(t);
  const device = await f.device();
  device.ssh();
  const { channelId } = await device.next('tunnel.open');
  for (let attempt = 0; attempt < 6; attempt++)
    assert.equal(
      await f.closeCode(await device.attach(channelId, 'w'.repeat(43))),
      TUNNEL_CLOSE.refused,
    );
  const blocked = new WebSocket(f.url);
  const [error] = (await once(blocked, 'error')) as [Error];
  assert.match(error.message, /429/);
});
test('a control connection cannot turn into a channel, nor a channel request arrive later', async (t) => {
  const f = await fixture(t);
  const device = await f.device();
  device.ssh();
  const { channelId } = await device.next('tunnel.open');
  device.control.send(
    JSON.stringify({
      type: 'tunnel.attach',
      connectionId: device.connectionId,
      channelId,
      secret: device.secret,
    }),
  );
  const error = await device.next('connection.error');
  assert.equal(error.code, 'invalid_command');
  assert.equal(device.control.readyState, WebSocket.OPEN);
});
test('channels do not use up the places for connections that have not signed in', async (t) => {
  const f = await fixture(t);
  const device = await f.device();
  // Three times the number of unauthenticated connections one address may hold at once.
  const outputs = [];
  for (let index = 0; index < 12; index++) {
    const ssh = device.ssh();
    outputs.push(collect(ssh));
    const { channelId } = await device.next('tunnel.open');
    (await device.attach(channelId)).send(Buffer.from(`channel ${index}`));
  }
  for (const [index, output] of outputs.entries())
    assert.equal((await output(`channel ${index}`.length)).toString(), `channel ${index}`);
  // A failed attach gives its place back as well.
  for (let attempt = 0; attempt < 8; attempt++)
    await f.closeCode(await device.attach(randomUUID()));
  await f.signIn(false);
});
test('an SSH connection is dropped when the device does not open its channel in time', async (t) => {
  const f = await fixture(t, 150);
  const device = await f.device();
  const ssh = device.ssh();
  const { channelId } = await device.next('tunnel.open');
  await once(ssh, 'close');
  assert.equal(await f.closeCode(await device.attach(channelId)), TUNNEL_CLOSE.unknown);
});
test('the tunnel ends with its control connection: channels, SSH connections, port and credentials', async (t) => {
  const f = await fixture(t);
  const device = await f.device();
  const [joined, waiting] = [device.ssh(), device.ssh()];
  const first = await device.next('tunnel.open');
  const second = await device.next('tunnel.open');
  const channel = await device.attach(first.channelId);
  channel.send(Buffer.from('x'));
  // An end is only seen by a connection that reads what came before it.
  joined.resume();
  const ended = Promise.all([once(joined, 'close'), once(waiting, 'close'), f.closeCode(channel)]);
  device.control.close();
  await ended;
  const late = connect(device.port, '127.0.0.1');
  const [error] = (await once(late, 'error')) as [NodeJS.ErrnoException];
  assert.equal(error.code, 'ECONNREFUSED');
  // The secret died with the tunnel.
  assert.equal(await f.closeCode(await device.attach(second.channelId)), TUNNEL_CLOSE.unknown);
  for (let attempt = 0; ; attempt++) {
    try {
      readFileSync(join(f.directory, 'connections', device.connectionId, 'identity'));
    } catch {
      break;
    }
    assert.ok(attempt < 200, 'credentials were left behind');
    await delay(10);
  }
  // The next device is welcome once the first is gone.
  await f.device();
});
test('two devices are online at once, each with an execution channel of its own', async (t) => {
  const f = await fixture(t);
  const first = await f.device();
  const second = await f.device();
  assert.notEqual(first.port, second.port);
  second.ssh();
  const open = await second.next('tunnel.open');
  assert.equal(open.connectionId, second.connectionId);
  assert.equal(
    first.messages.some((message) => message.type === 'tunnel.open'),
    false,
  );
  // The secret of one opens nothing on the other.
  assert.equal(
    await f.closeCode(await first.attach(open.channelId, first.secret, second.connectionId)),
    TUNNEL_CLOSE.refused,
  );
  // One leaving takes nothing from the other.
  second.control.close();
  first.ssh();
  assert.equal((await first.next('tunnel.open')).connectionId, first.connectionId);
});
