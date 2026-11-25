import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { strToU8, zipSync } from 'fflate';
import type { EventPayload, Session } from '@cc-desk-tunnel/protocol';
import { matches } from '../src/plugin-hooks.ts';
import { readArchive } from '../src/plugin-install.ts';
import { confinable } from '../src/plugin-process.ts';
import { Plugins } from '../src/plugins.ts';
import { EVENTS_VERSION, ServiceEvents } from '../src/service-events.ts';
import type { ServiceEvent } from '../src/service-events.ts';

// Enabled by the user, as one is where the system cannot confine it.
function agree(directory: string, ...ids: string[]) {
  mkdirSync(join(directory, 'plugin-config'), { recursive: true });
  for (const id of ids)
    writeFileSync(join(directory, 'plugin-config', `${id}.json`), '{"agreed":true}');
}

test('a matcher is names or a regular expression, as in Claude Code', () => {
  assert.ok(matches(undefined, 'Bash') && matches('*', 'Bash') && matches('Edit | Bash', 'Bash'));
  assert.ok(!matches('Bash', 'BashOutput'));
  assert.ok(matches('^mcp__.*', 'mcp__memory__read') && !matches('^mcp__.*', 'Bash'));
  assert.throws(() => matches('^(\\w+)+!$', 'a'.repeat(60)), /timed out/);
});

test('a broken plugin and one that does not end leave the others alone, and each log says how it went', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'cc-desk-tunnel-plugins-'));
  const plugins = new Plugins(directory);
  t.after(() => {
    plugins.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const add = (name: string, text: string) => {
    mkdirSync(join(directory, 'plugins', name, 'hooks'), { recursive: true });
    writeFileSync(join(directory, 'plugins', name, 'hooks', 'hooks.json'), text);
  };
  const script = (code: string, timeout: number) =>
    JSON.stringify({
      hooks: {
        RunEnded: [
          {
            hooks: [{ type: 'command', command: process.execPath, args: ['-e', code], timeout }],
          },
        ],
      },
    });
  agree(directory, 't.a-broken', 't.b-hangs', 't.c-fails', 't.d-works');
  add('t.a-broken', '{');
  add('t.b-hangs', script('setInterval(() => {}, 1000)', 0.5));
  add('t.c-fails', script('console.error("no token"); process.exit(3)', 10));
  add('t.d-works', script('console.log("sent")', 10));
  const logged = (name: string) => {
    try {
      return readFileSync(join(directory, 'plugin-logs', `${name}.log`), 'utf8');
    } catch {
      return '';
    }
  };
  await plugins.start();
  plugins.dispatch({
    version: EVENTS_VERSION,
    hook_event_name: 'RunEnded',
    timestamp: new Date().toISOString(),
    status: 'completed',
  });
  const all = ['t.a-broken', 't.b-hangs', 't.c-fails', 't.d-works'];
  for (const deadline = Date.now() + 10_000; !all.every(logged) && Date.now() < deadline;)
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.match(logged('t.a-broken'), /加载失败：/);
  assert.match(logged('t.b-hangs'), /RunEnded → 超时 0\.5s，已结束 \d+ms\n$/);
  assert.match(logged('t.c-fails'), /RunEnded → 退出 3 \d+ms\n    no token\n$/);
  assert.match(logged('t.d-works'), /RunEnded → 成功 \d+ms\n    sent\n$/);
});

test('a plugin is set by what its ui file declares and checks, and its secrets go to its commands alone', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'cc-desk-tunnel-plugins-'));
  const root = join(directory, 'plugins', 't.set');
  agree(directory, 't.set');
  mkdirSync(join(root, 'hooks'), { recursive: true });
  writeFileSync(
    join(root, 'hooks', 'hooks.json'),
    JSON.stringify({
      hooks: {
        RunEnded: [{ hooks: [{ type: 'command', command: process.execPath, args: ['told.mjs'] }] }],
      },
    }),
  );
  writeFileSync(
    join(root, 'told.mjs'),
    "import { readFileSync } from 'node:fs';\n" +
      'console.log(JSON.parse(readFileSync(0, "utf8")).config);\n',
  );
  writeFileSync(
    join(root, 'ui.ts'),
    `console.log('loaded');
export const settings = [{ title: '渠道', showWhen: 'on', fields: {
  on: { type: 'boolean', title: '启用', default: true },
  token: { type: 'string', title: 'Token', sensitive: true, required: true,
    validate: (value: string, all: { lines: number }) => ({ valid: value.length > all.lines, message: value + ' 太短' }) },
  lines: { type: 'number', title: '行数', default: 5, max: 9 },
  test: { type: 'button', title: '测试', run: async (all: { token: string }) => ({ ok: !!process.env.CLAUDE_PLUGIN_DATA, message: all.token }) },
} }];`,
  );
  const plugins = new Plugins(directory);
  t.after(() => {
    plugins.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  await plugins.start();
  assert.equal(plugins.list()[0]!.problem, '待配置：Token');
  assert.deepEqual(await plugins.attempt('t.set', 'RunEnded'), {
    ok: false,
    message: '待配置：Token',
  });

  const wrong = await plugins.configure('t.set', { token: 'abcd', lines: 10 });
  assert.deepEqual(wrong, {
    errors: { token: '*** 太短', lines: '不能大于 9' },
    notice: undefined,
  });
  // Neither was kept, and what holds beside one that does not is.
  assert.deepEqual(plugins.list()[0]!.secrets, []);
  await plugins.configure('t.set', { lines: 4, token: 'ab' });
  assert.deepEqual([plugins.list()[0]!.values.lines, plugins.list()[0]!.secrets], [4, []]);
  // A button takes the values of the form, kept or not.
  assert.deepEqual(await plugins.press('t.set', 'test', { token: 'not-kept-yet' }), {
    ok: true,
    message: '***',
  });
  await plugins.configure('t.set', { token: 'secret-token' });
  const [listed] = plugins.list();
  assert.equal(listed!.problem, undefined);
  assert.deepEqual([listed!.values, listed!.secrets], [{ on: true, lines: 4 }, ['token']]);

  // Left empty a secret stays; the command is given it, and the log is not.
  await plugins.configure('t.set', { token: '', lines: 6 });
  const tried = await plugins.attempt('t.set', 'RunEnded');
  assert.ok(tried.ok);
  assert.match(tried.message, /token: '\*\*\*', lines: 6/);
  assert.doesNotMatch(plugins.logOf('t.set'), /secret-token/);

  await plugins.enable('t.set', false);
  assert.deepEqual(plugins.list()[0]!.settings, []);
  assert.equal((await plugins.attempt('t.set', 'RunEnded')).ok, false);
  await plugins.enable('t.set', true);
  assert.deepEqual(plugins.list()[0]!.secrets, ['token']);
});

test('a check that hangs keeps nothing from being saved, and a ui file that cannot be loaded is told of', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'cc-desk-tunnel-plugins-'));
  const add = (name: string, ui: string) => {
    mkdirSync(join(directory, 'plugins', name, 'hooks'), { recursive: true });
    writeFileSync(join(directory, 'plugins', name, 'hooks', 'hooks.json'), '{"hooks":{}}');
    writeFileSync(join(directory, 'plugins', name, 'ui.ts'), ui);
  };
  const field = (more: string) =>
    `export const settings = [{ title: 'A', fields: { a: { type: 'string', title: 'A', ${more} } } }];`;
  agree(directory, 't.b-throws', 't.c-unknown', 't.d-garbles');
  add('t.a-hangs', field('validate: () => { for (;;); }'));
  add('t.b-throws', 'throw new Error("no luck");');
  add('t.c-unknown', field('type: "list"'));
  add('t.d-garbles', "import { writeSync } from 'node:fs'; writeSync(3, '{');");
  // Kept for what the field was before the plugin was updated.
  writeFileSync(
    join(directory, 'plugin-config', 't.a-hangs.json'),
    '{"agreed":true,"values":{"a":5}}',
  );
  const plugins = new Plugins(directory);
  t.after(() => {
    plugins.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  await plugins.start();
  const [hangs, throws, unknown, garbles] = plugins.list();
  assert.equal(hangs!.values.a, '');
  assert.equal(throws!.problem, '加载失败：no luck');
  assert.equal(garbles!.problem, '加载失败：没有结果就退出了');
  assert.match(unknown!.problem!, /^加载失败：settings\.0\.fields\.a/);
  const saved = await plugins.configure('t.a-hangs', { a: 'x' });
  assert.equal(plugins.list()[0]!.values.a, 'x');
  assert.match(saved.notice!, /没跑成：超过 2 秒/);
});

test('an archive is checked before any of it is run, and takes the place of the plugin of its name', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'cc-desk-tunnel-plugins-'));
  const plugins = new Plugins(directory);
  t.after(() => {
    plugins.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const hooks = {
    RunEnded: [{ hooks: [{ type: 'command', command: 'node', args: ['notify.mjs'] }] }],
  };
  const pack = (version: string, more: Record<string, string> = {}, folder = '') =>
    zipSync(
      Object.fromEntries(
        Object.entries({
          '.claude-plugin/plugin.json': JSON.stringify({ id: 't.notify', version }),
          'hooks/hooks.json': JSON.stringify({ hooks }),
          'notify.mjs': version,
          ...more,
        }).map(([name, text]) => [folder + name, strToU8(text)]),
      ),
    );
  for (const [archive, message] of [
    [strToU8('not a zip'), /不是有效的 zip/],
    [zipSync({ 'a.txt': strToU8('a') }), /没有 \.claude-plugin\/plugin\.json/],
    [pack('1', { '../evil.mjs': '' }), /路径不合规/],
    [pack('1', { '.claude-plugin/plugin.json': '{"id":"../x"}' }), /plugin\.json 有误：id/],
    [
      pack('1', { 'hooks/hooks.json': '{"hooks":{"RunEnded":[{"hooks":[{"type":"http"}]}]}}' }),
      /hooks\.json 有误/,
    ],
    [
      pack('1', { '.claude-plugin/plugin.json': '{"id":"t.notify","minVersion":"99.0.0"}' }),
      /需要 99\.0\.0 或更新的服务端/,
    ],
    [pack('1', { '..\\evil.mjs': '' }), /路径不合规/],
    [pack('1', { big: 'x'.repeat(21 * 1024 * 1024) }), /超过 20 MB/],
  ] as const)
    assert.throws(() => readArchive(archive), message);

  await plugins.start();
  const archive = readArchive(pack('1.0.0', { '__MACOSX/x': '' }, 'notify-main/'));
  assert.deepEqual([archive.events, archive.commands], [['RunEnded'], ['node notify.mjs']]);
  await plugins.install(archive);
  assert.equal(plugins.list()[0]!.version, '1.0.0');
  await plugins.enable('t.notify', false);
  await plugins.install(readArchive(pack('2.0.0', {}, 'notify\\')));
  assert.deepEqual(
    plugins.list().map(({ id, version, enabled }) => [id, version, enabled]),
    [['t.notify', '2.0.0', false]],
  );
  await plugins.remove('t.notify');
  assert.deepEqual(plugins.list(), []);
});

test('a newer release is found, its archive taken when it is what was released, and a repository that moved is not followed', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'cc-desk-tunnel-plugins-'));
  const pack = (id: string, version: string) =>
    zipSync({
      '.claude-plugin/plugin.json': strToU8(
        JSON.stringify({ id, version, repository: 'https://github.com/me/notify' }),
      ),
      'hooks/hooks.json': strToU8('{"hooks":{}}'),
    });
  let archive = pack('t.notify', '1.1.0');
  let moved = false;
  const digest = createHash('sha256').update(archive).digest('hex');
  const github = createHttpServer((request, response) => {
    if (request.url === '/archive') return response.end(archive);
    if (moved) return response.writeHead(301, { location: '/elsewhere' }).end();
    assert.equal(request.url, '/repos/me/notify/releases/latest');
    const url = `${api}/archive`;
    const assets = [
      { name: 't.notify.zip', browser_download_url: url, digest: `sha256:${digest}` },
    ];
    response.end(JSON.stringify({ tag_name: 'v1.1.0', zipball_url: url, assets }));
  });
  await new Promise<void>((done) => github.listen(0, '127.0.0.1', done));
  const api = `http://127.0.0.1:${(github.address() as AddressInfo).port}`;
  const plugins = new Plugins(directory, undefined, undefined, api);
  t.after(() => {
    github.closeAllConnections();
    github.close();
    plugins.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  await plugins.start();
  await plugins.install(readArchive(pack('t.notify', '1.0.0')));
  await plugins.checkAll();
  assert.equal(plugins.list()[0]!.newer, '1.1.0');
  archive = pack('t.notify', '1.2.0');
  await assert.rejects(plugins.download('t.notify'), /校验失败/);
  archive = pack('t.notify', '1.1.0');
  await plugins.install(await plugins.download('t.notify'));
  assert.equal(plugins.list()[0]!.newer, undefined);
  await plugins.check('t.notify');
  assert.equal(plugins.list()[0]!.newer, undefined);
  moved = true;
  await assert.rejects(plugins.check('t.notify'), /改名或转手/);
  await plugins.checkAll(Date.now() + 3600_000);
  assert.match(plugins.logOf('t.notify'), /检查更新：.*改名或转手/);
});

test('a third plugin that wants a button is not enabled while two have one', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'cc-desk-tunnel-plugins-'));
  const add = (name: string, ui: string) => {
    const root = join(directory, 'plugins', name);
    mkdirSync(join(root, 'hooks'), { recursive: true });
    writeFileSync(join(root, 'hooks', 'hooks.json'), '{"hooks":{}}');
    writeFileSync(join(root, 'a.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    writeFileSync(join(root, 'ui.mjs'), ui);
  };
  const button =
    "export const slots = { composer: { title: 'B', initial: 'a', states: { a: { icon: 'a.svg', title: 'A' } }, on: {} } };";
  agree(directory, 't.b', 't.c', 't.d', 't.none');
  for (const id of ['t.b', 't.c', 't.d']) add(id, button);
  add('t.none', 'export const settings = [];');
  const plugins = new Plugins(directory);
  t.after(() => {
    plugins.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const enabled = () => plugins.list().flatMap(({ id, enabled }) => (enabled ? [id] : []));
  await plugins.start();
  assert.deepEqual(enabled(), ['t.b', 't.c', 't.none']);
  assert.match(plugins.list()[2]!.problem!, /输入框插槽已被“t\.b”“t\.c”占用/);
  await assert.rejects(plugins.enable('t.d', true), /输入框插槽已被“t\.b”“t\.c”占用/);
  await plugins.enable('t.c', false);
  assert.equal(plugins.list()[2]!.problem, undefined);
  await plugins.enable('t.d', true);
  // Those that have one keep it, whatever their names.
  await assert.rejects(plugins.enable('t.c', true), /输入框插槽已被“t\.b”“t\.d”占用/);
  assert.deepEqual(enabled(), ['t.b', 't.d', 't.none']);
});

test('a plugin that is not confined runs once the user enabled it, and one that an update makes so is asked about anew', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'cc-desk-tunnel-plugins-'));
  const add = (id: string, permissions: string[]) => {
    const root = join(directory, 'plugins', id);
    mkdirSync(join(root, '.claude-plugin'), { recursive: true });
    mkdirSync(join(root, 'hooks'), { recursive: true });
    writeFileSync(join(root, 'hooks', 'hooks.json'), '{"hooks":{}}');
    writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ id, permissions }));
  };
  add('t.full', ['full']);
  add('t.grows', []);
  const plugins = new Plugins(directory);
  t.after(() => {
    plugins.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const shown = (at: number) => {
    const { enabled, problem } = plugins.list()[at]!;
    return [enabled, problem];
  };
  await plugins.start();
  assert.deepEqual(shown(0), [false, '它要完整权限，由你启用。']);
  await plugins.enable('t.full', true);
  assert.deepEqual(shown(0), [true, undefined]);
  if (!(await confinable())) return;
  assert.deepEqual(shown(1), [true, undefined]);
  add('t.grows', ['full']);
  for (const deadline = Date.now() + 5000; shown(1)[0] && Date.now() < deadline;)
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(shown(1), [false, '它要完整权限，由你启用。']);
});

test('a confined plugin reaches its own files and nothing else of the service', async (t) => {
  if (!(await confinable())) return t.skip('This system cannot confine a plugin.');
  const directory = mkdtempSync(join(tmpdir(), 'cc-desk-tunnel-plugins-'));
  const root = join(directory, 'plugins', 't.own');
  mkdirSync(join(root, 'hooks'), { recursive: true });
  writeFileSync(join(directory, 'secret'), 'secret', { mode: 0o600 });
  const socket = createServer().listen(join(directory, 'socket'));
  // What it leaves running does not get to write.
  const late = '(sleep 0.5; touch $CLAUDE_PLUGIN_DATA/late)';
  const hook = {
    type: 'command',
    command: `node --no-warnings tries.mjs; setsid sh -c '${late}' > /dev/null 2>&1 &`,
  };
  writeFileSync(
    join(root, 'hooks', 'hooks.json'),
    JSON.stringify({ hooks: { RunEnded: [{ hooks: [hook] }] } }),
  );
  writeFileSync(
    join(root, 'tries.mjs'),
    `import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
const python = (code) => execFileSync('python3', ['-c', code], { encoding: 'utf8', stdio: 'pipe' }).trim();
const site = python('import site; print(site.getusersitepackages())');
mkdirSync(site, { recursive: true });
writeFileSync(site + '/usercustomize.py', 'open("${directory}/loaded", "w")');
chmodSync('../../secret', 0);
const tries = {
  data: () => writeFileSync(process.env.CLAUDE_PLUGIN_DATA + '/a', readFileSync('tries.mjs')),
  itself: () => writeFileSync('tries.mjs', ''),
  secret: () => readFileSync('../../secret'),
  others: () => readdirSync('..'),
  environment: () => readFileSync('/proc/' + process.ppid + '/environ'),
  socket: () => python('import socket; socket.socket(socket.AF_UNIX).connect("../../socket")'),
};
for (const [name, go] of Object.entries(tries)) {
  try { go(); console.log(name); } catch {}
}`,
  );
  writeFileSync(
    join(root, 'ui.ts'),
    `import { readFileSync } from 'node:fs';
export const settings = [{ title: 'A', fields: {
  a: { type: 'button', title: 'A', run: () => ({ ok: true, message: String(readFileSync('../../secret')) }) } } }];`,
  );
  const plugins = new Plugins(directory);
  t.after(() => {
    plugins.close();
    socket.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await plugins.start();
  const log = join(directory, 'plugin-logs', 't.own.log');
  // Twice: what it left in its home directory the first time is not loaded outside its confines.
  for (const expected of [/→ 成功 \d+ms\n    data\n$/, /(→ 成功 \d+ms\n    data\n.*){2}$/]) {
    plugins.dispatch({
      version: EVENTS_VERSION,
      hook_event_name: 'RunEnded',
      timestamp: new Date().toISOString(),
    });
    const said = () => (existsSync(log) ? readFileSync(log, 'utf8') : '');
    for (const deadline = Date.now() + 10_000; !expected.test(said()) && Date.now() < deadline;)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.match(said(), expected);
  }
  assert.equal(statSync(join(directory, 'secret')).mode & 0o777, 0o600);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  for (const path of ['loaded', 'plugin-data/t.own/late'])
    assert.ok(!existsSync(join(directory, path)), path);
  assert.match((await plugins.press('t.own', 'a', {})).message, /EACCES/);
});

test('every wait is resolved by the end of its run, and a failed run says why and how the quota stands', () => {
  const heard: ServiceEvent[] = [];
  const window = { name: 'five_hour', utilization: 42, resetsAt: '2026-11-25T08:00:00.000Z' };
  const quota = { rateLimits: { available: true, windows: [window] } };
  const device = { id: randomUUID(), name: '电脑' };
  const session = { id: randomUUID(), title: '会话', projectPath: 'D:\\p', device } as Session;
  const events = new ServiceEvents(
    () => ({ session, metrics: null, quota }),
    () => true,
    (event) => heard.push(event),
  );
  const connectionId = randomUUID();
  const observe = (runId: string, payload: EventPayload) =>
    events.observe({
      sessionId: session.id,
      runId,
      sequence: 1,
      createdAt: new Date().toISOString(),
      payload,
    });
  const [run, terminal, approvalId] = [randomUUID(), randomUUID(), randomUUID()];
  observe(run, {
    type: 'tool.requested',
    toolId: 't',
    name: 'AskUserQuestion',
    input: '{}',
    target: 'Linux',
  });
  observe(run, { type: 'approval.requested', approvalId, toolId: 't' });
  observe(run, { type: 'run.status', status: 'running', waiting: 'background', connectionId });
  observe(run, { type: 'run.status', status: 'cancelled', reason: '用户停止', connectionId });
  // Recorded after the run: its wait is resolved already.
  observe(run, { type: 'approval.resolved', approvalId, allowed: false });
  for (const activity of ['waiting', 'working'] as const)
    observe(terminal, {
      type: 'run.status',
      status: 'running',
      surface: 'terminal',
      activity,
      connectionId,
    });
  assert.deepEqual(
    heard.map((event) => [event.hook_event_name, event.wait_id ?? event.status]),
    [
      ['QuestionAsked', approvalId],
      ['BackgroundOnly', undefined],
      ['WaitResolved', approvalId],
      ['RunEnded', 'cancelled'],
      ['TerminalWaiting', terminal],
      ['WaitResolved', terminal],
    ],
  );
  const failing = randomUUID();
  observe(failing, { type: 'run.error', code: 'cli_process_failed', message: 'boom' });
  observe(failing, { type: 'run.status', status: 'failed', connectionId });
  const ended = heard.at(-1)!;
  assert.deepEqual(ended.device, { ...device, platform: 'win32' });
  assert.deepEqual(ended.error, { code: 'cli_process_failed', message: 'boom' });
  assert.deepEqual(ended.quota, [
    { name: window.name, utilization: 42, resets_at: window.resetsAt },
  ]);
});

test('an event is not made while no plugin is there, and one that cannot be made leaves the run alone', (t) => {
  let wanted = false;
  let asked = 0;
  const events = new ServiceEvents(
    () => {
      asked++;
      throw new Error('no such session');
    },
    () => wanted,
    () => assert.fail('nothing to emit'),
  );
  const failed = {
    sessionId: randomUUID(),
    runId: randomUUID(),
    sequence: 1,
    createdAt: new Date().toISOString(),
    payload: { type: 'run.error', code: 'c', message: 'm' } as const,
  };
  t.mock.method(console, 'error', () => {});
  events.observe(failed);
  assert.equal(asked, 0);
  wanted = true;
  events.observe(failed);
  assert.equal(asked, 1);
});
