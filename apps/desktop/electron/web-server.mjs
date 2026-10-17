import { createReadStream } from 'node:fs';
import { lstat, realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { MAX_FRAME_BYTES } from '@cc-desk-tunnel/protocol';
import { createWebAuthStore } from './web-auth.cjs';

const BODY_LIMIT = 4096;
const RPC_BODY_LIMIT = 32 * 1024 * 1024;
const BUFFER_LIMIT = 8 * 1024 * 1024;
const RESPONSE_LIMIT = 16 * 1024 * 1024;
// A 64 MiB desktop snapshot is split into JSON chunks. Escaping that JSON again can double
// its wire size; reserve another MiB for chunk envelopes, and count the in-flight frame too.
const OUTBOUND_QUEUE_LIMIT = 2 * 64 * 1024 * 1024 + 1024 * 1024;
const OUTBOUND_SEND_TIMEOUT = 30_000;
const COOKIE = 'ccdt_web_session';
const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

function failure(status, message) {
  return Object.assign(new Error(message), { status });
}

function browserLabel(userAgent = '') {
  const browser = /Edg\//.test(userAgent)
    ? 'Edge'
    : /Firefox\/|FxiOS\//.test(userAgent)
      ? 'Firefox'
      : /Chrome\/|CriOS\//.test(userAgent)
        ? 'Chrome'
        : /Safari\//.test(userAgent)
          ? 'Safari'
          : '浏览器';
  const platform = /Android/.test(userAgent)
    ? 'Android'
    : /iPhone|iPad|iPod/.test(userAgent)
      ? 'iOS'
      : /Windows/.test(userAgent)
        ? 'Windows'
        : /Macintosh|Mac OS X/.test(userAgent)
          ? 'macOS'
          : /Linux/.test(userAgent)
            ? 'Linux'
            : '';
  return platform ? `${browser} · ${platform}` : browser;
}

async function body(request, maxBytes = BODY_LIMIT, reading) {
  if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json')
    throw failure(415, 'Expected application/json.');
  if (Number(request.headers['content-length'] ?? 0) > maxBytes)
    throw failure(413, 'Request body is too large.');
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of request) {
      if (size + chunk.length > maxBytes) throw failure(413, 'Request body is too large.');
      if (reading && reading.bytes + chunk.length > 2 * RPC_BODY_LIMIT)
        throw failure(429, 'Too many simultaneous uploads.');
      size += chunk.length;
      if (reading) reading.bytes += chunk.length;
      chunks.push(chunk);
    }
    try {
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
      return value;
    } catch {
      throw failure(400, 'Expected a JSON object.');
    }
  } finally {
    if (reading) reading.bytes -= size;
  }
}

// The desktop owns the proxy service connection. This server only exposes a bounded, authenticated
// control surface; invoke must implement an explicit method allowlist, never arbitrary IPC.
export async function startWebServer({
  host = '127.0.0.1',
  port = 0,
  distDirectory,
  token,
  authStore,
  cookieName = COOKIE,
  getInfo = async () => ({}),
  invoke = async () => {
    throw new Error('Unsupported remote operation.');
  },
  onConnection = () => {},
}) {
  const auth = authStore ?? createWebAuthStore({ token });
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid web port.');
  if (typeof cookieName !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(cookieName))
    throw new Error('Invalid session cookie name.');
  const root = await realpath(resolve(distDirectory));
  if (!(await stat(root)).isDirectory()) throw new Error('The web directory is not a directory.');
  const loopbackNames = new Set(['localhost', '127.0.0.1', '[::1]']);
  function localNames() {
    const names = new Set(loopbackNames);
    for (const interfaces of Object.values(networkInterfaces()))
      for (const entry of interfaces ?? [])
        if (entry.family === 'IPv4') names.add(entry.address);
        else if (!entry.address.includes('%')) names.add(`[${entry.address}]`);
    return names;
  }
  const names = localNames();
  if (!['0.0.0.0', '::'].includes(host) && !names.has(host) && !names.has(`[${host}]`))
    throw new Error('The web listener must bind a local interface address or localhost.');

  const sessions = new Map();
  const rates = new Map();
  const sockets = new Set();
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_FRAME_BYTES,
    perMessageDeflate: false,
  });
  let actualPort;
  let closing = false;
  let activeRpc = 0;
  const reading = { bytes: 0 };
  let closePromise;

  function originOf(request) {
    const authority = request.headers.host;
    if (!authority || /[\s/@\\]/.test(authority)) throw failure(403, 'Untrusted host.');
    let address;
    try {
      address = new URL(`http://${authority}`);
    } catch {
      throw failure(403, 'Untrusted host.');
    }
    if (address.host !== authority.toLowerCase()) throw failure(403, 'Untrusted host.');
    // A wildcard listener survives DHCP/VPN changes. Check the current local interfaces rather
    // than keeping addresses that disappeared or rejecting a newly joined interface until restart.
    if (
      Number(address.port || 80) !== actualPort ||
      (!loopbackNames.has(address.hostname) && !localNames().has(address.hostname))
    )
      throw failure(403, 'Untrusted host.');
    return address.origin;
  }
  function checkOrigin(request, required = false) {
    const expected = originOf(request);
    const supplied = request.headers.origin;
    if (
      (required && !supplied) ||
      (supplied && supplied !== expected) ||
      request.headers['sec-fetch-site'] === 'cross-site'
    )
      throw failure(403, 'Untrusted origin.');
    return expected;
  }
  function limit(request, area) {
    // Several browsers may share one source IP. Keep unauthenticated assets/login separate,
    // and never charge their traffic to an authenticated session.
    const key = `${area}:${request.socket.remoteAddress ?? 'unknown'}`;
    const now = Date.now();
    let record = rates.get(key);
    if (!record) {
      if (rates.size >= 1024) throw failure(429, 'Too many requests.');
      record = { until: now + 60_000, count: 0, loginUntil: 0, failures: 0 };
      rates.set(key, record);
    }
    if (record.until <= now) {
      record.until = now + 60_000;
      record.count = 0;
    }
    if (record.loginUntil <= now) {
      record.loginUntil = now + 300_000;
      record.failures = 0;
    }
    if (++record.count > 180 || (area === 'login' && record.failures >= 5))
      throw failure(429, 'Too many requests. Try again later.');
    return record;
  }
  function limitSession(session) {
    const now = Date.now();
    if (!session.rate || session.rate.until <= now)
      session.rate = { until: now + 60_000, count: 0 };
    if (++session.rate.count > 600)
      throw failure(429, 'Too many browser requests. Try again later.');
  }
  function disconnectSession(id) {
    const session = sessions.get(id);
    if (!session) return;
    sessions.delete(id);
    for (const socket of session.sockets) socket.terminate();
    session.sockets.clear();
  }
  function currentSession(request) {
    const cookies = (request.headers.cookie ?? '').split(';').map((part) => part.trim());
    const values = cookies.filter((part) => part.startsWith(`${cookieName}=`));
    const id = values.length === 1 ? values[0].slice(cookieName.length + 1) : '';
    const saved = auth.get(id);
    if (!saved) {
      disconnectSession(id);
      throw failure(401, 'Pair this browser with the desktop first.');
    }
    let session = sessions.get(id);
    if (!session) {
      session = { sockets: new Set(), active: 0 };
      sessions.set(id, session);
    }
    return { id, session };
  }
  function cookie(id, expiresAt = 0) {
    const remaining = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
    return `${cookieName}=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${remaining}; Expires=${new Date(expiresAt).toUTCString()}`;
  }
  function json(response, status, value) {
    if (response.destroyed || response.writableEnded) return;
    response.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    response.end(JSON.stringify(value));
  }
  async function serveFile(request, response) {
    let pathname;
    try {
      pathname = decodeURIComponent(request.url.split('?')[0]);
    } catch {
      throw failure(400, 'Invalid path.');
    }
    if (
      !pathname.startsWith('/') ||
      /[\\\0]/.test(pathname) ||
      pathname.split('/').some((part) => part.startsWith('.'))
    )
      throw failure(404, 'Not found.');
    const parts = (pathname === '/' ? '/index.html' : pathname).slice(1).split('/');
    if (parts.some((part) => !part || part.includes(':'))) throw failure(404, 'Not found.');
    const type = mimeTypes[extname(parts.at(-1)).toLowerCase()];
    if (!type) throw failure(404, 'Not found.');
    let file = root;
    for (const part of parts) {
      file = join(file, part);
      if ((await lstat(file)).isSymbolicLink()) throw failure(404, 'Not found.');
    }
    const canonical = await realpath(file);
    const child = relative(root, canonical);
    if (isAbsolute(child) || child === '..' || child.startsWith(`..${sep}`))
      throw failure(404, 'Not found.');
    const info = await stat(canonical);
    if (!info.isFile()) throw failure(404, 'Not found.');
    response.writeHead(200, {
      'Content-Type': type,
      'Content-Length': info.size,
      'Cache-Control': 'no-cache',
    });
    if (request.method === 'HEAD') {
      response.end();
      return;
    }
    const stream = createReadStream(canonical);
    stream.on('error', () => response.destroy());
    response.on('close', () => stream.destroy());
    stream.pipe(response);
  }
  async function handle(request, response) {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
    try {
      if (closing) throw failure(503, 'Web control is stopping.');
      checkOrigin(request, request.method !== 'GET' && request.method !== 'HEAD');
      const path = request.url.split('?')[0];
      if (path === '/api/login' && request.method === 'POST') {
        const rate = limit(request, 'login');
        const input = await body(request);
        if (!auth.accepts(input.token)) {
          rate.failures++;
          throw failure(401, 'Incorrect pairing token.');
        }
        if (closing) throw failure(503, 'Web control is stopping.');
        let previous;
        try {
          previous = currentSession(request).id;
        } catch {}
        const { id, expiresAt } = auth.issue(previous, browserLabel(request.headers['user-agent']));
        rate.failures = 0;
        response.setHeader('Set-Cookie', cookie(id, expiresAt));
        json(response, 200, { ok: true });
      } else if (path.startsWith('/api/')) {
        const { id, session } = currentSession(request);
        limitSession(session);
        if (path === '/api/logout' && request.method === 'POST') {
          await body(request);
          auth.revoke(id);
          response.setHeader('Set-Cookie', cookie(''));
          json(response, 200, { ok: true });
        } else if (path === '/api/info' && request.method === 'GET') {
          const info = await getInfo();
          if (!auth.get(id)) throw failure(401, 'Browser session ended.');
          json(response, 200, info);
        } else if (path === '/api/rpc' && request.method === 'POST') {
          if (session.active >= 4 || activeRpc >= 4)
            throw failure(429, 'Too many pending commands.');
          session.active++;
          activeRpc++;
          try {
            const input = await body(request, RPC_BODY_LIMIT, reading);
            if (
              typeof input.method !== 'string' ||
              !/^[a-zA-Z][a-zA-Z0-9._:-]{0,79}$/.test(input.method) ||
              !Array.isArray(input.args) ||
              input.args.length > 16
            )
              throw failure(400, 'Invalid remote command.');
            if (closing || !auth.get(id)) throw failure(401, 'Browser session ended.');
            const result = await invoke(input.method, input.args);
            if (!auth.get(id)) throw failure(401, 'Browser session ended.');
            json(response, 200, { result });
          } finally {
            session.active--;
            activeRpc--;
          }
        } else throw failure(404, 'Not found.');
      } else if (request.method === 'GET' || request.method === 'HEAD') {
        let authenticated = false;
        try {
          currentSession(request);
          authenticated = true;
        } catch {}
        if (!authenticated) limit(request, 'static');
        await serveFile(request, response);
      } else throw failure(405, 'Method not allowed.');
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      const missingFile = ['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code);
      const status =
        Number.isInteger(error.status) && error.status >= 400 && error.status <= 599
          ? error.status
          : missingFile
            ? 404
            : 500;
      if (status === 429) response.setHeader('Retry-After', '60');
      json(response, status, {
        error: missingFile
          ? 'Not found.'
          : status === 500
            ? 'Remote operation failed.'
            : error.message,
      });
      if (status === 413) request.resume();
    }
  }
  const server = createServer(
    { requestTimeout: 60_000, headersTimeout: 10_000 },
    (request, response) => {
      void handle(request, response);
    },
  );
  server.maxConnections = 128;
  server.setTimeout(30_000, (socket) => socket.destroy());
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('upgrade', (request, socket, head) => {
    try {
      if (closing || request.url !== '/api/control') throw failure(404, 'Not found.');
      checkOrigin(request, true);
      const { id, session } = currentSession(request);
      limitSession(session);
      if (session.sockets.size >= 4 || wss.clients.size >= 32)
        throw failure(429, 'Too many connections.');
      wss.handleUpgrade(request, socket, head, (ws) => {
        session.sockets.add(ws);
        let alive = true;
        let frameStart = Date.now();
        let frames = 0;
        let frameBytes = 0;
        ws.on('pong', () => {
          alive = true;
        });
        ws.on('error', () => {});
        const emit = ws.emit.bind(ws);
        ws.emit = (event, ...args) => {
          if (event !== 'message') return emit(event, ...args);
          const [data] = args;
          if (Date.now() - frameStart >= 1000) {
            frameStart = Date.now();
            frames = 0;
            frameBytes = 0;
          }
          frameBytes += data.byteLength;
          // Terminal flow-control acknowledgements alone can legitimately arrive 50/s.
          if (
            closing ||
            ws.readyState !== WebSocket.OPEN ||
            ++frames > 1000 ||
            frameBytes > BUFFER_LIMIT ||
            !auth.get(id)
          ) {
            ws.terminate();
            return false;
          }
          return emit(event, ...args);
        };
        const send = ws.send.bind(ws);
        const outgoing = [];
        let outgoingHead = 0;
        let outgoingBytes = 0;
        let sending = false;
        let sendTimer;
        let sendClosed = false;
        function clearOutgoing() {
          sendClosed = true;
          clearTimeout(sendTimer);
          outgoing.length = 0;
          outgoingHead = 0;
          outgoingBytes = 0;
        }
        function stopSending() {
          clearOutgoing();
          ws.terminate();
        }
        function drainOutgoing() {
          if (sending || sendClosed || outgoingHead === outgoing.length) return;
          if (closing || ws.readyState !== WebSocket.OPEN || !auth.get(id)) {
            stopSending();
            return;
          }
          const entry = outgoing[outgoingHead];
          sending = true;
          sendTimer = setTimeout(stopSending, OUTBOUND_SEND_TIMEOUT);
          sendTimer.unref();
          try {
            send(entry.data, ...entry.args, (error) => {
              if (sendClosed) return;
              clearTimeout(sendTimer);
              outgoingBytes -= entry.bytes;
              outgoing[outgoingHead++] = undefined;
              // Release sent entries without shifting the remaining queue for every chunk.
              if (outgoingHead === outgoing.length) {
                outgoing.length = 0;
                outgoingHead = 0;
              } else if (outgoingHead >= 1024 && outgoingHead * 2 >= outgoing.length) {
                outgoing.splice(0, outgoingHead);
                outgoingHead = 0;
              }
              sending = false;
              try {
                entry.callback?.(error);
              } finally {
                if (error) stopSending();
                else queueMicrotask(drainOutgoing);
              }
            });
          } catch {
            stopSending();
          }
        }
        ws.send = (data, ...args) => {
          const bytes = typeof data === 'string' ? Buffer.byteLength(data) : (data.byteLength ?? 0);
          if (
            sendClosed ||
            ws.readyState !== WebSocket.OPEN ||
            closing ||
            !auth.get(id) ||
            bytes > RESPONSE_LIMIT ||
            outgoingBytes + bytes > OUTBOUND_QUEUE_LIMIT
          ) {
            stopSending();
            return;
          }
          const callback = typeof args.at(-1) === 'function' ? args.pop() : undefined;
          outgoing.push({ data, args, callback, bytes });
          outgoingBytes += bytes;
          drainOutgoing();
        };
        ws.on('close', clearOutgoing);
        ws.on('error', clearOutgoing);
        const heartbeat = setInterval(() => {
          if (!alive || !auth.get(id)) {
            ws.terminate();
            return;
          }
          alive = false;
          ws.ping();
        }, 30_000);
        heartbeat.unref();
        ws.on('close', () => {
          clearInterval(heartbeat);
          session.sockets.delete(ws);
        });
        try {
          Promise.resolve(onConnection(ws)).catch(() => ws.close(1011, 'Control unavailable'));
        } catch {
          ws.close(1011, 'Control unavailable');
        }
      });
    } catch (error) {
      const status = error.status ?? 500;
      socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  actualPort = server.address().port;
  const unsubscribe = auth.subscribe(() => {
    for (const id of sessions.keys()) if (!auth.get(id)) disconnectSession(id);
  });
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const id of sessions.keys()) if (!auth.get(id)) disconnectSession(id);
    for (const [address, rate] of rates)
      if (rate.until <= now && rate.loginUntil <= now) rates.delete(address);
  }, 60_000);
  sweep.unref();
  const displayHost = ['0.0.0.0', '::'].includes(host)
    ? '127.0.0.1'
    : host.includes(':')
      ? `[${host}]`
      : host;
  return {
    url: `http://${displayHost}:${actualPort}`,
    port: actualPort,
    close() {
      if (closePromise) return closePromise;
      closing = true;
      clearInterval(sweep);
      unsubscribe();
      for (const id of sessions.keys()) disconnectSession(id);
      rates.clear();
      closePromise = new Promise((resolve) => {
        server.close(() => wss.close(() => resolve()));
        for (const socket of sockets) socket.destroy();
      });
      return closePromise;
    },
  };
}
