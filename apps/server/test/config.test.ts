import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clearServiceVariables, environmentConfig } from '../src/config.ts';
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
