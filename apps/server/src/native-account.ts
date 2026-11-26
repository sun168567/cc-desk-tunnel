import { execFile } from 'node:child_process';
import { spawn as spawnPty } from 'node-pty';
import headless from '@xterm/headless';
import { phrase, type Words } from '@cc-desk-tunnel/i18n';
import type { AccountState } from '@cc-desk-tunnel/protocol';
import { DomainError } from './errors.ts';
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
  return new Promise<{ code: number | null; stdout: string; error?: string }>((resolve) => {
    // `auth status` exits 1 when signed out and still prints its JSON.
    execFile(executable, args, { env: process.env, timeout: 20000 }, (error, stdout, stderr) =>
      resolve({
        code: error ? (typeof error.code === 'number' ? error.code : null) : 0,
        stdout,
        error: stderr.trim() || error?.message,
      }),
    );
  });
}
export async function accountStatus(executable: string) {
  return parseAccountStatus((await run(executable, ['auth', 'status', '--json'])).stdout);
}
export async function accountLogout(executable: string) {
  const result = await run(executable, ['auth', 'logout']);
  if (result.code !== 0)
    throw new DomainError(
      'logout_failed',
      result.error ||
        result.stdout.trim() ||
        phrase('service:account.logoutExit', { code: String(result.code) }),
    );
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
  error?: Words;
  private process: ReturnType<TerminalSpawner>;
  private output = '';
  private timer: ReturnType<typeof setTimeout>;
  private errorTimer?: ReturnType<typeof setTimeout>;
  private tokenTimer?: ReturnType<typeof setTimeout>;
  private enterTimer?: ReturnType<typeof setTimeout>;
  private answerTimer?: ReturnType<typeof setTimeout>;
  private answerMs: number;
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
      // How long the command may take to end by itself once it has shown the token.
      tokenGraceMs?: number;
      // How long setup-token may take to answer a code with a token or an error before it is ended.
      answerMs?: number;
    } = {},
  ) {
    this.method = options.method ?? 'browser';
    this.answerMs = options.answerMs ?? 90_000;
    // setup-token uses Ink screen redraws, so stripping ANSI codes would lose cursor-inserted spaces and edits.
    const screen =
      this.method === 'setup-token'
        ? new headless.Terminal({ cols: 4000, rows: 24, scrollback: 100, allowProposedApi: true })
        : undefined;
    let setupToken: string | undefined;
    let exited = false;
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
        this.error = phrase('service:account.authTimeout');
        try {
          this.process.kill();
        } catch {}
      },
      options.timeoutMs ?? 10 * 60 * 1000,
    );
    this.process.onData((text) => {
      if (screen) {
        screen.write(text, () => {
          const buffer = screen.buffer.active;
          const output = Array.from({ length: buffer.length }, (_, i) =>
            buffer.getLine(i)!.translateToString(true),
          ).join('\n');
          if (output.trim()) this.output = output;
          const link = /https:\/\/\S+(?=\s)/.exec(output);
          if (link) found(link[0]);
          setupToken =
            /Your OAuth token[^\n]*\n\s*(sk-ant-oat01-[A-Za-z0-9_-]+)(?=\s)/.exec(output)?.[1] ??
            setupToken;
          // Once it has shown the token the command has nothing left to ask, but it ends only after reporting its
          // usage, which a server whose network holds that up can wait on for a long time. The token is taken then.
          if (setupToken && !exited)
            this.tokenTimer ??= setTimeout(() => {
              try {
                this.process.kill();
              } catch {}
            }, options.tokenGraceMs ?? 3000);
          if (!exited && output.includes('OAuth error:')) {
            clearTimeout(this.errorTimer);
            this.errorTimer = setTimeout(() => this.process.kill(), 400);
          }
        });
        return;
      }
      this.output = (this.output + text).slice(-16384);
      const link = /https:\/\/[^\s\x00-\x1f]+(?=\s)/.exec(
        this.output.replace(controlSequences, ''),
      );
      if (link) found(link[0]);
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
    const finish = (exitCode: number) => {
      clearTimeout(this.timer);
      clearTimeout(this.errorTimer);
      clearTimeout(this.tokenTimer);
      clearTimeout(this.enterTimer);
      clearTimeout(this.answerTimer);
      clearTimeout(this.submitted?.timer);
      const token = setupToken;
      // The command shows a token only once it has been created, however it ends afterwards.
      const succeeded = this.method === 'browser' ? exitCode === 0 : !!token;
      if (!succeeded && !this.cancelled && !this.error) {
        // Only redact secrets; preserve the CLI's explanation, including multiline network and policy errors.
        let output = this.output
          .replace(controlSequences, '')
          .replace(/sk-ant-oat01-[A-Za-z0-9_-]+/g, '[token]');
        if (this.submitted?.code) output = output.replaceAll(this.submitted.code, '[code]');
        const errorAt = output.lastIndexOf('OAuth error:');
        if (errorAt >= 0) output = output.slice(errorAt).split('Press Enter to retry.')[0];
        this.error =
          exitCode === 0
            ? phrase('service:account.tokenUnread')
            : output.trim() || phrase('service:account.loginExit', { code: String(exitCode) });
      }
      failed(new DomainError('login_failed', this.error ?? phrase('service:account.noLink')));
      this.output = '';
      screen?.dispose();
      exit(succeeded, token);
    };
    this.process.onExit(({ exitCode }) => {
      exited = true;
      // xterm processes writes in order; finish after its last pending render, even if the CLI exits immediately.
      if (screen) screen.write('', () => finish(exitCode));
      else finish(exitCode);
    });
  }
  submit(code: string) {
    clearTimeout(this.submitted?.timer);
    clearTimeout(this.enterTimer);
    this.submitted = { code, reply: '' };
    // `auth login` reads a line, and takes the code with its Enter. setup-token's text input on a Linux terminal
    // takes the two written together as pasted text, and the code is never submitted: there Enter goes as a key
    // of its own, as a person presses it after pasting and as the CLI writes its own replies.
    if (this.method !== 'setup-token') {
      this.process.write(`${code}\r`);
      return;
    }
    this.process.write(code);
    this.enterTimer = setTimeout(() => {
      try {
        this.process.write('\r');
      } catch {}
    }, 100);

    // setup-token answers a code with its token or an error; one that shows neither is ended and what it last
    // showed told, rather than leaving the window waiting.
    clearTimeout(this.answerTimer);
    this.answerTimer = setTimeout(() => {
      const shown = this.output
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !/[█░▓▄]/.test(line))
        .slice(-4)
        .join(' ')
        .replace(/https:\/\/\S+/g, '[link]')
        .replaceAll(code, '[code]')
        .replace(/sk-ant-oat01-[A-Za-z0-9_-]+/g, '[token]');
      const count = Math.round(this.answerMs / 1000);
      this.error = shown
        ? phrase('service:account.noTokenSaid', { count, said: shown.slice(0, 300) })
        : phrase('service:account.noToken', { count });
      try {
        this.process.kill();
      } catch {}
    }, this.answerMs);
  }
  cancel() {
    this.cancelled = true;
    clearTimeout(this.errorTimer);
    try {
      this.process.kill();
    } catch {}
  }
}
