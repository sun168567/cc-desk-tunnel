import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { configureSetupToken, NativeLogin } from '../src/native-account.ts';
import type { TerminalSpawner } from '../src/native-terminal.ts';
import { setTimeout as delay } from 'node:timers/promises';
import { readNativeSettings, updateNativeSettings } from '../src/native-settings.ts';

test('setup token uses the CLI user settings, stays private and is removed without changing other settings', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'ccdt-account-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'settings.json');
  configureSetupToken(null, path);
  assert.equal(existsSync(path), false, 'ordinary logout does not create a settings file');
  writeFileSync(
    path,
    JSON.stringify({ env: { KEEP: 'yes' }, permissions: { allow: ['Read'] }, language: 'chinese' }),
  );
  const token = 'test-only-setup-token';
  configureSetupToken(token, path);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), {
    env: { KEEP: 'yes', CLAUDE_CODE_OAUTH_TOKEN: token },
    permissions: { allow: ['Read'] },
    language: 'chinese',
  });
  if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(JSON.stringify(readNativeSettings(path)).includes(token), false);
  updateNativeSettings({ fastMode: true }, path);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).env.CLAUDE_CODE_OAUTH_TOKEN, token);
  configureSetupToken(null, path);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), {
    env: { KEEP: 'yes' },
    permissions: { allow: ['Read'] },
    language: 'chinese',
    fastMode: true,
  });
  writeFileSync(path, '{}');
  configureSetupToken(token, path);
  configureSetupToken(null, path);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), {});
});

test('setup-token uses the official command, extracts its successful output and never forwards the secret', async () => {
  let data!: (text: string) => void, end!: (event: { exitCode: number }) => void;
  let args: string[] = [];
  const written: string[] = [],
    notices: string[] = [];
  const spawn: TerminalSpawner = (_file, command) => {
    args = command;
    return {
      pid: 1,
      onData: (listener) => {
        data = listener;
        return { dispose() {} };
      },
      onExit: (listener) => {
        end = listener;
        return { dispose() {} };
      },
      write: (text) => written.push(text.toString()),
      resize() {},
      pause() {},
      resume() {},
      kill() {
        end({ exitCode: 1 });
      },
    };
  };
  let result: { succeeded: boolean; token?: string } | undefined;
  const login = new NativeLogin(
    'claude',
    (succeeded, token) => {
      result = { succeeded, token };
    },
    (text) => notices.push(text),
    { method: 'setup-token', spawn },
  );
  assert.deepEqual(args, ['setup-token']);
  data('Sign in at: https://claude.ai/oauth/authorize?fixture=true\r\n');
  assert.equal(await login.url, 'https://claude.ai/oauth/authorize?fixture=true');
  login.submit('code#state');
  assert.deepEqual(written, ['code#state\r']);
  data('Your OAuth token (valid for 1 year):\r\n\x1b[33msk-ant-oat01-te');
  data('st\x1b[0m\r\nStore this token securely.\r\n');
  await delay(450);
  assert.equal(notices.length, 0);
  end({ exitCode: 0 });
  assert.deepEqual(result, { succeeded: true, token: 'sk-ant-oat01-test' });

  const failure = new NativeLogin(
    'claude',
    (succeeded) => {
      result = { succeeded };
    },
    (text) => notices.push(text),
    { method: 'setup-token', spawn },
  );
  data('https://claude.ai/oauth/authorize?fixture=true\r\n');
  await failure.url;
  failure.submit('bad');
  data(
    'OAuth error: Invalid code. Please make sure the full code was copied\r\nPress Enter to retry.\r\n',
  );
  assert.deepEqual(result, { succeeded: false });
  assert.equal(notices.length, 0);
});
