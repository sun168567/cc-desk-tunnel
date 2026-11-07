import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { Config, directories } from '../src/config.mjs';
import { proxyFor } from '../src/connection.mjs';
import { RESTORE, relay } from '../src/terminal.mjs';
import { readKeys } from '../src/keys.mjs';
import { fit } from '../src/picker.mjs';
import { packageName } from '../src/runtime.mjs';
import { protect, reveal } from '../src/secret.mjs';
import { choices, entries, parse, save, shown } from '../src/settings.mjs';
import { download, install } from '../src/upgrade.mjs';

test('settings live where each system keeps them, beside the desktop client’s', () => {
  assert.deepEqual(directories({ APPDATA: 'C:\\A' }, 'win32', 'C:\\H'), {
    cli: join('C:\\A', 'ccdt'),
    desktop: join('C:\\A', 'CC Desk Tunnel'),
  });
  assert.equal(
    directories({}, 'darwin', '/h').cli,
    join('/h', 'Library', 'Application Support', 'ccdt'),
  );
  assert.equal(directories({}, 'linux', '/h').desktop, join('/h', '.config', 'CC Desk Tunnel'));
  assert.equal(directories({ CCDT_CONFIG_DIR: '/c' }, 'linux', '/h').cli, '/c');
});

test('the desktop client’s device ID is the computer’s; without one ccdt keeps its own', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ccdt-config-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = { cli: join(root, 'cli'), desktop: join(root, 'desktop') };
  const own = new Config(paths).device();
  assert.equal(new Config(paths).device(), own);
  if (process.platform !== 'win32')
    assert.equal(statSync(join(paths.cli, 'config.json')).mode & 0o777, 0o600);
  mkdirSync(paths.desktop);
  const desktop = '11111111-2222-4333-8444-555555555555';
  writeFileSync(join(paths.desktop, 'settings.json'), JSON.stringify({ deviceId: desktop }));
  assert.equal(new Config(paths).device(), desktop);
  const config = new Config(paths);
  config.remember({ url: 'wss://a/ws', fingerprint: '' });
  config.remember({ url: 'wss://b/ws', fingerprint: '' });
  assert.equal(new Config(paths).server().url, 'wss://b/ws');
  config.forget('wss://b/ws');
  assert.equal(new Config(paths).server().url, 'wss://a/ws');
  assert.equal(
    JSON.parse(readFileSync(join(paths.cli, 'config.json'), 'utf8')).current,
    'wss://a/ws',
  );
});

test('a proxy from the environment, except for loopback and no_proxy addresses', () => {
  const env = { https_proxy: 'http://127.0.0.1:7890', no_proxy: 'internal.example,.lan' };
  assert.equal(proxyFor('wss://example.com/ws', env), 'PROXY 127.0.0.1:7890');
  assert.equal(proxyFor('wss://a.internal.example/ws', env), 'DIRECT');
  assert.equal(proxyFor('wss://box.lan/ws', env), 'DIRECT');
  assert.equal(proxyFor('wss://127.0.0.1:8787/ws', env), 'DIRECT');
  assert.equal(
    proxyFor('wss://example.com/ws', { https_proxy: 'socks5://127.0.0.1:1080' }),
    'DIRECT',
  );
  assert.equal(proxyFor('wss://example.com/ws', {}), 'DIRECT');
});

function fakes() {
  const service = new EventEmitter();
  const sent = [];
  const requests = [];
  service.send = (message) => sent.push(message);
  service.request = async (command) => {
    requests.push(command);
    return { type: 'response', ok: true };
  };
  const input = new PassThrough();
  input.setRawMode = (on) => (input.raw = on);
  const output = new PassThrough();
  output.columns = 120;
  output.rows = 30;
  let shown = '';
  output.on('data', (chunk) => (shown += chunk));
  return { service, sent, requests, input, output, shown: () => shown };
}

test('the terminal is shown as it is: output acknowledged once written, keys and size passed on', async () => {
  const f = fakes();
  const sessionId = 's';
  const ended = relay(f.service, sessionId, {}, f.input, f.output);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.requests[0], {
    type: 'terminal.open',
    sessionId,
    cols: 120,
    rows: 30,
  });
  assert.equal(f.input.raw, true);
  f.service.emit('message', {
    type: 'terminal.data',
    sessionId,
    terminalId: 'early',
    data: 'x',
    bytes: 1,
  });
  f.service.emit('message', { type: 'terminal.opened', sessionId, terminalId: 't' });
  f.service.emit('message', {
    type: 'terminal.data',
    sessionId,
    terminalId: 't',
    data: '画面',
    bytes: 6,
  });
  f.input.write('hi');
  f.output.columns = 100;
  f.output.emit('resize');
  await new Promise((resolve) => setImmediate(resolve));
  f.service.emit('message', { type: 'terminal.closed', sessionId, terminalId: 't', exitCode: 3 });
  assert.deepEqual(await ended, { how: 'exited', code: 3 });
  assert.equal(f.shown(), `画面${RESTORE}`);
  // The acknowledgment follows the write, so it may come after what was typed meanwhile.
  const byType = (a, b) => a.type.localeCompare(b.type);
  assert.deepEqual(f.sent.toSorted(byType), [
    { type: 'terminal.ack', sessionId, terminalId: 't', bytes: 6 },
    { type: 'terminal.input', sessionId, terminalId: 't', data: 'hi' },
    { type: 'terminal.resize', sessionId, terminalId: 't', cols: 100, rows: 30 },
  ]);
  assert.equal(f.input.raw, false);
});

test('a lost connection, a terminal taken elsewhere and output left behind end the showing, not the terminal', async () => {
  const lost = fakes();
  const one = relay(lost.service, 's', {}, lost.input, lost.output);
  lost.service.emit('end', true);
  assert.deepEqual(await one, { how: 'lost' });
  const taken = fakes();
  const two = relay(taken.service, 's', {}, taken.input, taken.output);
  taken.service.emit('message', { type: 'terminal.opened', sessionId: 's', terminalId: 't' });
  taken.service.emit('message', {
    type: 'terminal.detached',
    sessionId: 's',
    terminalId: 't',
    reason: 'taken',
  });
  assert.deepEqual(await two, { how: 'taken' });
  const stalled = fakes();
  const three = relay(stalled.service, 's', {}, stalled.input, stalled.output);
  stalled.service.emit('message', { type: 'terminal.opened', sessionId: 's', terminalId: 't' });
  stalled.service.emit('message', {
    type: 'terminal.detached',
    sessionId: 's',
    terminalId: 'other',
    reason: 'stalled',
  });
  stalled.service.emit('message', {
    type: 'terminal.detached',
    sessionId: 's',
    terminalId: 't',
    reason: 'stalled',
  });
  assert.deepEqual(await three, { how: 'stalled' });
});

test('ccdt login offers the services the desktop client signs in to, by its names, without their tokens', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ccdt-logins-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = { cli: join(root, 'cli'), desktop: join(root, 'desktop') };
  mkdirSync(join(paths.desktop, 'connections', 'abcdefgh'), { recursive: true });
  mkdirSync(join(paths.desktop, 'shared'), { recursive: true });
  const login = (url, fingerprint) =>
    JSON.stringify({ login: { url, fingerprint, token: 'encrypted' } });
  writeFileSync(join(paths.desktop, 'settings.json'), login('wss://main/ws', 'AA:BB'));
  writeFileSync(
    join(paths.desktop, 'connections', 'abcdefgh', 'settings.json'),
    login('wss://other/ws', ''),
  );
  writeFileSync(
    join(paths.desktop, 'shared', 'connections.json'),
    JSON.stringify([{ id: 'abcdefgh', name: '家里' }]),
  );
  assert.deepEqual(new Config(paths).desktopLogins(), [
    { url: 'wss://main/ws', fingerprint: 'AA:BB', name: '主连接' },
    { url: 'wss://other/ws', fingerprint: '', name: '家里' },
  ]);
});

// Three services signed in to, the desktop client calling one of them 公司.
function signedIn(t) {
  const root = mkdtempSync(join(tmpdir(), 'ccdt-servers-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = { cli: join(root, 'cli'), desktop: join(root, 'desktop') };
  mkdirSync(paths.cli, { recursive: true });
  mkdirSync(join(paths.desktop, 'shared'), { recursive: true });
  writeFileSync(
    join(paths.desktop, 'settings.json'),
    JSON.stringify({ login: { url: 'wss://tunnel.example.com/ws', fingerprint: '' } }),
  );
  writeFileSync(
    join(paths.desktop, 'shared', 'connections.json'),
    JSON.stringify([{ id: '', name: '公司' }]),
  );
  // Written by a ccdt before services said when they were last used.
  writeFileSync(
    join(paths.cli, 'config.json'),
    JSON.stringify({
      servers: [
        { url: 'wss://tunnel.example.com/ws', fingerprint: '' },
        { url: 'wss://tokyo.example.net/ws', fingerprint: '' },
        { url: 'wss://tokyo-2.example.net/ws', fingerprint: '' },
      ],
      current: 'wss://tokyo.example.net/ws',
    }),
  );
  return paths;
}

test('a service is named by its address, the desktop client’s name for it or its host, or a part that tells it apart', (t) => {
  const config = new Config(signedIn(t));
  const urls = (wanted) => config.find(wanted).map((server) => server.url);
  assert.deepEqual(urls('公司'), ['wss://tunnel.example.com/ws']);
  assert.deepEqual(urls('TUNNEL'), ['wss://tunnel.example.com/ws']);
  assert.deepEqual(urls('tokyo.example.net'), ['wss://tokyo.example.net/ws']);
  assert.deepEqual(urls('wss://tokyo-2.example.net/ws'), ['wss://tokyo-2.example.net/ws']);
  assert.deepEqual(urls('tokyo'), ['wss://tokyo.example.net/ws', 'wss://tokyo-2.example.net/ws']);
  assert.deepEqual(urls('osaka'), []);
});

test('the service connected to last is the one used when none is named, whatever another ccdt wrote meanwhile', (t) => {
  const paths = signedIn(t);
  const config = new Config(paths);
  assert.equal(config.server().url, 'wss://tokyo.example.net/ws');
  const other = new Config(paths);
  other.remember({ url: 'wss://osaka.example.net/ws', fingerprint: '' });
  config.use('wss://tunnel.example.com/ws');
  const read = new Config(paths);
  assert.equal(read.server().url, 'wss://tunnel.example.com/ws');
  assert.ok(read.find('osaka').length, 'a service another ccdt signed in to meanwhile is kept');
  assert.ok(read.find('tunnel')[0].usedAt);
  read.use('wss://tokyo-2.example.net/ws', false);
  const chosen = new Config(paths);
  assert.equal(chosen.server().url, 'wss://tokyo-2.example.net/ws');
  assert.equal(chosen.find('tokyo-2')[0].usedAt, undefined, 'chosen, not yet connected to');
});

test('naming a service none or several answer, or choosing one away from a terminal, stops before connecting', (t) => {
  const paths = signedIn(t);
  const ccdt = (...args) =>
    spawnSync(process.execPath, ['apps/cli/bin/ccdt.mjs', ...args], {
      encoding: 'utf8',
      input: '',
      env: { ...process.env, CCDT_CONFIG_DIR: paths.cli, APPDATA: join(paths.desktop, '..') },
    });
  const none = ccdt('sessions', '--server', 'osaka');
  assert.equal(none.status, 1);
  assert.match(none.stderr, /没有登录过 osaka/);
  assert.match(ccdt('sessions', '--server', 'tokyo').stderr, /有几个服务端都符合 tokyo/);
  assert.match(ccdt('-s').stderr, /选服务端需要在终端里运行/);
  const listed = ccdt('server');
  assert.equal(listed.status, 0);
  assert.match(listed.stderr, /tokyo\.example\.net .*（当前）/);
});

test('upgrading with no service saved says to log in, rather than failing inside the upgrade', () => {
  const root = mkdtempSync(join(tmpdir(), 'ccdt-upgrade-cli-'));
  try {
    const result = spawnSync(process.execPath, ['apps/cli/bin/ccdt.mjs', 'upgrade'], {
      encoding: 'utf8',
      input: '',
      env: { ...process.env, CCDT_CONFIG_DIR: join(root, 'cli'), APPDATA: join(root, 'appdata') },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr + result.stdout, /还没有登录服务端/);
    assert.doesNotMatch(result.stderr + result.stdout, /before initialization/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('reading keys leaves the input open for the terminal shown next', async () => {
  const input = new PassThrough();
  input.setRawMode = (on) => (input.raw = on);
  const reading = readKeys(input, (key) => (key === '\r' ? 'chosen' : undefined));
  input.write('a');
  input.write('\r');
  assert.equal(await reading, 'chosen');
  assert.equal(input.raw, false);
  assert.equal(input.destroyed, false);
  const again = readKeys(input, (key) => key);
  input.write('b');
  assert.equal(await again, 'b');
});

// A Linux server over SSH has the Secret Service's command at times, but no desktop session for it to work in.
test(
  'a token goes to the Secret Service where it works, and to the settings file where it does not',
  {
    skip: process.platform === 'win32',
  },
  (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'ccdt-secret-'));
    const path = process.env.PATH;
    t.after(() => {
      process.env.PATH = path;
      rmSync(directory, { recursive: true, force: true });
    });
    const tool = join(directory, 'secret-tool');
    process.env.PATH = `${directory}:${path}`;
    writeFileSync(
      tool,
      '#!/bin/sh\necho "Cannot autolaunch D-Bus without X11 $DISPLAY" >&2\nexit 1\n',
    );
    chmodSync(tool, 0o755);
    assert.deepEqual(protect('wss://a.test/ws', 'token-1', 'linux'), {
      store: 'file',
      data: 'token-1',
    });
    const kept = join(directory, 'kept');
    writeFileSync(
      tool,
      `#!/bin/sh\ncase "$1" in store) cat > '${kept}';; lookup) cat '${kept}';; esac\n`,
    );
    const stored = protect('wss://a.test/ws', 'token-2', 'linux');
    assert.deepEqual(stored, { store: 'secret-service' });
    assert.equal(reveal('wss://a.test/ws', stored), 'token-2');
  },
);

test('a list entry is cut to the terminal, Chinese taking two columns and colours none', () => {
  assert.equal(fit('今天 10:00  会话', 40), '今天 10:00  会话');
  assert.equal(fit('项目项目项目', 8), '项目项\x1b[0m…');
  assert.equal(fit('ab\x1b[2mcdef\x1b[0m', 5), 'ab\x1b[2mcd\x1b[0m…');
});

test('each system has the ccdt package of its own name on the release page', () => {
  assert.equal(packageName('0.3.9', 'win32-x64'), 'ccdt-0.3.9-windows-x64.zip');
  assert.equal(packageName('0.3.9', 'darwin-arm64'), 'ccdt-0.3.9-mac-arm64.tar.gz');
  assert.equal(packageName('0.3.9', 'linux-arm64'), 'ccdt-0.3.9-linux-arm64.tar.gz');
  assert.equal(packageName('0.3.9', 'win32-arm64'), undefined);
});

test("a downloaded package is used only when it matches the release's checksum", async () => {
  const body = Buffer.from('package');
  const name = 'ccdt-0.3.9-linux-x64.tar.gz';
  const sum = createHash('sha256').update(body).digest('hex');
  const asked = [];
  const release =
    (sums, served = body) =>
    async (url) => {
      asked.push(url);
      return url.endsWith('/SHA256SUMS')
        ? new Response(sums)
        : url.endsWith(`/${name}`)
          ? new Response(served)
          : new Response('', { status: 404 });
    };
  const fetched = await download('0.3.9', {
    system: 'linux-x64',
    get: release(`${'0'.repeat(64)}  other.zip\n${sum}  ${name}\n`),
  });
  assert.equal(fetched.name, name);
  assert.deepEqual(fetched.body, body);
  assert.match(asked[0], /\/releases\/download\/v0\.3\.9\/SHA256SUMS$/);
  await assert.rejects(
    download('0.3.9', { system: 'linux-x64', get: release(`${sum}  ${name}\n`, 'tampered') }),
    /校验不符/,
  );
  await assert.rejects(
    download('0.3.9', { system: 'linux-x64', get: release(`${sum}  other.zip\n`) }),
    /没有/,
  );
  await assert.rejects(
    download('0.3.9', { system: 'win32-arm64', get: release('') }),
    /没有这个系统/,
  );
});

test('the package is put in place by the install script it carries', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ccdt-upgrade-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const marker = join(root, 'installed');
  mkdirSync(join(root, 'ccdt'));
  const windows = process.platform === 'win32';
  const tar = windows
    ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar';
  const name = windows ? 'ccdt.zip' : 'ccdt.tar.gz';
  // A stand-in for the script, which tells how it was run.
  if (windows)
    writeFileSync(
      join(root, 'ccdt', 'install.ps1'),
      `Set-Content -LiteralPath '${marker.replaceAll("'", "''")}' -Value ran`,
    );
  else {
    writeFileSync(join(root, 'ccdt', 'install.sh'), `#!/bin/sh\necho ran > '${marker}'\n`);
    chmodSync(join(root, 'ccdt', 'install.sh'), 0o755);
  }
  execFileSync(
    tar,
    windows
      ? ['-a', '-cf', join(root, name), '-C', root, 'ccdt']
      : ['-czf', join(root, name), '-C', root, 'ccdt'],
  );
  install({ name, body: readFileSync(join(root, name)) });
  assert.equal(readFileSync(marker, 'utf8').trim(), 'ran');
  // A script that fails says so.
  if (windows) writeFileSync(join(root, 'ccdt', 'install.ps1'), "throw 'in use'");
  else writeFileSync(join(root, 'ccdt', 'install.sh'), "#!/bin/sh\necho 'in use' >&2\nexit 1\n");
  rmSync(join(root, name));
  execFileSync(
    tar,
    windows
      ? ['-a', '-cf', join(root, name), '-C', root, 'ccdt']
      : ['-czf', join(root, name), '-C', root, 'ccdt'],
  );
  assert.throws(
    () => install({ name, body: readFileSync(join(root, name)) }),
    /没有装上：[\s\S]*in use/,
  );
});

test('ccdt’s settings: its own waits, the service’s and Claude Code’s with the desktop client’s words', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ccdt-settings-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = new Config({ cli: join(root, 'cli'), desktop: join(root, 'desktop') });
  const remote = {
    compaction: { enabled: false, afterMinutes: 50, minTokens: 100_000 },
    cli: { autoCompactEnabled: null, autoCompactWindow: 250_000, fallbackModel: ['sonnet'] },
    web: { enabled: true, url: 'https://work.example.com/desk/' },
  };
  const list = entries({ waits: { ssh: 20 }, ...remote });
  const named = (name) => list.find((entry) => entry.name === name);
  // The groups in the desktop client's order, each item once, and what is not here yet said so.
  assert.deepEqual(
    [...new Set(list.map((entry) => entry.group.split(' · ')[0]))],
    ['本机', '服务端', 'Claude Code'],
  );
  assert.equal(new Set(list.map((entry) => entry.name)).size, list.length);
  assert.equal(shown(named('connection.ssh')), '20 秒');
  assert.equal(shown(named('connection.ready')), '45 秒（默认）');
  assert.equal(shown(named('compaction.enabled')), '关闭');
  assert.equal(shown(named('compaction.minTokens')), '100K tokens');
  assert.equal(shown(named('web.enabled')), '开启');
  assert.equal(shown(named('cli.autoCompactEnabled')), '默认');
  // A value set by hand that is not among the choices is still one of them.
  assert.equal(shown(named('cli.autoCompactWindow')), '250K tokens');
  assert.equal(shown(named('cli.fallbackModel')), 'sonnet');
  assert.equal(shown(named('cli.instructions')), '暂不支持');
  assert.deepEqual(
    choices(named('cli.autoCompactEnabled')).map(([value]) => value),
    [null, true, false],
  );
  // What is written on the command line, in either language, and what will not do.
  assert.equal(parse(named('compaction.enabled'), 'on'), true);
  assert.equal(parse(named('cli.autoCompactEnabled'), '关闭'), false);
  assert.equal(parse(named('cli.autoCompactEnabled'), 'default'), null);
  assert.equal(parse(named('compaction.afterMinutes'), '45'), 45);
  assert.equal(parse(named('connection.ssh'), '30'), 30);
  assert.deepEqual(parse(named('cli.fallbackModel'), 'sonnet， haiku'), ['sonnet', 'haiku']);
  assert.throws(() => parse(named('compaction.enabled'), 'default'), /on 或 off/);
  assert.throws(() => parse(named('connection.ssh'), '3'), /5–600/);
  assert.throws(() => parse(named('compaction.afterMinutes'), '42'), /可选/);
  assert.throws(() => parse(named('cli.instructions'), 'x'), /\/memory/);
  // ccdt keeps its waits; the rest goes to the service as the desktop client sends it.
  const requests = [];
  const service = { request: async (command) => (requests.push(command), { type: 'response' }) };
  await save(named('connection.connect'), 30, { config, service });
  await save(named('connection.connect'), null, { config, service });
  await save(named('connection.ready'), 90, { config, service });
  assert.deepEqual(JSON.parse(readFileSync(config.path, 'utf8')).waits, { ready: 90 });
  await save(named('compaction.afterMinutes'), 45, { config, service });
  await save(named('web.enabled'), false, { config, service });
  await save(named('cli.autoCompactEnabled'), null, { config, service });
  assert.deepEqual(requests, [
    { type: 'compaction.update', values: { afterMinutes: 45 } },
    { type: 'web.settings.update', values: { enabled: false } },
    { type: 'settings.update', values: { autoCompactEnabled: null } },
  ]);
  // Without a service only this computer's settings are listed.
  assert.deepEqual(
    entries({})
      .filter((entry) => entry.kind !== 'pending')
      .map((entry) => entry.name),
    ['connection.connect', 'connection.ssh', 'connection.ready'],
  );
});

test('ccdt offers the shell Claude should prefer on Windows, Git Bash once the computer has it', async () => {
  const here = { id: 'x', name: 'pc', ready: true, shells: ['pwsh', 'bash'] };
  const shell = (device) =>
    entries({ here: device }).find((entry) => entry.name === 'device.shell');
  assert.equal(shell({ ...here, platform: 'darwin', shells: ['zsh'] }), undefined);
  assert.equal(shell(undefined), undefined);
  // Without Git Bash it is listed as not found, and choosing it says how to get it.
  const alone = shell({ ...here, shells: ['pwsh'] });
  assert.deepEqual(
    choices(alone).map(([, words]) => words),
    ['不指定', 'PowerShell 7', 'Git Bash（未检测到）'],
  );
  const asked = [];
  const quiet = { request: async (command) => (asked.push(command), { type: 'response' }) };
  await assert.rejects(save(alone, 'bash', { service: quiet }), /安装 Git for Windows/);
  await save(alone, 'pwsh', { service: quiet });
  assert.deepEqual(asked, [{ type: 'device.shell', shell: 'pwsh' }]);
  const entry = shell(here);
  assert.equal(entry.group, '本机');
  assert.equal(shown(entry), '不指定');
  assert.equal(shown(shell({ ...here, shell: 'bash' })), 'Git Bash');
  assert.deepEqual(
    choices(entry).map(([value]) => value),
    [null, 'pwsh', 'bash'],
  );
  assert.equal(parse(entry, 'bash'), 'bash');
  assert.equal(parse(entry, 'PowerShell 7'), 'pwsh');
  assert.equal(parse(entry, 'default'), null);
  assert.throws(() => parse(entry, 'zsh'), /可选：pwsh、bash、default/);
  // It goes to the service, which keeps it for this computer.
  const requests = [];
  const service = { request: async (command) => (requests.push(command), { type: 'response' }) };
  await save(entry, 'bash', { service });
  await save(entry, null, { service });
  assert.deepEqual(requests, [
    { type: 'device.shell', shell: 'bash' },
    { type: 'device.shell', shell: null },
  ]);
});
