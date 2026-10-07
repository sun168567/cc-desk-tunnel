import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile, spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { connect, createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from 'ssh2';

const vendor = resolve('apps/desktop/vendor');
const available =
  process.platform === 'win32' &&
  (await access(join(vendor, 'openssh/sshd.exe')).then(
    () => true,
    () => false,
  ));
function execute(file, args) {
  return new Promise((resolve, reject) =>
    execFile(
      file,
      args,
      { windowsHide: true, encoding: 'utf8', timeout: 20000 },
      (error, stdout, stderr) =>
        error ? reject(new Error(stderr || error.message)) : resolve(stdout),
    ),
  );
}
async function prepare() {
  const directory = await mkdtemp(join(tmpdir(), 'cc-desk-tunnel-ssh-'));
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  try {
    const metadata = JSON.parse(
      await execute('pwsh.exe', [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-File',
        resolve('apps/desktop/electron/prepare-ssh.ps1'),
        '-Runtime',
        directory,
        '-OpenSshDirectory',
        join(vendor, 'openssh'),
        '-Port',
        String(port),
      ]),
    );
    const config = await readFile(join(directory, 'sshd_config'), 'utf8');
    assert.match(config, /ListenAddress 127\.0\.0\.1/);
    assert.match(config, /PasswordAuthentication no/);
    return { directory, port, metadata };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
function listening(port) {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1');
    socket.setTimeout(200);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
  });
}
async function until(check) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (await check()) return;
    await delay(100);
  }
  assert.fail('Component lifecycle timed out');
}
function hostArgs(directory, owner = process.pid) {
  return [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-File',
    resolve('apps/desktop/electron/component-host.ps1'),
    '-Runtime',
    directory,
    '-OpenSshDirectory',
    join(vendor, 'openssh'),
    '-OwnerProcessId',
    String(owner),
  ];
}

test(
  'application-owned OpenSSH closes its loopback listener and removes keys on client shutdown',
  { skip: !available, timeout: 30000 },
  async () => {
    const { directory, port } = await prepare();
    const host = spawn('pwsh.exe', hostArgs(directory), {
      windowsHide: true,
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let error = '';
    host.stderr.on('data', (data) => (error += data.toString('utf8')));
    const stopped = new Promise((resolve) => host.once('close', resolve));
    try {
      await until(() => listening(port));
      await writeFile(join(directory, 'stop'), '');
      assert.equal(await stopped, 0, error);
      assert.equal(await listening(port), false);
      assert.equal(
        await access(directory).then(
          () => true,
          () => false,
        ),
        false,
      );
    } finally {
      if (host.exitCode === null) {
        await execute('taskkill.exe', ['/PID', String(host.pid), '/T', '/F']);
        await stopped;
      }
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  'commands from the application-owned OpenSSH run without a visible console window',
  { skip: !available, timeout: 30000 },
  async () => {
    const { directory, port, metadata } = await prepare();
    const host = spawn('pwsh.exe', hostArgs(directory), { windowsHide: true, stdio: 'ignore' });
    const stopped = new Promise((resolve) => host.once('close', resolve));
    const script = `Add-Type -Namespace Probe -Name Console -MemberDefinition '[DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow(); [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);'
    [Probe.Console]::IsWindowVisible([Probe.Console]::GetConsoleWindow())`;
    try {
      await until(() => listening(port));
      const output = await new Promise((resolve, reject) => {
        const client = new Client();
        client
          .once('error', reject)
          .once('ready', () =>
            client.exec(
              `"${metadata.powershellPath}" -NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}`,
              (error, stream) => {
                if (error) return reject(error);
                let text = '';
                stream
                  .on('data', (data) => (text += data.toString('utf8')))
                  .on('close', () => {
                    client.end();
                    resolve(text.trim());
                  });
                stream.end();
              },
            ),
          )
          .connect({
            host: '127.0.0.1',
            port,
            username: metadata.username,
            privateKey: metadata.privateKey,
          });
      });
      assert.equal(output, 'False');
    } finally {
      await writeFile(join(directory, 'stop'), '');
      await stopped;
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  'abrupt client exit is detected by the component host and reclaims OpenSSH',
  { skip: !available, timeout: 30000 },
  async () => {
    const { directory, port } = await prepare();
    const source = `
    const { spawn } = require('node:child_process');
    const args = ${JSON.stringify(hostArgs(directory))};
    args[args.length - 1] = String(process.pid);
    const child = spawn('pwsh.exe', args, { windowsHide: true, stdio: 'ignore' });
    child.on('error', () => process.exit(1));
    child.on('exit', (code) => console.error('Host exited:', code));
    console.log(child.pid);
    setInterval(() => {}, 1000);
  `;
    const owner = spawn(process.execPath, ['-e', source], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let diagnostics = '';
    owner.stdout.on('data', (data) => (diagnostics += data.toString('utf8')));
    owner.stderr.on('data', (data) => (diagnostics += data.toString('utf8')));
    owner.once('exit', (code) => (diagnostics += ` Owner exited: ${code}`));
    const exited = new Promise((resolve) => owner.once('close', resolve));
    try {
      await until(() => listening(port)).catch((error) => {
        throw new Error(`${error.message}: ${diagnostics}`);
      });
      // Deliberately kill only the client, not its tree: the host must observe the owner process.
      await execute('taskkill.exe', ['/PID', String(owner.pid), '/F']);
      await exited;
      await until(async () => !(await listening(port)));
      // A hard console/process-tree termination can bypass the PowerShell finally block.
      // The job must still remove the executable listener; the fixture removes inert files.
    } finally {
      if (owner.exitCode === null) {
        await execute('taskkill.exe', ['/PID', String(owner.pid), '/T', '/F']);
        await exited;
      }
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  'missing bundled frpc reclaims an already-started OpenSSH and temporary credentials',
  { skip: !available, timeout: 30000 },
  async () => {
    const { directory, port } = await prepare();
    try {
      await assert.rejects(
        execute('pwsh.exe', [
          ...hostArgs(directory),
          '-FrpcPath',
          join(directory, 'missing-frpc.exe'),
        ]),
      );
      assert.equal(await listening(port), false);
      assert.equal(
        await access(directory).then(
          () => true,
          () => false,
        ),
        false,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  'closing the application component job terminates an in-flight SSH command',
  { skip: !available, timeout: 30000 },
  async () => {
    const { directory, port, metadata } = await prepare();
    const fixture = await mkdtemp(join(tmpdir(), 'cc-desk-tunnel-test-'));
    const host = spawn('pwsh.exe', hostArgs(directory), { windowsHide: true, stdio: 'ignore' });
    const stopped = new Promise((resolve) => host.once('close', resolve));
    const marker = join(fixture, 'command-side-effect');
    let ssh;
    let sshStopped;
    try {
      await until(() => listening(port));
      const script = `Write-Output 'command-started'; Start-Sleep -Seconds 8; Set-Content -LiteralPath '${marker.replaceAll("'", "''")}' -Value 'should-not-complete'`;
      ssh = spawn(
        join(vendor, 'openssh/ssh.exe'),
        [
          '-T',
          '-p',
          String(port),
          '-i',
          join(directory, 'identity'),
          '-o',
          'BatchMode=yes',
          '-o',
          'StrictHostKeyChecking=accept-new',
          '-o',
          `UserKnownHostsFile=${join(directory, 'known_hosts')}`,
          `${metadata.username}@127.0.0.1`,
          `"${metadata.powershellPath}" -NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}`,
        ],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
      );
      sshStopped = new Promise((resolve) => ssh.once('close', resolve));
      let output = '';
      ssh.stdout.on('data', (data) => (output += data.toString('utf8')));
      await until(() => output.includes('command-started'));
      await writeFile(join(directory, 'stop'), '');
      assert.equal(await stopped, 0);
      await sshStopped;
      await delay(8500);
      assert.equal(
        await access(marker).then(
          () => true,
          () => false,
        ),
        false,
      );
      assert.equal(await listening(port), false);
    } finally {
      if (host.exitCode === null) {
        await execute('taskkill.exe', ['/PID', String(host.pid), '/T', '/F']);
        await stopped;
      }
      if (ssh?.exitCode === null) {
        await execute('taskkill.exe', ['/PID', String(ssh.pid), '/T', '/F']);
        await sshStopped;
      }
      await rm(directory, { recursive: true, force: true });
      await rm(fixture, { recursive: true, force: true });
    }
  },
);
