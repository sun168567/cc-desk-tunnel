import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sshConfig, WindowsTunnel, availablePort } from '../src/tunnel.ts';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { remotePrompt } from '../src/claude.ts';

test('SSH config pins loopback target and host key, disallows interactive/agent forwarding', () => {
  const files = sshConfig('/tmp/private', 32123, 'user', 'ssh-ed25519 AAAATEST');
  assert.match(files.config, /HostName 127\.0\.0\.1/);
  assert.match(files.config, /StrictHostKeyChecking yes/);
  assert.match(files.config, /BatchMode yes/);
  assert.match(files.config, /ForwardAgent no/);
  assert.match(files.config, /IgnoreUnknown WarnWeakCrypto\n {2}WarnWeakCrypto no/);
  assert.equal(files.knownHosts, '[127.0.0.1]:32123 ssh-ed25519 AAAATEST\n');
});
test('context references native SSH configuration without inventing execution tools', () => {
  const prompt = remotePrompt(
    "D:\\中文 空格\\it's",
    {
      configPath: '/private/ssh_config',
      powershellPath: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    },
    '0d0c6a0e-6a53-4a0c-9d3a-2f6f5f3f7b11',
  );
  assert.match(prompt, /%APPDATA%\\CC Desk Tunnel\\schedules\.json/);
  assert.match(prompt, /0d0c6a0e-6a53-4a0c-9d3a-2f6f5f3f7b11/);
  assert.match(prompt, /native Bash/);
  assert.match(prompt, /ssh -F/);
  assert.match(prompt, /it''s/);
  assert.doesNotMatch(prompt, /mcp__/);
});
test('missing frps executable fails and closes without leaving credentials or hanging', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'claude-tunnel-failure-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const tunnel = new WindowsTunnel(
    {
      executable: join(directory, 'missing-frps'),
      publicHost: 'localhost',
      port: await availablePort(),
      certificatePath: join(directory, 'unused.crt'),
      keyPath: join(directory, 'unused.key'),
      serverName: 'unused',
    },
    directory,
    randomUUID(),
    () => {},
  );
  await assert.rejects(tunnel.start(), /startup failed/);
  await tunnel.close();
  assert.equal(existsSync(tunnel.directory), false);
});

test('Linux context targets desktop Bash and its actual schedules path', () => {
  const prompt = remotePrompt(
    "/home/user/it's 中文",
    {
      configPath: '/private/ssh_config',
      powershellPath: '/bin/bash',
      platform: 'linux',
      schedulesPath: '/home/user/.config/CC Desk Tunnel/schedules.json',
    },
    'session-id',
  );
  assert.match(prompt, /Shell: \/bin\/bash/);
  assert.match(prompt, /NOT this agent host/);
  assert.match(prompt, /\.config\/CC Desk Tunnel\/schedules.json/);
  assert.doesNotMatch(prompt, /PowerShell|%APPDATA%/);
});

test('Linux desktops share one SSH connection and wait for a reconnecting desktop', () => {
  const linux = sshConfig('/data/connections/id', 32123, 'user', 'ssh-ed25519 AAAATEST', 'linux');
  assert.match(
    linux.config,
    /ControlMaster auto\n {2}ControlPath "\/data\/connections\/id\/cm"\n {2}ControlPersist yes/,
  );
  assert.match(linux.config, /ConnectTimeout 30/);
  // A socket path that does not fit in sun_path would make every ssh fail; such a directory goes without.
  const long = sshConfig(`/${'x'.repeat(120)}`, 32123, 'user', 'ssh-ed25519 AAAATEST', 'linux');
  assert.doesNotMatch(long.config, /ControlMaster/);
  const windows = sshConfig('/data/connections/id', 32123, 'user', 'ssh-ed25519 AAAATEST');
  assert.doesNotMatch(windows.config, /ControlMaster/);
  assert.match(windows.config, /ConnectTimeout 5/);
});

test('Linux context without a scheduler does not point at one', () => {
  const prompt = remotePrompt(
    '/home/user/project',
    { configPath: '/private/ssh_config', powershellPath: '/bin/bash', platform: 'linux' },
    'session-id',
  );
  assert.doesNotMatch(prompt, /undefined|schedules/);
  assert.match(prompt, /no scheduled prompts/);
});
