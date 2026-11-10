import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import {
  NativeTerminal,
  programStatus,
  terminalArguments,
  terminalEnvironment,
} from '../src/native-terminal.ts';
import { completeOnboarding } from '../src/native-onboarding.ts';
import { nativeContext } from '../src/claude.ts';
import { SessionStore } from '../src/store.ts';
import { NativeLogin, parseAccountStatus } from '../src/native-account.ts';
import { loginExpiryWarnings } from '../src/login-expiry.ts';
import type { TerminalSpawner } from '../src/native-terminal.ts';
import type { Session, TerminalActivity } from '@cc-desk-tunnel/protocol';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function fixture(screen?: { detached: () => void }, status?: (activity: TerminalActivity) => void) {
  let onData!: (text: string) => void, onExit!: (event: { exitCode: number }) => void;
  let paused = 0,
    resumed = 0,
    killed = 0;
  const input: string[] = [],
    sizes: number[][] = [],
    output: { text: string; bytes: number }[] = [];
  const spawn: TerminalSpawner = () => ({
    pid: 2147483647,
    onData(listener) {
      onData = listener;
      return { dispose() {} };
    },
    onExit(listener) {
      onExit = listener;
      return { dispose() {} };
    },
    write(text) {
      input.push(String(text));
    },
    resize(cols, rows) {
      sizes.push([cols, rows]);
    },
    pause() {
      paused++;
    },
    resume() {
      resumed++;
    },
    kill() {
      killed++;
      queueMicrotask(() => onExit({ exitCode: 0 }));
    },
  });
  const terminal = new NativeTerminal(
    'claude',
    [],
    { cwd: '.', cols: 80, rows: 24, env: {}, ...(screen ? { screen } : {}), status },
    (text, bytes) => output.push({ text, bytes }),
    () => {},
    spawn,
  );
  return {
    terminal,
    output,
    input,
    sizes,
    data: (text: string) => onData(text),
    counts: () => ({ paused, resumed, killed }),
  };
}

test('native terminal forwards exact UTF-8 data with bounded frames and pauses until rendering is acknowledged', async () => {
  const f = fixture();
  const text = '中文🙂'.repeat(20000);
  f.data(text);
  assert.equal(f.output.map((frame) => frame.text).join(''), text);
  assert.ok(
    f.output.every((frame) => frame.bytes === Buffer.byteLength(frame.text) && frame.bytes < 65536),
  );
  assert.equal(f.counts().paused, 1);
  assert.throws(() => f.terminal.acknowledge(f.terminal.outstanding + 1), /Invalid/);
  f.terminal.acknowledge(f.terminal.outstanding);
  assert.equal(f.counts().resumed, 1);
  f.terminal.write('/config\r');
  f.terminal.resize(80, 24);
  f.terminal.resize(100, 35);
  f.terminal.resize(100, 35);
  assert.deepEqual(f.input, ['/config\r']);
  assert.deepEqual(f.sizes, [[100, 35]]);
  await f.terminal.close();
  f.data('late');
  assert.equal(f.counts().killed, 1);
  assert.equal(f.output.map((frame) => frame.text).join(''), text);
});

// As CLI 2.1.321 reports itself through OSC 7501 once its question is answered: idle at start, working on a prompt,
// idle when the user stops the turn, done when it ends.
test("a terminal answers the CLI's OSC 7501 question for the client and reads what the CLI reports", async () => {
  const heard: TerminalActivity[] = [];
  const f = fixture(undefined, (activity) => heard.push(activity));
  f.data('\x1b[c\x1b]7501;?\x1b\\\x1b[>0q');
  assert.deepEqual(f.input, ['\x1b]7501;?\x1b\\']);
  f.data('\x1b]7501;state=idle:app=claude-code\x1b\\screen');
  f.data('\x1b]7501;state=working:app=claude-code:msg=');
  f.data('Q3J1bmNoaW5n\x1b\\');
  f.data('\x1b]7501;state=working:app=claude-code:progress=50\x1b\\');
  f.data('\x1b]7501;state=working:app=claude-code:id=task-1\x1b\\');
  f.data('\x1b]7501;state=blocked:app=claude-code:kind=permission\x1b\\');
  f.data('\x1b]7501;state=idle:app=claude-code\x07');
  f.data('\x1b]7501;state=done:app=claude-code\x1b\\');
  assert.deepEqual(heard, ['idle', 'working', 'waiting', 'idle']);
  assert.equal(programStatus('state=blocked:app=claude-code:kind=auth'), 'idle');
  assert.equal(programStatus('state=error:app=claude-code'), 'idle');
  assert.equal(
    programStatus('state=blocked:app=claude-code'),
    undefined,
    "a dialog of the CLI's own",
  );
  assert.equal(programStatus('state=clear'), undefined);
  assert.equal(programStatus('state=working:app=other'), undefined);
  await delay(20);
  const shown = f.output.map((frame) => frame.text).join('');
  assert.ok(shown.startsWith('\x1b[c\x1b[>0q'), 'the question is not passed on; the rest is');
  assert.ok(shown.includes('\x1b]7501;state=done:app=claude-code\x1b\\'), 'reports are');
  await f.terminal.close();
});

test('a terminal that keeps running shows its current screen to a client that attaches, then the live output', async () => {
  let detached = 0;
  const f = fixture({ detached: () => detached++ });
  f.data('\x1b[?1049h\x1b[>1u第一屏');
  // A small write is gathered for a few milliseconds before it goes.
  assert.equal(f.output.length, 0);
  await delay(20);
  f.terminal.detach();
  f.data('\r\n看不到的时候');
  assert.deepEqual(
    f.output.map((frame) => frame.text),
    ['\x1b[?1049h\x1b[>1u第一屏'],
  );
  f.output.length = 0;
  await f.terminal.attach(100, 30);
  assert.deepEqual(f.sizes, [[100, 30]]);
  const [snapshot] = f.output;
  assert.ok(snapshot.text.startsWith('\x1b[?25h'));
  assert.ok(snapshot.text.includes('第一屏') && snapshot.text.includes('看不到的时候'));
  assert.ok(snapshot.text.includes('\x1b[>1u'));
  f.data('之后');
  f.data('，再之后');
  await delay(20);
  assert.equal(f.output.at(-1)!.text, '之后，再之后');
  // Acknowledgments of what was sent before an attach may still come; they do not fail the terminal.
  f.terminal.acknowledge(10 ** 6);
  assert.equal(f.terminal.outstanding, 0);
  assert.equal(detached, 0);
  await f.terminal.close();
});

test('a terminal launches the official CLI directly with remote guidance and no shell, MCP or bypass', () => {
  const own = {
    resume: true,
    settingsPath: '/t.json',
    execution: { platform: 'win32' as const, shells: ['pwsh' as const] },
  };
  const args = terminalArguments(
    { executable: '/native/claude', model: 'provider', settingsPath: '/private/provider.json' },
    {
      id: '11111111-2222-4333-8444-555555555555',
      projectPath: 'D:\\项目',
      permissionMode: 'auto',
      model: null,
      effort: 'high',
    } as Session,
    { configPath: '/private/ssh.conf' },
    own,
  );
  assert.ok(args.includes('--append-system-prompt'));
  assert.ok(args.some((arg) => arg.includes('D:\\\\项目')));
  assert.ok(args.some((arg) => arg.includes('ssh device-pwsh')));
  assert.ok(args.includes('provider'));
  assert.ok(args.includes('high'));
  assert.ok(
    !args.some((arg) => arg.includes('bypass') || arg.includes('mcp') || arg.includes('sdk-ts')),
  );
  const mode = (permissionMode: Session['permissionMode']) => {
    const launched = terminalArguments(
      { executable: 'claude' },
      { id: 's', projectPath: 'D:\\test', permissionMode } as Session,
      { configPath: '/ssh' },
      own,
    );
    return launched[launched.indexOf('--permission-mode') + 1];
  };
  assert.equal(mode('default'), 'manual');
  assert.equal(mode('bypassPermissions'), 'bypassPermissions');
});

test('a terminal resumes its session or creates it under the session ID, with its own settings', () => {
  const session = {
    id: '11111111-2222-4333-8444-555555555555',
    projectPath: 'D:\\test',
    permissionMode: 'auto',
  } as Session;
  const options = { executable: 'claude', settingsPath: '/private/provider.json' };
  const execution = { platform: 'win32' as const, shells: ['pwsh' as const] };
  const resumed = terminalArguments(
    options,
    session,
    { configPath: '/ssh' },
    { resume: true, settingsPath: '/t.json', execution },
  );
  assert.deepEqual(resumed.slice(0, 2), ['--resume', session.id]);
  assert.deepEqual(resumed.slice(-2), ['--settings', '/t.json']);
  assert.ok(!resumed.includes('/private/provider.json'));
  const created = terminalArguments(options, session, undefined, {
    resume: false,
    settingsPath: '/t.json',
    execution,
  });
  assert.deepEqual(created.slice(0, 2), ['--session-id', session.id]);
});

test('a terminal never passes for an SDK process, whatever the service inherited', () => {
  const env = terminalEnvironment(
    { executable: 'claude', environment: { CLAUDE_AGENT_SDK_VERSION: '0.3.286' } },
    { CLAUDE_CODE_ENTRYPOINT: 'sdk-ts', CLAUDE_AGENT_SDK_CLIENT_APP: 'x', LANG: 'C.UTF-8' },
  );
  assert.deepEqual(Object.keys(env).sort(), ['LANG', 'TERM']);
});

test("a terminal's CLI finds the session's ssh before the service's", () => {
  const ssh = { configPath: '/data/session-ssh/s/config', bin: '/data/session-ssh/s/bin' };
  const env = terminalEnvironment({ executable: 'claude' }, { PATH: '/usr/bin' }, ssh);
  assert.equal(
    env.PATH,
    `/data/session-ssh/s/bin${process.platform === 'win32' ? ';' : ':'}/usr/bin`,
  );
  assert.equal(
    terminalEnvironment({ executable: 'claude' }, { PATH: '/usr/bin' }).PATH,
    '/usr/bin',
  );
});

test('terminal provider environment stays inside the child process and does not mutate the proxy', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'cc-desk-tunnel-terminal-env-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const settingsPath = join(directory, 'provider.json');
  writeFileSync(
    settingsPath,
    JSON.stringify({ env: { TEST_PROVIDER: 'private-value', INVALID: 5 }, unrelated: 'ignored' }),
  );
  const inherited = { LANG: 'C.UTF-8', TEST_PROVIDER: 'old-value' };
  const env = terminalEnvironment({ executable: 'claude', settingsPath }, inherited);
  assert.equal(env.TEST_PROVIDER, 'private-value');
  assert.equal(env.LANG, 'C.UTF-8');
  assert.equal(env.TERM, 'xterm-256color');
  assert.equal(env.INVALID, undefined);
  assert.equal(inherited.TEST_PROVIDER, 'old-value');
});

test('a signed-in account skips the first-run wizard; a signed-out one keeps it', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'cc-desk-tunnel-onboarding-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const statePath = join(directory, '.claude.json');
  writeFileSync(
    statePath,
    JSON.stringify({ userID: 'kept', oauthAccount: { emailAddress: 'user@example.invalid' } }),
  );
  assert.equal(completeOnboarding(directory), false);
  assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).hasCompletedOnboarding, undefined);

  writeFileSync(
    join(directory, '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: 'placeholder' } }),
  );
  assert.equal(completeOnboarding(directory), true);
  assert.deepEqual(JSON.parse(readFileSync(statePath, 'utf8')), {
    userID: 'kept',
    oauthAccount: { emailAddress: 'user@example.invalid' },
    hasCompletedOnboarding: true,
  });
  assert.equal(completeOnboarding(directory), false);
});

test('official sign-in: the link is read from the command output, the pasted code is typed back, exit decides the result', async () => {
  let data!: (text: string) => void, exit!: (event: { exitCode: number; signal?: number }) => void;
  const written: string[] = [];
  let launched: string[] = [];
  const spawn: TerminalSpawner = (_file, args) => {
    launched = args;
    return {
      pid: 1,
      onData: (listener) => {
        data = listener;
        return { dispose() {} };
      },
      onExit: (listener) => {
        exit = listener;
        return { dispose() {} };
      },
      write: (text: string) => {
        written.push(text);
      },
      resize() {},
      pause() {},
      resume() {},
      kill() {},
    };
  };
  let result: boolean | undefined;
  const replies: string[] = [];
  const login = new NativeLogin(
    'claude',
    (succeeded) => {
      result = succeeded;
    },
    (text) => {
      replies.push(text);
    },
    spawn,
  );
  assert.deepEqual(launched, ['auth', 'login']);
  data(
    "Opening browser to sign in…\r\nIf the browser didn't open, visit: \x1b]8;;https://claude.com/cai/oauth/authorize?code=true&sta",
  );
  data('te=abc\x07https://claude.com/cai/oauth/authorize?code=true&sta');
  data('te=abc\x1b]8;;\x07\r\nPaste code here if prompted > ');
  assert.equal(await login.url, 'https://claude.com/cai/oauth/authorize?code=true&state=abc');
  login.submit('wrong');
  data(
    'wrong\r\nInvalid code. Please make sure the full code was copied.\r\nPaste code here if prompted > ',
  );
  await delay(500);
  assert.deepEqual(replies, ['Invalid code. Please make sure the full code was copied.']);
  login.submit('code#state');
  assert.deepEqual(written, ['wrong\r', 'code#state\r']);
  exit({ exitCode: 0 });
  assert.equal(result, true);

  assert.deepEqual(
    parseAccountStatus(
      '{"loggedIn":true,"authMethod":"claude.ai","email":"user@example.invalid","orgName":"Org","orgId":"x","subscriptionType":"pro"}',
    ),
    {
      loggedIn: true,
      authMethod: 'claude.ai',
      email: 'user@example.invalid',
      organization: 'Org',
      subscriptionType: 'pro',
    },
  );
  assert.deepEqual(parseAccountStatus('{"loggedIn":false,"authMethod":"none"}'), {
    loggedIn: false,
    authMethod: 'none',
  });
  // CLI 2.1.318 and later say when a stored claude.ai sign-in ends.
  assert.equal(
    parseAccountStatus('{"loggedIn":true,"loginExpiresAt":"2026-12-01T00:00:00.000Z"}')
      .loginExpiresAt,
    '2026-12-01T00:00:00.000Z',
  );
  assert.equal(
    parseAccountStatus('{"loggedIn":true,"loginExpiresAt":null}').loginExpiresAt,
    undefined,
  );
});

test('a sign-in about to end is told in the conversation once a day, from ten days before', () => {
  const warn = loginExpiryWarnings();
  const now = Date.parse('2026-11-10T08:00:00Z');
  assert.equal(warn('2026-12-01T00:00:00Z', now), null);
  assert.equal(warn(undefined, now), null);
  assert.match(warn('2026-11-15T00:00:00Z', now) ?? '', /约 5 天后到期（2026-11-15）/);
  assert.equal(warn('2026-11-15T00:00:00Z', now + 3_600_000), null, 'once a day');
  assert.match(warn('2026-11-09T00:00:00Z', now + 86_400_000) ?? '', /可能已经到期/);
});

// A long terminal fills the page of history a client opens the session with, leaving out what a chat run said of
// the native session before it; the terminal says it again as it ends, or compacting would not be offered.
test('a terminal that ends says the native session is on record, in the page a client opens the session with', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'cc-desk-tunnel-context-'));
  const store = new SessionStore(directory);
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const session = store.create(randomUUID(), '会话', 'D:\\项目', {
    id: randomUUID(),
    name: '台式机',
  });
  const info = {
    sessionId: session.id,
    summary: '',
    lastModified: Date.parse('2026-11-04T08:00:00Z'),
  };
  store.append(session.id, randomUUID(), nativeContext(session.id, info as never));
  const terminal = randomUUID();
  for (let index = 0; index < 1200; index++)
    store.append(session.id, terminal, { type: 'native.notice', text: `第 ${index} 行` });
  const opened = () =>
    store
      .history(session.id, randomUUID())
      .events.filter(({ payload }) => payload.type === 'native.context');
  assert.equal(opened().length, 0);
  store.append(session.id, randomUUID(), nativeContext(session.id, info as never));
  assert.deepEqual(opened().at(-1)?.payload, {
    type: 'native.context',
    nativeSessionId: session.id,
    persisted: true,
    updatedAt: '2026-11-04T08:00:00.000Z',
  });
  assert.equal(nativeContext(session.id, undefined).persisted, false);
});
