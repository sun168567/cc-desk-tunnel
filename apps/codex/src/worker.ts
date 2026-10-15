import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import type {
  CodexLimits,
  CodexParentMessage,
  CodexRunStart,
  CodexWorkerMessage,
} from '@cc-desk-tunnel/agent-ipc';
import type { EventPayload, PermissionMode } from '@cc-desk-tunnel/protocol';
import { moveToCgroup, planLaunch, prepareCgroup, prlimitAvailable, limitReport } from './limits.ts';
import { codexTurnPolicy, policyRejected } from './policy.ts';

type Rpc = {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { message?: string };
  consumed?: boolean;
};

type QuestionDecision = { allowed: boolean; answers?: Record<string, string> };

type TokenUse = {
  input: number;
  output: number;
  cached: number;
  total: number;
  window: number | null;
};

type Live = {
  threadId: string | null;
  turnId: string | null;
  messageId: string;
  approvals: Map<string, (decision: QuestionDecision) => void>;
  commands: Map<string, string>;
  usage?: TokenUse;
};

let generation = 0;
let home = '';
let executable = 'codex';
let model: string | undefined;
let turnTimeoutMs = 120_000;
let budget: { memoryMb: number; pids: number; cpuMillis?: number } | undefined;
let workerGrouped = false;
let appliedLimits: CodexLimits = {
  kind: 'none',
  memory: false,
  memoryMb: 0,
  pids: 0,
  cpu: false,
  cpuMillis: 0,
};
let app: App | undefined;
let loginId: string | undefined;
const runs = new Map<string, Live>();
const aborting = new Set<string>();
const terminals = new Map<string, { id: string; pty: CodexPty }>();

type CodexPty = {
  write(text: string): void;
  resize(cols: number, rows: number): void;
  acknowledge(bytes: number): void;
  close(): Promise<void>;
};

process.on('message', (message: CodexParentMessage) => {
  if (message.generation !== generation && message.type !== 'init') return;
  void handle(message).catch((error: unknown) => {
    const text = error instanceof Error ? error.message : String(error);
    if (message.id) fail(message.id, 'codex_failed', text);
  });
});

async function handle(message: CodexParentMessage) {
  switch (message.type) {
    case 'init': {
      generation = message.generation;
      executable = message.config.executable;
      model = message.config.model;
      turnTimeoutMs =
        message.config.turnTimeoutMs && message.config.turnTimeoutMs > 0
          ? message.config.turnTimeoutMs
          : 120_000;
      home = join(message.dataDir, 'providers', 'openai', message.config.profileId);
      mkdirSync(home, { recursive: true });
      budget =
        message.config.memoryMb && message.config.pidsMax
          ? {
              memoryMb: message.config.memoryMb,
              pids: message.config.pidsMax,
              ...(message.config.cpuMillis ? { cpuMillis: message.config.cpuMillis } : {}),
            }
          : undefined;
      const scriptExecutable =
        message.config.executable.endsWith('.mjs') || message.config.executable.endsWith('.js');
      // The worker joins the group before Codex is spawned, so the runtime and its children inherit it.
      // A script double is the test app-server: limiting this process would limit Node, not Codex.
      if (!scriptExecutable && budget) {
        const leaf = prepareCgroup(budget);
        workerGrouped = !!(leaf && moveToCgroup(leaf, process.pid));
      }
      try {
        app = startApp(message.config.executable, home);
        await app.request('initialize', {
          clientInfo: { name: 'cc-desk-tunnel', title: 'CC Desk Tunnel', version: '0' },
        });
        app.notify('initialized', {});
        send({ type: 'ready', generation, limits: appliedLimits });
      } catch {
        process.exit(1);
      }
      return;
    }
    case 'shutdown':
      for (const [sessionId] of runs) await interrupt(sessionId);
      for (const terminal of terminals.values()) await terminal.pty.close();
      app?.close();
      process.exit(0);
      return;
    case 'account.status':
      reply(message.id, await readAccount());
      return;
    case 'account.login':
      reply(message.id, await beginLogin());
      return;
    case 'account.cancel':
      if (loginId) await app?.request('account/login/cancel', { loginId }).catch(() => undefined);
      loginId = undefined;
      send({ type: 'login.exit', generation, succeeded: false, cancelled: true });
      return;
    case 'account.logout':
      await app?.request('account/logout', {});
      reply(message.id, { loggedIn: false });
      return;
    case 'model.list':
      reply(message.id, { models: await listModels() });
      return;
    case 'run.start':
      void beginRun(message.run);
      return;
    case 'run.abort':
      aborting.add(message.sessionId);
      await interrupt(message.sessionId);
      return;
    case 'thread.fork': {
      try {
        const started = (await app!.request('thread/fork', {
          threadId: message.threadId,
        })) as { thread?: { id?: string } };
        const threadId = started.thread?.id;
        if (!threadId) throw new Error('Codex 没有返回分叉后的会话编号。');
        reply(message.id, { threadId });
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        if (!message.id) return;
        if (methodMissing(text))
          fail(message.id, 'fork_unsupported', '当前 Codex 不认识会话分叉。');
        else fail(message.id, 'codex_failed', text);
      }
      return;
    }
    case 'task.stop': {
      const live = runs.get(message.sessionId);
      if (!live?.commands.has(message.taskId) || !app) {
        emit(message.sessionId, { type: 'native.notice', text: '这条命令已经结束。' });
        return;
      }
      try {
        await app.request('item/commandExecution/cancel', {
          threadId: live.threadId,
          turnId: live.turnId,
          itemId: message.taskId,
        });
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        emit(message.sessionId, {
          type: 'native.notice',
          text: methodMissing(text)
            ? '当前 Codex 不能单独停止这一条命令。可以停止整轮。'
            : `没有停掉这条命令：${text}`,
        });
      }
      return;
    }
    case 'run.input': {
      const live = runs.get(message.sessionId);
      if (!live?.threadId || !app) return;
      try {
        await app.request('turn/steer', {
          threadId: live.threadId,
          ...(live.turnId ? { expectedTurnId: live.turnId } : {}),
          input: [{ type: 'text', text: message.text }],
        });
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        emit(message.sessionId, {
          type: 'run.error',
          code: 'codex_failed',
          message: methodMissing(text)
            ? '这一轮进行中，当前 Codex 不能追加消息。'
            : text,
        });
      }
      return;
    }
    case 'status.read':
      reply(message.id, { rateLimits: await readLimits() });
      return;
    case 'terminal.open': {
      const { CodexTerminal } = await import('./terminal.ts');
      const spec = message.terminal;
      const opened = await CodexTerminal.open({
        executable,
        home,
        sessionId: spec.sessionId,
        cols: spec.cols,
        rows: spec.rows,
        resumeThreadId: spec.resumeThreadId,
        instructions: spec.instructions,
        limits: budget,
        onData: (data, bytes) =>
          send({
            type: 'terminal.data',
            generation,
            sessionId: spec.sessionId,
            terminalId: spec.terminalId,
            data,
            bytes,
          }),
        onExit: (exitCode) => {
          if (terminals.get(spec.sessionId)?.id === spec.terminalId)
            terminals.delete(spec.sessionId);
          send({
            type: 'terminal.exit',
            generation,
            sessionId: spec.sessionId,
            terminalId: spec.terminalId,
            exitCode,
          });
        },
      });
      terminals.set(spec.sessionId, { id: spec.terminalId, pty: opened });
      reply(message.id, {});
      return;
    }
    case 'terminal.close': {
      const open = terminals.get(message.sessionId);
      if (open?.id === message.terminalId) {
        terminals.delete(message.sessionId);
        await open.pty.close();
      }
      reply(message.id, {});
      return;
    }
    case 'terminal.input':
      terminals.get(message.sessionId)?.pty.write(message.data);
      return;
    case 'terminal.resize':
      terminals.get(message.sessionId)?.pty.resize(message.cols, message.rows);
      return;
    case 'terminal.ack':
      try {
        terminals.get(message.sessionId)?.pty.acknowledge(message.bytes);
      } catch {
        send({
          type: 'terminal.fault',
          generation,
          sessionId: message.sessionId,
          terminalId: message.terminalId,
        });
      }
      return;
    case 'approval.resolve': {
      const decide = runs.get(message.sessionId)?.approvals.get(message.approvalId);
      runs.get(message.sessionId)?.approvals.delete(message.approvalId);
      decide?.({ allowed: message.allowed, answers: message.answers });
      return;
    }
    default:
      return;
  }
}

async function beginLogin() {
  const current = await readAccount();
  if (current.loggedIn) {
    send({ type: 'login.exit', generation, succeeded: true, cancelled: false });
    return { url: '', userCode: '', already: true };
  }
  const started = (await app!.request('account/login/start', { type: 'chatgptDeviceCode' })) as {
    loginId?: string;
    verificationUrl?: string;
    userCode?: string;
  };
  loginId = started.loginId;
  void app!
    .waitFor((item) => item.method === 'account/login/completed', 300_000)
    .then((done) => {
      const success = done?.params?.success === true;
      loginId = undefined;
      send({ type: 'login.exit', generation, succeeded: success, cancelled: false });
    });
  return { url: started.verificationUrl ?? '', userCode: started.userCode ?? '' };
}

async function readAccount() {
  const status = (await app!.request('account/read', { refreshToken: false })) as {
    account?: { type?: string } | null;
  };
  return { loggedIn: Boolean(status.account), accountType: status.account?.type ?? null };
}

async function listModels() {
  const listed = (await app!.request('model/list', { limit: 20, includeHidden: false })) as {
    models?: { id?: string; model?: string; displayName?: string }[];
    data?: { id?: string; model?: string; displayName?: string }[];
  };
  const rows = listed.models ?? listed.data ?? [];
  return rows
    .map((row) => ({
      id: row.id ?? row.model ?? '',
      displayName: row.displayName ?? row.id ?? row.model ?? '',
    }))
    .filter((row) => row.id);
}

function finishRun(
  sessionId: string,
  status: 'completed' | 'failed' | 'cancelled',
  unknown: boolean | undefined,
  threadId: string | null,
  dropThread = false,
) {
  send({
    type: 'run.finished',
    generation,
    sessionId,
    status,
    ...(unknown === undefined ? {} : { unknown }),
    ...(threadId ? { threadId } : {}),
    ...(dropThread ? { dropThread: true } : {}),
  });
}

// The same tool names the Claude transcript already knows how to draw.
function toolAsk(
  method: string | undefined,
  params: Record<string, unknown> | undefined,
  toolId: string,
): EventPayload | null {
  if (method === 'item/commandExecution/requestApproval') {
    const command = typeof params?.command === 'string' ? params.command : '';
    return {
      type: 'tool.requested',
      toolId,
      name: 'Bash',
      input: JSON.stringify({ command }),
      target: 'Linux',
    };
  }
  if (method === 'item/fileChange/requestApproval') {
    const path = filePathOf(params);
    return {
      type: 'tool.requested',
      toolId,
      name: 'Edit',
      input: JSON.stringify({ file_path: path, old_string: '', new_string: '' }),
      target: 'Linux',
    };
  }
  return null;
}

function filePathOf(params: Record<string, unknown> | undefined) {
  for (const key of ['file_path', 'path', 'filePath']) {
    const value = params?.[key];
    if (typeof value === 'string' && value) return value;
  }
  return '文件';
}

async function beginRun(run: CodexRunStart) {
  const live: Live = {
    threadId: null,
    turnId: null,
    messageId: randomUUID(),
    approvals: new Map(),
    commands: new Map(),
  };
  runs.set(run.sessionId, live);
  try {
    if (run.effort) writeEffort(home, run.effort);
    const chosen = run.model ?? model;
    const started = run.resumeThreadId
      ? ((await app!.request('thread/resume', {
          threadId: run.resumeThreadId,
          ...(chosen ? { model: chosen } : {}),
        })) as { thread?: { id?: string } })
      : ((await app!.request('thread/start', chosen ? { model: chosen } : {})) as {
          thread?: { id?: string };
        });
    live.threadId = started.thread?.id ?? run.resumeThreadId ?? null;
    if (!live.threadId) throw new Error('Codex 没有返回会话编号。');
    if (run.compact) {
      try {
        await app!.request('thread/compact', { threadId: live.threadId });
        emit(run.sessionId, { type: 'native.compact', trigger: 'manual', previousTokens: null });
        finishRun(run.sessionId, 'completed', undefined, live.threadId);
        return;
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        // An older app-server has no compact method. The slash command is the same request Claude sends.
        if (!/unknown method|method not found|not implemented|unsupported|-32601/i.test(text))
          throw error;
      }
    }
    const turn = (await startTurn(live.threadId, run.text, run.permissionMode)) as {
      turn?: { id?: string };
    };
    live.turnId = turn.turn?.id ?? null;
    if (aborting.has(run.sessionId)) await interrupt(run.sessionId);
    const outcome = await follow(run.sessionId, live);
    finishRun(run.sessionId, outcome.status, outcome.unknown, live.threadId);
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    emit(run.sessionId, { type: 'run.error', code: 'codex_failed', message: text });
    // A resume that never started a thread must not keep the id that failed.
    finishRun(run.sessionId, 'failed', undefined, live.threadId, !live.threadId && !!run.resumeThreadId);
  } finally {
    aborting.delete(run.sessionId);
    runs.delete(run.sessionId);
  }
}

async function follow(sessionId: string, live: Live) {
  const deadline = Date.now() + turnTimeoutMs;
  while (Date.now() < deadline) {
    const message = await app!.waitFor(
      (item) =>
        item.method === 'item/agentMessage/delta' ||
        item.method === 'item/commandExecution/requestApproval' ||
        item.method === 'item/fileChange/requestApproval' ||
        isQuestion(item.method) ||
        item.method === 'item/started' ||
        item.method === 'item/completed' ||
        item.method === 'turn/completed',
      Math.max(1, deadline - Date.now()),
    );
    if (!message) break;
    if (message.method === 'item/agentMessage/delta') {
      const text = deltaText(message.params);
      if (text) emit(sessionId, { type: 'text.delta', messageId: live.messageId, text });
      continue;
    }
    if (message.method === 'item/started') {
      const item = message.params?.item as
        | { id?: string; type?: string; command?: string }
        | undefined;
      if (item?.type === 'commandExecution' && item.id) {
        live.commands.set(item.id, item.command?.trim() || '命令');
        publishCommands(sessionId, live);
      }
      continue;
    }
    if (message.method === 'item/completed') {
      const item = message.params?.item as {
        id?: string;
        status?: string;
        aggregatedOutput?: unknown;
        diff?: unknown;
      } | undefined;
      const tracked = !!(item?.id && live.commands.delete(item.id));
      if (tracked) publishCommands(sessionId, live);
      if (item?.id && !tracked)
        emit(sessionId, {
          type: 'tool.result',
          toolId: item.id,
          status: toolStatus(item.status),
          output: itemOutput(item),
          exitCode: null,
        });
      continue;
    }
    if (message.method === 'turn/completed') {
      const spent = live.usage;
      if (spent)
        emit(sessionId, {
          type: 'turn.stats',
          messageId: live.messageId,
          requests: 1,
          inputTokens: spent.input,
          outputTokens: spent.output,
          cacheReadTokens: spent.cached,
          cacheCreationTokens: 0,
          modelMs: 0,
          ttftMs: null,
          outputPerSecond: null,
          partial: false,
        });
      const status = (message.params?.turn as { status?: string } | undefined)?.status ?? null;
      if (status === 'interrupted') return { status: 'cancelled' as const, unknown: false };
      if (status === 'failed') return { status: 'failed' as const, unknown: false };
      if (status === 'completed') return { status: 'completed' as const, unknown: false };
      return { status: 'failed' as const, unknown: true };
    }
    const toolId = typeof message.params?.itemId === 'string' ? message.params.itemId : 'tool';
    const approvalId = randomUUID();
    const question = isQuestion(message.method);
    const waiting = question ? 'question' : 'approval';
    const kind = question
      ? 'question'
      : message.method === 'item/fileChange/requestApproval'
        ? 'file'
        : 'command';
    const questions = question ? askedQuestions(message.params) : [];
    const asked = questions.length
      ? {
          type: 'tool.requested' as const,
          toolId,
          name: 'AskUserQuestion',
          input: JSON.stringify({
            questions: questions.map(({ question: prompt, header, options }) => ({
              question: prompt,
              ...(header ? { header } : {}),
              options,
            })),
          }),
          target: 'Linux' as const,
        }
      : toolAsk(message.method, message.params, toolId);
    if (asked) emit(sessionId, asked);
    send({
      type: 'approval.requested',
      generation,
      sessionId,
      approvalId,
      toolId,
      waiting,
      kind,
    });
    const decision = await new Promise<QuestionDecision>((resolve) =>
      live.approvals.set(approvalId, resolve),
    );
    if (message.method === 'item/tool/requestUserInput')
      app!.respond(message.id!, codexAnswers(message.params, decision));
    else if (question)
      app!.respond(message.id!, {
        action: decision.allowed ? 'accept' : 'decline',
        content: null,
      });
    else app!.respond(message.id!, { decision: decision.allowed ? 'accept' : 'decline' });
  }
  emit(sessionId, {
    type: 'run.error',
    code: 'result_unknown',
    message: 'Codex 没有在时限内结束这一轮，结果未知。',
  });
  return { status: 'failed' as const, unknown: true };
}

async function interrupt(sessionId: string) {
  const live = runs.get(sessionId);
  if (!live?.threadId || !live.turnId || !app) return;
  await app
    .request('turn/interrupt', { threadId: live.threadId, turnId: live.turnId })
    .catch(() => undefined);
}

const QUESTION_METHODS = new Set(['tool/requestUserInput', 'item/tool/requestUserInput']);

function isQuestion(method: string | undefined) {
  return method !== undefined && QUESTION_METHODS.has(method);
}

function askedQuestions(params: Record<string, unknown> | undefined) {
  const raw = params?.questions;
  if (!Array.isArray(raw)) return [];
  const questions = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const row = item as { id?: unknown; question?: unknown; header?: unknown; options?: unknown };
    if (typeof row.id !== 'string' || !row.id || typeof row.question !== 'string' || !row.question)
      continue;
    const options = Array.isArray(row.options)
      ? row.options.flatMap((option) => {
          if (!option || typeof option !== 'object') return [];
          const label = (option as { label?: unknown }).label;
          if (typeof label !== 'string' || !label) return [];
          const description = (option as { description?: unknown }).description;
          return [{ label, ...(typeof description === 'string' ? { description } : {}) }];
        })
      : [];
    questions.push({
      id: row.id,
      question: row.question,
      ...(typeof row.header === 'string' && row.header ? { header: row.header } : {}),
      options,
    });
  }
  return questions;
}

function codexAnswers(params: Record<string, unknown> | undefined, decision: QuestionDecision) {
  const answers: Record<string, { answers: string[] }> = {};
  if (decision.allowed) {
    for (const question of askedQuestions(params)) {
      const text = decision.answers?.[question.id] ?? decision.answers?.[question.question];
      const values = text
        ?.split(', ')
        .map((part) => part.trim())
        .filter(Boolean);
      if (values?.length) answers[question.id] = { answers: values };
    }
  }
  return { answers };
}

function deltaText(params: Record<string, unknown> | undefined) {
  if (!params) return '';
  if (typeof params.delta === 'string') return params.delta;
  if (typeof params.text === 'string') return params.text;
  return '';
}

function toolStatus(
  status: string | undefined,
): 'completed' | 'denied' | 'cancelled' | 'failed' | 'unknown' {
  if (status === 'completed') return 'completed';
  if (status === 'declined') return 'denied';
  if (status === 'failed') return 'failed';
  if (status === 'cancelled') return 'cancelled';
  return 'unknown';
}

async function startTurn(threadId: string, text: string, mode: PermissionMode | undefined) {
  const input = [{ type: 'text' as const, text }];
  const policy = mode ? codexTurnPolicy(mode) : undefined;
  try {
    return await app!.request('turn/start', { threadId, input, ...(policy ?? {}) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!policy || !policyRejected(message)) throw error;
    // Plan and bypass are the modes whose meaning is the sandbox. Running without it would
    // edit anyway, or keep asking. The other modes still have the server decide each prompt.
    if (mode === 'plan' || mode === 'bypassPermissions')
      throw new Error('当前 Codex 不接受这一轮的审批策略，没有开始。');
    return app!.request('turn/start', { threadId, input });
  }
}

function startApp(executable: string, cwd: string) {
  const args = ['app-server', '--listen', 'stdio://'];
  const script = executable.endsWith('.mjs') || executable.endsWith('.js');
  const plainCommand = script ? process.execPath : executable;
  const plainArgs = script ? [executable, ...args] : args;
  const leaf = !script && budget ? prepareCgroup(budget) : undefined;
  // A script is the test double. Wrapping it would limit Node, not Codex.
  const spec = script
    ? { command: plainCommand, args: plainArgs, wrapped: false }
    : planLaunch({
        executable: plainCommand,
        args: plainArgs,
        limits: budget,
        prlimit: prlimitAvailable(),
        cgroup: !!leaf,
      });
  const child = spawn(spec.command, spec.args, {
    cwd,
    env: childEnv(cwd),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  }) as ChildProcessWithoutNullStreams;
  const moved = workerGrouped || !!(leaf && child.pid && moveToCgroup(leaf, child.pid));
  appliedLimits = limitReport({ limits: budget, wrapped: spec.wrapped, cgroup: moved });
  return new App(child);
}

function childEnv(cwd: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: cwd };
  for (const key of Object.keys(env)) {
    if (/^(?:CLAUDE|ANTHROPIC)_/i.test(key)) delete env[key];
  }
  return env;
}

class App {
  private next = 1;
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private inbox: Rpc[] = [];
  private waiters: (() => void)[] = [];
  private child: ChildProcessWithoutNullStreams;
  private closed = false;

  constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    child.stderr.on('data', (chunk) => process.stderr.write(chunk));
    child.stdin.on('error', () => {});
    child.on('exit', () => {
      this.closed = true;
      const error = new Error('Codex 进程已退出。');
      for (const [id, pending] of this.pending) {
        this.pending.delete(id);
        pending.reject(error);
      }
      for (const wake of this.waiters.splice(0)) wake();
    });
    createInterface({ input: child.stdout }).on('line', (line) => {
      let message: Rpc;
      try {
        message = JSON.parse(line) as Rpc;
      } catch {
        return;
      }
      if (
        message.id !== undefined &&
        this.pending.has(Number(message.id)) &&
        (message.result !== undefined || message.error)
      ) {
        const pending = this.pending.get(Number(message.id))!;
        this.pending.delete(Number(message.id));
        if (message.error) pending.reject(new Error(message.error.message ?? 'Codex 请求失败。'));
        else pending.resolve(message.result);
        return;
      }
      if (message.method === 'thread/tokenUsage/updated') {
        rememberUsage(message.params);
        return;
      }
      if (message.method === 'account/rateLimits/updated') {
        const limits = limitsOf(message.params);
        if (limits) publishLimits(limits);
        return;
      }
      this.inbox.push(message);
      for (const wake of this.waiters) wake();
    });
  }

  request(method: string, params: unknown, timeoutMs = 30_000) {
    if (this.closed) return Promise.reject(new Error('Codex 进程已退出。'));
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Codex 请求超时：' + method));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.send({ method, id, params });
    });
  }

  notify(method: string, params: unknown) {
    this.send({ method, params });
  }

  respond(id: number | string, result: unknown) {
    this.send({ id, result });
  }

  waitFor(predicate: (message: Rpc) => boolean, timeoutMs: number) {
    const existing = this.inbox.find((item) => !item.consumed && predicate(item));
    if (existing) {
      existing.consumed = true;
      return Promise.resolve(existing);
    }
    return new Promise<Rpc | null>((resolve) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((waiter) => waiter !== wake);
        resolve(null);
      }, timeoutMs);
      const wake = () => {
        const found = this.inbox.find((item) => !item.consumed && predicate(item));
        if (!found) return;
        clearTimeout(timer);
        found.consumed = true;
        this.waiters = this.waiters.filter((waiter) => waiter !== wake);
        resolve(found);
      };
      this.waiters.push(wake);
    });
  }

  close() {
    this.child.kill();
  }

  private send(message: unknown) {
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }
}

function publishCommands(sessionId: string, live: Live) {
  emit(sessionId, {
    type: 'native.tasks',
    tasks: [...live.commands].map(([id, description]) => ({
      id,
      kind: 'command',
      description,
    })),
  });
}

function methodMissing(text: string) {
  return /unknown method|method not found|not implemented|unsupported|-32601/i.test(text);
}

function writeEffort(directory: string, effort: string) {
  const mapped = effort === 'max' ? 'xhigh' : effort;
  if (!['low', 'medium', 'high', 'xhigh'].includes(mapped)) return;
  const path = join(directory, 'config.toml');
  let text = '';
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    text = '';
  }
  const line = `model_reasoning_effort = "${mapped}"`;
  const next = /^model_reasoning_effort\s*=.*$/m.test(text)
    ? text.replace(/^model_reasoning_effort\s*=.*$/m, line)
    : `${text.trimEnd()}\n${line}\n`;
  writeFileSync(path, next.startsWith('\n') ? next.slice(1) : next);
}

function amount(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function pick(record: Record<string, unknown> | undefined, ...keys: string[]) {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === 'number' || typeof value === 'string') return amount(value);
  }
  return 0;
}

function rememberUsage(params: Record<string, unknown> | undefined) {
  const tokenUsage = (params?.tokenUsage ?? params) as Record<string, unknown> | undefined;
  const last = (tokenUsage?.last ?? tokenUsage?.total) as Record<string, unknown> | undefined;
  if (!last) return;
  const window = pick(tokenUsage, 'modelContextWindow', 'model_context_window');
  const usage: TokenUse = {
    input: pick(last, 'inputTokens', 'input_tokens'),
    output: pick(last, 'outputTokens', 'output_tokens'),
    cached: pick(last, 'cachedInputTokens', 'cached_input_tokens'),
    total: pick(last, 'totalTokens', 'total_tokens'),
    window: window > 0 ? window : null,
  };
  const threadId = typeof params?.threadId === 'string' ? params.threadId : undefined;
  for (const live of runs.values())
    if (!threadId || live.threadId === threadId) live.usage = usage;
}

function limitsOf(params: Record<string, unknown> | undefined) {
  const body = (params?.rateLimits ?? params) as Record<string, unknown> | undefined;
  const primary = body?.primary as Record<string, unknown> | undefined;
  const secondary = body?.secondary as Record<string, unknown> | undefined;
  const windowOf = (name: string, source: Record<string, unknown> | undefined) => {
    if (!source) return null;
    const used = source.usedPercent ?? source.used_percent;
    if (typeof used !== 'number') return null;
    const reset = source.resetsAt ?? source.resets_at;
    let resetsAt: string | null = null;
    if (typeof reset === 'number' && Number.isFinite(reset)) {
      const ms = reset > 1e12 ? reset : reset * 1000;
      resetsAt = new Date(ms).toISOString();
    } else if (typeof reset === 'string' && !Number.isNaN(Date.parse(reset)))
      resetsAt = new Date(reset).toISOString();
    return { name, utilization: used, resetsAt };
  };
  const windows = [windowOf('five_hour', primary), windowOf('seven_day', secondary)].filter(
    (window): window is { name: string; utilization: number; resetsAt: string | null } => !!window,
  );
  if (!windows.length) return null;
  return {
    available: true as const,
    windows,
    measuredAt: new Date().toISOString(),
  };
}

function publishLimits(
  rateLimits: NonNullable<ReturnType<typeof limitsOf>>,
  sessionId?: string,
) {
  const targets = sessionId ? [sessionId] : [...runs.keys()];
  for (const id of targets) {
    const live = runs.get(id);
    const spent = live?.usage;
    const percentage =
      spent?.window && spent.total >= 0 ? Math.min(100, (spent.total / spent.window) * 100) : null;
    emit(id, {
      type: 'native.metrics',
      context:
        spent?.window && percentage !== null
          ? {
              model: model ?? 'codex',
              usedTokens: spent.total,
              windowTokens: spent.window,
              percentage,
              measuredAt: rateLimits.measuredAt,
              categories: [
                { name: '已用', tokens: Math.min(spent.total, spent.window), kind: 'used' },
                {
                  name: '剩余',
                  tokens: Math.max(0, spent.window - spent.total),
                  kind: 'free',
                },
              ],
            }
          : null,
      usage: null,
      rateLimits,
    });
  }
}

async function readLimits() {
  try {
    const result = (await app!.request('account/rateLimits/read', {})) as Record<string, unknown>;
    return limitsOf(result);
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    if (methodMissing(text)) return null;
    throw error;
  }
}

function itemOutput(item: { aggregatedOutput?: unknown; diff?: unknown }) {
  const text =
    typeof item.aggregatedOutput === 'string'
      ? item.aggregatedOutput
      : typeof item.diff === 'string'
        ? item.diff
        : '';
  return text.slice(0, 4000);
}

function emit(sessionId: string, payload: EventPayload) {
  send({ type: 'event', generation, sessionId, payload });
}

function reply(id: string | undefined, result: unknown) {
  if (!id) return;
  send({ type: 'reply', generation, id, ok: true, result });
}

function fail(id: string, code: string, message: string) {
  send({ type: 'reply', generation, id, ok: false, code, message });
}

// One IPC message past this is replaced. The parent must not receive an unbounded blob.
const IPC_BYTES = 256 * 1024;

export function clipIpc(message: CodexWorkerMessage): CodexWorkerMessage | undefined {
  if (JSON.stringify(message).length <= IPC_BYTES) return message;
  if (message.type !== 'event') return undefined;
  return {
    type: 'event',
    generation: message.generation,
    sessionId: message.sessionId,
    payload: {
      type: 'run.error',
      code: 'codex_limited',
      message: '这一轮的输出超过了单条消息上限，已经截断。',
    },
  };
}

function send(message: CodexWorkerMessage) {
  const fitted = clipIpc(message);
  if (fitted) process.send?.(fitted);
}
