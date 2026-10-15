import type {
  AccountState,
  Effort,
  EventPayload,
  NativeSettings,
  PermissionMode,
} from '@cc-desk-tunnel/protocol';

// What the parent already resolved from the device. The worker never imports the server's prompt helper.
export type DeviceTerms = { name: string; script: string; command: string };

// Serializable Claude invocation settings. The parent fills `environment` after its telemetry port is listening.
export type ClaudeConfig = {
  executable: string;
  model?: string;
  settingsPath?: string;
  maxTurns?: number;
  contextRetentionDays?: number;
  environment?: Record<string, string>;
};

export type AccountSnapshot = Omit<AccountState, 'login' | 'notice'>;

export type TurnReport = {
  messageId?: string;
  startedAt: number;
  endedAt: number;
  requests: number;
  outputTokens: number;
  promptIds: string[];
};

export type RunStart = {
  sessionId: string;
  runId: string;
  nativeRoot: string;
  projectPath: string;
  terms: DeviceTerms;
  permissionMode: PermissionMode;
  model?: string | null;
  effort?: Effort | null;
  resume: boolean;
  sshConfigPath: string;
  messageId: string;
  text: string;
};

export type TerminalStart = {
  terminalId: string;
  sessionId: string;
  nativeRoot: string;
  projectPath: string;
  terms: DeviceTerms;
  permissionMode: PermissionMode;
  model?: string | null;
  effort?: Effort | null;
  cols: number;
  rows: number;
  sshConfigPath: string;
};

export type ForkResult = { id: string | null; resumable: boolean };

// Parent → worker. `id` is set when the parent waits for `reply`. `generation` is the worker the parent spawned.
export type ParentMessage = {
  generation: number;
  id?: string;
} & (
  | { type: 'init'; dataDir: string; config: ClaudeConfig }
  | { type: 'shutdown' }
  | { type: 'run.start'; run: RunStart }
  | { type: 'run.abort'; sessionId: string }
  | { type: 'input.reserve'; sessionId: string }
  | { type: 'input.submit'; sessionId: string; messageId: string; text: string }
  | {
      type: 'approval.resolve';
      sessionId: string;
      approvalId: string;
      allowed: boolean;
      answers?: Record<string, string>;
    }
  | { type: 'task.stop'; sessionId: string; taskId: string }
  | { type: 'status.refresh'; sessionId: string }
  | { type: 'status.read'; sessionId: string; nativeRoot: string }
  | { type: 'status.abort' }
  | { type: 'session.delete'; sessionId: string; nativeRoot: string }
  | { type: 'session.rename'; sessionId: string; nativeRoot: string; title: string }
  | {
      type: 'session.fork';
      sessionId: string;
      nativeRoot: string;
      title: string;
      beforeMessageId?: string;
    }
  | { type: 'terminal.open'; terminal: TerminalStart }
  | { type: 'terminal.input'; sessionId: string; terminalId: string; data: string }
  | { type: 'terminal.resize'; sessionId: string; terminalId: string; cols: number; rows: number }
  | { type: 'terminal.ack'; sessionId: string; terminalId: string; bytes: number }
  | { type: 'terminal.close'; sessionId: string; terminalId: string }
  | { type: 'account.status' }
  | { type: 'account.login' }
  | { type: 'account.code'; code: string }
  | { type: 'account.cancel' }
  | { type: 'account.logout' }
  | { type: 'settings.get' }
  | { type: 'settings.update'; values: Partial<NativeSettings> }
);

export type WorkerMessage =
  | { type: 'ready'; generation: number }
  | { type: 'reply'; generation: number; id: string; ok: true; result?: unknown }
  | { type: 'reply'; generation: number; id: string; ok: false; code: string; message: string }
  | { type: 'event'; generation: number; sessionId: string; payload: EventPayload }
  | { type: 'turnEnded'; generation: number; sessionId: string; turn: TurnReport }
  | { type: 'waiting'; generation: number; sessionId: string; background: boolean }
  | { type: 'controls'; generation: number; sessionId: string; refresh: boolean; stopTask: boolean }
  | {
      type: 'approval.requested';
      generation: number;
      sessionId: string;
      approvalId: string;
      toolId: string;
      waiting: 'approval' | 'question';
    }
  | {
      type: 'run.finished';
      generation: number;
      sessionId: string;
      status: 'completed' | 'failed' | 'cancelled';
    }
  | {
      type: 'terminal.data';
      generation: number;
      sessionId: string;
      terminalId: string;
      data: string;
      bytes: number;
    }
  | {
      type: 'terminal.exit';
      generation: number;
      sessionId: string;
      terminalId: string;
      exitCode: number | null;
    }
  | { type: 'terminal.fault'; generation: number; sessionId: string; terminalId: string }
  | { type: 'login.notice'; generation: number; text: string }
  | { type: 'login.exit'; generation: number; succeeded: boolean; cancelled: boolean };

export function workerMessage(value: unknown): WorkerMessage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const message = value as { type?: unknown; generation?: unknown };
  if (typeof message.type !== 'string' || typeof message.generation !== 'number') return undefined;
  return value as WorkerMessage;
}

// Codex control plane. Project paths and SSH config are intentionally absent: that gate was not measured.
export type CodexLimits = {
  kind: 'cgroup' | 'rlimit' | 'none';
  // Whether memory is actually capped. A process-count cap alone leaves this false.
  memory: boolean;
  memoryMb: number;
  pids: number;
  // cpu is true only when a cgroup cpu.max was written. prlimit cannot cap CPU.
  cpu?: boolean;
  cpuMillis?: number;
};

export type CodexConfig = {
  executable: string;
  profileId: string;
  model?: string;
  // How long one turn may run before its result is unknown. Absent, two minutes.
  turnTimeoutMs?: number;
  // Resident or address-space cap for the Codex process, and how many processes it may spawn.
  memoryMb?: number;
  pidsMax?: number;
  // One CPU is 1000. Absent, no CPU cap is requested.
  cpuMillis?: number;
};

export type CodexRunStart = {
  sessionId: string;
  runId: string;
  messageId: string;
  text: string;
  resumeThreadId?: string;
  // The session's chosen model. Absent, the process config's model is used.
  model?: string;
  // Compact the thread instead of sending the text as a normal turn.
  compact?: boolean;
  // Written into the profile config. It is not a thread/start field.
  effort?: string;
  // Applied as Codex's own approval and sandbox fields on turn/start.
  permissionMode?: PermissionMode;
};

export type CodexTerminalStart = {
  terminalId: string;
  sessionId: string;
  cols: number;
  rows: number;
  resumeThreadId?: string;
  instructions?: string;
};

export type CodexParentMessage = {
  generation: number;
  id?: string;
} & (
  | { type: 'init'; dataDir: string; config: CodexConfig }
  | { type: 'shutdown' }
  | { type: 'account.login' }
  | { type: 'account.cancel' }
  | { type: 'account.status' }
  | { type: 'account.logout' }
  | { type: 'model.list' }
  | { type: 'run.start'; run: CodexRunStart }
  | { type: 'run.abort'; sessionId: string }
  | { type: 'run.input'; sessionId: string; text: string }
  | { type: 'thread.fork'; threadId: string }
  | { type: 'task.stop'; sessionId: string; taskId: string }
  | { type: 'status.read' }
  | { type: 'terminal.open'; terminal: CodexTerminalStart }
  | { type: 'terminal.close'; sessionId: string; terminalId: string }
  | { type: 'terminal.input'; sessionId: string; terminalId: string; data: string }
  | { type: 'terminal.resize'; sessionId: string; terminalId: string; cols: number; rows: number }
  | { type: 'terminal.ack'; sessionId: string; terminalId: string; bytes: number }
  | {
      type: 'approval.resolve';
      sessionId: string;
      approvalId: string;
      allowed: boolean;
      answers?: Record<string, string>;
    }
);

export type CodexWorkerMessage =
  | { type: 'ready'; generation: number; limits?: CodexLimits }
  | { type: 'reply'; generation: number; id: string; ok: true; result?: unknown }
  | { type: 'reply'; generation: number; id: string; ok: false; code: string; message: string }
  | { type: 'event'; generation: number; sessionId: string; payload: EventPayload }
  | {
      type: 'approval.requested';
      generation: number;
      sessionId: string;
      approvalId: string;
      toolId: string;
      waiting: 'approval' | 'question';
      kind?: 'command' | 'file' | 'question';
    }
  | {
      type: 'run.finished';
      generation: number;
      sessionId: string;
      status: 'completed' | 'failed' | 'cancelled';
      unknown?: boolean;
      // Present once Codex has created the thread, including when the turn itself failed.
      threadId?: string;
      // The resume id did not start a thread. The session should forget it.
      dropThread?: boolean;
    }
  | { type: 'login.exit'; generation: number; succeeded: boolean; cancelled: boolean }
  | {
      type: 'terminal.data';
      generation: number;
      sessionId: string;
      terminalId: string;
      data: string;
      bytes: number;
    }
  | {
      type: 'terminal.exit';
      generation: number;
      sessionId: string;
      terminalId: string;
      exitCode: number | null;
    }
  | { type: 'terminal.fault'; generation: number; sessionId: string; terminalId: string };

export function codexWorkerMessage(value: unknown): CodexWorkerMessage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const message = value as { type?: unknown; generation?: unknown };
  if (typeof message.type !== 'string' || typeof message.generation !== 'number') return undefined;
  return value as CodexWorkerMessage;
}
