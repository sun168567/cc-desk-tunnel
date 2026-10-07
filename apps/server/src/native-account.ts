import { execFile } from 'node:child_process';
import { spawn as spawnPty } from 'node-pty';
import type { AccountState } from '@cc-desk-tunnel/protocol';
import { definedEnvironment } from './native-terminal.ts';
import type { TerminalSpawner } from './native-terminal.ts';

type Account = Omit<AccountState, 'login' | 'notice'>;
// Terminal hyperlink (OSC) and styling (CSI) sequences; only the visible text is read.
const controlSequences = /\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b\[[0-9;?]*[A-Za-z]/g;

// Sign-in state comes from the official `claude auth` commands; the proxy never reads or writes the credentials.
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
}

// Drives `claude auth login`: it prints the authorization link, then reads the code the browser page shows.
export class NativeLogin {
  url: Promise<string>;
  private process: ReturnType<TerminalSpawner>;
  private output = '';
  private timer: ReturnType<typeof setTimeout>;
  private submitted?: { code: string; reply: string; timer?: ReturnType<typeof setTimeout> };
  cancelled = false;
  // `reply` carries what the command prints after a code and keeps waiting, such as its invalid-code message.
  constructor(
    executable: string,
    exit: (succeeded: boolean) => void,
    reply: (text: string) => void = () => {},
    spawn: TerminalSpawner = spawnPty,
    timeoutMs = 10 * 60 * 1000,
  ) {
    let found!: (url: string) => void, failed!: (error: Error) => void;
    this.url = new Promise((resolve, reject) => {
      found = resolve;
      failed = reject;
    });
    this.url.catch(() => {});
    // A wide terminal keeps the link on one line.
    this.process = spawn(executable, ['auth', 'login'], {
      cwd: process.cwd(),
      cols: 4000,
      rows: 24,
      env: { ...definedEnvironment(process.env), TERM: 'dumb' },
      name: 'dumb',
    });
    this.timer = setTimeout(() => {
      try {
        this.process.kill();
      } catch {}
    }, timeoutMs);
    this.process.onData((text) => {
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
    this.process.onExit(({ exitCode }) => {
      clearTimeout(this.timer);
      clearTimeout(this.submitted?.timer);
      failed(new Error('Login command exited before printing a link'));
      exit(exitCode === 0);
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
