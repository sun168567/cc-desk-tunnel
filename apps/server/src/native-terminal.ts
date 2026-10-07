import { spawn as spawnPty } from 'node-pty';
import type { IPty } from 'node-pty';
import type { Session } from '@cc-desk-tunnel/protocol';
import type { ClaudeOptions } from './claude.ts';
import { remotePrompt } from './claude.ts';
import type { SshConnection } from './tunnel.ts';
import { readFileSync } from 'node:fs';

// node-pty takes a plain string map, while a process environment may hold undefined entries.
export function definedEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

export function terminalEnvironment(
  options: ClaudeOptions,
  inherited: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env = definedEnvironment(inherited);
  // Reuse the private provider configuration as a normal CLI process environment.
  if (options.settingsPath) {
    const settings = JSON.parse(readFileSync(options.settingsPath, 'utf8'));
    if (settings.env && typeof settings.env === 'object')
      for (const [key, value] of Object.entries(settings.env))
        if (typeof value === 'string') env[key] = value;
  }
  return { ...env, ...options.environment, TERM: 'xterm-256color' };
}

type TerminalProcess = Pick<
  IPty,
  'onData' | 'onExit' | 'write' | 'resize' | 'pause' | 'resume' | 'kill' | 'pid'
>;
export type TerminalSpawner = (
  file: string,
  args: string[],
  options: { cwd: string; cols: number; rows: number; env: Record<string, string>; name: string },
) => TerminalProcess;

export function terminalArguments(options: ClaudeOptions, session: Session, ssh: SshConnection) {
  return [
    '--permission-mode',
    session.permissionMode === 'default' ? 'manual' : session.permissionMode,
    '--append-system-prompt',
    remotePrompt(session.projectPath, ssh, session.id),
    ...((session.model ?? options.model) ? ['--model', session.model ?? options.model!] : []),
    ...(session.effort ? ['--effort', session.effort] : []),
    ...(options.settingsPath ? ['--settings', options.settingsPath] : []),
  ];
}

// Native control sessions have their own CLI history; no terminal transcript is persisted by the proxy.
export class NativeTerminal {
  process: TerminalProcess;
  outstanding = 0;
  paused = false;
  exited = false;
  closing = false;
  closed: Promise<void>;
  private resolveClosed!: () => void;
  private killTimer?: ReturnType<typeof setTimeout>;
  private ackTimer?: ReturnType<typeof setTimeout>;
  private cols: number;
  private rows: number;
  constructor(
    file: string,
    args: string[],
    options: { cwd: string; cols: number; rows: number; env: Record<string, string> },
    data: (text: string, bytes: number) => void,
    exit: (code: number | null) => void,
    spawn: TerminalSpawner = spawnPty,
  ) {
    this.cols = options.cols;
    this.rows = options.rows;
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
    this.process = spawn(file, args, { ...options, name: 'xterm-256color' });
    this.process.onData((text) => {
      if (this.exited || this.closing) return;
      // UTF-16 boundaries stay intact, while each frame is well below the control-frame limit.
      for (let offset = 0; offset < text.length;) {
        let end = Math.min(offset + 16384, text.length);
        const last = text.charCodeAt(end - 1);
        if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
        const chunk = text.slice(offset, end);
        const bytes = Buffer.byteLength(chunk, 'utf8');
        this.outstanding += bytes;
        data(chunk, bytes);
        offset = end;
      }
      if (this.outstanding >= 128 * 1024 && !this.paused) {
        this.paused = true;
        this.process.pause();
        this.ackTimer = setTimeout(() => {
          void this.close();
        }, 30000);
      }
    });
    this.process.onExit(({ exitCode }) => {
      this.exited = true;
      if (process.platform === 'linux') {
        try {
          process.kill(-this.process.pid, 'SIGKILL');
        } catch {}
      }
      clearTimeout(this.killTimer);
      clearTimeout(this.ackTimer);
      try {
        exit(exitCode);
      } finally {
        this.resolveClosed();
      }
    });
  }
  write(text: string) {
    if (!this.exited && !this.closing) this.process.write(text);
  }
  resize(cols: number, rows: number) {
    if (!this.exited && !this.closing && (this.cols !== cols || this.rows !== rows)) {
      this.cols = cols;
      this.rows = rows;
      this.process.resize(cols, rows);
    }
  }
  acknowledge(bytes: number) {
    if (bytes > this.outstanding) throw new Error('Invalid terminal acknowledgment');
    this.outstanding -= bytes;
    if (this.paused && this.outstanding < 32 * 1024 && !this.closing) {
      this.paused = false;
      clearTimeout(this.ackTimer);
      this.process.resume();
    }
  }
  close() {
    if (this.exited || this.closing) return this.closed;
    this.closing = true;
    clearTimeout(this.ackTimer);
    if (this.paused) this.process.resume();
    // forkpty starts a separate process group; clean descendants as well as the foreground CLI.
    try {
      if (process.platform === 'linux') process.kill(-this.process.pid, 'SIGTERM');
      else this.process.kill();
    } catch {
      try {
        this.process.kill();
      } catch {}
    }
    this.killTimer = setTimeout(() => {
      try {
        if (process.platform === 'linux') process.kill(-this.process.pid, 'SIGKILL');
        else this.process.kill();
      } catch {}
    }, 2000);
    return this.closed;
  }
}
