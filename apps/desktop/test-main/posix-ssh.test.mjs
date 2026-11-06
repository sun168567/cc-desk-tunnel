import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import ssh2 from 'ssh2';
import { startPosixSsh } from '../electron/posix-ssh.mjs';
import { quotePosix } from '../electron/shell-environment.mjs';

const { Client, utils } = ssh2;
const execute = promisify(execFile);
// On macOS, and on a Linux that has zsh, which the fixtures write their startup files for.
const mac = { skip: process.platform === 'win32' || !existsSync('/bin/zsh'), timeout: 30000 };
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'cc-desk-posix-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await options.setup?.(directory);
  const controller = new AbortController();
  const executor = await startPosixSsh(
    randomUUID(),
    {
      environment: { CC_DESK_TUNNEL_SCHEDULES: join(directory, 'schedules.json') },
      shellPath: '/bin/zsh',
      cwd: directory,
      env: { ...process.env, HOME: directory, ZDOTDIR: directory },
      ...options,
    },
    controller.signal,
    (message) => assert.fail(message),
  );
  t.after(() => executor.close());
  const identity = join(directory, 'identity');
  const knownHosts = join(directory, 'known_hosts');
  await writeFile(identity, executor.credentials.privateKey, { mode: 0o600 });
  await writeFile(
    knownHosts,
    `[127.0.0.1]:${executor.port} ${executor.credentials.hostPublicKey}\n`,
    { mode: 0o600 },
  );
  const args = [
    '-p',
    String(executor.port),
    '-i',
    identity,
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    `UserKnownHostsFile=${knownHosts}`,
  ];
  return {
    directory,
    executor,
    args,
    async ssh(command, input) {
      return new Promise((done, fail) => {
        const child = execFile(
          '/usr/bin/ssh',
          [...args, 'device@127.0.0.1', command],
          {
            encoding: 'buffer',
            timeout: 15000,
            maxBuffer: 32 * 1024 * 1024,
          },
          (error, stdout, stderr) =>
            error
              ? fail(
                  Object.assign(
                    new Error(
                      `SSH command failed (${error.code}); stdout ${stdout.length} bytes; stderr ${stderr.length} bytes`,
                    ),
                    { code: error.code, stdout, stderr },
                  ),
                )
              : done({ stdout, stderr }),
        );
        child.stdin.on('error', () => {});
        child.stdin.end(input);
      });
    },
  };
}

function clientOf(executor, overrides = {}) {
  const client = new Client();
  return new Promise((done, fail) => {
    client.once('error', (error) => {
      client.destroy();
      fail(error);
    });
    client.once('ready', () => done(client));
    client.connect({
      host: '127.0.0.1',
      port: executor.port,
      username: executor.credentials.username,
      privateKey: executor.credentials.privateKey,
      readyTimeout: 3000,
      ...overrides,
    });
  });
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function until(check, message) {
  for (const deadline = Date.now() + 7000; !(await check());) {
    assert.ok(Date.now() < deadline, message);
    await delay(20);
  }
}
async function sleeper(t, executor, client) {
  client ??= await clientOf(executor);
  t.after(() => client.destroy());
  const stream = await new Promise((done, fail) =>
    client.exec(
      `trap '' TERM; printf '%s\\n' $$; /bin/sh -c 'trap "" TERM; printf "%s\\n" $$; exec /bin/sleep 120' & wait`,
      (error, channel) => (error ? fail(error) : done(channel)),
    ),
  );
  let output = '';
  stream.on('data', (chunk) => (output += chunk));
  stream.stderr.resume();
  await until(() => output.trim().split('\n').length === 2, 'command and descendant started');
  const pids = output.trim().split('\n').map(Number);
  t.after(() => {
    for (const pid of pids) if (alive(pid)) process.kill(pid, 'SIGKILL');
  });
  return { client, stream, pids };
}

test(
  'only this connection key and username authenticate, with signatures verified',
  mac,
  async (t) => {
    const first = await fixture(t);
    const second = await fixture(t);
    assert.notEqual(
      first.executor.credentials.hostPublicKey,
      second.executor.credentials.hostPublicKey,
    );
    assert.notEqual(first.executor.credentials.privateKey, second.executor.credentials.privateKey);
    await assert.rejects(
      clientOf(first.executor, { privateKey: second.executor.credentials.privateKey }),
      /authentication/,
    );
    await assert.rejects(clientOf(first.executor, { username: 'other' }), /authentication/);
    await assert.rejects(
      clientOf(first.executor, { privateKey: undefined, password: 'not-allowed' }),
      /authentication/,
    );
    const key = utils.parseKey(first.executor.credentials.privateKey);
    key.sign = () => Buffer.alloc(64);
    await assert.rejects(clientOf(first.executor, { privateKey: key }), /authentication/);
    const { stdout } = await first.ssh("printf 'authenticated'");
    assert.equal(stdout.toString(), 'authenticated');
  },
);

test('real OpenSSH preserves stdout, stderr, nonzero exits and input EOF', mac, async (t) => {
  const fixtureOf = await fixture(t);
  const success = await fixtureOf.ssh(
    "cat; printf '\\n结束'; printf '错误流' >&2",
    Buffer.from('输入数据'),
  );
  assert.equal(success.stdout.toString(), '输入数据\n结束');
  assert.equal(success.stderr.toString(), '错误流');
  await assert.rejects(fixtureOf.ssh("printf 'failure' >&2; exit 7"), (error) => {
    assert.equal(error.code, 7);
    assert.equal(error.stderr.toString(), 'failure');
    return true;
  });
});

test(
  'one login initializes the environment shared by commands without disclosing it in credentials',
  mac,
  async (t) => {
    const secret = randomUUID();
    const f = await fixture(t, {
      setup: async (directory) => {
        await writeFile(
          join(directory, '.zshrc'),
          `export CC_DESK_ENV_TEST=${quotePosix(secret)}; echo login >> "$HOME/login-count"\n`,
        );
      },
    });
    for (let index = 0; index < 2; index++) {
      const { stdout } = await f.ssh('printf "%s" "$CC_DESK_ENV_TEST"');
      assert.equal(stdout.toString(), secret);
    }
    assert.equal((await readFile(join(f.directory, 'login-count'), 'utf8')).trim(), 'login');
    assert.equal(JSON.stringify(f.executor.credentials).includes(secret), false);
  },
);

test('a bash symlink retains bash command semantics and glob expansion', mac, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'cc-desk-bash-link-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const shells = join(directory, "shell's 中文目录");
  await mkdir(shells);
  const executable = join(shells, 'bash-versioned');
  const alias = join(shells, 'bash');
  // A link named bash to a file of another name, as a versioned installation has it: taking the shell by the
  // name of what the link points at would give bash the flags of zsh. The file hands over to the system's
  // own bash where it is; a copy of that does not run on Apple silicon outside /bin.
  await writeFile(executable, '#!/bin/bash\nexec /bin/bash "$@"\n', { mode: 0o700 });
  await symlink('bash-versioned', alias);
  const f = await fixture(t, {
    shellPath: alias,
    setup: (project) =>
      Promise.all([
        writeFile(join(project, 'matched.txt'), 'file'),
        writeFile(
          join(project, '.bash_profile'),
          'export CC_DESK_BASH_ALIAS="captured"; echo login >> "$HOME/login-count"\n',
        ),
      ]),
  });
  for (let index = 0; index < 2; index++) {
    const { stdout } = await f.ssh(
      'printf \'%s\\n\' "$CC_DESK_BASH_ALIAS" "$BASH_VERSION" *.txt; printf \'%s\\n\' {left,right}',
    );
    const [environment, version, ...expanded] = stdout.toString().trim().split('\n');
    assert.equal(environment, 'captured');
    assert.match(version, /^\d+\.\d+/);
    assert.deepEqual(expanded, ['matched.txt', 'left', 'right']);
  }
  const input = Buffer.from('标准输入经过 bash 别名\n');
  assert.deepEqual((await f.ssh('cat', input)).stdout, input);
  await assert.rejects(f.ssh('exit 23'), (error) => error.code === 23);
  assert.equal((await readFile(join(f.directory, 'login-count'), 'utf8')).trim(), 'login');
});

test(
  'parallel commands and large backpressured input, stdout and stderr remain intact',
  mac,
  async (t) => {
    const fixtureOf = await fixture(t);
    const commands = await Promise.all(
      Array.from({ length: 16 }, (_, index) => fixtureOf.ssh(`printf '%s' ${index}`)),
    );
    assert.deepEqual(
      commands.map(({ stdout }) => stdout.toString()),
      Array.from({ length: 16 }, (_, index) => String(index)),
    );
    const megabytes = 8;
    const output = await fixtureOf.ssh(
      `${quotePosix(process.execPath)} -e ${quotePosix(`const b=Buffer.alloc(1024*1024,37);for(let i=0;i<${megabytes};i++){require('fs').writeSync(1,b);require('fs').writeSync(2,b)}`)}`,
    );
    const expected = Buffer.alloc(megabytes * 1024 * 1024, 37);
    assert.equal(sha256(output.stdout), sha256(expected));
    assert.equal(sha256(output.stderr), sha256(expected));
    const input = randomBytes(4 * 1024 * 1024);
    const reported = await fixtureOf.ssh(
      `${quotePosix(process.execPath)} -e ${quotePosix("const h=require('crypto').createHash('sha256');process.stdin.on('data',d=>h.update(d)).on('end',()=>console.log(h.digest('hex')))")}`,
      input,
    );
    assert.equal(reported.stdout.toString().trim(), sha256(input));
  },
);

test('both output streams drain after either exhausts the shared SSH window', mac, async (t) => {
  const { executor } = await fixture(t);
  const client = await clientOf(executor);
  t.after(() => client.destroy());
  for (const order of [
    [1, 2],
    [2, 1],
  ]) {
    const script = `const fs=require('fs');const b=Buffer.alloc(65536,19);for(const fd of [${order}])for(let i=0;i<64;i++)fs.writeSync(fd,b);`;
    const stream = await new Promise((done, fail) =>
      client.exec(`${quotePosix(process.execPath)} -e ${quotePosix(script)}`, (error, channel) =>
        error ? fail(error) : done(channel),
      ),
    );
    stream.end();
    const first = order[0] === 1 ? stream : stream.stderr;
    await until(
      () => first.readableLength >= first.readableHighWaterMark,
      'the first output stream exhausted the client receive window',
    );
    const stdout = [];
    const stderr = [];
    const closed = once(stream, 'close');
    stream.on('data', (chunk) => stdout.push(chunk));
    stream.stderr.on('data', (chunk) => stderr.push(chunk));
    const [code] = await closed;
    assert.equal(code, 0);
    const expected = sha256(Buffer.alloc(4 * 1024 * 1024, 19));
    assert.equal(sha256(Buffer.concat(stdout)), expected);
    assert.equal(sha256(Buffer.concat(stderr)), expected);
  }
});

test(
  'closing a backpressured channel releases pending output and reclaims its process',
  mac,
  async (t) => {
    const { executor, directory } = await fixture(t);
    const client = await clientOf(executor);
    t.after(() => client.destroy());
    const marker = join(directory, 'writer-pid');
    const script = `const fs=require('fs');process.on('SIGTERM',()=>{});fs.writeFileSync(process.argv.at(-1),String(process.pid));const b=Buffer.alloc(65536,23);for(let i=0;i<1024;i++){fs.writeSync(1,b);fs.writeSync(2,b);}`;
    const stream = await new Promise((done, fail) =>
      client.exec(
        `${quotePosix(process.execPath)} -e ${quotePosix(script)} ${quotePosix(marker)}`,
        (error, channel) => (error ? fail(error) : done(channel)),
      ),
    );
    stream.end();
    await until(
      () => stream.readableLength + stream.stderr.readableLength >= stream.readableHighWaterMark,
      'the writer exhausted its SSH send window',
    );
    const pid = Number(await readFile(marker, 'utf8'));
    t.after(() => {
      if (alive(pid)) process.kill(pid, 'SIGKILL');
    });
    stream.destroy();
    await until(() => !alive(pid), 'closing a blocked writer reclaimed its process');
    const next = await new Promise((done, fail) =>
      client.exec('printf survived', (error, channel) => (error ? fail(error) : done(channel))),
    );
    let output = '';
    const closed = once(next, 'close');
    next.on('data', (chunk) => (output += chunk));
    next.stderr.resume();
    next.end();
    const [code] = await closed;
    assert.equal(code, 0);
    assert.equal(output, 'survived');
  },
);

test('system SFTP works through real scp in both directions with Unicode paths', mac, async (t) => {
  const fixtureOf = await fixture(t);
  const source = join(fixtureOf.directory, 'source.bin');
  const copied = join(fixtureOf.directory, '副本 file.bin');
  const returned = join(fixtureOf.directory, 'returned.bin');
  const bytes = randomBytes(2 * 1024 * 1024);
  await writeFile(source, bytes);
  const args = fixtureOf.args.map((value) => (value === '-p' ? '-P' : value));
  await execute('/usr/bin/scp', [...args, source, `device@127.0.0.1:${copied}`], {
    timeout: 15000,
  });
  await execute('/usr/bin/scp', [...args, `device@127.0.0.1:${copied}`, returned], {
    timeout: 15000,
  });
  assert.equal(sha256(await readFile(returned)), sha256(bytes));
});

test('PTY, shell, arbitrary subsystem and forwarding requests are rejected', mac, async (t) => {
  const { executor } = await fixture(t);
  const client = await clientOf(executor);
  t.after(() => client.destroy());
  const rejected = (start) =>
    assert.rejects(
      new Promise((done, fail) =>
        start((error, channel) => {
          if (channel) channel.destroy();
          error ? fail(error) : done();
        }),
      ),
    );
  await rejected((callback) => client.shell(callback));
  await rejected((callback) => client.shell(false, callback));
  await rejected((callback) => client.exec('echo should-not-start', { pty: true }, callback));
  await rejected((callback) => client.subsys('unknown', callback));
  await rejected((callback) => client.forwardOut('127.0.0.1', 1, '127.0.0.1', 22, callback));
  await rejected((callback) => client.forwardIn('127.0.0.1', 0, callback));
});

test(
  'closing one channel terminates its TERM-resistant descendants while another channel continues',
  mac,
  async (t) => {
    const { executor } = await fixture(t);
    const client = await clientOf(executor);
    const first = await sleeper(t, executor, client);
    const second = await sleeper(t, executor, client);
    first.stream.destroy();
    await until(
      () => first.pids.every((pid) => !alive(pid)),
      'closed channel process group was killed',
    );
    assert.ok(second.pids.every(alive));
    client.destroy();
    await until(
      () => second.pids.every((pid) => !alive(pid)),
      'disconnected connection process group was killed',
    );
  },
);

test(
  'normal command completion reclaims background children retaining output pipes',
  mac,
  async (t) => {
    const f = await fixture(t);
    const result = await f.ssh('/bin/sleep 120 & printf "%s\\n" $!; exit 0');
    const pid = Number(result.stdout.toString().trim());
    assert.ok(pid > 0);
    t.after(() => {
      if (alive(pid)) process.kill(pid, 'SIGKILL');
    });
    assert.equal(alive(pid), false);
  },
);

test(
  'a command spawn failure finishes its channel without stopping other commands',
  mac,
  async (t) => {
    const { executor, directory } = await fixture(t);
    const client = await clientOf(executor);
    t.after(() => client.destroy());
    const running = await sleeper(t, executor, client);
    await rm(directory, { recursive: true, force: true });
    const stream = await new Promise((done, fail) =>
      client.exec('printf should-not-run', (error, channel) =>
        error ? fail(error) : done(channel),
      ),
    );
    stream.resume();
    stream.stderr.resume();
    stream.end();
    const [code] = await once(stream, 'close');
    assert.equal(code, 127);
    assert.ok(running.pids.every(alive));
    client.destroy();
    await until(
      () => running.pids.every((pid) => !alive(pid)),
      'spawn failure did not lose process ownership',
    );
  },
);

test(
  'executor close is idempotent, closes the listener and kills active descendants',
  mac,
  async (t) => {
    const { executor } = await fixture(t);
    const running = await sleeper(t, executor);
    await Promise.all([executor.close(), executor.close()]);
    await until(
      () => running.pids.every((pid) => !alive(pid)),
      'shutdown process group was killed',
    );
    await assert.rejects(
      new Promise((done, fail) => {
        const socket = connect(executor.port, '127.0.0.1');
        socket.once('connect', () => {
          socket.destroy();
          done();
        });
        socket.once('error', fail);
      }),
      /ECONNREFUSED/,
    );
  },
);

test('startup cancellation waits until the supervised login shell is reclaimed', mac, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'cc-desk-posix-cancel-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const marker = join(directory, 'profile-pid');
  await writeFile(join(directory, '.zshrc'), `echo $$ > ${quotePosix(marker)}; /bin/sleep 120\n`);
  const controller = new AbortController();
  const preparing = startPosixSsh(
    randomUUID(),
    {
      shellPath: '/bin/zsh',
      cwd: directory,
      env: { ...process.env, HOME: directory, ZDOTDIR: directory },
    },
    controller.signal,
  );
  const cancelled = assert.rejects(preparing, /cancelled/);
  await until(
    () =>
      access(marker).then(
        () => true,
        () => false,
      ),
    'login profile started',
  );
  const pid = Number((await readFile(marker, 'utf8')).trim());
  t.after(() => {
    if (alive(pid)) process.kill(pid, 'SIGKILL');
  });
  controller.abort();
  await cancelled;
  assert.equal(alive(pid), false);
});

test(
  'shutdown also closes a raw TCP connection that has not sent an SSH header',
  mac,
  async (t) => {
    const { executor } = await fixture(t);
    const socket = connect(executor.port, '127.0.0.1');
    socket.on('error', () => {});
    t.after(() => socket.destroy());
    await once(socket, 'connect');
    socket.resume();
    // Closed either way: the service may end the connection or reset it, and a reset arrives as an error
    // first, which `once` would turn into a failure.
    const ended = new Promise((resolve) => socket.once('close', resolve));
    await executor.close();
    await ended;
    assert.equal(socket.destroyed, true);
  },
);

test('SSH keepalives reclaim a command when its TCP path stops replying', mac, async (t) => {
  const { executor } = await fixture(t, { keepaliveInterval: 100 });
  let link;
  const proxy = createServer((socket) => {
    const upstream = connect(executor.port, '127.0.0.1');
    link = { socket, upstream };
    for (const end of [socket, upstream]) end.on('error', () => {});
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  t.after(() => {
    link.socket.destroy();
    link.upstream.destroy();
    return new Promise((done) => proxy.close(done));
  });
  const client = await clientOf({ ...executor, port: proxy.address().port });
  const running = await sleeper(t, executor, client);
  link.socket.unpipe(link.upstream);
  link.upstream.unpipe(link.socket);
  link.socket.resume();
  link.upstream.resume();
  await until(
    () => running.pids.every((pid) => !alive(pid)),
    'stalled SSH connection process group was killed',
  );
});

test(
  'an abruptly killed owner is observed through IPC and its execution processes are reclaimed',
  mac,
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'cc-desk-posix-owner-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const executorModule = pathToFileURL(resolve('apps/desktop/electron/posix-ssh.mjs')).href;
    const sshModule = pathToFileURL(resolve('node_modules/ssh2/lib/index.js')).href;
    const source = `
    import {startPosixSsh} from ${JSON.stringify(executorModule)};
    import ssh2 from ${JSON.stringify(sshModule)};
    const e=await startPosixSsh('owner-test',{shellPath:'/bin/zsh',cwd:${JSON.stringify(directory)},env:{...process.env,HOME:${JSON.stringify(directory)},ZDOTDIR:${JSON.stringify(directory)}}},new AbortController().signal,()=>{});
    const c=new ssh2.Client();
    c.on('error',()=>{}).once('ready',()=>c.exec('echo $$; sleep 120',(err,s)=>{if(err)throw err;s.on('data',d=>console.log(JSON.stringify({port:e.port,pid:Number(d.toString().trim())})));s.stderr.resume();})).connect({host:'127.0.0.1',port:e.port,username:e.credentials.username,privateKey:e.credentials.privateKey});
  `;
    const owner = spawn(process.execPath, ['--input-type=module', '-e', source], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    t.after(() => {
      if (owner.exitCode === null && owner.signalCode === null) owner.kill('SIGKILL');
    });
    let output = '';
    owner.stdout.on('data', (chunk) => (output += chunk));
    await until(() => output.includes('\n'), 'owner command started');
    const { port, pid } = JSON.parse(output.trim());
    t.after(() => {
      if (alive(pid)) process.kill(pid, 'SIGKILL');
    });
    owner.kill('SIGKILL');
    await once(owner, 'close');
    await until(() => !alive(pid), 'IPC disconnect reclaimed command');
    await assert.rejects(
      new Promise((done, fail) => {
        const socket = connect(port, '127.0.0.1');
        socket.once('connect', () => {
          socket.destroy();
          done();
        });
        socket.once('error', fail);
      }),
      /ECONNREFUSED/,
    );
  },
);

test(
  'a script reaches the shell the way the service sends one, with its exit code kept',
  mac,
  async (t) => {
    const { sshConfig, sshProbe } = await import('../../server/src/tunnel.ts');
    const f = await fixture(t);
    // The service's own configuration, pointed straight at the SSH service instead of through a tunnel.
    const files = sshConfig(
      f.directory,
      f.executor.port,
      f.executor.credentials.username,
      f.executor.credentials.hostPublicKey,
      'win32',
      15,
      process.platform,
      f.executor.credentials.shells,
    );
    // The SSH service names the user's own shell, which the host of its scripts is called after.
    const [shell] = f.executor.credentials.shells;
    assert.match(shell, /^(zsh|bash)$/);
    assert.equal(f.executor.credentials.shells.length, 1);
    const configPath = join(f.directory, 'ssh_config');
    await writeFile(join(f.directory, 'known_hosts'), files.knownHosts, { mode: 0o600 });
    await writeFile(configPath, files.config, { mode: 0o600 });
    await sshProbe(configPath, `device-${shell}`);
    const run = (script) =>
      new Promise((done) => {
        const child = execFile(
          '/usr/bin/ssh',
          ['-F', configPath, `device-${shell}`],
          { timeout: 15000 },
          (error, stdout, stderr) => done({ code: error?.code ?? 0, stdout, stderr }),
        );
        child.stdin.end(script);
      });
    const result = await run(
      `cd -- ${quotePosix(f.directory)}\nfor name in 一 "two words"; do\n  printf '%s|' "$name"\ndone\nprintf '%s' "$CC_DESK_TUNNEL_SCHEDULES"\nexit 3\n`,
    );
    assert.equal(result.stdout, `一|two words|${join(f.directory, 'schedules.json')}`);
    assert.equal(result.code, 3);
    assert.equal((await run('nonexistent-command-of-the-test\n')).code, 127);
  },
);

test(
  'commands of one device share an SSH connection to the service, as the server sets it up',
  mac,
  async (t) => {
    const { sshConfig } = await import('../../server/src/tunnel.ts');
    const f = await fixture(t);
    // The socket of a shared connection needs a short path, which the temporary directory of macOS is not.
    const directory = await mkdtemp('/tmp/cc-mux-');
    t.after(() => rm(directory, { recursive: true, force: true }));
    const files = sshConfig(
      directory,
      f.executor.port,
      f.executor.credentials.username,
      f.executor.credentials.hostPublicKey,
      process.platform,
      15,
      process.platform,
      f.executor.credentials.shells,
    );
    const script = `device-${f.executor.credentials.shells[0]}`;
    assert.match(files.config, /ControlMaster auto/);
    const configPath = join(directory, 'ssh_config');
    await writeFile(join(directory, 'identity'), f.executor.credentials.privateKey, {
      mode: 0o600,
    });
    await writeFile(join(directory, 'known_hosts'), files.knownHosts, { mode: 0o600 });
    await writeFile(configPath, files.config, { mode: 0o600 });
    const ssh = (host, input, ...command) =>
      new Promise((done) => {
        const child = execFile(
          '/usr/bin/ssh',
          ['-F', configPath, host, ...command],
          { timeout: 20000 },
          (error, stdout) => done({ code: error?.code ?? 0, stdout }),
        );
        child.stdin.end(input);
      });
    t.after(() => ssh('device', '', '-O', 'exit'));
    // The first opens the connection; the rest, scripts and command lines together, run over it.
    assert.deepEqual(await ssh(script, 'echo first\n'), { code: 0, stdout: 'first\n' });
    assert.equal((await ssh('device', '', '-O', 'check')).code, 0);
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        index % 2
          ? ssh(script, `sleep 0.2; printf '%s' ${index}; exit ${index}\n`)
          : ssh('device', '', `printf '%s' ${index}`),
      ),
    );
    assert.deepEqual(
      results,
      Array.from({ length: 12 }, (_, index) => ({
        code: index % 2 ? index : 0,
        stdout: String(index),
      })),
    );
  },
);
