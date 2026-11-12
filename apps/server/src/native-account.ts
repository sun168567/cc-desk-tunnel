import { execFile } from 'node:child_process';
import { spawn as spawnPty } from 'node-pty';
import type { AccountState } from '@cc-desk-tunnel/protocol';
import { definedEnvironment } from './native-terminal.ts';
import type { TerminalSpawner } from './native-terminal.ts';
import { readSettingsFile, settingsPath, writeSettingsFile } from './native-settings.ts';

type Account = Omit<AccountState, 'login' | 'notice'>;
// Terminal hyperlink (OSC) and styling (CSI) sequences; only the visible text is read.
const controlSequences = /\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b\[[0-9;?]*[A-Za-z]/g;

// Sign-in state comes from the official `claude auth` commands. A setup token is a CLI setting, not an entry in
// its private credential store; auth status reports it as configured even before a request verifies it.
export function parseAccountStatus(output: string): Account {
  const status = JSON.parse(output);
  return {
    loggedIn: status.loggedIn === true,
    ...(typeof status.authMethod === 'string' && { authMethod: status.authMethod }),
    ...(typeof status.email === 'string' && { email: status.email }),
    ...(typeof status.orgName === 'string' && { organization: status.orgName }),
    ...(typeof status.subscriptionType === 'string' && {
      subscriptionType: status.subscriptionType,
    }),
    ...(typeof status.loginExpiresAt === 'string' &&
      Number.isFinite(Date.parse(status.loginExpiresAt)) && {
        loginExpiresAt: status.loginExpiresAt,
      }),
  };
}
function run(executable: string, args: string[]) {
  return new Promise<{ code: number | null; stdout: string }>((resolve) => {
    // `auth status` exits 1 when signed out and still prints its JSON.
    execFile(executable, args, { env: process.env, timeout: 20000 }, (error, stdout) =>
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : null) : 0, stdout }),
    );
  });
}
export async function accountStatus(executable: string) {
  return parseAccountStatus((await run(executable, ['auth', 'status', '--json'])).stdout);
}
export async function accountLogout(executable: string) {
  if ((await run(executable, ['auth', 'logout'])).code !== 0) throw new Error('Logout failed');
  // Official logout clears stored sign-ins, but leaves tokens supplied through settings.env in effect.
  configureSetupToken(null);
}

export function configureSetupToken(token: string | null, path = settingsPath()) {
  const file = readSettingsFile(path);
  const env = { ...(file.env as Record<string, string> | undefined) };
  if (token === null) {
    if (!Object.hasOwn(env, 'CLAUDE_CODE_OAUTH_TOKEN')) return;
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
  } else env.CLAUDE_CODE_OAUTH_TOKEN = token;
  if (Object.keys(env).length) file.env = env;
  else delete file.env;
  writeSettingsFile(file, path);
}

// Both official commands print an authorization link and accept the code the browser page shows.
export class NativeLogin {
  url: Promise<string>;
  readonly method: 'browser' | 'setup-token';
  private process: ReturnType<TerminalSpawner>;
  private output = '';
  private timer: ReturnType<typeof setTimeout>;
  private submitted?: { code: string; reply: string; timer?: ReturnType<typeof setTimeout> };
  cancelled = false;
  // `reply` carries what the command prints after a code and keeps waiting, such as its invalid-code message.
  constructor(
    executable: string,
    exit: (succeeded: boolean, token?: string) => void,
    reply: (text: string) => void = () => {},
    options: {
      method?: 'browser' | 'setup-token';
      spawn?: TerminalSpawner;
      timeoutMs?: number;
    } = {},
  ) {
    this.method = options.method ?? 'browser';
    let found!: (url: string) => void, failed!: (error: Error) => void;
    this.url = new Promise((resolve, reject) => {
      found = resolve;
      failed = reject;
    });
    this.url.catch(() => {});
    // A wide terminal keeps the link on one line.
    this.process = (options.spawn ?? spawnPty)(
      executable,
      this.method === 'setup-token' ? ['setup-token'] : ['auth', 'login'],
      {
        cwd: process.cwd(),
        cols: 4000,
        rows: 24,
        env: { ...definedEnvironment(process.env), TERM: 'dumb' },
        name: 'dumb',
      },
    );
    this.timer = setTimeout(
      () => {
        try {
          this.process.kill();
        } catch {}
      },
      options.timeoutMs ?? 10 * 60 * 1000,
    );
    this.process.onData((text) => {
      this.output = (this.output + text).slice(-16384);
      const link = /https:\/\/[^\s\x00-\x1f]+(?=\s)/.exec(
        this.output.replace(controlSequences, ''),
      );
      if (link) found(link[0]);
      // setup-token renders its secret in the terminal. Never forward that terminal output as a notice.
      // Its Ink error screen waits for a key to retry; end this attempt and let the user request a fresh link.
      if (this.method === 'setup-token') {
        if (this.output.replace(controlSequences, '').includes('OAuth error:')) this.process.kill();
        return;
      }
      const submitted = this.submitted;
      if (!submitted) return;
      submitted.reply += text;
      clearTimeout(submitted.timer);
      submitted.timer = setTimeout(() => {
        const lines = submitted.reply
          .replace(controlSequences, '')
          .split(/[\r\n]+/)
          .map((line) =>
            line
              .replace(/^Paste code here if prompted >/, '')
              .replace(submitted.code, '')
              .trim(),
          )
          .filter(Boolean);
        submitted.reply = '';
        if (lines.length) reply(lines.join(' ').slice(0, 300));
      }, 400);
    });
    this.process.onExit(({ exitCode }) => {
      clearTimeout(this.timer);
      clearTimeout(this.submitted?.timer);
      failed(new Error('Login command exited before printing a link'));
      const token =
        this.method === 'setup-token'
          ? /Your OAuth token[^\n]*\r?\n\s*(sk-ant-oat01-[A-Za-z0-9_-]+)(?=\s)/.exec(
              this.output.replace(controlSequences, ''),
            )?.[1]
          : undefined;
      this.output = '';
      exit(exitCode === 0 && (this.method === 'browser' || !!token), token);
    });
  }
  submit(code: string) {
    clearTimeout(this.submitted?.timer);
    this.submitted = { code, reply: '' };
    this.process.write(`${code}\r`);
  }
  cancel() {
    this.cancelled = true;
    try {
      this.process.kill();
    } catch {}
  }
}
