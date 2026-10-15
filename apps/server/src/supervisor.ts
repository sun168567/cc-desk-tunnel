import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type {
  AccountSnapshot,
  ClaudeConfig,
  ForkResult,
  ParentMessage,
  RunStart,
  TerminalStart,
  WorkerMessage,
} from '@cc-desk-tunnel/agent-ipc';
import { workerMessage } from '@cc-desk-tunnel/agent-ipc';
import type { EventPayload, NativeSettings } from '@cc-desk-tunnel/protocol';
import { DomainError } from './errors.ts';

const UNAVAILABLE = 'Claude 工作进程不可用；主服务和已有会话仍可使用。';

export type ClaudeServiceOptions = ClaudeConfig & {
  // A test double. Production uses the worker beside this package.
  worker?: string;
  // Unexpected exits before the process is left stopped. The next attempt waits out `openMs`.
  failureLimit?: number;
  restartDelayMs?: number[];
  openMs?: number;
};

export type WorkerHandlers = {
  event(sessionId: string, payload: EventPayload): void;
  turnEnded(sessionId: string, turn: Extract<WorkerMessage, { type: 'turnEnded' }>['turn']): void;
  waiting(sessionId: string, background: boolean): void;
  controls(sessionId: string, refresh: boolean, stopTask: boolean): void;
  approvalRequested(
    sessionId: string,
    approvalId: string,
    toolId: string,
    waiting: 'approval' | 'question',
  ): void;
  runFinished(sessionId: string, status: 'completed' | 'failed' | 'cancelled'): void;
  terminalData(sessionId: string, terminalId: string, data: string, bytes: number): void;
  terminalExit(sessionId: string, terminalId: string, exitCode: number | null): void;
  terminalFault(sessionId: string, terminalId: string): void;
  loginNotice(text: string): void;
  loginExit(succeeded: boolean, cancelled: boolean): void;
  exited(): void;
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export type ClaudeHost = {
  setEnvironment(environment: Record<string, string>): void;
  // Reads the worker that is already up. It does not start one.
  availability(): 'ready' | 'unavailable';
  whenReady(): Promise<void>;
  exited(): Promise<void>;
  terminate(): void;
  prepareStop(): void;
  stop(): Promise<void>;
  startRun(run: RunStart): void;
  abort(sessionId: string): void;
  reserve(sessionId: string): Promise<void>;
  submitInput(sessionId: string, messageId: string, text: string): void;
  resolveApproval(
    sessionId: string,
    approvalId: string,
    allowed: boolean,
    answers?: Record<string, string>,
  ): void;
  stopTask(sessionId: string, taskId: string): Promise<void>;
  refresh(sessionId: string): Promise<void>;
  readStatus(sessionId: string, nativeRoot: string, signal: AbortSignal): Promise<EventPayload[]>;
  deleteSession(sessionId: string, nativeRoot: string): Promise<void>;
  renameSession(sessionId: string, nativeRoot: string, title: string): Promise<void>;
  forkSession(
    sessionId: string,
    nativeRoot: string,
    title: string,
    beforeMessageId?: string,
  ): Promise<ForkResult>;
  openTerminal(terminal: TerminalStart): Promise<void>;
  terminalInput(sessionId: string, terminalId: string, data: string): void;
  terminalResize(sessionId: string, terminalId: string, cols: number, rows: number): void;
  terminalAck(sessionId: string, terminalId: string, bytes: number): void;
  closeTerminal(sessionId: string, terminalId: string): Promise<void>;
  accountStatus(): Promise<AccountSnapshot>;
  login(): Promise<string>;
  loginCode(code: string): void;
  loginCancel(): void;
  logout(): Promise<void>;
  readSettings(): Promise<NativeSettings>;
  updateSettings(values: Partial<NativeSettings>): Promise<NativeSettings>;
};

export function createClaudeHost(
  service: ClaudeServiceOptions,
  dataDir: string,
  handlers: WorkerHandlers,
): ClaudeHost {
  const limit = service.failureLimit ?? 5;
  const delays = service.restartDelayMs ?? [1000, 2000, 4000, 8000, 16000];
  const openMs = service.openMs ?? 60_000;
  const entry =
    service.worker ?? fileURLToPath(new URL('../../claude/src/worker.ts', import.meta.url));
  let environment = service.environment;
  let child: ChildProcess | undefined;
  let generation = 0;
  let ready = false;
  let failures = 0;
  let circuitUntil = 0;
  let shuttingDown = false;
  let launching: Promise<void> | undefined;
  let restartTimer: NodeJS.Timeout | undefined;
  const pending = new Map<string, Pending>();
  const exitWaiters: (() => void)[] = [];

  function unavailable() {
    return new DomainError('native_unavailable', UNAVAILABLE);
  }
  function circuitOpen() {
    return Date.now() < circuitUntil;
  }
  function send(message: ParentMessage) {
    if (!child?.connected) throw unavailable();
    child.send(message);
  }
  function rejectPending(error: Error) {
    for (const [id, waiter] of pending) {
      clearTimeout(waiter.timer);
      pending.delete(id);
      waiter.reject(error);
    }
  }
  function rpc<T>(message: ParentMessage, timeoutMs = 30_000): Promise<T> {
    const id = message.id ?? randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new DomainError('native_unavailable', '原生进程没有应答。'));
      }, timeoutMs);
      pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      try {
        send({ ...message, id });
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(error instanceof Error ? error : unavailable());
      }
    });
  }
  function dispatch(message: WorkerMessage) {
    if (message.type === 'reply') {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      clearTimeout(waiter.timer);
      pending.delete(message.id);
      if (message.ok) waiter.resolve(message.result);
      else waiter.reject(new DomainError(message.code, message.message));
      return;
    }
    switch (message.type) {
      case 'ready':
        return;
      case 'event':
        handlers.event(message.sessionId, message.payload);
        return;
      case 'turnEnded':
        handlers.turnEnded(message.sessionId, message.turn);
        return;
      case 'waiting':
        handlers.waiting(message.sessionId, message.background);
        return;
      case 'controls':
        handlers.controls(message.sessionId, message.refresh, message.stopTask);
        return;
      case 'approval.requested':
        handlers.approvalRequested(
          message.sessionId,
          message.approvalId,
          message.toolId,
          message.waiting,
        );
        return;
      case 'run.finished':
        handlers.runFinished(message.sessionId, message.status);
        return;
      case 'terminal.data':
        handlers.terminalData(message.sessionId, message.terminalId, message.data, message.bytes);
        return;
      case 'terminal.exit':
        handlers.terminalExit(message.sessionId, message.terminalId, message.exitCode);
        return;
      case 'terminal.fault':
        handlers.terminalFault(message.sessionId, message.terminalId);
        return;
      case 'login.notice':
        handlers.loginNotice(message.text);
        return;
      case 'login.exit':
        handlers.loginExit(message.succeeded, message.cancelled);
        return;
      default:
        return;
    }
  }
  function launch(): Promise<void> {
    clearTimeout(restartTimer);
    const gen = ++generation;
    ready = false;
    return new Promise<void>((resolve, reject) => {
      const proc = fork(entry, [], {
        execArgv: [],
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      });
      child = proc;
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        proc.kill();
        reject(unavailable());
      }, 15_000);
      const succeed = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ready = true;
        failures = 0;
        resolve();
      };
      proc.on('message', (value) => {
        const message = workerMessage(value);
        if (!message || message.generation !== gen || child !== proc) return;
        if (message.type === 'ready') succeed();
        else dispatch(message);
      });
      proc.on('error', () => {});
      proc.on('exit', () => {
        if (child !== proc) return;
        child = undefined;
        ready = false;
        launching = undefined;
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(unavailable());
        }
        rejectPending(unavailable());
        for (const wait of exitWaiters.splice(0)) wait();
        handlers.exited();
        if (shuttingDown) return;
        failures += 1;
        if (failures >= limit) {
          circuitUntil = Date.now() + openMs;
          return;
        }
        const delay = delays[Math.min(failures - 1, delays.length - 1)] ?? 1000;
        restartTimer = setTimeout(() => {
          if (!shuttingDown && !circuitOpen()) void whenReady().catch(() => {});
        }, delay);
      });
      proc.send({
        type: 'init',
        generation: gen,
        dataDir,
        config: {
          executable: service.executable,
          model: service.model,
          settingsPath: service.settingsPath,
          maxTurns: service.maxTurns,
          contextRetentionDays: service.contextRetentionDays,
          environment,
        },
      } satisfies ParentMessage);
    });
  }
  function whenReady() {
    if (shuttingDown || circuitOpen()) return Promise.reject(unavailable());
    if (ready && child?.connected) return Promise.resolve();
    if (!launching)
      launching = launch().finally(() => {
        if (!ready) launching = undefined;
      });
    return launching;
  }

  return {
    setEnvironment(next) {
      environment = next;
    },
    availability() {
      return ready && child?.connected && !circuitOpen() ? 'ready' : 'unavailable';
    },
    whenReady,
    exited: () => new Promise((resolve) => exitWaiters.push(resolve)),
    terminate() {
      child?.kill();
    },
    prepareStop() {
      shuttingDown = true;
      clearTimeout(restartTimer);
    },
    async stop() {
      shuttingDown = true;
      clearTimeout(restartTimer);
      const proc = child;
      if (!proc) return;
      try {
        proc.send({ type: 'shutdown', generation } satisfies ParentMessage);
      } catch {
        proc.kill();
      }
      await new Promise<void>((resolve) => {
        if (!child) {
          resolve();
          return;
        }
        const timer = setTimeout(() => {
          proc.kill();
          resolve();
        }, 5000);
        proc.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
    startRun(run) {
      send({ type: 'run.start', generation, run });
    },
    abort(sessionId) {
      send({ type: 'run.abort', generation, sessionId });
    },
    reserve(sessionId) {
      return rpc({ type: 'input.reserve', generation, sessionId });
    },
    submitInput(sessionId, messageId, text) {
      send({ type: 'input.submit', generation, sessionId, messageId, text });
    },
    resolveApproval(sessionId, approvalId, allowed, answers) {
      send({ type: 'approval.resolve', generation, sessionId, approvalId, allowed, answers });
    },
    stopTask(sessionId, taskId) {
      return rpc({ type: 'task.stop', generation, sessionId, taskId });
    },
    refresh(sessionId) {
      return rpc({ type: 'status.refresh', generation, sessionId });
    },
    readStatus(sessionId, nativeRoot, signal) {
      const id = randomUUID();
      const reading = rpc<EventPayload[]>(
        { type: 'status.read', generation, id, sessionId, nativeRoot },
        60_000,
      );
      const abort = () => {
        try {
          send({ type: 'status.abort', generation, id });
        } catch {
          // The process is already gone; the read fails on its own.
        }
      };
      signal.addEventListener('abort', abort, { once: true });
      return reading.finally(() => signal.removeEventListener('abort', abort));
    },
    deleteSession(sessionId, nativeRoot) {
      return rpc({ type: 'session.delete', generation, sessionId, nativeRoot }, 60_000);
    },
    renameSession(sessionId, nativeRoot, title) {
      return rpc({ type: 'session.rename', generation, sessionId, nativeRoot, title }, 60_000);
    },
    forkSession(sessionId, nativeRoot, title, beforeMessageId) {
      return rpc(
        { type: 'session.fork', generation, sessionId, nativeRoot, title, beforeMessageId },
        60_000,
      );
    },
    openTerminal(terminal) {
      return rpc({ type: 'terminal.open', generation, terminal });
    },
    terminalInput(sessionId, terminalId, data) {
      send({ type: 'terminal.input', generation, sessionId, terminalId, data });
    },
    terminalResize(sessionId, terminalId, cols, rows) {
      send({ type: 'terminal.resize', generation, sessionId, terminalId, cols, rows });
    },
    terminalAck(sessionId, terminalId, bytes) {
      send({ type: 'terminal.ack', generation, sessionId, terminalId, bytes });
    },
    closeTerminal(sessionId, terminalId) {
      if (!child?.connected) return Promise.resolve();
      return rpc({ type: 'terminal.close', generation, sessionId, terminalId }).then(
        () => undefined,
      );
    },
    accountStatus() {
      return rpc({ type: 'account.status', generation }, 30_000);
    },
    async login() {
      const result = await rpc<{ url: string }>({ type: 'account.login', generation }, 120_000);
      return result.url;
    },
    loginCode(code) {
      send({ type: 'account.code', generation, code });
    },
    loginCancel() {
      if (child?.connected) send({ type: 'account.cancel', generation });
    },
    logout() {
      return rpc({ type: 'account.logout', generation });
    },
    readSettings() {
      return rpc({ type: 'settings.get', generation });
    },
    updateSettings(values) {
      return rpc({ type: 'settings.update', generation, values });
    },
  };
}
