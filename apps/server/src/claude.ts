import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { query, getSessionInfo } from '@anthropic-ai/claude-agent-sdk';
import type { Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Effort, EventPayload, NativeMetrics, PermissionMode } from '@cc-desk-tunnel/protocol';
import { ClaudeStream } from './claude-stream.ts';
import type { SshConnection } from './tunnel.ts';
import { nativeCapabilities, nativeContextRefresh, nativeMetrics } from './native-controls.ts';
import type { NativeInput } from './native-input.ts';

export type ClaudeOptions = {
  executable: string;
  model?: string;
  settingsPath?: string;
  maxTurns?: number;
  contextRetentionDays?: number;
  // Added to the CLI's inherited environment; set by the service for its usage collector.
  environment?: Record<string, string>;
};
export type ClaudeRun = {
  sessionId: string;
  // The session whose Linux directory holds this session's native history; itself unless it is a fork.
  nativeRoot: string;
  projectPath: string;
  permissionMode: PermissionMode;
  model?: string | null;
  effort?: Effort | null;
  input: NativeInput;
  dataDir: string;
  resume: boolean;
  signal: AbortSignal;
  emit: (event: EventPayload) => void;
  // Asks the user about a tool call. A question Claude asks comes back with the answers chosen.
  approve: (
    toolId: string,
    waiting: 'approval' | 'question',
  ) => Promise<{ allowed: boolean; answers?: Record<string, string> }>;
  ssh: SshConnection;
  // Told when Claude has finished its turn and the run goes on only for background tasks, and when it resumes.
  waiting: (background: boolean) => void;
  // Filled in while the CLI is running, so the service can ask it for fresh account quota mid-run and end
  // one of its background tasks.
  controls: { refresh?: () => Promise<void>; stopTask?: (taskId: string) => Promise<void> };
};
// `sessionId` is the proxy's name for the session, which a scheduled task needs to continue it.
export function remotePrompt(projectPath: string, ssh: SshConnection, sessionId: string) {
  return [
    "The user's projects are on their own computer, the device, NOT on this Linux host, which only runs Claude Code and has no copy of them.",
    `Device: Windows. Project directory: ${JSON.stringify(projectPath)}.`,
    `Do all project reads, edits, searches and commands on the device with your native Bash tool: ssh -F ${JSON.stringify(ssh.configPath)} device '<command>'. Do not use this host's Read/Edit tools on project files, and do not print, read into conversation or copy the key the SSH configuration names.`,
    `On Windows the command is parsed by cmd.exe. Run PowerShell 7 as: "%CC_DESK_TUNNEL_PWSH%" -NoLogo -NoProfile -NonInteractive -EncodedCommand <script as UTF-16LE Base64>, quotes included, the script beginning with Set-Location -LiteralPath '${projectPath.replaceAll("'", "''")}' and using UTF-8 for console and file I/O.`,
    'If the device is unreachable, say so; never fall back to this host. After an interruption report results as unknown; do not repeat side effects on your own.',
    'Commands may run concurrently. One that blocks holds the turn until its Bash timeout: size the timeout to the work, and run anything long-lived, such as a dev server or watcher, as a background Bash task. Ending an ssh command does not reliably end what it started on the device; stop that process on the device.',
    `Scheduled and recurring prompts are sent by the desktop client, not by cron on this host: edit the UTF-8 JSON file whose path is in the device's CC_DESK_TUNNEL_SCHEDULES environment variable (its "说明" field documents the format; changes apply within seconds). This session's ID for a task that continues it: ${sessionId}.`,
  ].join('\n');
}

// Each session has its own Linux working directory; the CLI keys its native history by it. A fork shares
// the directory of the session it came from, which is where the CLI puts a fork's history.
export function nativeDirectory(dataDir: string, sessionId: string) {
  return join(dataDir, 'native', sessionId);
}

export function prepareNativeDirectory(options: ClaudeOptions, dataDir: string, sessionId: string) {
  const cwd = nativeDirectory(dataDir, sessionId);
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  const settingsDirectory = join(cwd, '.claude');
  mkdirSync(settingsDirectory, { recursive: true, mode: 0o700 });
  const localSettingsPath = join(settingsDirectory, 'settings.local.json');
  const settings = existsSync(localSettingsPath)
    ? JSON.parse(readFileSync(localSettingsPath, 'utf8'))
    : {};
  settings.cleanupPeriodDays = options.contextRetentionDays ?? 3650;
  writeFileSync(localSettingsPath, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
  return cwd;
}

export async function runClaude(
  options: ClaudeOptions,
  run: ClaudeRun,
): Promise<'completed' | 'failed' | 'cancelled'> {
  if (process.platform === 'win32') throw new Error('Native adapter must run on Linux.');
  const mapper = new ClaudeStream(run.emit, run.permissionMode, run.effort);
  const cwd = prepareNativeDirectory(options, run.dataDir, run.nativeRoot);
  if (run.resume && !(await getSessionInfo(run.sessionId, { dir: cwd }))) {
    run.emit({
      type: 'run.error',
      code: 'native_context_missing',
      message:
        'Claude Code 原生上下文不存在；不会用界面记录伪造恢复或另开会话。请检查原生存储与备份。',
    });
    return 'failed';
  }
  const abortController = new AbortController();
  const stop = () => abortController.abort();
  run.signal.addEventListener('abort', stop, { once: true });
  if (run.signal.aborted) stop();
  let stderr = '',
    failure: Error | undefined;
  let session: Query | undefined;
  let settle: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  try {
    session = query({
      prompt: run.input.stream(),
      options: {
        cwd,
        pathToClaudeCodeExecutable: options.executable,
        abortController,
        includePartialMessages: true,
        permissionMode: run.permissionMode,
        persistSession: true,
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append: remotePrompt(run.projectPath, run.ssh, run.sessionId),
          snapshot: false,
        },
        ...(run.resume ? { resume: run.sessionId } : { sessionId: run.sessionId }),
        model: run.model ?? options.model,
        effort: run.effort ?? undefined,
        // Newer models return no reasoning text unless a summary is asked for; headless runs ignore the
        // showThinkingSummaries setting, so this is the only switch.
        extraArgs: { 'thinking-display': 'summarized' },
        settings: options.settingsPath,
        settingSources: ['user', 'project', 'local'],
        maxTurns: options.maxTurns,
        env: { ...process.env, ...options.environment },
        stderr: (text) => {
          stderr = (stderr + text).slice(-8192);
        },
        canUseTool: async (name, input, context) => {
          const tool = mapper.tool(name, input, context.toolUseID);
          const question = name === 'AskUserQuestion';
          const { allowed, answers } =
            context.signal.aborted || run.signal.aborted
              ? { allowed: false }
              : await run.approve(tool.id, question ? 'question' : 'approval');
          tool.denied = !allowed;
          if (!allowed)
            return {
              behavior: 'deny',
              message: question
                ? 'The Windows user declined to answer.'
                : 'The Windows user denied or cancelled this request.',
            };
          // The official tool takes the user's choices as `answers`, keyed by question text.
          return {
            behavior: 'allow',
            updatedInput: question && answers ? { ...input, answers } : input,
          };
        },
      },
    });
    const initialized = await session.initializationResult();
    run.emit(
      nativeCapabilities(
        initialized.models,
        initialized.account,
        initialized.commands.map((command) => command.name),
        run.model ?? options.model,
      ),
    );
    let metrics: NativeMetrics | undefined;
    let refresh: Promise<void> | undefined;
    let refreshedAt = 0;
    let quotaAt = Date.now();
    const running = session;
    run.controls.stopTask = (taskId) => running.stopTask(taskId);
    run.controls.refresh = async () => {
      const payload = await nativeMetrics(running);
      if (payload.type === 'native.metrics') metrics = payload;
      quotaAt = Date.now();
      if (!run.signal.aborted) run.emit(payload);
    };
    // Background Bash tasks and subagents live in the CLI process, and the completion of one starts a turn of
    // its own. Closing the CLI with the turn that started them would kill them, so the run stays open until
    // none is left.
    let background = 0;
    let idle = false;
    let told = false;
    for await (const message of session) {
      if (message.type === 'system' && message.subtype === 'background_tasks_changed') {
        const tasks = message.tasks.filter((task) => !task.ambient);
        background = tasks.length;
        if (!run.signal.aborted)
          run.emit({
            type: 'native.tasks',
            tasks: tasks.map((task) => ({
              id: task.task_id,
              kind: task.task_type,
              description: task.description,
            })),
          });
        // The turn a finished task starts follows at once, announced by the CLI's `init`. When none does,
        // as after the user ended the last task, nothing is left to wait for.
        clearTimeout(settle);
        if (idle && !background)
          settle = setTimeout(() => {
            settled = true;
            run.input.close();
            running.close();
          }, 3000);
      } else if (
        (message.type === 'system' && message.subtype === 'init') ||
        ['user', 'assistant', 'stream_event'].includes(message.type)
      ) {
        if (told && !run.signal.aborted) run.waiting(false);
        told = false;
        idle = false;
        clearTimeout(settle);
      }
      if (!run.signal.aborted) {
        run.input.observe(message);
        mapper.accept(message);
      }
      // Context grows with every model call; show it during a long turn, not only once the turn ends.
      if (
        message.type === 'assistant' &&
        !refresh &&
        !run.signal.aborted &&
        Date.now() - refreshedAt >= 5000
      ) {
        refreshedAt = Date.now();
        // Quota moves slowly; a long turn rereads it once a minute and the context every few seconds.
        const full = !metrics || refreshedAt - quotaAt >= 60000;
        if (full) quotaAt = refreshedAt;
        refresh = (full ? nativeMetrics(session) : nativeContextRefresh(session, metrics!))
          .then(
            (payload) => {
              if (payload?.type !== 'native.metrics' || !payload.context || run.signal.aborted)
                return;
              metrics = payload;
              run.emit(payload);
            },
            () => {},
          )
          .finally(() => {
            refresh = undefined;
          });
      }
      if (message.type === 'result') {
        await refresh;
        const done = run.input.endTurn(message, background > 0);
        if (!run.signal.aborted) {
          try {
            const payload = await nativeMetrics(session, message);
            if (payload.type === 'native.metrics') metrics = payload;
            run.emit(payload);
          } catch {
            run.emit({ type: 'native.notice', text: '本轮原生状态未能读取；任务结果不受影响。' });
          }
        }
        if (done || run.signal.aborted) break;
        idle = true;
        if (background) {
          told = true;
          run.waiting(true);
        }
      }
    }
  } catch (error) {
    if (!settled)
      failure = error instanceof Error ? error : new Error('Native SDK process failed.');
  } finally {
    clearTimeout(settle);
    run.controls.refresh = undefined;
    run.controls.stopTask = undefined;
    run.input.close();
    session?.close();
    run.signal.removeEventListener('abort', stop);
  }
  const context = await getSessionInfo(run.sessionId, { dir: cwd });
  run.emit({
    type: 'native.context',
    nativeSessionId: run.sessionId,
    persisted: !!context,
    updatedAt: context ? new Date(context.lastModified).toISOString() : undefined,
  });
  if (context?.summary?.trim())
    run.emit({ type: 'native.title', title: context.summary.trim().slice(0, 120) });
  for (const tool of mapper.tools.values())
    if (!tool.finished) {
      run.emit({
        type: 'tool.result',
        toolId: tool.id,
        status: 'unknown',
        output:
          '运行结束；该工具最终执行结果未确认。已发出的 Windows SSH 命令可能继续执行，副作用未撤销，不能自动重放。',
        exitCode: null,
      });
    }
  if (run.signal.aborted) return 'cancelled';
  if (failure || !mapper.result) {
    run.emit({
      type: 'run.error',
      code: 'cli_process_failed',
      message: failure?.message ?? (stderr.trim() || 'Claude Code exited without a result.'),
    });
    return 'failed';
  }
  return mapper.result.failed ? 'failed' : 'completed';
}

export async function readNativeStatus(
  options: ClaudeOptions,
  dataDir: string,
  nativeRoot: string,
  sessionId: string,
  signal: AbortSignal,
) {
  const cwd = prepareNativeDirectory(options, dataDir, nativeRoot);
  const saved = await getSessionInfo(sessionId, { dir: cwd });
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  async function* input(): AsyncGenerator<SDKUserMessage> {
    await waiting;
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const timer = setTimeout(abort, 15000);
  let process: Query | undefined;
  let drain: Promise<void> | undefined;
  try {
    process = query({
      prompt: input(),
      options: {
        cwd,
        pathToClaudeCodeExecutable: options.executable,
        ...(saved ? { resume: sessionId } : {}),
        abortController: controller,
        settings: options.settingsPath,
        settingSources: ['user', 'project', 'local'],
        env: { ...globalThis.process.env, ...options.environment },
      },
    });
    // Keep draining while control requests are in flight; no model prompt is submitted.
    const session = process;
    drain = (async () => {
      for await (const _message of session) {
      }
    })().catch(() => {});
    const initialized = await process.initializationResult();
    return [
      nativeCapabilities(
        initialized.models,
        initialized.account,
        initialized.commands.map((command) => command.name),
        options.model,
      ),
      await nativeMetrics(process),
    ];
  } finally {
    clearTimeout(timer);
    release();
    process?.close();
    signal.removeEventListener('abort', abort);
    await drain;
  }
}
