import assert from 'node:assert/strict';
import { test } from 'node:test';
import { proxyCertificateName, proxyConfiguration, proxyUpstream } from '../src/reverse-proxy.ts';

const values = {
  publicOrigin: 'https://web.example.com',
  path: 'private-entry',
  upstream: 'https://192.0.2.42:8787',
  serverName: 'cc-desk-tunnel.local',
  trustFile: '/etc/cc-desk-tunnel/upstream.pem',
};

test('proxy helper starts from the saved desktop connection, preserves port and IPv6, and does not copy credentials', () => {
  assert.equal(proxyUpstream('wss://192.0.2.42:8787/ws'), values.upstream);
  assert.equal(proxyUpstream('wss://[2001:db8::1]:9443/ws'), 'https://[2001:db8::1]:9443');
  assert.equal(proxyUpstream('wss://control.example.com/ws'), 'https://control.example.com');
  assert.equal(proxyUpstream('wss://user:secret@example.com/ws'), '');
  assert.equal(proxyUpstream('ws://127.0.0.1:18887/ws'), 'http://127.0.0.1:18887');
  assert.equal(proxyUpstream('http://[::1]:8787/entry/'), 'http://[::1]:8787');
  assert.equal(
    proxyUpstream('https://control.example.com:9443/entry/'),
    'https://control.example.com:9443',
  );
  assert.equal(proxyUpstream('http://user:secret@example.com'), '');
  assert.equal(proxyUpstream('file:///etc/config'), '');
  assert.equal(proxyUpstream('not a URL'), '');
});

test('proxy certificate name uses the default SAN only for default self-signed deployment', () => {
  const connection = 'wss://control.example.com:8787/ws';
  assert.equal(
    proxyCertificateName(connection, { mode: 'default', selfSigned: true }),
    'cc-desk-tunnel.local',
  );
  assert.equal(
    proxyCertificateName(connection, { mode: 'default', selfSigned: false }),
    'control.example.com',
  );
  assert.equal(
    proxyCertificateName(connection, {
      mode: 'custom',
      selfSigned: true,
      details: { domain: 'web.example.com' },
    }),
    'web.example.com',
  );
  assert.equal(
    proxyCertificateName('wss://192.0.2.42/ws', { mode: 'default', selfSigned: false }),
    '',
  );
  assert.equal(proxyCertificateName('wss://[2001:db8::1]/ws', null), '');
});

test('NGINX configuration verifies upstream trust and name, forwards WS, and preserves a custom entry prefix', () => {
  const config = proxyConfiguration('nginx', values);
  assert.match(config, /server_name web\.example\.com;/);
  assert.match(config, /proxy_pass https:\/\/192\.0\.2\.42:8787;/);
  assert.match(config, /proxy_ssl_verify on;/);
  assert.match(config, /proxy_ssl_server_name on;/);
  assert.match(config, /proxy_ssl_name cc-desk-tunnel\.local;/);
  assert.match(config, /proxy_ssl_trusted_certificate \/etc\/cc-desk-tunnel\/upstream.pem;/);
  assert.match(config, /proxy_set_header Host \$http_host;/);
  assert.match(config, /proxy_set_header X-Real-IP \$remote_addr;/);
  assert.match(config, /proxy_set_header Upgrade \$http_upgrade;/);
  assert.match(
    config,
    /location = \/private-entry \{ return 308 \/private-entry\/\$is_args\$args; \}/,
  );
  assert.match(config, /location \^~ \/private-entry\//);
  assert.match(config, /location = \/ws \{ proxy_pass https:\/\/192\.0\.2\.42:8787; \}/);
  assert.match(
    config,
    /location = \/client\/installer \{ proxy_pass https:\/\/192\.0\.2\.42:8787; \}/,
  );
  assert.match(config, /location \/ \{ return 404; \}/);
  assert.doesNotMatch(config, /proxy_ssl_verify off|proxy_pass [^;]+\/private-entry|rewrite /);
});

test('Caddy configuration verifies TLS and explicitly preserves the public Host and URI', () => {
  const config = proxyConfiguration('caddy', values);
  assert.match(config, /redir \/private-entry \/private-entry\/\?\{query\} 308/);
  assert.match(config, /@web path \/private-entry\/\* \/ws \/client\/installer\n/);
  assert.match(config, /reverse_proxy https:\/\/192\.0\.2\.42:8787/);
  assert.match(config, /header_up Host \{hostport\}/);
  assert.match(config, /header_up X-Real-IP \{remote_host\}/);
  assert.match(config, /tls_server_name cc-desk-tunnel\.local/);
  assert.match(config, /tls_trust_pool file \/etc\/cc-desk-tunnel\/upstream.pem/);
  assert.match(config, /respond 404/);
  assert.doesNotMatch(config, /insecure|handle_path|rewrite /);
});

test('HTTP upstreams omit certificate fields while keeping public HTTPS and root desktop endpoints', () => {
  for (const upstream of ['http://127.0.0.1:8787', 'http://[::1]:8787/', 'http://backend:8787']) {
    const http = { ...values, upstream, serverName: '', trustFile: '' };
    const nginx = proxyConfiguration('nginx', http);
    assert.match(nginx, /listen 443 ssl;/);
    assert.match(nginx, /ssl_certificate /);
    assert.match(nginx, /proxy_set_header Host \$http_host;/);
    assert.match(nginx, /proxy_set_header X-Forwarded-Proto \$scheme;/);
    assert.match(nginx, /location = \/ws \{ proxy_pass http:\/\//);
    assert.match(nginx, /location = \/client\/installer \{ proxy_pass http:\/\//);
    assert.match(nginx, /location \^~ \/private-entry\//);
    assert.match(nginx, /location \/ \{ return 404; \}/);
    assert.doesNotMatch(nginx, /proxy_ssl_/);
    const caddy = proxyConfiguration('caddy', http);
    assert.match(caddy, /^https:\/\/web\.example\.com \{/);
    assert.match(caddy, /reverse_proxy http:\/\//);
    assert.match(caddy, /header_up Host \{hostport\}/);
    assert.match(caddy, /@web path \/private-entry\/\* \/ws \/client\/installer\n/);
    assert.doesNotMatch(caddy, /tls_|transport http|insecure/);
  }
});

test('HTTP certificate inputs are not used, and returning to HTTPS requires valid trust settings', () => {
  for (const kind of ['nginx', 'caddy']) {
    const http = {
      ...values,
      upstream: 'http://127.0.0.1:8787',
      serverName: 'UNUSED; invalid',
      trustFile: 'UNUSED; invalid',
    };
    assert.doesNotMatch(proxyConfiguration(kind, http), /UNUSED/);
    assert.throws(() => proxyConfiguration(kind, { ...http, upstream: values.upstream }));
    assert.throws(() => proxyConfiguration(kind, { ...values, serverName: '' }));
    assert.throws(() => proxyConfiguration(kind, { ...values, trustFile: '' }));
    const root = proxyConfiguration(kind, { ...http, path: '' });
    assert.doesNotMatch(root, /\/private-entry|\/ws|\/client\/installer/);
    assert.match(root, kind === 'nginx' ? /location \/ \{/ : /@web path \/\*/);
  }
});

test('root entry and IPv6 upstream generate without an invented path or port', () => {
  const root = { ...values, path: '', upstream: 'https://[2001:db8::42]:9443/' };
  const nginx = proxyConfiguration('nginx', root);
  assert.match(nginx, /location \/ \{/);
  assert.doesNotMatch(nginx, /return 308|return 404/);
  assert.match(nginx, /proxy_pass https:\/\/\[2001:db8::42\]:9443;/);
  const caddy = proxyConfiguration('caddy', root);
  assert.match(caddy, /@web path \/\*/);
  assert.match(caddy, /reverse_proxy https:\/\/\[2001:db8::42\]:9443/);
});

test('invalid and injected fields cannot produce copyable configuration', () => {
  for (const [key, invalid] of Object.entries({
    publicOrigin: [
      '',
      'https://192.0.2.42',
      'web.example.com',
      'http://web.example.com',
      'https://web.example.com:65536',
      'https://web.example.com/path',
      'https://web.example.com?query=1',
      'https://web.example.com#hash',
      'https://user:secret@web.example.com',
      'https://example.com; listen 80;',
    ],
    path: ['ws', 'api', '../entry', 'entry; return 200;', 'entry\n}'],
    upstream: [
      'ftp://127.0.0.1:8787',
      'ws://127.0.0.1:8787',
      'http://user:password@example.com',
      'http://example.com/path',
      'http://example.com?token=secret',
      'http://example.com#fragment',
      'http://example.com\n',
      'http://example.com:65536',
      'http://example.com; proxy_pass https://other.example.com',
      'https://user:password@example.com',
      'https://example.com/path',
      'https://example.com?token=secret',
      'https://example.com\n',
      'https://example.com:65536',
      'https://example.com;',
    ],
    serverName: [
      '',
      '192.0.2.42',
      'https://example.com',
      'web.example.com; proxy_ssl_verify off;',
      'example.com\nfoo',
    ],
    trustFile: [
      'relative.pem',
      '/etc/trust file.pem',
      '/etc/trust.pem; proxy_ssl_verify off;',
      '/etc/${secret}.pem',
      '/etc/a\n.pem',
    ],
  })) {
    for (const value of invalid)
      for (const kind of ['nginx', 'caddy'])
        assert.throws(
          () => proxyConfiguration(kind, { ...values, [key]: value }),
          `${key}: ${JSON.stringify(value)}`,
        );
  }
});

test('public origin controls the proxy listener independently of the upstream port', () => {
  const custom = { ...values, publicOrigin: 'https://web.example.com:1443' };
  const nginx = proxyConfiguration('nginx', custom);
  assert.match(nginx, /listen 1443 ssl;/);
  assert.match(nginx, /server_name web\.example\.com;/);
  assert.match(nginx, /proxy_pass https:\/\/192\.0\.2\.42:8787;/);
  assert.match(proxyConfiguration('caddy', custom), /^https:\/\/web\.example\.com:1443 \{/);
  const standard = { ...custom, publicOrigin: 'https://WEB.EXAMPLE.COM:443/' };
  assert.match(proxyConfiguration('nginx', standard), /listen 443 ssl;/);
  assert.match(proxyConfiguration('caddy', standard), /^https:\/\/web\.example\.com \{/);
});
