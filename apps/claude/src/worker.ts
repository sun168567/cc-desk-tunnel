import { randomUUID } from 'node:crypto';
import {
  deleteSession,
  forkSession,
  getSessionMessages,
  renameSession,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  AccountSnapshot,
  ClaudeConfig,
  ForkResult,
  ParentMessage,
  RunStart,
  TerminalStart,
  WorkerMessage,
} from '@cc-desk-tunnel/agent-ipc';
import type { EventPayload, NativeSettings } from '@cc-desk-tunnel/protocol';
import { nativeDirectory, prepareNativeDirectory, readNativeStatus, runClaude } from './claude.ts';
import type { ClaudeOptions, ClaudeRun } from './claude.ts';
import { DomainError } from './errors.ts';
import { accountLogout, accountStatus, NativeLogin } from './native-account.ts';
import { NativeInput } from './native-input.ts';
import { completeOnboarding } from './native-onboarding.ts';
import { readNativeSettings, updateNativeSettings } from './native-settings.ts';
import { NativeTerminal, terminalArguments, terminalEnvironment } from './native-terminal.ts';

type Approval = (value: { allowed: boolean; answers?: Record<string, string> }) => void;
type LiveRun = {
  controller: AbortController;
  input: NativeInput;
  approvals: Map<string, Approval>;
  controls: ClaudeRun['controls'];
};
type LiveTerminal = { id: string; sessionId: string; process: NativeTerminal };

let generation = 0;
let dataDir = '';
let config: ClaudeConfig = { executable: 'claude' };
const runs = new Map<string, LiveRun>();
const terminals = new Map<string, LiveTerminal>();
const statusReads = new Map<string, AbortController>();
let login: NativeLogin | undefined;

function send(message: WorkerMessage) {
  if (typeof process.send === 'function') process.send(message);
}
function reply(id: string | undefined, result?: unknown) {
  if (id) send({ type: 'reply', generation, id, ok: true, result });
}
function fail(id: string | undefined, error: unknown) {
  if (!id) return;
  const domain = error instanceof DomainError;
  send({
    type: 'reply',
    generation,
    id,
    ok: false,
    code: domain ? error.code : 'internal_error',
    message: error instanceof Error ? error.message : 'Claude worker failed.',
  });
}
function sendEvent(sessionId: string, payload: EventPayload) {
  send({ type: 'event', generation, sessionId, payload });
}
function options(): ClaudeOptions {
  return config;
}
function requireRun(sessionId: string) {
  const run = runs.get(sessionId);
  if (!run) throw new DomainError('run_finishing', '原生运行正在收尾，请待结束后发送。');
  return run;
}

function beginRun(start: RunStart) {
  const controller = new AbortController();
  const input = new NativeInput(start.sessionId, (event) => sendEvent(start.sessionId, event));
  const controls: ClaudeRun['controls'] = {};
  controls.ready = () =>
    send({
      type: 'controls',
      generation,
      sessionId: start.sessionId,
      refresh: !!controls.refresh,
      stopTask: !!controls.stopTask,
    });
  const approvals = new Map<string, Approval>();
  const live: LiveRun = { controller, input, approvals, controls };
  runs.set(start.sessionId, live);
  void finishRun(start, live);
}
async function finishRun(start: RunStart, live: LiveRun) {
  let status: 'completed' | 'failed' | 'cancelled' = 'failed';
  try {
    live.input.submit(start.messageId, start.text);
    status = await runClaude(options(), {
      sessionId: start.sessionId,
      nativeRoot: start.nativeRoot,
      projectPath: start.projectPath,
      terms: start.terms,
      permissionMode: start.permissionMode,
      model: start.model,
      effort: start.effort,
      input: live.input,
      dataDir,
      resume: start.resume,
      signal: live.controller.signal,
      emit: (event) => sendEvent(start.sessionId, event),
      approve: (toolId, waiting) =>
        new Promise((resolve) => {
          const approvalId = randomUUID();
          live.approvals.set(approvalId, resolve);
          send({
            type: 'approval.requested',
            generation,
            sessionId: start.sessionId,
            approvalId,
            toolId,
            waiting,
          });
          if (live.controller.signal.aborted) {
            live.approvals.delete(approvalId);
            resolve({ allowed: false });
          }
        }),
      ssh: { configPath: start.sshConfigPath },
      waiting: (background) =>
        send({ type: 'waiting', generation, sessionId: start.sessionId, background }),
      turnEnded: (turn) =>
        send({ type: 'turnEnded', generation, sessionId: start.sessionId, turn }),
      controls: live.controls,
    });
  } catch (error) {
    sendEvent(start.sessionId, {
      type: 'run.error',
      code: 'native_adapter_failed',
      message: error instanceof Error ? error.message : '原生进程适配失败。',
    });
    status = live.controller.signal.aborted ? 'cancelled' : 'failed';
  } finally {
    if (runs.get(start.sessionId) === live) runs.delete(start.sessionId);
    send({ type: 'run.finished', generation, sessionId: start.sessionId, status });
  }
}

async function forkNative(
  sessionId: string,
  nativeRoot: string,
  title: string,
  beforeMessageId?: string,
): Promise<ForkResult> {
  const dir = nativeDirectory(dataDir, nativeRoot);
  if (!beforeMessageId) {
    return { id: (await forkSession(sessionId, { dir, title })).sessionId, resumable: true };
  }
  const through = await forkSession(sessionId, { dir, upToMessageId: beforeMessageId });
  try {
    const kept = (await getSessionMessages(through.sessionId, { dir })).at(-2);
    if (!kept) return { id: null, resumable: false };
    return {
      id: (await forkSession(through.sessionId, { dir, upToMessageId: kept.uuid, title }))
        .sessionId,
      resumable: true,
    };
  } finally {
    await deleteSession(through.sessionId, { dir });
  }
}

function openTerminal(terminal: TerminalStart) {
  completeOnboarding();
  const session = {
    id: terminal.sessionId,
    projectPath: terminal.projectPath,
    permissionMode: terminal.permissionMode,
    model: terminal.model,
    effort: terminal.effort,
  };
  const process = new NativeTerminal(
    config.executable,
    terminalArguments(options(), session, { configPath: terminal.sshConfigPath }, terminal.terms),
    {
      cwd: prepareNativeDirectory(options(), dataDir, terminal.nativeRoot),
      cols: terminal.cols,
      rows: terminal.rows,
      env: terminalEnvironment(options()),
    },
    (data, bytes) =>
      send({
        type: 'terminal.data',
        generation,
        sessionId: terminal.sessionId,
        terminalId: terminal.terminalId,
        data,
        bytes,
      }),
    (exitCode) => {
      terminals.delete(terminal.sessionId);
      send({
        type: 'terminal.exit',
        generation,
        sessionId: terminal.sessionId,
        terminalId: terminal.terminalId,
        exitCode,
      });
    },
  );
  terminals.set(terminal.sessionId, {
    id: terminal.terminalId,
    sessionId: terminal.sessionId,
    process,
  });
}
function requireTerminal(sessionId: string, terminalId: string) {
  const terminal = terminals.get(sessionId);
  if (!terminal || terminal.id !== terminalId) throw new Error('Terminal is not running');
  return terminal.process;
}

async function onMessage(message: ParentMessage) {
  if (message.type === 'init') {
    generation = message.generation;
    dataDir = message.dataDir;
    config = message.config;
    send({ type: 'ready', generation });
    return;
  }
  if (message.generation !== generation) return;
  try {
    switch (message.type) {
      case 'shutdown': {
        for (const run of runs.values()) {
          run.controller.abort();
          run.input.close();
        }
        login?.cancel();
        await Promise.all([...terminals.values()].map((terminal) => terminal.process.close()));
        process.exit(0);
        return;
      }
      case 'run.start':
        beginRun(message.run);
        return;
      case 'run.abort': {
        const run = runs.get(message.sessionId);
        run?.controller.abort();
        run?.input.close();
        if (run)
          for (const [id, resolve] of run.approvals) {
            run.approvals.delete(id);
            resolve({ allowed: false });
          }
        return;
      }
      case 'input.reserve':
        requireRun(message.sessionId).input.assertWritable();
        reply(message.id);
        return;
      case 'input.submit':
        requireRun(message.sessionId).input.submit(message.messageId, message.text);
        return;
      case 'approval.resolve': {
        const resolve = runs.get(message.sessionId)?.approvals.get(message.approvalId);
        if (!resolve) return;
        runs.get(message.sessionId)?.approvals.delete(message.approvalId);
        resolve({ allowed: message.allowed, answers: message.answers });
        return;
      }
      case 'task.stop':
        await runs.get(message.sessionId)?.controls.stopTask?.(message.taskId);
        reply(message.id);
        return;
      case 'status.refresh': {
        const refresh = runs.get(message.sessionId)?.controls.refresh;
        if (!refresh) throw new DomainError('native_busy', '运行结束后再刷新原生状态。');
        await refresh();
        reply(message.id);
        return;
      }
      case 'status.read': {
        const controller = new AbortController();
        if (message.id) statusReads.set(message.id, controller);
        try {
          reply(
            message.id,
            await readNativeStatus(
              options(),
              dataDir,
              message.nativeRoot,
              message.sessionId,
              controller.signal,
            ),
          );
        } finally {
          if (message.id) statusReads.delete(message.id);
        }
        return;
      }
      case 'status.abort':
        if (message.id) statusReads.get(message.id)?.abort();
        return;
      case 'session.delete':
        await deleteSession(message.sessionId, {
          dir: nativeDirectory(dataDir, message.nativeRoot),
        });
        reply(message.id);
        return;
      case 'session.rename':
        await renameSession(message.sessionId, message.title, {
          dir: nativeDirectory(dataDir, message.nativeRoot),
        });
        reply(message.id);
        return;
      case 'session.fork':
        reply(
          message.id,
          await forkNative(
            message.sessionId,
            message.nativeRoot,
            message.title,
            message.beforeMessageId,
          ),
        );
        return;
      case 'terminal.open':
        openTerminal(message.terminal);
        reply(message.id);
        return;
      case 'terminal.input':
        requireTerminal(message.sessionId, message.terminalId).write(message.data);
        return;
      case 'terminal.resize':
        requireTerminal(message.sessionId, message.terminalId).resize(message.cols, message.rows);
        return;
      case 'terminal.ack':
        try {
          requireTerminal(message.sessionId, message.terminalId).acknowledge(message.bytes);
        } catch {
          send({
            type: 'terminal.fault',
            generation,
            sessionId: message.sessionId,
            terminalId: message.terminalId,
          });
        }
        return;
      case 'terminal.close':
        await terminals.get(message.sessionId)?.process.close();
        reply(message.id);
        return;
      case 'account.status':
        reply(message.id, (await accountStatus(config.executable)) satisfies AccountSnapshot);
        return;
      case 'account.login': {
        if (!login) {
          const current = new NativeLogin(
            config.executable,
            (succeeded) => {
              if (login !== current) return;
              login = undefined;
              if (succeeded) completeOnboarding();
              send({ type: 'login.exit', generation, succeeded, cancelled: current.cancelled });
            },
            (text) => {
              if (login === current) send({ type: 'login.notice', generation, text });
            },
          );
          login = current;
        }
        reply(message.id, { url: await login.url });
        return;
      }
      case 'account.code':
        login?.submit(message.code);
        return;
      case 'account.cancel':
        login?.cancel();
        return;
      case 'account.logout':
        login?.cancel();
        await accountLogout(config.executable);
        reply(message.id);
        return;
      case 'settings.get':
        reply(message.id, readNativeSettings() satisfies NativeSettings);
        return;
      case 'settings.update':
        reply(message.id, updateNativeSettings(message.values) satisfies NativeSettings);
        return;
      default:
        return;
    }
  } catch (error) {
    fail(message.id, error);
  }
}

process.on('message', (value: ParentMessage) => {
  void onMessage(value);
});
