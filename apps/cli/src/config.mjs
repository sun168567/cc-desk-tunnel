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

// `servers` are the services signed in to, by address; `current` is the one used when none is named.
export class Config {
  constructor(paths = directories()) {
    this.paths = paths;
    this.path = join(paths.cli, 'config.json');
    const value = readJson(this.path);
    this.servers = Array.isArray(value.servers) ? value.servers : [];
    this.current = typeof value.current === 'string' ? value.current : undefined;
    this.deviceId = typeof value.deviceId === 'string' ? value.deviceId : undefined;
  }
  save() {
    writeJson(this.path, { servers: this.servers, current: this.current, deviceId: this.deviceId });
  }
  server(url) {
    const wanted = url ?? this.current;
    return (
      this.servers.find((server) => server.url === wanted) ?? (url ? undefined : this.servers[0])
    );
  }
  remember(server) {
    this.servers = [...this.servers.filter((other) => other.url !== server.url), server];
    this.current = server.url;
    this.save();
  }
  forget(url) {
    this.servers = this.servers.filter((server) => server.url !== url);
    if (this.current === url) this.current = this.servers.at(-1)?.url;
    this.save();
  }
  // The services the desktop client signs in to, one a connection, for `ccdt login` to offer: the address and the
  // certificate pin. Its saved tokens are encrypted for the desktop program alone and are not read.
  desktopLogins() {
    const connections = join(this.paths.desktop, 'connections');
    let names = [];
    try {
      names = readdirSync(connections);
    } catch {}
    const logins = [this.paths.desktop, ...names.map((name) => join(connections, name))]
      .map((directory) => readJson(join(directory, 'settings.json')).login)
      .filter((login) => login && typeof login.url === 'string' && login.url.startsWith('wss://'))
      .map((login) => ({ url: login.url, fingerprint: String(login.fingerprint ?? '') }));
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
