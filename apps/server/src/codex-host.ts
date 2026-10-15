import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  CodexConfig,
  CodexLimits,
  CodexParentMessage,
  CodexRunStart,
  CodexTerminalStart,
  CodexWorkerMessage,
} from '@cc-desk-tunnel/agent-ipc';
import { codexWorkerMessage } from '@cc-desk-tunnel/agent-ipc';
import { eventPayloadSchema, type EventPayload } from '@cc-desk-tunnel/protocol';
import { LOG_BYTES, takeIpc, takeLog } from './codex-guard.ts';
import { DomainError } from './errors.ts';

const UNAVAILABLE = 'Codex 工作进程不可用；Claude、主服务和已有会话仍可使用。';

export type CodexServiceOptions = CodexConfig & {
  worker?: string;
  failureLimit?: number;
  restartDelayMs?: number[];
  openMs?: number;
  // How long to wait for the worker to become ready. Absent, 15 seconds.
  readyMs?: number;
};

export type CodexHandlers = {
  event(sessionId: string, payload: EventPayload): void;
  approvalRequested(
    sessionId: string,
    approvalId: string,
    toolId: string,
    waiting: 'approval' | 'question',
    kind: 'command' | 'file' | 'question',
  ): void;
  runFinished(
    sessionId: string,
    status: 'completed' | 'failed' | 'cancelled',
    unknown: boolean,
    threadId?: string,
    dropThread?: boolean,
  ): void;
  loginExit(succeeded: boolean, cancelled: boolean): void;
  terminalData(sessionId: string, terminalId: string, data: string, bytes: number): void;
  terminalExit(sessionId: string, terminalId: string, exitCode: number | null): void;
  terminalFault(sessionId: string, terminalId: string): void;
  exited(): void;
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export type CodexHost = {
  // Reads the worker that is already up. It does not start one.
  availability(): 'ready' | 'unavailable';
  whenReady(): Promise<void>;
  exited(): Promise<void>;
  terminate(): void;
  prepareStop(): void;
  stop(): Promise<void>;
  login(): Promise<{ url: string; userCode: string; already?: boolean }>;
  loginCancel(): void;
  accountStatus(): Promise<{ loggedIn: boolean; accountType: string | null }>;
  logout(): Promise<{ loggedIn: boolean }>;
  models(): Promise<{ id: string; displayName: string }[]>;
  startRun(run: CodexRunStart): void;
  steer(sessionId: string, text: string): void;
  readStatus(): Promise<{
    rateLimits: {
      available: boolean;
      windows: { name: string; utilization: number; resetsAt: string | null }[];
      measuredAt: string;
    } | null;
  }>;
  abort(sessionId: string): void;
  forkThread(threadId: string): Promise<string>;
  stopTask(sessionId: string, taskId: string): void;
  resolveApproval(
    sessionId: string,
    approvalId: string,
    allowed: boolean,
    answers?: Record<string, string>,
  ): void;
  openTerminal(terminal: CodexTerminalStart): Promise<void>;
  terminalInput(sessionId: string, terminalId: string, data: string): void;
  terminalResize(sessionId: string, terminalId: string, cols: number, rows: number): void;
  terminalAck(sessionId: string, terminalId: string, bytes: number): void;
  closeTerminal(sessionId: string, terminalId: string): Promise<void>;
  limits(): CodexLimits | null;
};

export function createCodexHost(
  service: CodexServiceOptions,
  dataDir: string,
  handlers: CodexHandlers,
): CodexHost {
  const limit = service.failureLimit ?? 5;
  const delays = service.restartDelayMs ?? [1000, 2000, 4000, 8000, 16000];
  const openMs = service.openMs ?? 60_000;
  const readyMs = service.readyMs && service.readyMs > 0 ? service.readyMs : 15_000;
  const entry =
    service.worker ?? fileURLToPath(new URL('../../codex/src/worker.ts', import.meta.url));
  let child: ChildProcess | undefined;
  let generation = 0;
  let limits: CodexLimits | null = null;
  let ready = false;
  let failures = 0;
  let circuitUntil = 0;
  let shuttingDown = false;
  let launching: Promise<void> | undefined;
  let restartTimer: NodeJS.Timeout | undefined;
  const pending = new Map<string, Pending>();
  const exitWaiters: (() => void)[] = [];
  const ipc = { window: 0, count: 0 };
  const logFile = join(dataDir, 'providers', 'openai', service.profileId, 'worker.log');
  let logUsed = 0;

  function unavailable() {
    return new DomainError('openai_unavailable', UNAVAILABLE);
  }
  function circuitOpen() {
    return Date.now() < circuitUntil;
  }
  function send(message: CodexParentMessage) {
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
  function rpc<T>(message: CodexParentMessage, timeoutMs = 30_000): Promise<T> {
    const id = message.id ?? randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new DomainError('openai_unavailable', 'Codex 工作进程没有应答。'));
      }, timeoutMs);
      pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      try {
        send({ ...message, id });
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(error instanceof Error ? error : unavailable());
      }
    });
  }
  function dispatch(message: CodexWorkerMessage) {
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
      case 'event': {
        const payload = eventPayloadSchema.safeParse(message.payload);
        if (!payload.success) return;
        handlers.event(message.sessionId, payload.data);
        return;
      }
      case 'approval.requested':
        handlers.approvalRequested(
          message.sessionId,
          message.approvalId,
          message.toolId,
          message.waiting,
          message.kind ?? 'command',
        );
        return;
      case 'run.finished':
        handlers.runFinished(
          message.sessionId,
          message.status,
          message.unknown === true,
          message.threadId,
          message.dropThread === true,
        );
        return;
      case 'login.exit':
        handlers.loginExit(message.succeeded, message.cancelled);
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
      default:
        return;
    }
  }
  function keepLog(chunk: Buffer) {
    try {
      const taken = takeLog(logUsed, chunk, LOG_BYTES);
      logUsed = taken.used;
      if (!taken.slice?.length) return;
      mkdirSync(join(logFile, '..'), { recursive: true });
      appendFileSync(logFile, taken.slice);
    } catch {
      // A log that cannot be written must not take down the service. Further output is discarded.
      logUsed = LOG_BYTES;
    }
  }
  function launch(): Promise<void> {
    clearTimeout(restartTimer);
    const gen = ++generation;
    ready = false;
    return new Promise<void>((resolve, reject) => {
      const proc = fork(entry, [], {
        execArgv: [],
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      child = proc;
      proc.stdout?.on('data', (chunk: Buffer) => keepLog(chunk));
      proc.stderr?.on('data', (chunk: Buffer) => keepLog(chunk));
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        proc.kill();
        reject(unavailable());
      }, readyMs);
      const succeed = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ready = true;
        failures = 0;
        resolve();
      };
      proc.on('message', (value) => {
        try {
          const message = codexWorkerMessage(value);
          if (!message || message.generation !== gen || child !== proc) return;
          if (message.type === 'ready') {
            limits = message.limits ?? null;
            succeed();
          } else if (message.type !== 'reply') {
            const sessionId = 'sessionId' in message ? message.sessionId : undefined;
            const verdict = takeIpc(ipc, Date.now());
            if (verdict === 'limit' && sessionId) {
              handlers.event(sessionId, {
                type: 'run.error',
                code: 'codex_limited',
                message: 'OpenAI 这一轮的输出太快，已经停下。Claude 不受影响。',
              });
              try {
                send({ type: 'run.abort', generation, sessionId });
              } catch {
                // The worker is already gone.
              }
            }
            if (verdict !== 'ok') return;
            dispatch(message);
          } else dispatch(message);
        } catch {
          // One bad event stays with this worker. The next message is still delivered.
        }
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
          profileId: service.profileId,
          ...(service.model ? { model: service.model } : {}),
          ...(service.turnTimeoutMs && service.turnTimeoutMs > 0
            ? { turnTimeoutMs: service.turnTimeoutMs }
            : {}),
          ...(service.memoryMb && service.pidsMax
            ? {
                memoryMb: service.memoryMb,
                pidsMax: service.pidsMax,
                ...(service.cpuMillis ? { cpuMillis: service.cpuMillis } : {}),
              }
            : {}),
        },
      } satisfies CodexParentMessage);
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
        proc.send({ type: 'shutdown', generation } satisfies CodexParentMessage);
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
    async login() {
      await whenReady();
      return rpc<{ url: string; userCode: string; already?: boolean }>(
        { type: 'account.login', generation },
        30_000,
      );
    },
    loginCancel() {
      if (child?.connected) send({ type: 'account.cancel', generation });
    },
    async accountStatus() {
      await whenReady();
      return rpc<{ loggedIn: boolean; accountType: string | null }>({
        type: 'account.status',
        generation,
      });
    },
    async logout() {
      await whenReady();
      return rpc({ type: 'account.logout', generation });
    },
    async models() {
      await whenReady();
      const result = await rpc<{ models: { id: string; displayName: string }[] }>({
        type: 'model.list',
        generation,
      });
      return result.models;
    },
    startRun(run) {
      send({ type: 'run.start', generation, run });
    },
    steer(sessionId, text) {
      send({ type: 'run.input', generation, sessionId, text });
    },
    readStatus() {
      return rpc<{
        rateLimits: {
          available: boolean;
          windows: { name: string; utilization: number; resetsAt: string | null }[];
          measuredAt: string;
        } | null;
      }>({ type: 'status.read', generation });
    },
    abort(sessionId) {
      send({ type: 'run.abort', generation, sessionId });
    },
    async forkThread(threadId) {
      const result = await rpc<{ threadId?: string }>({
        type: 'thread.fork',
        generation,
        threadId,
      });
      if (!result.threadId) throw new DomainError('codex_failed', 'Codex 没有返回分叉后的会话编号。');
      return result.threadId;
    },
    stopTask(sessionId, taskId) {
      if (child?.connected) send({ type: 'task.stop', generation, sessionId, taskId });
    },
    resolveApproval(sessionId, approvalId, allowed, answers) {
      send({
        type: 'approval.resolve',
        generation,
        sessionId,
        approvalId,
        allowed,
        ...(answers ? { answers } : {}),
      });
    },
    openTerminal(terminal) {
      return rpc({ type: 'terminal.open', generation, terminal }).then(() => undefined);
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
    limits() {
      return limits;
    },
    closeTerminal(sessionId, terminalId) {
      if (!child?.connected) return Promise.resolve();
      return rpc({ type: 'terminal.close', generation, sessionId, terminalId }).then(
        () => undefined,
      );
    },
  };
}
