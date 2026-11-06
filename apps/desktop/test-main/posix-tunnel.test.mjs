import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { X509Certificate, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { WebSocket } from 'ws';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import { openProxyBridge } from '../electron/proxy-bridge.mjs';

// The whole execution channel on one machine, on macOS and Linux: the real service over TLS, the real
// connection bridge with the SSH service it starts, and the system's `ssh` and `scp` as the commands the
// native CLI would run, through the configuration the service keeps for the device. tunnel.test.mjs does the
// same on Windows and goes further into faults on the way, which are the same bytes on every system.
const execute = promisify(execFile);
const posix = { skip: process.platform === 'win32' || !existsSync('/bin/zsh'), timeout: 60000 };

async function connected(t) {
  const { createProxyServer } = await import('../../server/src/server.ts');
  // Short, for the socket of the shared SSH connection.
  const directory = await mkdtemp('/tmp/cc-tunnel-');
  const home = join(directory, 'home');
  const project = join(home, '项目 one');
  await execute('mkdir', ['-p', project]);
  await execute('openssl', [
    ...['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes'],
    ...['-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem')],
    ...['-subj', '/CN=localhost', '-days', '1'],
  ]);
  const tls = {
    cert: await readFile(join(directory, 'cert.pem')),
    key: await readFile(join(directory, 'key.pem')),
  };
  const token = `tunnel-test-${randomUUID()}`;
  const dataDir = join(directory, 'd');
  const server = createProxyServer({
    token,
    dataDir,
    tls,
    claude: { executable: join(directory, 'no-cli') },
    tunnel: {},
  });
  const port = Number(new URL(await server.listen(0)).port);
  const schedules = join(home, 'schedules.json');
  const bridge = await openProxyBridge(
    {
      url: `wss://127.0.0.1:${port}/ws`,
      fingerprint: new X509Certificate(tls.cert).fingerprint256,
    },
    {
      environment: { CC_DESK_TUNNEL_SCHEDULES: schedules },
      shellPath: '/bin/zsh',
      env: { ...process.env, HOME: home, ZDOTDIR: home },
      cwd: home,
    },
  );
  const local = new WebSocket(bridge.url);
  const messages = [];
  local.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
  await once(local, 'open');
  const id = randomUUID();
  local.send(
    JSON.stringify({
      type: 'auth',
      protocolVersion: PROTOCOL_VERSION,
      token,
      deviceName: '测试设备',
    }),
  );
  // The page names no system; the bridge writes this computer's into the frame.
  local.send(JSON.stringify({ type: 'device', id }));
  t.after(async () => {
    local.terminate();
    await bridge.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  });
  // The page hears `ready` only once the service has run a script on this computer through the channel.
  for (const deadline = Date.now() + 40000; !messages.some(({ type }) => type === 'ready');) {
    const refused = messages.find(({ type }) => type === 'connection.error');
    assert.equal(refused, undefined, JSON.stringify(refused));
    assert.ok(Date.now() < deadline, 'the connection did not become ready');
    await delay(20);
  }
  // What a session's own configuration includes: the device's, which stays through reconnects.
  const config = join(dataDir, 'devices', id, 'ssh_config');
  for (const deadline = Date.now() + 5000; !existsSync(config);) {
    assert.ok(Date.now() < deadline, 'the device got no SSH configuration');
    await delay(20);
  }
  const run = (program, args, input) =>
    new Promise((done) => {
      const child = execFile(program, args, { timeout: 30000 }, (error, stdout, stderr) =>
        done({ code: error?.code ?? 0, stdout, stderr }),
      );
      child.stdin.end(input);
    });
  return {
    config,
    home,
    project,
    schedules,
    bridge,
    // The host of scripts in the user's own shell, zsh here (see below).
    script: (text) => run('ssh', ['-F', config, 'device-zsh'], text),
    command: (line) => run('ssh', ['-F', config, 'device', line], ''),
    scp: (from, to) => run('scp', ['-q', '-F', config, from, to], ''),
  };
}

test(
  'scripts, command lines and files reach a POSIX device over the service address alone',
  posix,
  async (t) => {
    const device = await connected(t);
    const config = await readFile(device.config, 'utf8');
    assert.match(config, /^Host device-zsh\n {2}RemoteCommand exec "\$CC_DESK_TUNNEL_SHELL" -s\n/m);
    assert.match(config, /^Host device device-zsh$/m);
    assert.match(config, /ControlMaster auto/);
    // A script as the system prompt has it written: begun in the project, any length, its exit code kept.
    const result = await device.script(
      `cd -- '${device.project}'\nprintf '%s\\n' "$PWD" "$CC_DESK_TUNNEL_SCHEDULES"\nprintf '内容' > '文件 一.txt'\nexit 5\n`,
    );
    assert.deepEqual(result.stdout.split('\n'), [device.project, device.schedules, '']);
    assert.equal(result.code, 5);
    assert.equal((await device.command('printf %s "$CC_DESK_TUNNEL_SHELL"')).stdout, '/bin/zsh');
    // Together, over the one connection the first of them opened.
    const together = await Promise.all(
      Array.from({ length: 10 }, (_, index) => device.script(`sleep 0.2\nprintf '%s' ${index}\n`)),
    );
    assert.deepEqual(
      together.map(({ stdout }) => stdout),
      Array.from({ length: 10 }, (_, index) => String(index)),
    );
    // Files both ways, by the path form the prompt gives for scp.
    const fetched = join(device.home, 'fetched.txt');
    assert.equal((await device.scp(`device:${device.project}/文件 一.txt`, fetched)).code, 0);
    assert.equal(await readFile(fetched, 'utf8'), '内容');
    const large = join(device.home, 'large.bin');
    await writeFile(large, Buffer.alloc(8 * 1024 * 1024, 7));
    assert.equal((await device.scp(large, `device:${device.project}/大 文件.bin`)).code, 0);
    assert.equal(
      (await device.script(`wc -c < '${device.project}/大 文件.bin' | tr -d ' \\n'\n`)).stdout,
      String(8 * 1024 * 1024),
    );
  },
);

test('closing the client ends what its commands were running', posix, async (t) => {
  const device = await connected(t);
  const marker = join(device.home, 'pid');
  const running = device.script(`echo $$ > '${marker}'\nsleep 120\n`);
  for (const deadline = Date.now() + 10000; !existsSync(marker);) {
    assert.ok(Date.now() < deadline, 'the command did not start');
    await delay(20);
  }
  const pid = Number(await readFile(marker, 'utf8'));
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  t.after(() => alive() && process.kill(pid, 'SIGKILL'));
  assert.equal(alive(), true);
  await device.bridge.close();
  assert.notEqual((await running).code, 0);
  for (const deadline = Date.now() + 10000; alive();) {
    assert.ok(Date.now() < deadline, 'the command outlived the client');
    await delay(50);
  }
});
