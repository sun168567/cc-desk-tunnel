import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import {
  passkeyAuthenticationResponseSchema,
  passkeyCancellationSchema,
  passkeyEmptyRequestSchema,
  passkeyRegistrationRequestSchema,
  passkeyRegistrationResponseSchema,
  webCommandSchema,
  webLoginSchema,
  webStoredSettingsSchema,
} from '@cc-desk-tunnel/protocol';
import type {
  ServerMessage,
  WebCommand,
  WebCredentialProof,
  WebLoginState,
  WebProof,
  WebSession,
  WebSettingsState,
} from '@cc-desk-tunnel/protocol';
import { DomainError } from './errors.ts';
import { Passkeys } from './passkeys.ts';
import type { PasskeyEntry } from './passkeys.ts';
import { Throttle } from './throttle.ts';
import { WebCertificates } from './web-certificate.ts';
import { totpSecret, totpStep } from './web-totp.ts';

const DAY = 86_400_000;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const defaults = {
  enabled: false,
  domain: '',
  path: '',
  idleMinutes: 120,
  proxyEnabled: false,
  trustedProxies: [] as string[],
};
type Settings = typeof defaults;
type StoredSession = {
  id: string;
  secret_hash: string;
  token_hash: string;
  name: string;
  created: number;
  active: number;
  expires: number;
  passkey_id: string | null;
};
type StoredSettings = {
  settings: string;
  device_id: string;
  totp_secret: string | null;
  totp_last: number;
  pending_secret: string | null;
  pending_expires: number | null;
};
export type WebReply = Extract<
  ServerMessage,
  { type: 'web.settings.state' | 'web.totp.setup' | 'web.certificate.state' }
>;
export type WebAccessOptions = {
  database: DatabaseSync;
  token: string;
  // The shared frontend build, and the data directory that keeps an imported certificate.
  directory: string;
  dataDir: string;
  tls?: { cert: string | Buffer; key: string | Buffer };
  reverseProxy?: boolean;
  host?: string;
  now?: () => number;
};
// Who sends a command: an authenticated desktop, or the browser login `sessionId`.
export type WebContext = { desktop: boolean; address: string; sessionId?: string; origin?: string };
const ip = (address: string) =>
  address.startsWith('::ffff:') && isIP(address.slice(7)) === 4
    ? address.slice(7)
    : isIP(address) === 6
      ? new URL(`http://[${address}]`).hostname.slice(1, -1)
      : address;
const loopback = (address: string) => address === '::1' || /^127(?:\.\d{1,3}){3}$/.test(address);
const fail = (code: string, message: string): never => {
  throw new DomainError(code, message);
};
const statuses: Record<string, number> = {
  web_unauthorized: 401,
  web_rate_limited: 429,
  passkey_busy: 429,
};
const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

export function webStaticPath(root: string, target: string) {
  const inside = relative(root, target);
  return !isAbsolute(inside) && inside !== '..' && !inside.startsWith(`..${sep}`);
}

export class WebAccess {
  private options: WebAccessOptions;
  private settings: Settings;
  private tokenHash: string;
  private now: () => number;
  private sockets = new Map<string, Set<WebSocket>>();
  private timer?: NodeJS.Timeout;
  private closed = false;
  private index?: Buffer;
  // The last address that sent X-Real-IP without being trusted to.
  private forwardedBy?: string;
  readonly serverDeviceId: string;
  // Browser sign-ins are counted apart from desktops: mistakes typed in a browser never lock out a desktop
  // that shares its address.
  readonly throttle = new Throttle();
  readonly certificates: WebCertificates;
  readonly passkeys: Passkeys;

  constructor(options: WebAccessOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.tokenHash = hash(options.token);
    options.database.exec(`
      CREATE TABLE IF NOT EXISTS web_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1), settings TEXT NOT NULL, device_id TEXT NOT NULL,
        totp_secret TEXT, totp_last INTEGER NOT NULL DEFAULT -1, pending_secret TEXT, pending_expires INTEGER
      );
      CREATE TABLE IF NOT EXISTS web_sessions (
        id TEXT PRIMARY KEY, secret_hash TEXT UNIQUE NOT NULL, token_hash TEXT NOT NULL,
        name TEXT NOT NULL, created INTEGER NOT NULL, active INTEGER NOT NULL, expires INTEGER NOT NULL
      );
    `);
    options.database
      .prepare('INSERT OR IGNORE INTO web_settings (id, settings, device_id) VALUES (1, ?, ?)')
      .run(JSON.stringify(defaults), randomUUID());
    const row = this.record();
    this.settings = webStoredSettingsSchema.parse(JSON.parse(row.settings));
    this.serverDeviceId = z.uuid().parse(row.device_id);
    this.certificates = new WebCertificates({
      dataDir: options.dataDir,
      domain: this.settings.domain,
      tls: options.tls,
      reverseProxy: options.reverseProxy,
    });
    options.database.prepare('DELETE FROM web_sessions WHERE token_hash != ?').run(this.tokenHash);
    // Upgrade the session table published before Passkey support; existing credential logins stay valid.
    const columns = options.database.prepare('PRAGMA table_info(web_sessions)').all();
    if (!columns.some((column) => column.name === 'passkey_id'))
      options.database.exec('ALTER TABLE web_sessions ADD COLUMN passkey_id TEXT');
    this.passkeys = new Passkeys(options.database, this.tokenHash, this.serverDeviceId, this.now);
    this.sweep();
  }

  private get https() {
    return !!this.options.tls || !!this.options.reverseProxy;
  }
  private record() {
    return this.options.database
      .prepare('SELECT * FROM web_settings WHERE id = 1')
      .get() as StoredSettings;
  }
  get enabled() {
    return !this.closed && this.settings.enabled;
  }
  private get prefix() {
    return this.settings.path ? `/${this.settings.path}` : '';
  }
  private get cookieName() {
    return `cc_web_${this.serverDeviceId.replaceAll('-', '')}_${hash(this.prefix).slice(0, 16)}`;
  }
  private publicSession(row: StoredSession): WebSession {
    return {
      id: row.id,
      name: row.name,
      createdAt: new Date(row.created).toISOString(),
      lastActiveAt: new Date(row.active).toISOString(),
      expiresAt: new Date(row.expires).toISOString(),
    };
  }
  private getSession(id: string) {
    return this.options.database.prepare('SELECT * FROM web_sessions WHERE id = ?').get(id) as
      StoredSession | undefined;
  }
  private valid(row: StoredSession) {
    const now = this.now();
    return (
      row.token_hash === this.tokenHash &&
      row.expires > now &&
      row.active + this.settings.idleMinutes * 60_000 > now
    );
  }
  private disconnect(id: string) {
    for (const socket of this.sockets.get(id) ?? []) socket.close(4001, 'Browser session ended');
    this.sockets.delete(id);
  }
  private revoke(id: string) {
    this.passkeys.revokeSession(id);
    this.options.database.prepare('DELETE FROM web_sessions WHERE id = ?').run(id);
    this.disconnect(id);
  }
  private sweep() {
    const rows = this.options.database
      .prepare('SELECT * FROM web_sessions')
      .all() as StoredSession[];
    for (const row of rows) if (!this.valid(row)) this.revoke(row.id);
  }
  // Wakes when the first connected login runs out, so an idle browser is closed without sending anything.
  private schedule() {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.enabled || !this.sockets.size) return;
    let next = Infinity;
    for (const id of this.sockets.keys()) {
      const row = this.getSession(id);
      if (row) next = Math.min(next, row.expires, row.active + this.settings.idleMinutes * 60_000);
    }
    if (!Number.isFinite(next)) return;
    this.timer = setTimeout(
      () => {
        this.sweep();
        this.schedule();
      },
      Math.max(1, Math.min(next - this.now(), 2_147_483_647)),
    );
    this.timer.unref();
  }
  active(id: string) {
    if (!this.enabled) return false;
    const row = this.getSession(id);
    if (row && this.valid(row)) return true;
    if (row) this.revoke(id);
    return false;
  }
  // The user did something in the browser: the idle time starts over.
  touch(id: string) {
    if (!this.active(id)) return false;
    this.options.database
      .prepare('UPDATE web_sessions SET active = ? WHERE id = ?')
      .run(this.now(), id);
    this.schedule();
    return true;
  }
  attach(id: string, socket: WebSocket) {
    if (!this.active(id)) return false;
    const own = this.sockets.get(id) ?? new Set<WebSocket>();
    const total = [...this.sockets.values()].reduce((sum, value) => sum + value.size, 0);
    if (own.size >= 8 || total >= 128) return false;
    own.add(socket);
    this.sockets.set(id, own);
    socket.once('close', () => {
      own.delete(socket);
      if (!own.size && this.sockets.get(id) === own) this.sockets.delete(id);
      this.schedule();
    });
    this.schedule();
    return true;
  }

  // Whether the request came through the deployment's proxy or one the user named.
  proxied(request: IncomingMessage) {
    const remote = ip(request.socket.remoteAddress ?? '');
    return (
      !!this.options.reverseProxy ||
      (this.settings.proxyEnabled && this.settings.trustedProxies.includes(remote))
    );
  }
  // Only a proxy the user named may tell the client's address.
  address(request: IncomingMessage) {
    const remote = ip(request.socket.remoteAddress ?? '');
    const forwarded = request.headers['x-real-ip'];
    return this.proxied(request) && typeof forwarded === 'string' && isIP(forwarded)
      ? ip(forwarded)
      : remote;
  }
  // The origin a page of this entry has, or undefined for a host it does not serve. Plain HTTP is only for
  // a service on loopback reached on loopback.
  private requestOrigin(request: IncomingMessage) {
    const host = request.headers.host;
    if (!host || /[\s,/@\\?#]/.test(host)) return undefined;
    const protocol = this.https ? 'https:' : 'http:';
    try {
      const url = new URL(`${protocol}//${host}`);
      if (this.settings.domain && url.hostname !== this.settings.domain) return undefined;
      if (
        protocol === 'http:' &&
        (!loopback(ip(request.socket.remoteAddress ?? '')) ||
          !loopback(this.options.host ?? '127.0.0.1') ||
          !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
      )
        return undefined;
      return url.origin;
    } catch {
      return undefined;
    }
  }
  // Same-origin requests only. A plain navigation or same-origin fetch may omit Origin where it is optional.
  private trusted(request: IncomingMessage, required = true) {
    const origin = this.requestOrigin(request);
    const site = request.headers['sec-fetch-site'];
    return (
      !!origin &&
      (request.headers.origin === origin ||
        (!required &&
          !request.headers.origin &&
          (!site || ['same-origin', 'none'].includes(String(site)))))
    );
  }
  private route(request: IncomingMessage) {
    const pathname = (request.url ?? '').split('?')[0];
    if (!pathname.startsWith(`${this.prefix}/`)) return undefined;
    return pathname.slice(this.prefix.length);
  }
  matchesUpgrade(request: IncomingMessage) {
    return this.enabled && this.route(request) === '/api/ws' && !!this.requestOrigin(request);
  }
  authenticate(request: IncomingMessage) {
    if (!this.enabled || !this.trusted(request)) return undefined;
    const row = this.cookieSession(request);
    return row ? this.publicSession(row) : undefined;
  }
  private cookieSession(request: IncomingMessage) {
    const values = (request.headers.cookie ?? '')
      .split(';')
      .map((value) => value.trim())
      .filter((value) => value.startsWith(`${this.cookieName}=`));
    if (values.length !== 1) return undefined;
    const secret = values[0].slice(this.cookieName.length + 1);
    if (!/^[a-f0-9]{64}$/.test(secret)) return undefined;
    const row = this.options.database
      .prepare('SELECT * FROM web_sessions WHERE secret_hash = ?')
      .get(hash(secret)) as StoredSession | undefined;
    if (!row || !this.active(row.id)) return undefined;
    return row;
  }
  private cookie(secret: string, expiry: number) {
    const age = Math.max(0, Math.floor((expiry - this.now()) / 1000));
    return `${this.cookieName}=${secret}; Path=${this.prefix}/; HttpOnly; SameSite=Strict; Max-Age=${age}${this.https ? '; Secure' : ''}`;
  }
  private url(origin?: string) {
    if (!origin) return undefined;
    try {
      const url = new URL(origin);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
        return undefined;
      if (this.settings.domain) url.hostname = this.settings.domain;
      url.pathname = `${this.prefix}/`;
      url.search = '';
      url.hash = '';
      return url.toString();
    } catch {
      return undefined;
    }
  }
  // Whether the certificate a browser at this origin gets is self-signed. Behind a proxy it gets the proxy's.
  selfSigned(origin?: string, proxied = false) {
    return (
      !proxied &&
      this.certificates.selfSigned(origin ? new URL(origin).hostname : this.settings.domain)
    );
  }
  state(origin?: string): WebSettingsState {
    this.sweep();
    return {
      ...this.settings,
      totpEnabled: !!this.record().totp_secret,
      passkeys: this.passkeys.list(this.settings.domain),
      passkeyAvailable: !this.passkeyReason(),
      ...(this.passkeyReason() ? { passkeyReason: this.passkeyReason() } : {}),
      sessions: (
        this.options.database
          .prepare('SELECT * FROM web_sessions ORDER BY created DESC')
          .all() as StoredSession[]
      ).map((row) => this.publicSession(row)),
      url: this.url(origin),
      selfSigned: this.selfSigned(this.url(origin)),
      ...(this.forwardedBy ? { forwardedBy: this.forwardedBy } : {}),
    };
  }
  private loginState(request: IncomingMessage, row?: StoredSession): WebLoginState {
    const origin = this.requestOrigin(request);
    return {
      authenticated: !!row,
      passkeyAvailable:
        !this.passkeyReason() &&
        this.passkeys.list(this.settings.domain).some((key) => key.available),
      ...(row ? { session: this.publicSession(row) } : {}),
      totpEnabled: !!this.record().totp_secret,
      selfSigned: this.selfSigned(origin, this.proxied(request)),
      url: this.url(origin),
    };
  }
  // The service token, and the authenticator code once two-step verification is on.
  private proof(proof: WebCredentialProof | undefined, address: string) {
    if (this.throttle.blocked(address, this.now()))
      fail('web_rate_limited', '尝试过于频繁，请稍后重试。');
    const row = this.record();
    const passwordOK =
      proof &&
      timingSafeEqual(Buffer.from(hash(proof.password), 'hex'), Buffer.from(this.tokenHash, 'hex'));
    const step = row.totp_secret
      ? totpStep(row.totp_secret, proof?.code ?? '', this.now(), row.totp_last)
      : undefined;
    if (!passwordOK || (row.totp_secret && step === undefined)) {
      this.throttle.fail(address, this.now());
      fail('web_unauthorized', '密码或动态码不正确，或动态码已被使用。');
    }
    if (step !== undefined)
      this.options.database.prepare('UPDATE web_settings SET totp_last = ? WHERE id = 1').run(step);
    this.throttle.succeed(address);
  }
  // A browser proves itself again for a security setting; an authenticated desktop already holds the token.
  private reauthenticate(proof: WebProof | undefined, context: WebContext) {
    if (context.desktop) return;
    if (proof && 'passkey' in proof) {
      const sessionId = context.sessionId ?? fail('web_unauthorized', '登录已失效，请重新登录。');
      if (!this.active(sessionId)) fail('web_unauthorized', '登录已失效，请重新登录。');
      this.passkeys.consumeProof(proof.passkey, sessionId);
    } else this.proof(proof, context.address);
  }

  private passkeyReason() {
    if (!this.enabled) return '请先启用 Web 访问。';
    if (!this.https || !this.settings.domain) return '请先设置 HTTPS 访问域名。';
    return undefined;
  }
  private passkeyEntry(request: IncomingMessage): PasskeyEntry {
    const reason = this.passkeyReason();
    if (reason) fail('passkey_unavailable', reason);
    const origin = this.requestOrigin(request) ?? fail('web_unauthorized', '访问地址已变化。');
    return { rpId: this.settings.domain, origin };
  }
  private passkeySession(request: IncomingMessage) {
    return this.cookieSession(request) ?? fail('web_unauthorized', '请先登录 Web 工作台。');
  }
  private sessionExpiry(session: StoredSession) {
    return Math.min(session.expires, session.active + this.settings.idleMinutes * 60_000);
  }

  execute(input: WebCommand, context: WebContext): WebReply {
    const command = webCommandSchema.parse(input);
    const { requestId } = command;
    if (!context.desktop && (!context.sessionId || !this.active(context.sessionId)))
      fail('web_unauthorized', '登录已失效，请重新登录。');
    switch (command.type) {
      case 'web.passkeys.rename':
        this.reauthenticate(command.proof, context);
        this.passkeys.rename(command.passkeyId, command.name);
        break;
      case 'web.passkeys.remove':
        this.reauthenticate(command.proof, context);
        this.passkeys.remove(command.passkeyId);
        for (const row of this.options.database
          .prepare('SELECT id FROM web_sessions WHERE passkey_id = ?')
          .all(command.passkeyId) as { id: string }[])
          this.revoke(row.id);
        break;
      case 'web.settings.get':
        break;
      case 'web.settings.update':
        this.update(command.values, command.proof, context);
        break;
      case 'web.sessions.revoke':
        // Signing this browser out needs no proof; ending another one does.
        if (command.sessionId !== context.sessionId) this.reauthenticate(command.proof, context);
        this.revoke(command.sessionId);
        break;
      case 'web.totp.setup':
        return { type: 'web.totp.setup', requestId, ...this.setupTotp(command.proof, context) };
      case 'web.totp.enable':
        this.enableTotp(command.code, context);
        break;
      case 'web.totp.disable':
        this.reauthenticate(command.proof, context);
        this.options.database
          .prepare(
            'UPDATE web_settings SET totp_secret = NULL, totp_last = -1, pending_secret = NULL, pending_expires = NULL WHERE id = 1',
          )
          .run();
        this.clearSessions(context.sessionId);
        break;
      case 'web.certificate.get':
      case 'web.certificate.set':
      case 'web.certificate.reset':
        if (!context.desktop) fail('web_desktop_only', '请在桌面客户端管理证书。');
        if (command.type === 'web.certificate.set')
          this.certificates.set({
            domain: this.settings.domain,
            cert: command.cert,
            key: command.key,
          });
        if (command.type === 'web.certificate.reset') this.certificates.reset();
        if (command.type !== 'web.certificate.get') this.passkeys.clearPending();
        return { type: 'web.certificate.state', requestId, ...this.certificates.state() };
    }
    return { type: 'web.settings.state', requestId, values: this.state(context.origin) };
  }
  private update(values: Partial<Settings>, proof: WebProof | undefined, context: WebContext) {
    if (!context.desktop && Object.keys(values).some((key) => key !== 'path'))
      fail('web_desktop_only', '此设置需要在桌面客户端修改。');
    this.reauthenticate(proof, context);
    const next = { ...this.settings, ...values };
    this.certificates.validateDomain(next.domain);
    const proxies = next.trustedProxies.map(ip);
    if (proxies.some((value) => !isIP(value)) || (next.proxyEnabled && !proxies.length))
      fail('web_invalid_settings', '请填写可信反向代理的 IP 地址。');
    if (next.enabled && !this.https && !loopback(this.options.host ?? '127.0.0.1'))
      fail('web_https_required', '公网 Web 访问需要 HTTPS。');
    if (next.domain && !this.https) fail('web_https_required', '域名访问需要 HTTPS。');
    next.trustedProxies = [...new Set(proxies)];
    const moved = next.domain !== this.settings.domain || next.path !== this.settings.path;
    this.options.database
      .prepare('UPDATE web_settings SET settings = ? WHERE id = 1')
      .run(JSON.stringify(next));
    this.settings = next;
    this.passkeys.clearPending();
    // Logins belong to an address; a browser that moved it is told after its answer is on the way.
    if (moved) this.options.database.prepare('DELETE FROM web_sessions').run();
    if (moved || !next.enabled) {
      const ids = [...this.sockets.keys()];
      setImmediate(() => {
        for (const id of ids) this.disconnect(id);
        this.schedule();
      });
    }
    this.sweep();
    this.schedule();
  }
  // A new secret is kept for ten minutes, waiting for one correct code to turn it on.
  private setupTotp(proof: WebProof | undefined, context: WebContext) {
    this.reauthenticate(proof, context);
    if (this.record().totp_secret) fail('web_totp_enabled', '请先关闭现有二次验证。');
    const secret = totpSecret();
    const expires = this.now() + 600_000;
    this.options.database
      .prepare('UPDATE web_settings SET pending_secret = ?, pending_expires = ? WHERE id = 1')
      .run(secret, expires);
    const label = encodeURIComponent(this.settings.domain || 'Web');
    return {
      secret,
      uri: `otpauth://totp/CC%20Desk%20Tunnel:${label}?secret=${secret}&issuer=CC%20Desk%20Tunnel&algorithm=SHA1&digits=6&period=30`,
      expiresAt: new Date(expires).toISOString(),
    };
  }
  // Only who passed setup has seen the pending secret, so its code alone confirms it.
  private enableTotp(code: string, context: WebContext) {
    if (this.throttle.blocked(context.address, this.now()))
      fail('web_rate_limited', '尝试过于频繁，请稍后重试。');
    const row = this.record();
    const step =
      row.pending_secret && row.pending_expires! > this.now()
        ? totpStep(row.pending_secret, code, this.now(), -1)
        : undefined;
    if (step === undefined) {
      this.throttle.fail(context.address, this.now());
      fail('web_totp_invalid', '动态码不正确或设置已过期，请重新设置。');
    }
    this.options.database
      .prepare(
        'UPDATE web_settings SET totp_secret = pending_secret, totp_last = ?, pending_secret = NULL, pending_expires = NULL WHERE id = 1',
      )
      .run(step!);
    this.throttle.succeed(context.address);
    this.clearSessions(context.sessionId);
  }
  private clearSessions(except?: string) {
    this.passkeys.clearPending();
    const rows = this.options.database.prepare('SELECT id FROM web_sessions').all() as {
      id: string;
    }[];
    for (const row of rows) if (row.id !== except) this.revoke(row.id);
  }

  private headers(response: ServerResponse) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    // Not no-referrer: under it Safari sends Origin: null with the page's own POSTs, and sign-in is refused.
    response.setHeader('Referrer-Policy', 'same-origin');
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    if (this.https) response.setHeader('Strict-Transport-Security', 'max-age=31536000');
  }
  private empty(response: ServerResponse, status: number) {
    response.writeHead(status).end();
    return true;
  }
  private json(response: ServerResponse, status: number, body: unknown) {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(body));
    return true;
  }
  private async body(request: IncomingMessage, limit = 4096) {
    if (!/^application\/json(?:\s*;|$)/i.test(String(request.headers['content-type'] ?? '')))
      fail('web_bad_request', '请使用 JSON 请求。');
    const chunks: Buffer[] = [];
    let size = 0;
    const timeout = setTimeout(() => request.destroy(), 10_000);
    try {
      for await (const chunk of request) {
        size += chunk.length;
        if (size > limit) fail('web_bad_request', '请求内容过长。');
        chunks.push(Buffer.from(chunk));
      }
      try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return fail('web_bad_request', '请求格式无效。');
      }
    } finally {
      clearTimeout(timeout);
    }
  }
  // Answers the requests of the Web entry; false leaves the request to the caller.
  async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    if (!this.enabled) return false;
    // Where a proxy connects from is not always what one expects; the desktop settings show it.
    if (request.headers['x-real-ip'] !== undefined && !this.proxied(request))
      this.forwardedBy = ip(request.socket.remoteAddress ?? '');
    this.headers(response);
    if (!this.requestOrigin(request)) return this.empty(response, 404);
    const pathname = (request.url ?? '').split('?')[0];
    const reading = ['GET', 'HEAD'].includes(request.method ?? '');
    if (this.prefix && pathname === this.prefix && reading) {
      response.writeHead(308, { Location: `${this.prefix}/` }).end();
      return true;
    }
    const route = this.route(request);
    if (!route) return this.empty(response, 404);
    if (route.startsWith('/api/')) return this.api(route, request, response);
    if (!reading) return this.empty(response, 404);
    return this.file(route, request, response);
  }
  private api(route: string, request: IncomingMessage, response: ServerResponse) {
    if (!this.trusted(request, request.method !== 'GET')) return this.empty(response, 403);
    if (route === '/api/session' && request.method === 'GET')
      return this.json(response, 200, this.loginState(request, this.cookieSession(request)));
    if (route === '/api/logout' && request.method === 'POST') {
      const row = this.cookieSession(request);
      if (row) this.revoke(row.id);
      response.setHeader('Set-Cookie', this.cookie('', 0));
      return this.json(response, 200, { authenticated: false });
    }
    if (route === '/api/login' && request.method === 'POST') return this.login(request, response);
    if (route.startsWith('/api/passkey/') && request.method === 'POST')
      return this.passkeyApi(route.slice('/api/passkey/'.length), request, response);
    return this.empty(response, 404);
  }
  private async login(request: IncomingMessage, response: ServerResponse) {
    const address = this.address(request);
    const wait = this.throttle.blocked(address, this.now());
    if (wait || !this.throttle.enter(address)) {
      response.setHeader('Retry-After', String(wait || 5));
      return this.json(response, 429, { error: '尝试过于频繁，请稍后重试。' });
    }
    try {
      const body = webLoginSchema.safeParse(await this.body(request));
      if (!body.success) fail('web_bad_request', '登录请求格式无效。');
      this.proof(body.data, address);
      return this.signIn(request, response);
    } catch (error) {
      const known = error instanceof DomainError;
      return this.json(response, (known && statuses[error.code]) || 400, {
        error: known ? error.message : '登录暂时不可用。',
        code: known ? error.code : 'web_login_failed',
      });
    } finally {
      this.throttle.leave(address);
    }
  }
  private async passkeyApi(route: string, request: IncomingMessage, response: ServerResponse) {
    if (!/^(?:register|login|proof)\/(?:options|verify|cancel)$/.test(route))
      return this.empty(response, 404);
    const address = this.address(request);
    const cancelling = route.endsWith('/cancel');
    const wait = cancelling ? 0 : this.throttle.blocked(address, this.now());
    if (wait || !this.throttle.enter(address)) {
      response.setHeader('Retry-After', String(wait || 5));
      return this.json(response, 429, { error: '尝试过于频繁，请稍后重试。' });
    }
    try {
      const input: unknown = await this.body(request, 64 * 1024);
      // A slow upload must not start a ceremony for an entry that was disabled or moved meanwhile.
      if (this.route(request) !== `/api/passkey/${route}` || !this.trusted(request))
        fail('passkey_expired', '访问地址已变化，请重新开始。');
      const entry = this.passkeyEntry(request);
      if (cancelling) {
        const kind = route.startsWith('register/')
          ? 'register'
          : route.startsWith('login/')
            ? 'login'
            : 'proof';
        const session = kind === 'login' ? undefined : this.passkeySession(request);
        const { challengeId } = passkeyCancellationSchema.parse(input);
        this.passkeys.cancel(challengeId, kind, entry, session?.id);
        return this.json(response, 200, { cancelled: true });
      }
      if (route.startsWith('register/')) {
        const result = await this.registerPasskey(route, input, request, entry);
        return this.json(response, 200, result);
      }
      return await this.authenticatePasskey(route, input, request, response, entry);
    } catch (error) {
      if (route.endsWith('/verify')) this.throttle.fail(address, this.now());
      const known = error instanceof DomainError;
      return this.json(response, (known && statuses[error.code]) || 400, {
        error: known ? error.message : '通行密钥验证失败，请重新尝试。',
        code: known ? error.code : 'passkey_failed',
      });
    } finally {
      this.throttle.leave(address);
    }
  }
  private async registerPasskey(
    route: string,
    input: unknown,
    request: IncomingMessage,
    entry: PasskeyEntry,
  ) {
    const session = this.passkeySession(request);
    if (route === 'register/options') {
      const body = passkeyRegistrationRequestSchema.parse(input);
      return this.passkeys.registrationOptions(
        body.name,
        session.id,
        entry,
        this.address(request),
        this.sessionExpiry(session),
      );
    }
    const body = passkeyRegistrationResponseSchema.parse(input);
    const id = await this.passkeys.register(body.challengeId, body.response, entry, session.id);
    return { registered: true, id };
  }
  private async authenticatePasskey(
    route: string,
    input: unknown,
    request: IncomingMessage,
    response: ServerResponse,
    entry: PasskeyEntry,
  ) {
    const kind = route.startsWith('login/') ? 'login' : 'proof';
    const session = kind === 'proof' ? this.passkeySession(request) : undefined;
    if (route.endsWith('/options')) {
      passkeyEmptyRequestSchema.parse(input);
      const options = await this.passkeys.authenticationOptions(
        kind,
        entry,
        this.address(request),
        session?.id,
        session ? this.sessionExpiry(session) : undefined,
      );
      return this.json(response, 200, options);
    }
    const body = passkeyAuthenticationResponseSchema.parse(input);
    return this.passkeys.authenticate(
      kind,
      body.challengeId,
      body.response,
      entry,
      session?.id,
      (id) => {
        this.throttle.succeed(this.address(request));
        return kind === 'login'
          ? this.signIn(request, response, id)
          : this.json(response, 200, this.passkeys.proof(session!.id));
      },
    );
  }

  private signIn(request: IncomingMessage, response: ServerResponse, passkeyId?: string) {
    this.sweep();
    // Signing in again replaces this browser's login instead of adding one.
    const previous = this.cookieSession(request);
    const { count } = this.options.database
      .prepare('SELECT COUNT(*) AS count FROM web_sessions')
      .get() as { count: number };
    if (count >= 128 && !previous)
      fail('web_session_limit', '登录会话数量已达上限，请先撤销不用的会话。');
    const now = this.now();
    const secret = randomBytes(32).toString('hex');
    const row: StoredSession = {
      id: randomUUID(),
      name: String(request.headers['user-agent'] ?? '浏览器').slice(0, 120),
      secret_hash: hash(secret),
      token_hash: this.tokenHash,
      created: now,
      active: now,
      expires: now + 30 * DAY,
      passkey_id: passkeyId ?? null,
    };
    this.options.database
      .prepare(
        'INSERT INTO web_sessions (id, secret_hash, token_hash, name, created, active, expires, passkey_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        row.id,
        row.secret_hash,
        row.token_hash,
        row.name,
        now,
        now,
        row.expires,
        row.passkey_id,
      );
    if (previous) this.revoke(previous.id);
    response.setHeader('Set-Cookie', this.cookie(secret, row.expires));
    return this.json(response, 200, this.loginState(request, row));
  }
  // Files of the build only: the page, its assets and icons; no dotfiles or source maps.
  private async file(route: string, request: IncomingMessage, response: ServerResponse) {
    try {
      const file = route === '/' ? 'index.html' : decodeURIComponent(route.slice(1));
      if (
        file.includes('\\') ||
        file.includes('\0') ||
        file.split('/').some((part) => part === '.' || part === '..' || part.startsWith('.')) ||
        file.endsWith('.map') ||
        !(
          file === 'index.html' ||
          file.startsWith('assets/') ||
          ['favicon.ico', 'icon.png'].includes(file)
        )
      )
        return this.empty(response, 404);
      const root = await realpath(this.options.directory);
      const target = await realpath(resolve(root, file));
      if (!webStaticPath(root, target)) return this.empty(response, 404);
      const info = await stat(target);
      if (!info.isFile() || info.size > 20 * 1024 * 1024) return this.empty(response, 404);
      const data = file === 'index.html' ? await this.page(target) : await readFile(target);
      response.writeHead(200, {
        'Content-Type': types[extname(target)] ?? 'application/octet-stream',
        'Content-Length': data.length,
      });
      response.end(request.method === 'HEAD' ? undefined : data);
    } catch {
      if (!response.headersSent) response.writeHead(404).end();
      else response.destroy();
    }
    return true;
  }
  // The shared build carries the desktop's CSP in a meta tag; the Web page has the HTTP policy above instead.
  private async page(target: string) {
    this.index ??= Buffer.from(
      (await readFile(target, 'utf8')).replace(
        /<meta\b[^>]*\bhttp-equiv\s*=\s*["']Content-Security-Policy["'][^>]*>/gi,
        '',
      ),
    );
    return this.index;
  }
  close() {
    this.closed = true;
    this.passkeys.clearPending();
    clearTimeout(this.timer);
    for (const id of this.sockets.keys()) this.disconnect(id);
  }
}
