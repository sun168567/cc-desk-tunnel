import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { applySavedCodexPath, clearServiceVariables, environmentConfig, writeCodexExecutable } from '../src/config.ts';
import { createProxyServer } from '../src/server.ts';

const native = {
  PROXY_ADAPTER: 'claude-code',
  PROXY_TOKEN: 'a'.repeat(32),
  PROXY_PUBLIC_HOST: 'proxy.example.com',
  PROXY_TLS_MODE: 'reverse-proxy',
};
// What a deployment made before 0.2.10 still has in its configuration file.
const legacy = {
  FRPS_TLS_CERT: '/private/frp.crt',
  FRPS_TLS_KEY: '/private/frp.key',
  FRPS_SERVER_NAME: 'cc-desk-tunnel.frp',
  FRPS_PORT: 'NaN',
  FRPS_PATH: '/missing/frps',
};
test('reverse proxy mode leaves TLS to the proxy and defaults to loopback', () => {
  const { options, port } = environmentConfig(native, '/state');
  assert.equal(options.host, '127.0.0.1');
  assert.equal(options.reverseProxy, true);
  assert.equal(options.tls, undefined);
  assert.equal(port, 8787);
  assert.deepEqual(options.tunnel, {});
});
test('the frp settings of an older deployment are ignored, as is a missing public host', () => {
  const { options } = environmentConfig(
    { ...native, ...legacy, PROXY_PUBLIC_HOST: undefined },
    '/state',
  );
  assert.deepEqual(options.tunnel, {});
  assert.equal(
    environmentConfig({ PROXY_TOKEN: 'a'.repeat(32) }, '/state').options.tunnel,
    undefined,
  );
});
test('explicit native TLS mode is required', () => {
  assert.throws(
    () => environmentConfig({ ...native, PROXY_TLS_MODE: undefined }, '/state'),
    /Direct mode/,
  );
  assert.throws(
    () => environmentConfig({ ...native, PROXY_TLS_MODE: 'insecure' }, '/state'),
    /PROXY_TLS_MODE/,
  );

  assert.throws(() => environmentConfig({ ...native, PROXY_PORT: '0' }, '/state'), /PROXY_PORT/);
  assert.throws(
    () => environmentConfig({ ...native, CLAUDE_CONTEXT_RETENTION_DAYS: '0' }, '/state'),
    /RETENTION/,
  );
});
test('service settings are removed from the environment inherited by the native CLI, leaving everything else', () => {
  const env = {
    ...native,
    FRPS_PORT: '7000',
    PROXY_DATA_DIR: '/state',
    CLAUDE_PATH: 'claude',
    CLAUDE_MODEL: 'opus',
    CLAUDE_SETTINGS_PATH: '/private/provider.json',
    CLAUDE_CONTEXT_RETENTION_DAYS: '30',
    CODEX_PATH: 'codex',
    CODEX_PROFILE: 'default',
    CODEX_MODEL: 'gpt-test',
    CODEX_MEMORY_MB: '2048',
    CODEX_PIDS_MAX: '64',
    CODEX_CPU_MILLICORES: '1000',
    HOME: '/data/home',
    PATH: '/usr/bin',
    CLAUDE_CODE_USE_BEDROCK: '1',
    ANTHROPIC_BASE_URL: 'https://api.example.com',
  };
  clearServiceVariables(env);
  assert.deepEqual(env, {
    HOME: '/data/home',
    PATH: '/usr/bin',
    CLAUDE_CODE_USE_BEDROCK: '1',
    ANTHROPIC_BASE_URL: 'https://api.example.com',
  });
});
test('native server fails before opening history storage when transport config is incomplete', () => {
  assert.throws(
    () =>
      createProxyServer({
        token: 'a'.repeat(32),
        dataDir: '/must-not-open',
        claude: { executable: 'claude' },
      }),
    /TLS/,
  );
});
test('a Codex path saved in the data directory overrides the environment', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cc-desk-codex-path-'));
  try {
    const { options } = environmentConfig(
      { ...native, CODEX_PATH: 'from-env', PROXY_DATA_DIR: directory },
      directory,
    );
    assert.equal(options.codex?.executable, 'from-env');
    writeCodexExecutable(options.dataDir, 'from-file');
    applySavedCodexPath(options);
    assert.equal(options.codex?.executable, 'from-file');
    assert.equal(options.codex?.memoryMb, 2048);
    writeCodexExecutable(options.dataDir, '   ');
    applySavedCodexPath(options);
    assert.equal(options.codex, undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
