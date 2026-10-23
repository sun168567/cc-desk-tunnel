import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import dns from 'node:dns';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createTlsServer, request as tlsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import { test, type TestContext } from 'node:test';
import { WebSocket } from 'ws';
import type { WebCommand } from '@cc-desk-tunnel/protocol';
import {
  PROTOCOL_VERSION,
  serverMessageSchema,
  type ServerMessage,
} from '@cc-desk-tunnel/protocol';
import { createProxyServer } from '../src/server.ts';
import { WebAccess, type WebContext } from '../src/web-access.ts';
import { browserCommands } from '../src/web-commands.ts';
import { ca, custom, defaultCertificate } from './fixtures/web-certificates.ts';

type Gateway = (req: IncomingMessage, res: ServerResponse, forward: () => void) => void;

function trustTestEntry(t: TestContext) {
  const certificates = getCACertificates();
  setDefaultCACertificates([...certificates, ca]);
  const lookup = dns.lookup;
  t.mock.method(dns, 'lookup', (host: string, options: any, callback: any) => {
    if (host !== 'web.example.test') return lookup(host, options, callback);
    queueMicrotask(() =>
      callback(null, options?.all ? [{ address: '127.0.0.1', family: 4 }] : '127.0.0.1', 4),
    );
  });
  t.after(() => setDefaultCACertificates(certificates));
  return () => setDefaultCACertificates(certificates);
}

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'cc-proxy-detect-'));
  const database = new DatabaseSync(':memory:');
  const untrustCertificate = trustTestEntry(t);
  const web = new WebAccess({
    database,
    directory,
    dataDir: directory,
    token: 'test-proxy-detection-' + randomUUID(),
    tls: defaultCertificate,
    host: '127.0.0.1',
  });
  const context = { desktop: true, address: '203.0.113.10', connectionId: randomUUID() };
  const backend = createServer((req, res) => {
    void web.handle(req, res).then((handled) => {
      if (!handled) res.writeHead(404).end();
    });
  });
  backend.listen(0, '127.0.0.1');
  await once(backend, 'listening');
  const address = backend.address();
  assert.ok(address && typeof address !== 'string');
  const received: IncomingMessage[] = [];
  let gatewayHandler: Gateway | undefined;
  let realIP: string | undefined = '198.51.100.27';
  let started: (() => void) | undefined;
  const gateway = createTlsServer(custom, (req, res) => {
    received.push(req);
    started?.();
    const forward = () => {
      const upstream = request(
        {
          hostname: '127.0.0.1',
          port: address.port,
          path: req.url,
          method: req.method,
          headers: { ...req.headers, ...(realIP === undefined ? {} : { 'x-real-ip': realIP }) },
        },
        (response) => {
          res.writeHead(response.statusCode!, response.headers);
          response.pipe(res);
        },
      );
      upstream.on('error', () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      req.pipe(upstream);
    };
    if (gatewayHandler) gatewayHandler(req, res, forward);
    else forward();
  });
  gateway.listen(0, '127.0.0.1');
  await once(gateway, 'listening');
  const gatewayAddress = gateway.address();
  assert.ok(gatewayAddress && typeof gatewayAddress !== 'string');
  const publicOrigin = `https://web.example.test:${gatewayAddress.port}`;
  const update = (values: object) =>
    web.execute(
      {
        type: 'web.settings.update',
        requestId: randomUUID(),
        values,
      } as WebCommand,
      context,
    );
  update({ enabled: true, publicOrigin, path: 'private' });
  t.after(async () => {
    web.close();
    gateway.closeAllConnections();
    backend.closeAllConnections();
    await Promise.all([
      new Promise<void>((resolve) => gateway.close(() => resolve())),
      new Promise<void>((resolve) => backend.close(() => resolve())),
    ]);
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const direct = (
    headers: Record<string, string> = {},
    path = '/private/api/proxy-detect',
    method = 'GET',
  ) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const outgoing = request(
        {
          hostname: '127.0.0.1',
          port: address.port,
          path,
          method,
          headers: { Host: new URL(publicOrigin).host, ...headers },
        },
        (response) => {
          let body = '';
          response.setEncoding('utf8');
          response.on('data', (chunk) => {
            body += chunk;
          });
          response.on('end', () => resolve({ status: response.statusCode!, body }));
        },
      );
      outgoing.on('error', reject);
      outgoing.end();
    });
  return {
    web,
    context,
    publicOrigin,
    received,
    update,
    direct,
    detect: (who: WebContext = context) =>
      web.detectProxy({ type: 'web.proxy.detect', requestId: randomUUID() }, who),
    nextRequest: () =>
      new Promise<void>((resolve) => {
        started = resolve;
      }),
    handle: (handler?: Gateway) => {
      gatewayHandler = handler;
    },
    realIP: (value?: string) => {
      realIP = value;
    },
    untrustCertificate,
  };
}

test('a TLS round trip returns the observed proxy socket, never the forwarded client, and changes no trust', async (t) => {
  const f = await fixture(t);
  const before = f.web.state();
  const reply = await f.detect();
  assert.equal(reply.type, 'web.proxy.detected');
  assert.equal(reply.address, '127.0.0.1');
  assert.equal(reply.publicOrigin, f.publicOrigin);
  assert.equal(reply.path, 'private');
  assert.equal(f.web.state().proxyEnabled, before.proxyEnabled);
  assert.deepEqual(f.web.state().trustedProxies, before.trustedProxies);
  assert.equal(f.received[0].headers.cookie, undefined);
  assert.equal(f.received[0].headers.authorization, undefined);
  assert.equal(f.received[0].headers['x-real-ip'], undefined);
  const challenge = String(f.received[0].headers['x-cc-proxy-probe']);
  assert.match(challenge, /^[a-f0-9]{64}$/);
  assert.deepEqual(
    await f.direct({ 'x-cc-proxy-probe': challenge, 'x-real-ip': '198.51.100.27' }),
    { status: 404, body: '' },
  );
  f.update({ proxyEnabled: true, trustedProxies: ['192.0.2.99'] });
  assert.equal((await f.detect()).address, '127.0.0.1');
  assert.equal(f.web.state().proxyEnabled, true);
  assert.deepEqual(f.web.state().trustedProxies, ['192.0.2.99']);
});

test('unauthenticated, browser and disabled probes never issue an outbound request', async (t) => {
  const f = await fixture(t);
  assert.equal(browserCommands.has('web.proxy.detect'), false);
  await assert.rejects(f.detect({ desktop: false, address: '203.0.113.10' }), /桌面客户端/);
  await assert.rejects(f.detect({ desktop: true, address: '203.0.113.10' }), /桌面客户端/);
  f.update({ enabled: false });
  await assert.rejects(f.detect(), /启用 Web/);
  f.update({ enabled: true, publicOrigin: '' });
  await assert.rejects(f.detect(), /Web 对外地址/);
  assert.equal(f.received.length, 0);
  assert.deepEqual(
    await f.direct({ 'x-real-ip': '203.0.113.20', 'x-cc-proxy-probe': 'a'.repeat(64) }),
    { status: 404, body: '' },
  );
});

test('invalid probe attempts do not consume a pending challenge; a valid observation is single-use', async (t) => {
  const f = await fixture(t);
  let release!: () => void;
  f.handle((_req, res) => {
    release = () => res.writeHead(204).end();
  });
  const arrived = f.nextRequest();
  const detecting = f.detect();
  await arrived;
  const headers = {
    'x-cc-proxy-probe': String(f.received[0].headers['x-cc-proxy-probe']),
    'x-real-ip': '198.51.100.27',
  };
  const rejected = [
    await f.direct({ ...headers, 'x-cc-proxy-probe': '0'.repeat(64) }),
    await f.direct({ ...headers, 'x-real-ip': '198.51.100.27, 192.0.2.4' }),
    await f.direct({ ...headers, 'x-real-ip': 'invalid' }),
    await f.direct({ 'x-cc-proxy-probe': headers['x-cc-proxy-probe'] }),
    await f.direct({ ...headers, Host: 'attacker.example.test' }),
    await f.direct(headers, '/wrong/api/proxy-detect'),
    await f.direct(headers, '/private/api/proxy-detect', 'POST'),
  ];
  for (const result of rejected) assert.deepEqual(result, { status: 404, body: '' });
  assert.deepEqual(await f.direct(headers), { status: 204, body: '' });
  assert.deepEqual(await f.direct(headers), { status: 404, body: '' });
  release();
  assert.equal((await detecting).address, '127.0.0.1');
});

test('a missing or invalid forwarded address and an unrelated 204 cannot identify a proxy', async (t) => {
  const f = await fixture(t);
  for (const address of [undefined, '', 'invalid', '198.51.100.27, 192.0.2.4']) {
    f.realIP(address);
    await assert.rejects(f.detect(), /未检测到有效反向代理/);
  }
  f.handle((_req, res) => res.writeHead(204).end());
  await assert.rejects(f.detect(), /未检测到有效反向代理/);
  assert.equal(f.web.state().proxyEnabled, false);
  assert.deepEqual(f.web.state().trustedProxies, []);
});

test('TLS certificate validation is mandatory and redirects are not followed', async (t) => {
  const f = await fixture(t);
  f.handle((_req, res) => res.writeHead(302, { Location: 'https://attacker.example.test/' }).end());
  await assert.rejects(f.detect(), /发生跳转/);
  assert.equal(f.received.length, 1);
  f.untrustCertificate();
  await assert.rejects(f.detect(), /证书验证失败/);
  assert.equal(f.received.length, 1);
});

test('only one detection runs; disconnect, settings change and shutdown cancel pending challenges', async (t) => {
  const f = await fixture(t);
  f.handle(() => undefined);
  for (const cancel of [
    () => f.web.disconnected(f.context.connectionId),
    () => f.update({ idleMinutes: 180 }),
    () => f.update({ enabled: false }),
    () => f.web.close(),
  ]) {
    f.update({ enabled: true });
    const arrived = f.nextRequest();
    const detecting = f.detect();
    const rejected = assert.rejects(detecting, /检测已取消/);
    await arrived;
    await assert.rejects(f.detect(), /正在检测反向代理/);
    f.web.disconnected(randomUUID());
    const headers = {
      'x-cc-proxy-probe': String(f.received.at(-1)!.headers['x-cc-proxy-probe']),
      'x-real-ip': '198.51.100.27',
    };
    cancel();
    await rejected;
    assert.deepEqual(await f.direct(headers), { status: 404, body: '' });
  }
  assert.equal(f.web.state().proxyEnabled, false);
  assert.deepEqual(f.web.state().trustedProxies, []);
});

test('the total probe deadline cancels a stalled public entry and permits a later retry', async (t) => {
  const f = await fixture(t);
  f.handle(() => undefined);
  const start = performance.now();
  await assert.rejects(f.detect(), /检测超时/);
  assert.ok(performance.now() - start >= 7900);
  assert.ok(performance.now() - start < 15_000);
  f.handle();
  assert.equal((await f.detect()).address, '127.0.0.1');
});

test('the desktop command reaches the authenticated server dispatcher; browsers and anonymous sockets are refused', async (t) => {
  trustTestEntry(t);
  const directory = mkdtempSync(join(tmpdir(), 'cc-proxy-detect-server-'));
  const token = 'test-proxy-dispatch-' + randomUUID();
  const server = createProxyServer({
    token,
    dataDir: directory,
    webDirectory: directory,
    tls: { cert: Buffer.from(defaultCertificate.cert), key: Buffer.from(defaultCertificate.key) },
  });
  const serviceURL = new URL(await server.listen(0));
  let probeCount = 0;
  const gateway = createTlsServer(custom, (req, res) => {
    if (req.url === '/api/proxy-detect') probeCount++;
    const upstream = tlsRequest(
      {
        hostname: '127.0.0.1',
        port: Number(serviceURL.port),
        path: req.url,
        method: req.method,
        ca: defaultCertificate.cert,
        servername: 'default.example.test',
        headers: { ...req.headers, 'x-real-ip': '198.51.100.27' },
      },
      (response) => {
        res.writeHead(response.statusCode!, response.headers);
        response.pipe(res);
      },
    );
    upstream.on('error', () => res.writeHead(502).end());
    req.pipe(upstream);
  });
  gateway.listen(0, '127.0.0.1');
  await once(gateway, 'listening');
  const gatewayAddress = gateway.address();
  assert.ok(gatewayAddress && typeof gatewayAddress !== 'string');
  const publicOrigin = `https://web.example.test:${gatewayAddress.port}`;
  const sockets: WebSocket[] = [];
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    gateway.closeAllConnections();
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
    await server.close();
    rmSync(directory, { recursive: true, force: true });
  });
  async function connect(cookie?: string) {
    const tlsOptions = { ca: defaultCertificate.cert, servername: 'default.example.test' };
    const socket = new WebSocket(
      `wss://127.0.0.1:${serviceURL.port}${cookie ? '/api/ws' : '/ws'}`,
      {
        ...tlsOptions,
        ...(cookie ? { origin: publicOrigin } : {}),
        headers: { Host: new URL(publicOrigin).host, ...(cookie ? { Cookie: cookie } : {}) },
      },
    );
    sockets.push(socket);
    const messages: ServerMessage[] = [];
    socket.on('message', (data) =>
      messages.push(serverMessageSchema.parse(JSON.parse(data.toString()))),
    );
    await once(socket, 'open');
    const wait = async (predicate: (message: ServerMessage) => boolean) => {
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const index = messages.findIndex(predicate);
        if (index >= 0) return messages.splice(index, 1)[0];
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error('Missing proxy detection server reply');
    };
    return {
      socket,
      wait,
      request: async (command: object) => {
        const requestId = randomUUID();
        socket.send(JSON.stringify({ ...command, requestId }));
        return wait((message) => 'requestId' in message && message.requestId === requestId);
      },
    };
  }
  const anonymous = await connect();
  anonymous.socket.send(JSON.stringify({ type: 'web.proxy.detect', requestId: randomUUID() }));
  const refused = await anonymous.wait((message) => message.type === 'connection.error');
  assert.equal(refused.type, 'connection.error');
  assert.equal(probeCount, 0);
  const desktop = await connect();
  desktop.socket.send(
    JSON.stringify({
      type: 'auth',
      token,
      deviceName: 'Proxy test',
      protocolVersion: PROTOCOL_VERSION,
    }),
  );
  await desktop.wait((message) => message.type === 'ready');
  const settings = await desktop.request({
    type: 'web.settings.update',
    values: { enabled: true, publicOrigin },
  });
  assert.equal(settings.type, 'web.settings.state');
  const detected = await desktop.request({ type: 'web.proxy.detect' });
  assert.equal(detected.type, 'web.proxy.detected');
  assert.equal(detected.address, '127.0.0.1');
  const completed = await desktop.wait(
    (message) => message.type === 'response' && message.requestId === detected.requestId,
  );
  assert.equal(completed.type, 'response');
  assert.equal(completed.ok, true);
  assert.equal(probeCount, 1);
  const cookie = await new Promise<string>((resolve, reject) => {
    const req = tlsRequest(
      `${publicOrigin}/api/login`,
      {
        method: 'POST',
        headers: { Origin: publicOrigin, 'Content-Type': 'application/json' },
      },
      (res) => {
        res.resume();
        assert.equal(res.statusCode, 200);
        resolve(res.headers['set-cookie']![0].split(';')[0]);
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify({ password: token }));
  });
  const browser = await connect(cookie);
  browser.socket.send(JSON.stringify({ type: 'web.auth', protocolVersion: PROTOCOL_VERSION }));
  await browser.wait((message) => message.type === 'ready');
  const denied = await browser.request({ type: 'web.proxy.detect' });
  assert.equal(denied.type, 'response');
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'web_forbidden');
  assert.equal(probeCount, 1);
});
