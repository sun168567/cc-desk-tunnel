import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { NativeTerminal, terminalArguments, terminalEnvironment } from '../src/native-terminal.ts';
import { completeOnboarding } from '../src/native-onboarding.ts';
import { NativeLogin, parseAccountStatus } from '../src/native-account.ts';
import type { TerminalSpawner } from '../src/native-terminal.ts';
import type { Session } from '@cc-desk-tunnel/protocol';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function fixture(screen?: { detached: () => void }) {
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
    { cwd: '.', cols: 80, rows: 24, env: {}, ...(screen ? { screen } : {}) },
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

test('a terminal that keeps running shows its current screen to a client that attaches, then the live output', async () => {
  let detached = 0;
  const f = fixture({ detached: () => detached++ });
  f.data('\x1b[?1049h\x1b[>1u第一屏');
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
  assert.equal(f.output.at(-1)!.text, '之后');
  // Acknowledgments of what was sent before an attach may still come; they do not fail the terminal.
  f.terminal.acknowledge(10 ** 6);
  assert.equal(f.terminal.outstanding, 0);
  assert.equal(detached, 0);
  await f.terminal.close();
});

test('control terminal launches the official CLI directly with remote guidance and no shell, MCP or bypass', () => {
  const args = terminalArguments(
    { executable: '/native/claude', model: 'provider', settingsPath: '/private/provider.json' },
    { projectPath: 'D:\\项目', permissionMode: 'auto', model: null, effort: 'high' } as Session,
    { configPath: '/private/ssh.conf' },
  );
  assert.ok(args.includes('--append-system-prompt'));
  assert.ok(args.some((arg) => arg.includes('D:\\\\项目')));
  assert.ok(args.includes('provider'));
  assert.ok(args.includes('high'));
  assert.ok(!args.includes('--resume') && !args.includes('--session-id'));
  assert.ok(
    !args.some((arg) => arg.includes('bypass') || arg.includes('mcp') || arg.includes('sdk-ts')),
  );
  assert.equal(
    terminalArguments(
      { executable: 'claude' },
      { projectPath: 'D:\\test', permissionMode: 'default' } as Session,
      { configPath: '/ssh' },
    )[1],
    'manual',
  );
  assert.equal(
    terminalArguments(
      { executable: 'claude' },
      { projectPath: 'D:\\test', permissionMode: 'bypassPermissions' } as Session,
      { configPath: '/ssh' },
    )[1],
    'bypassPermissions',
  );
});

test('a terminal that continues its session resumes or creates it under the session ID, with its own settings', () => {
  const session = {
    id: '11111111-2222-4333-8444-555555555555',
    projectPath: 'D:\\test',
    permissionMode: 'auto',
  } as Session;
  const options = { executable: 'claude', settingsPath: '/private/provider.json' };
  const resumed = terminalArguments(
    options,
    session,
    { configPath: '/ssh' },
    { resume: true, settingsPath: '/t.json' },
  );
  assert.deepEqual(resumed.slice(0, 2), ['--resume', session.id]);
  assert.deepEqual(resumed.slice(-2), ['--settings', '/t.json']);
  assert.ok(!resumed.includes('/private/provider.json'));
  const created = terminalArguments(options, session, undefined, {
    resume: false,
    settingsPath: '/t.json',
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
});
