import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LimitBudget } from './limits.ts';
import { moveToCgroup, planLaunch, prepareCgroup, prlimitAvailable } from './limits.ts';

type PtyProcess = {
  onData(callback: (text: string) => void): void;
  onExit(callback: (event: { exitCode: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  pause(): void;
  resume(): void;
  kill(): void;
  pid: number;
};

// The Codex CLI is the terminal. Its working directory holds AGENTS.md for this session, and
// CODEX_HOME stays the signed-in profile so the login is the same one the app-server uses.
export class CodexTerminal {
  private process: PtyProcess;
  private outstanding = 0;
  private paused = false;
  private exited = false;
  private closing = false;
  private closed: Promise<void>;
  private resolveClosed!: () => void;
  private killTimer?: ReturnType<typeof setTimeout>;
  private ackTimer?: ReturnType<typeof setTimeout>;
  private cols: number;
  private rows: number;

  static async open(options: {
    executable: string;
    home: string;
    sessionId: string;
    cols: number;
    rows: number;
    resumeThreadId?: string;
    instructions?: string;
    limits?: LimitBudget;
    onData: (data: string, bytes: number) => void;
    onExit: (exitCode: number | null) => void;
  }) {
    const pty = (await import('node-pty')) as {
      spawn: (
        file: string,
        args: string[],
        spawnOptions: {
          name: string;
          cwd: string;
          cols: number;
          rows: number;
          env: Record<string, string>;
        },
      ) => PtyProcess;
    };
    const cwd = join(options.home, 'terminals', options.sessionId);
    mkdirSync(cwd, { recursive: true });
    if (options.instructions) writeFileSync(join(cwd, 'AGENTS.md'), options.instructions, 'utf8');
    const script = options.executable.endsWith('.mjs') || options.executable.endsWith('.js');
    const args = options.resumeThreadId ? ['resume', options.resumeThreadId] : [];
    const plainCommand = script ? process.execPath : options.executable;
    const plainArgs = script ? [options.executable, ...args] : args;
    const leaf = !script && options.limits ? prepareCgroup(options.limits) : undefined;
    const spec = script
      ? { command: plainCommand, args: plainArgs }
      : planLaunch({
          executable: plainCommand,
          args: plainArgs,
          limits: options.limits,
          prlimit: prlimitAvailable(),
          cgroup: !!leaf,
        });
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value === undefined || /^(?:CLAUDE|ANTHROPIC)_/i.test(key)) continue;
      env[key] = value;
    }
    env.CODEX_HOME = options.home;
    env.TERM = 'xterm-256color';
    const terminal = new CodexTerminal(
      spec.command,
      spec.args,
      { cwd, cols: options.cols, rows: options.rows, env },
      options.onData,
      options.onExit,
      pty.spawn,
    );
    if (leaf && terminal.process.pid) moveToCgroup(leaf, terminal.process.pid);
    return terminal;
  }

  private constructor(
    file: string,
    args: string[],
    options: { cwd: string; cols: number; rows: number; env: Record<string, string> },
    data: (text: string, bytes: number) => void,
    exit: (code: number | null) => void,
    spawn: (
      file: string,
      args: string[],
      spawnOptions: {
        name: string;
        cwd: string;
        cols: number;
        rows: number;
        env: Record<string, string>;
      },
    ) => PtyProcess,
  ) {
    this.cols = options.cols;
    this.rows = options.rows;
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
    this.process = spawn(file, args, { ...options, name: 'xterm-256color' });
    this.process.onData((text) => {
      if (this.exited || this.closing) return;
      for (let offset = 0; offset < text.length; ) {
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
        } catch {
          // The process group is already gone.
        }
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
    try {
      if (process.platform === 'linux') process.kill(-this.process.pid, 'SIGTERM');
      else this.process.kill();
    } catch {
      try {
        this.process.kill();
      } catch {
        // Already exited.
      }
    }
    this.killTimer = setTimeout(() => {
      try {
        if (process.platform === 'linux') process.kill(-this.process.pid, 'SIGKILL');
        else this.process.kill();
      } catch {
        // Already exited.
      }
    }, 2000);
    return this.closed;
  }
}
