import { spawn as spawnPty } from 'node-pty';
import type { IPty } from 'node-pty';
import type { Session } from '@cc-desk-tunnel/protocol';
import type { ClaudeOptions } from './claude.ts';
import { remotePrompt } from './claude.ts';
import type { SshConnection } from './tunnel.ts';
import { readFileSync } from 'node:fs';
import headless from '@xterm/headless';
import serialize from '@xterm/addon-serialize';

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

export function terminalArguments(
  options: ClaudeOptions,
  session: Session,
  ssh: SshConnection,
  continued = false,
) {
  return [
    ...(continued ? ['--continue'] : []),
    '--permission-mode',
    session.permissionMode === 'default' ? 'manual' : session.permissionMode,
    '--append-system-prompt',
    remotePrompt(session.projectPath, ssh, session.id),
    ...((session.model ?? options.model) ? ['--model', session.model ?? options.model!] : []),
    ...(session.effort ? ['--effort', session.effort] : []),
    ...(options.settingsPath ? ['--settings', options.settingsPath] : []),
  ];
}

// What a client may have switched on for the previous screen it showed; cleared before another screen is drawn.
const RESET =
  '\x1b[?25h\x1b[?2004l\x1b[?1004l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1l\x1b[<u\x1b[>4;0m' +
  '\x1b[?1049l\x1b[0m\x1b[H\x1b[2J\x1b[3J';
// Keyboard modes a CLI may switch on that the screen model does not record: the kitty keyboard protocol and xterm's
// modifyOtherKeys.
const KEYBOARD = /\x1b\[>(\d+)u|\x1b\[<\d*u|\x1b\[>4;(\d+)m/g;

// Native control sessions have their own CLI history; no terminal transcript is persisted by the proxy.
//
// A terminal keeps running while no client shows it. Its output always goes to a screen model, and a client that
// attaches gets the current screen first, then the live output; while attached, output waits for the client's
// acknowledgments. A client that stops acknowledging for 30 s is detached, not the CLI ended.
export class NativeTerminal {
  process: TerminalProcess;
  outstanding = 0;
  paused = false;
  attached = true;
  exited = false;
  closing = false;
  closed: Promise<void>;
  private screen: InstanceType<typeof headless.Terminal>;
  private serializer: InstanceType<typeof serialize.SerializeAddon>;
  // Output that arrived while the screen was being captured for an attach; it follows the capture.
  private pending?: string[];
  private kitty = 0;
  private otherKeys = 0;
  private data: (text: string, bytes: number) => void;
  private resolveClosed!: () => void;
  private killTimer?: ReturnType<typeof setTimeout>;
  private ackTimer?: ReturnType<typeof setTimeout>;
  cols: number;
  rows: number;
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
    this.data = data;
    this.screen = new headless.Terminal({
      cols: options.cols,
      rows: options.rows,
      scrollback: 1000,
      allowProposedApi: true,
    });
    this.serializer = new serialize.SerializeAddon();
    this.screen.loadAddon(this.serializer);
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
    this.process = spawn(file, args, { ...options, name: 'xterm-256color' });
    this.process.onData((text) => {
      if (this.exited || this.closing) return;
      this.screen.write(text);
      for (const [, kitty, otherKeys] of text.matchAll(KEYBOARD)) {
        if (otherKeys !== undefined) this.otherKeys = Number(otherKeys);
        else this.kitty = kitty === undefined ? 0 : Number(kitty);
      }
      if (this.pending) this.pending.push(text);
      else if (this.attached) this.send(text);
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
        this.screen.dispose();
        this.resolveClosed();
      }
    });
  }
  private send(text: string) {
    // UTF-16 boundaries stay intact, while each frame is well below the control-frame limit.
    for (let offset = 0; offset < text.length;) {
      let end = Math.min(offset + 16384, text.length);
      const last = text.charCodeAt(end - 1);
      if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
      const chunk = text.slice(offset, end);
      const bytes = Buffer.byteLength(chunk, 'utf8');
      this.outstanding += bytes;
      this.data(chunk, bytes);
      offset = end;
    }
    if (this.outstanding >= 128 * 1024 && !this.paused) {
      this.paused = true;
      this.process.pause();
      this.ackTimer = setTimeout(() => this.detach(), 30000);
    }
  }
  write(text: string) {
    if (!this.exited && !this.closing) this.process.write(text);
  }
  resize(cols: number, rows: number) {
    if (!this.exited && !this.closing && (this.cols !== cols || this.rows !== rows)) {
      this.cols = cols;
      this.rows = rows;
      this.process.resize(cols, rows);
      this.screen.resize(cols, rows);
    }
  }
  // The CLI runs on unwatched: its output only updates the screen model.
  detach() {
    this.attached = false;
    this.outstanding = 0;
    clearTimeout(this.ackTimer);
    if (this.paused && !this.closing && !this.exited) {
      this.paused = false;
      this.process.resume();
    }
  }
  // Shows the terminal to a client at its size: the current screen, drawn from a cleared one, then live output.
  async attach(cols: number, rows: number) {
    if (this.exited || this.closing) return;
    this.detach();
    this.resize(cols, rows);
    this.pending = [];
    // Everything written before this point is in the screen when the callback runs.
    await new Promise<void>((resolve) => this.screen.write('', resolve));
    const core = (
      this.screen as unknown as {
        _core?: {
          coreService?: { isCursorHidden?: boolean };
          coreMouseService?: { activeEncoding?: string };
        };
      }
    )._core;
    const snapshot =
      RESET +
      this.serializer.serialize({ scrollback: 1000 }) +
      (core?.coreMouseService?.activeEncoding === 'SGR' ? '\x1b[?1006h' : '') +
      (this.kitty ? `\x1b[>${this.kitty}u` : '') +
      (this.otherKeys ? `\x1b[>4;${this.otherKeys}m` : '') +
      (core?.coreService?.isCursorHidden ? '\x1b[?25l' : '');
    const later = this.pending;
    this.pending = undefined;
    if (this.exited || this.closing) return;
    this.attached = true;
    this.send(snapshot + later.join(''));
  }
  acknowledge(bytes: number) {
    // Acknowledgments of output sent before a detach may still arrive; they count for nothing.
    this.outstanding = Math.max(0, this.outstanding - bytes);
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
