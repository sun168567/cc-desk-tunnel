import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Where ccdt keeps its settings, and where the desktop client keeps the settings of the computer. The two share the
// computer's device ID, so that the service takes them for the same computer.
export function directories(env = process.env, platform = process.platform, home = homedir()) {
  const base =
    platform === 'win32'
      ? (env.APPDATA ?? join(home, 'AppData', 'Roaming'))
      : platform === 'darwin'
        ? join(home, 'Library', 'Application Support')
        : (env.XDG_CONFIG_HOME ?? join(home, '.config'));
  return { cli: env.CCDT_CONFIG_DIR ?? join(base, 'ccdt'), desktop: join(base, 'CC Desk Tunnel') };
}

function readJson(path) {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

// Only this account reads it: it may hold a service token.
function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

// A service as ccdt calls it where the desktop client has no name for it.
export const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

// `servers` are the services signed in to, by address, each with when it was last connected to (`usedAt`); `current`
// is the one used when none is named: the one connected to last. `waits` are the seconds each step of connecting may
// take where they are not the defaults (see `ccdt config`).
export class Config {
  constructor(paths = directories()) {
    this.paths = paths;
    this.path = join(paths.cli, 'config.json');
    const value = readJson(this.path);
    this.servers = Array.isArray(value.servers) ? value.servers : [];
    this.current = typeof value.current === 'string' ? value.current : undefined;
    this.deviceId = typeof value.deviceId === 'string' ? value.deviceId : undefined;
    this.waits = value.waits && typeof value.waits === 'object' ? value.waits : {};
  }
  save() {
    writeJson(this.path, {
      servers: this.servers,
      current: this.current,
      deviceId: this.deviceId,
      ...(Object.keys(this.waits).length ? { waits: this.waits } : {}),
    });
  }
  server(url) {
    const wanted = url ?? this.current;
    return (
      this.servers.find((server) => server.url === wanted) ?? (url ? undefined : this.servers[0])
    );
  }
  // The services `wanted` names: by address, by the desktop client's name for the connection to it or by host, else
  // those any of these hold it in, ignoring case.
  find(wanted, names = this.names()) {
    const text = wanted.toLowerCase();
    const called = (server) =>
      [server.url, names.get(server.url) ?? '', hostOf(server.url)].map((name) =>
        name.toLowerCase(),
      );
    const exact = this.servers.filter((server) => called(server).includes(text));
    return exact.length
      ? exact
      : this.servers.filter((server) => called(server).some((name) => name.includes(text)));
  }
  // The desktop client's names for the services it connects to, by address.
  names() {
    return new Map(this.desktopLogins().map(({ url, name }) => [url, name]));
  }
  remember(server) {
    const used = { ...server, usedAt: new Date().toISOString() };
    this.servers = [...this.servers.filter((other) => other.url !== server.url), used];
    this.current = server.url;
    this.save();
  }
  // The service becomes the one used when none is named; `connected` also says it was used now. Another ccdt may
  // have changed the file since this one read it, so it is read again first.
  use(url, connected = true) {
    const fresh = new Config(this.paths);
    const server = fresh.servers.find((other) => other.url === url);
    if (!server) return;
    if (connected) server.usedAt = new Date().toISOString();
    fresh.current = url;
    fresh.save();
    this.servers = fresh.servers;
    this.current = fresh.current;
  }
  forget(url) {
    this.servers = this.servers.filter((server) => server.url !== url);
    if (this.current === url) this.current = this.servers.at(-1)?.url;
    this.save();
  }
  // The services the desktop client signs in to, one a connection, for `ccdt login` to offer: the address, the
  // certificate pin and the connection's name, the first one's "主连接" unless the user renamed it. Its saved tokens
  // are encrypted for the desktop program alone and are not read.
  desktopLogins() {
    const connections = join(this.paths.desktop, 'connections');
    let ids = [];
    try {
      ids = readdirSync(connections);
    } catch {}
    let named = [];
    try {
      named = JSON.parse(
        readFileSync(join(this.paths.desktop, 'shared', 'connections.json'), 'utf8'),
      );
    } catch {}
    const nameOf = (id) =>
      (Array.isArray(named) && named.find((entry) => entry?.id === id)?.name) ||
      (id ? id : '主连接');
    const logins = ['', ...ids]
      .map((id) => ({
        id,
        login: readJson(join(id ? join(connections, id) : this.paths.desktop, 'settings.json'))
          .login,
      }))
      .filter(
        ({ login }) => login && typeof login.url === 'string' && login.url.startsWith('wss://'),
      )
      .map(({ id, login }) => ({
        url: login.url,
        fingerprint: String(login.fingerprint ?? ''),
        name: String(nameOf(id)),
      }));
    return logins.filter(
      (login, index) => logins.findIndex((other) => other.url === login.url) === index,
    );
  }
  // The desktop client's ID for this computer when it is installed; ccdt's own otherwise.
  device() {
    const desktop = readJson(join(this.paths.desktop, 'settings.json')).deviceId;
    if (typeof desktop === 'string' && uuid.test(desktop)) return desktop;
    if (!this.deviceId) {
      this.deviceId = randomUUID();
      this.save();
    }
    return this.deviceId;
  }
}
