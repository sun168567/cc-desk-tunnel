import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket, createWebSocketStream } from 'ws';
import ssh2 from 'ssh2';
import type { SFTPWrapper } from 'ssh2';
import { FILES_TARGET_ENV, PROTOCOL_VERSION, TUNNEL_CLOSE } from '@cc-desk-tunnel/protocol';
import { createProxyServer } from '../src/server.ts';
import { sftpPath } from '../src/files.ts';

// OpenSSH's SFTP server, as the service finds it; on Windows Git's, as the service run from source there does.
// (Windows' own OpenSSH build only runs under its sshd.)
const sftpServer = [
  '/usr/lib/openssh/sftp-server',
  '/usr/libexec/openssh/sftp-server',
  '/usr/libexec/sftp-server',
  'C:/Program Files/Git/usr/lib/ssh/sftp-server.exe',
].find((path) => existsSync(path));
const skip = sftpServer ? false : 'no OpenSSH SFTP server on this machine';
const token = 'files-test-' + randomUUID();
type Message = { type: string; [key: string]: unknown };

async function fixture(t: TestContext, landlock = false, sftp: string[] | null = [sftpServer!]) {
  const directory = mkdtempSync(join(tmpdir(), 'cc-desk-tunnel-files-'));
  const configDir = join(directory, 'home', '.claude');
  mkdirSync(configDir, { recursive: true });
  const server = createProxyServer({
    token,
    dataDir: directory,
    tunnel: { probe: async () => {} },
    files: { sftpServer: sftp, landlock, configDir },
  });
  const url = (await server.listen(0)).replace('http', 'ws') + '/ws';
  const sockets: WebSocket[] = [];
  const clients: ssh2.Client[] = [];
  const channels: WebSocket[] = [];
  t.after(async () => {
    for (const client of clients) client.end();
    for (const socket of sockets) socket.terminate();
    await server.close();
    rmSync(directory, { recursive: true, force: true });
  });
  async function socket() {
    const created = new WebSocket(url);
    sockets.push(created);
    await once(created, 'open');
    return created;
  }
  // A desktop signed in with an execution channel, which the file panel's connections sign in with.
  async function desktop() {
    const control = await socket();
    const messages: Message[] = [];
    control.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
    const next = async (type: string) => {
      for (let attempt = 0; attempt < 600; attempt++) {
        const index = messages.findIndex((message) => message.type === type);
        if (index >= 0) return messages.splice(index, 1)[0]!;
        await delay(5);
      }
      throw new Error(`No ${type}: ${JSON.stringify(messages)}`);
    };
    control.send(
      JSON.stringify({
        type: 'auth',
        token,
        protocolVersion: PROTOCOL_VERSION,
        deviceName: '测试',
        tunnel: true,
      }),
    );
    control.send(JSON.stringify({ type: 'device', id: randomUUID() }));
    const ready = await next('ready');
    const offer = await next('tunnel.offer');
    return {
      control,
      ready,
      connectionId: ready.connectionId as string,
      secret: offer.secret as string,
    };
  }
  // The file panel's connection, as the client opens it: resolves to SFTP for the target, or to the close code
  // of a connection that was refused.
  async function files(
    signed: { connectionId: string; secret: string },
    target = 'server',
  ): Promise<SFTPWrapper | number> {
    const channel = await socket();
    channels.push(channel);
    channel.send(
      JSON.stringify({
        type: 'files.attach',
        connectionId: signed.connectionId,
        secret: signed.secret,
      }),
    );
    const closed = once(channel, 'close').then(([code]) => code as number);
    const client = new ssh2.Client();
    clients.push(client);
    const ready = new Promise<void>((resolve, reject) => {
      client.once('ready', resolve);
      client.once('error', reject);
    });
    client.connect({
      sock: createWebSocketStream(channel) as never,
      username: 'files',
      hostVerifier: () => true,
      readyTimeout: 5000,
    });
    // A refused connection also fails the SSH handshake; its close code is what tells why.
    const outcome = await ready.then(
      () => 'ready' as const,
      () => closed,
    );
    if (outcome !== 'ready') return outcome;
    // ssh2 sends the environment before asking for the subsystem; its types leave that argument out.
    const sftp = client.sftp as unknown as (
      env: Record<string, string>,
      done: (error: Error | undefined, sftp: SFTPWrapper) => void,
    ) => void;
    return await new Promise<SFTPWrapper>((resolve, reject) =>
      sftp.call(client, { [FILES_TARGET_ENV]: target }, (error, opened) =>
        error ? reject(error) : resolve(opened),
      ),
    );
  }
  return { directory, configDir, desktop, files, socket, channels };
}
const call = <T>(run: (done: (error: Error | null | undefined, value?: T) => void) => void) =>
  new Promise<T>((resolve, reject) =>
    run((error, value) => (error ? reject(error) : resolve(value as T))),
  );

test(
  'the file panel reaches the service files over SFTP, signed in with its execution channel',
  { skip },
  async (t) => {
    const f = await fixture(t);
    const signed = await f.desktop();
    assert.deepEqual(signed.ready.files, {
      server: true,
      dataDir: sftpPath(f.directory),
      home: sftpPath((await import('node:os')).homedir()),
      protected: false,
    });
    const work = join(f.directory, 'native', 'root');
    mkdirSync(work, { recursive: true });
    writeFileSync(join(work, 'notes.txt'), 'hello');
    const sftp = await f.files(signed);
    assert.ok(typeof sftp !== 'number');
    const names = await call<{ filename: string }[]>((done) => sftp.readdir(sftpPath(work), done));
    assert.deepEqual(
      names.map((entry) => entry.filename),
      ['notes.txt'],
    );
    // Written through the panel and read back, in parts as a transfer would.
    await call((done) =>
      sftp.writeFile(sftpPath(join(work, 'up.bin')), Buffer.alloc(300_000, 7), done),
    );
    const back = await call<Buffer>((done) => sftp.readFile(sftpPath(join(work, 'up.bin')), done));
    assert.equal(back.length, 300_000);
    await call((done) =>
      sftp.rename(sftpPath(join(work, 'up.bin')), sftpPath(join(work, 'moved.bin')), done),
    );
    await call((done) => sftp.unlink(sftpPath(join(work, 'moved.bin')), done));
    // A computer that is not connected has no SFTP to give.
    const away = await f.files(signed, randomUUID()).catch((error: Error) => error);
    assert.ok(away instanceof Error);
  },
);

test('without an SFTP server of its own the service offers only other computers files', async (t) => {
  const f = await fixture(t, false, null);
  const signed = await f.desktop();
  assert.equal((signed.ready.files as { server: boolean }).server, false);
  assert.equal((signed.ready.files as { protected: boolean }).protected, false);
  // The file connection is taken, for the computers it can reach; the service's own files are not offered.
  const refused = await f.files(signed).catch((error: Error) => error);
  assert.ok(refused instanceof Error);
  assert.match(String(refused.message), /subsystem|Unable to start/i);
});

test(
  'a file connection needs the secret of a live execution channel, and ends with its control connection',
  { skip },
  async (t) => {
    const f = await fixture(t);
    const signed = await f.desktop();
    assert.equal(await f.files({ ...signed, secret: 'x'.repeat(43) }), TUNNEL_CLOSE.refused);
    assert.equal(await f.files({ ...signed, connectionId: randomUUID() }), TUNNEL_CLOSE.unknown);
    const sftp = await f.files(signed);
    assert.ok(typeof sftp !== 'number');
    const ended = once(f.channels.at(-1)!, 'close');
    signed.control.close();
    await ended;
  },
);

test(
  'Landlock keeps the service SFTP server from its secrets and nothing else',
  {
    skip: skip || (process.platform !== 'linux' && 'Landlock is Linux only'),
  },
  async (t) => {
    const f = await fixture(t, true);
    const signed = await f.desktop();
    if (!(signed.ready.files as { protected: boolean }).protected)
      return t.skip('the kernel has no Landlock');
    writeFileSync(join(f.configDir, '.credentials.json'), 'SECRET');
    writeFileSync(
      join(f.configDir, 'settings.json'),
      '{"env":{"CLAUDE_CODE_OAUTH_TOKEN":"SECRET"}}',
    );
    mkdirSync(join(f.configDir, 'projects', 'p', 'memory'), { recursive: true });
    writeFileSync(join(f.configDir, 'projects', 'p', 'memory', 'MEMORY.md'), 'remembered');
    const work = join(f.directory, 'native', 'root');
    mkdirSync(work, { recursive: true });
    // Made after the service started, as Claude's files are: reached all the same.
    const sftp = await f.files(signed);
    assert.ok(typeof sftp !== 'number');
    const read = (path: string) =>
      call<Buffer>((done) => sftp.readFile(path, done)).then(String, () => null);
    assert.equal(await read(join(f.configDir, '.credentials.json')), null);
    assert.equal(await read(join(f.configDir, 'settings.json')), null);
    assert.equal(await read(join(f.directory, 'sessions.sqlite')), null);
    assert.equal(await read(`/proc/${process.pid}/environ`), null);
    await assert.rejects(call((done) => sftp.unlink(join(f.configDir, '.credentials.json'), done)));
    await assert.rejects(
      call((done) =>
        sftp.rename(join(f.configDir, '.credentials.json'), join(work, 'taken'), done),
      ),
    );
    assert.equal(
      await read(join(f.configDir, 'projects', 'p', 'memory', 'MEMORY.md')),
      'remembered',
    );
    await call((done) => sftp.writeFile(join(work, 'made.txt'), 'made', done));
    assert.equal(await read(join(work, 'made.txt')), 'made');
  },
);
