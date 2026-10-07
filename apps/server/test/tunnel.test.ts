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
