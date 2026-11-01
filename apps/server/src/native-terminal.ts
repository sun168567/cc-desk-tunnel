import { spawn as spawnPty } from 'node-pty';
import type { IPty } from 'node-pty';
import { platformOf } from '@cc-desk-tunnel/protocol';
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
  const result: Record<string, string> = {
    ...env,
    ...options.environment,
    TERM: 'xterm-256color',
  };
  // The CLI reports what started it from these. A terminal runs the interactive CLI and must never pass for an SDK
  // process, whatever this process inherited.
  for (const name of Object.keys(result))
    if (name === 'CLAUDE_CODE_ENTRYPOINT' || name.startsWith('CLAUDE_AGENT_SDK_'))
      delete result[name];
  return result;
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

// A terminal that continues the session works in the same native session as its chat runs: it resumes it, or
// creates it under the session's ID when there is none yet. `settingsPath` replaces the provider's settings then,
// with the terminal's hooks added to them.
export function terminalArguments(
  options: ClaudeOptions,
  session: Session,
  ssh?: SshConnection,
  continued?: { resume: boolean; settingsPath: string },
) {
  const settingsPath = continued?.settingsPath ?? options.settingsPath;
  return [
    ...(continued ? [continued.resume ? '--resume' : '--session-id', session.id] : []),
    '--permission-mode',
    session.permissionMode === 'default' ? 'manual' : session.permissionMode,
    ...(ssh
      ? [
          '--append-system-prompt',
          remotePrompt(session.projectPath, ssh, session.id, platformOf(session.device)),
        ]
      : []),
    ...((session.model ?? options.model) ? ['--model', session.model ?? options.model!] : []),
    ...(session.effort ? ['--effort', session.effort] : []),
    ...(settingsPath ? ['--settings', settingsPath] : []),
  ];
}

// What a client may have switched on for the screen it showed before; cleared before another screen is drawn.
const RESET =
  '\x1b[?25h\x1b[?2004l\x1b[?1004l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1l\x1b[<u\x1b[>4;0m' +
  '\x1b[?1049l\x1b[0m\x1b[H\x1b[2J\x1b[3J';
// Keyboard modes a CLI may switch on that the screen model does not keep: the kitty keyboard protocol and xterm's
// modifyOtherKeys.
const KEYBOARD = /\x1b\[>(\d+)u|\x1b\[<\d*u|\x1b\[>4;(\d+)m/g;

// Native control sessions have their own CLI history; no terminal transcript is persisted by the proxy.
//
// A terminal that keeps running while no client shows it (`screen`) also writes its output to a screen model. A client
// that attaches gets the current screen first, then the live output; one that stops acknowledging for 30 s is
// detached and the CLI goes on. Without a screen the terminal ends then. The screen model, the snapshot and the modes
// it restores follow jiangan-code/cc-desk-tunnel.
export class NativeTerminal {
  process: TerminalProcess;
  outstanding = 0;
  paused = false;
  attached = true;
  exited = false;
  closing = false;
  closed: Promise<void>;
  private resolveClosed!: () => void;
  private killTimer?: ReturnType<typeof setTimeout>;
  private ackTimer?: ReturnType<typeof setTimeout>;
  private cols: number;
  private rows: number;
  private data: (text: string, bytes: number) => void;
  private detached?: () => void;
  private screen?: InstanceType<typeof headless.Terminal>;
  private serializer?: InstanceType<typeof serialize.SerializeAddon>;
  // Output that arrived while the screen was being captured for an attach; it follows the capture.
  private pending?: string[];
  private kitty = 0;
  private otherKeys = 0;
  constructor(
    file: string,
    args: string[],
    options: {
      cwd: string;
      cols: number;
      rows: number;
      env: Record<string, string>;
      // Keep a screen model, and on a client's 30 s of silence call `detached` instead of ending.
      screen?: { detached: () => void };
    },
    data: (text: string, bytes: number) => void,
    exit: (code: number | null) => void | Promise<void>,
    spawn: TerminalSpawner = spawnPty,
  ) {
    const { screen, ...spawnOptions } = options;
    this.cols = options.cols;
    this.rows = options.rows;
    this.data = data;
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
    if (screen) {
      this.detached = screen.detached;
      this.screen = new headless.Terminal({
        cols: options.cols,
        rows: options.rows,
        scrollback: 1000,
        allowProposedApi: true,
      });
      this.serializer = new serialize.SerializeAddon();
      this.screen.loadAddon(this.serializer);
    }
    this.process = spawn(file, args, { ...spawnOptions, name: 'xterm-256color' });
    this.process.onData((text) => {
      if (this.exited || this.closing) return;
      if (this.screen) {
        this.screen.write(text);
        for (const [, kitty, otherKeys] of text.matchAll(KEYBOARD)) {
          if (otherKeys !== undefined) this.otherKeys = Number(otherKeys);
          else this.kitty = kitty === undefined ? 0 : Number(kitty);
        }
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
      this.screen?.dispose();
      // What the end leads to may take a while, such as recording what the terminal added; closing waits for it.
      void Promise.resolve()
        .then(() => exit(exitCode))
        .catch(() => {})
        .finally(() => this.resolveClosed());
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
      this.ackTimer = setTimeout(() => {
        if (!this.screen) return void this.close();
        this.detach();
        this.detached?.();
      }, 30000);
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
  // Shows the terminal to a client at its size: the current screen, drawn on a cleared one, then the live output.
  async attach(cols: number, rows: number) {
    const screen = this.screen;
    if (!screen || this.exited || this.closing) return;
    this.detach();
    this.resize(cols, rows);
    this.pending = [];
    // Everything written before this point is in the screen when the callback runs.
    await new Promise<void>((resolve) => screen.write('', resolve));
    const core = (
      screen as unknown as {
        _core?: {
          coreService?: { isCursorHidden?: boolean };
          coreMouseService?: { activeEncoding?: string };
        };
      }
    )._core;
    const snapshot =
      RESET +
      this.serializer!.serialize({ scrollback: 1000 }) +
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
  write(text: string) {
    if (!this.exited && !this.closing) this.process.write(text);
  }
  resize(cols: number, rows: number) {
    if (!this.exited && !this.closing && (this.cols !== cols || this.rows !== rows)) {
      this.cols = cols;
      this.rows = rows;
      this.process.resize(cols, rows);
      this.screen?.resize(cols, rows);
    }
  }
  acknowledge(bytes: number) {
    // After a detach, acknowledgments of what was sent before it may still arrive; they count for nothing.
    if (bytes > this.outstanding && !this.screen)
      throw new Error('Invalid terminal acknowledgment');
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
