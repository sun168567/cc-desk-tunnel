import { z } from 'zod';

export const PROTOCOL_VERSION = 12;
export const MAX_FRAME_BYTES = 256 * 1024;
const id = z.uuid();
const timestamp = z.iso.datetime();
export const permissionModeSchema = z.enum(['auto', 'default', 'plan', 'acceptEdits']);
export type PermissionMode = z.infer<typeof permissionModeSchema>;
export const effortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
export type Effort = z.infer<typeof effortSchema>;
export const modelInfoSchema = z.object({
  value: z.string(),
  displayName: z.string(),
  description: z.string(),
  resolvedModel: z.string().optional(),
  source: z.enum(['native', 'configured']),
  supportedEffortLevels: z.array(effortSchema),
});
export const nativeAccountSchema = z.object({
  email: z.string().optional(),
  organization: z.string().optional(),
  subscriptionType: z.string().optional(),
  apiProvider: z.string().optional(),
  apiKeySource: z.string().optional(),
  tokenSource: z.string().optional(),
});
export const accountStateSchema = z.object({
  loggedIn: z.boolean(),
  authMethod: z.string().optional(),
  email: z.string().optional(),
  organization: z.string().optional(),
  subscriptionType: z.string().optional(),
  // Present while the official sign-in command waits for the code shown after browser authorization.
  login: z.object({ url: z.url() }).nullable(),
  notice: z.string().optional(),
});
export type AccountState = z.infer<typeof accountStateSchema>;
// The part of the official CLI's user settings the GUI edits. null means unset: the CLI's own default applies.
const toggle = z.boolean().nullable();
export const nativeSettingsSchema = z.object({
  autoCompactEnabled: toggle,
  autoCompactWindow: z.number().int().min(100_000).max(1_000_000).nullable(),
  alwaysThinkingEnabled: toggle,
  fastMode: toggle,
  autoContinueAtUsageLimit: toggle,
  switchModelsOnFlag: toggle,
  autoMemoryEnabled: toggle,
  fileCheckpointingEnabled: toggle,
  promptCacheTtl: z.enum(['5m', '1h']).nullable(),
  language: z.string().trim().min(1).max(60).nullable(),
});
export type NativeSettings = z.infer<typeof nativeSettingsSchema>;
export const contextUsageSchema = z.object({
  model: z.string(),
  usedTokens: z.number().nonnegative(),
  windowTokens: z.number().positive(),
  percentage: z.number().nonnegative(),
  measuredAt: timestamp,
  categories: z.array(
    z.object({
      name: z.string(),
      tokens: z.number().nonnegative(),
      kind: z.enum(['used', 'free', 'buffer', 'deferred']),
    }),
  ),
});
export const nativeUsageSchema = z.object({
  costUsd: z.number().nonnegative().nullable(),
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  cacheReadTokens: z.number().nonnegative(),
  cacheWriteTokens: z.number().nonnegative(),
  measuredAt: timestamp,
});
export const rateLimitsSchema = z.object({
  available: z.boolean(),
  windows: z.array(
    z.object({
      name: z.string(),
      utilization: z.number().nonnegative().nullable(),
      resetsAt: z.string().nullable(),
    }),
  ),
  measuredAt: timestamp.optional(),
});
const usageTotals = {
  requests: z.number().int().nonnegative(),
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  cacheReadTokens: z.number().nonnegative(),
  cacheCreationTokens: z.number().nonnegative(),
  // The official CLI's API-price estimate, not a subscription bill.
  costUsd: z.number().nonnegative(),
};
export const usageSummarySchema = z.object({
  retentionDays: z.number().int().positive(),
  firstRecordAt: timestamp.nullable(),
  // One entry per official quota period; totals cover requests since that period started.
  windows: z.array(
    z.object({
      name: z.string(),
      startedAt: timestamp,
      resetsAt: timestamp.nullable(),
      utilization: z.number().nonnegative().nullable(),
      ...usageTotals,
    }),
  ),
});
export const usagePageSchema = z.object({
  rows: z.array(
    z.object({
      id: z.number().int().positive(),
      at: timestamp,
      sessionId: z.string().nullable(),
      sessionTitle: z.string().nullable(),
      model: z.string(),
      inputTokens: z.number().nonnegative(),
      outputTokens: z.number().nonnegative(),
      cacheReadTokens: z.number().nonnegative(),
      cacheCreationTokens: z.number().nonnegative(),
      costUsd: z.number().nonnegative(),
      durationMs: z.number().nonnegative(),
      ttftMs: z.number().nonnegative().nullable(),
      source: z.string().nullable(),
    }),
  ),
  hasMore: z.boolean(),
  totals: z.object({
    ...usageTotals,
    durationMs: z.number().nonnegative(),
    ttftMs: z.number().nonnegative().nullable(),
    outputPerSecond: z.number().nonnegative().nullable(),
  }),
  models: z.array(z.string()),
  series: z.array(
    z.object({
      at: timestamp,
      requests: z.number().int().nonnegative(),
      tokens: z.number().nonnegative(),
      costUsd: z.number().nonnegative(),
    }),
  ),
});
export type UsageSummary = z.infer<typeof usageSummarySchema>;
export type UsagePage = z.infer<typeof usagePageSchema>;
export const runStatusSchema = z.enum([
  'running',
  'awaiting_approval',
  'completed',
  'cancelled',
  'failed',
]);
export const terminalStatuses = new Set<RunStatus>(['completed', 'cancelled', 'failed']);
export type RunStatus = z.infer<typeof runStatusSchema>;

const toolSchema = z.object({
  toolId: z.string().min(1),
  name: z.string().min(1),
  input: z.string(),
  target: z.enum(['Windows (simulation)', 'Windows', 'Linux']),
});
export const eventPayloadSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('message.user'),
    messageId: id,
    text: z.string(),
    scenario: z.enum(['chat', 'tool', 'error']),
  }),
  z.object({
    type: z.literal('message.delivery'),
    messageId: id,
    status: z.enum(['submitted', 'queued', 'received', 'not_sent', 'unconfirmed']),
  }),
  z.object({
    type: z.literal('run.status'),
    status: runStatusSchema,
    connectionId: id,
    surface: z.enum(['chat', 'terminal']).optional(),
    reason: z.string().optional(),
  }),
  z.object({ type: z.literal('text.delta'), messageId: id, text: z.string() }),
  z.object({ type: z.literal('thinking.delta'), messageId: id, text: z.string() }),
  z.object({
    type: z.literal('native.session'),
    nativeSessionId: id,
    model: z.string(),
    version: z.string(),
    requestedPermissionMode: permissionModeSchema.optional(),
    permissionMode: z.string().optional(),
    requestedEffort: effortSchema.nullable().optional(),
    effort: effortSchema.nullable().optional(),
  }),
  z.object({
    type: z.literal('native.context'),
    nativeSessionId: id,
    persisted: z.boolean(),
    updatedAt: timestamp.optional(),
  }),
  z.object({ type: z.literal('native.notice'), text: z.string() }),
  z.object({
    type: z.literal('native.capabilities'),
    models: z.array(modelInfoSchema),
    account: nativeAccountSchema,
    commands: z.array(z.string()),
  }),
  z.object({
    type: z.literal('native.metrics'),
    context: contextUsageSchema.nullable(),
    usage: nativeUsageSchema.nullable(),
    rateLimits: rateLimitsSchema.nullable(),
    errors: z.object({ context: z.string().optional(), usage: z.string().optional() }).optional(),
  }),
  z.object({ type: z.literal('native.title'), title: z.string().min(1).max(120) }),
  z.object({
    type: z.literal('native.compact'),
    trigger: z.string(),
    previousTokens: z.number().nonnegative().nullable(),
  }),
  z.object({ type: z.literal('tool.requested'), ...toolSchema.shape }),
  z.object({ type: z.literal('tool.input'), toolId: z.string().min(1), input: z.string() }),
  z.object({ type: z.literal('tool.input.delta'), toolId: z.string().min(1), text: z.string() }),
  z.object({
    type: z.literal('tool.progress'),
    toolId: z.string().min(1),
    elapsedSeconds: z.number().nonnegative(),
  }),
  z.object({ type: z.literal('approval.requested'), approvalId: id, toolId: z.string().min(1) }),
  z.object({ type: z.literal('approval.resolved'), approvalId: id, allowed: z.boolean() }),
  z.object({
    type: z.literal('tool.result'),
    toolId: z.string().min(1),
    status: z.enum(['completed', 'denied', 'cancelled', 'failed', 'unknown']),
    output: z.string(),
    exitCode: z.number().int().nullable(),
  }),
  z.object({
    type: z.literal('tool.output'),
    toolId: z.string().min(1),
    stream: z.enum(['stdout', 'stderr']),
    text: z.string(),
  }),
  z.object({ type: z.literal('run.error'), code: z.string(), message: z.string() }),
]);
export type EventPayload = z.infer<typeof eventPayloadSchema>;
type Payload<T extends EventPayload['type']> = Extract<EventPayload, { type: T }>;
export type NativeSession = Payload<'native.session'>;
export type NativeContext = Payload<'native.context'>;
export type NativeCapabilities = Payload<'native.capabilities'>;
export type NativeMetrics = Payload<'native.metrics'>;
export const eventSchema = z.object({
  sessionId: id,
  runId: id,
  sequence: z.number().int().positive(),
  createdAt: timestamp,
  payload: eventPayloadSchema,
});
export type SessionEvent = z.infer<typeof eventSchema>;
export const sessionSchema = z.object({
  id,
  title: z.string().min(1).max(120),
  autoTitle: z.boolean().default(false),
  projectPath: z.string().min(1).max(2048),
  permissionMode: permissionModeSchema.default('auto'),
  model: z.string().trim().min(1).max(200).nullable().default(null),
  effort: effortSchema.nullable().default(null),
  // A fork keeps its native history beside the session it was forked from; this names that session.
  nativeRoot: id.optional(),
  createdAt: timestamp,
  updatedAt: timestamp,
  activeRun: z
    .object({
      id,
      status: runStatusSchema,
      connectionId: id,
      surface: z.enum(['chat', 'terminal']).optional(),
    })
    .nullable(),
});
export type Session = z.infer<typeof sessionSchema>;
export const snapshotSchema = z.object({ session: sessionSchema, events: z.array(eventSchema) });
export type SessionSnapshot = z.infer<typeof snapshotSchema>;
export const historyPageSchema = snapshotSchema.extend({
  requestId: id,
  mode: z.enum(['replace', 'prepend', 'append']),
  firstSequence: z.number().int().nonnegative(),
  lastSequence: z.number().int().nonnegative(),
  hasEarlier: z.boolean(),
});
export type HistoryPage = z.infer<typeof historyPageSchema>;

const versionSchema = z.string().regex(/^\d+\.\d+\.\d+$/);
const installerSchema = z.object({
  version: versionSchema,
  size: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
// Where the service stands against the published releases. `manual` is a newer release this installation cannot
// install by itself; `installing` carries the step in `detail`, `failed` the reason.
export const serviceUpdateSchema = z.object({
  state: z.enum(['idle', 'checking', 'available', 'manual', 'installing', 'restarting', 'failed']),
  latest: versionSchema.optional(),
  detail: z.string().optional(),
  checkedAt: z.number().int().nonnegative().optional(),
});
export type ServiceUpdate = z.infer<typeof serviceUpdateSchema>;
const request = { requestId: id };
export const commandSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('session.create'),
      ...request,
      title: z.string().trim().min(1).max(120),
      projectPath: z.string().trim().min(1).max(2048),
    })
    .strict(),
  z.object({ type: z.literal('account.status'), ...request }).strict(),
  z.object({ type: z.literal('account.login'), ...request }).strict(),
  z
    .object({
      type: z.literal('account.code'),
      ...request,
      code: z
        .string()
        .trim()
        .regex(/^[\x21-\x7e]{1,2048}$/),
    })
    .strict(),
  z.object({ type: z.literal('account.cancel'), ...request }).strict(),
  z.object({ type: z.literal('account.logout'), ...request }).strict(),
  z.object({ type: z.literal('settings.get'), ...request }).strict(),
  z
    .object({
      type: z.literal('settings.update'),
      ...request,
      values: nativeSettingsSchema.partial().strict(),
    })
    .strict(),
  z.object({ type: z.literal('usage.summary'), ...request }).strict(),
  z.object({ type: z.literal('service.update.check'), ...request }).strict(),
  z
    .object({ type: z.literal('service.update.install'), ...request, version: versionSchema })
    .strict(),
  z
    .object({
      type: z.literal('usage.query'),
      ...request,
      from: timestamp.optional(),
      to: timestamp.optional(),
      model: z.string().min(1).max(200).optional(),
      beforeId: z.number().int().positive().optional(),
      limit: z.number().int().min(1).max(200).default(100),
      bucketMinutes: z.number().int().min(5).max(1440).default(60),
      // Minutes east of UTC, so day buckets follow the viewer's calendar.
      offsetMinutes: z.number().int().min(-840).max(840).default(0),
    })
    .strict(),
  z.object({ type: z.literal('session.delete'), ...request, sessionId: id }).strict(),
  z
    .object({
      type: z.literal('session.rename'),
      ...request,
      sessionId: id,
      title: z.string().trim().min(1).max(120),
    })
    .strict(),
  z
    .object({
      type: z.literal('session.configure'),
      ...request,
      sessionId: id,
      permissionMode: permissionModeSchema,
      model: z.string().trim().min(1).max(200).nullable().optional(),
      effort: effortSchema.nullable().optional(),
    })
    .strict(),
  z.object({ type: z.literal('session.compact'), ...request, sessionId: id }).strict(),
  // Copies a session under a new ID. With `beforeMessageId` the copy ends just before that user message,
  // which is how an earlier message is edited and sent again without losing the original.
  z
    .object({
      type: z.literal('session.fork'),
      ...request,
      sessionId: id,
      beforeMessageId: id.optional(),
    })
    .strict(),
  z.object({ type: z.literal('session.status'), ...request, sessionId: id }).strict(),
  z
    .object({
      type: z.literal('terminal.open'),
      ...request,
      sessionId: id,
      cols: z.number().int().min(20).max(400),
      rows: z.number().int().min(5).max(160),
      // Picks up the session's latest native conversation, if it has one, instead of starting a new one.
      continue: z.boolean().optional(),
    })
    .strict(),
  z
    .object({ type: z.literal('terminal.close'), ...request, sessionId: id, terminalId: id })
    .strict(),
  // Stops showing a terminal while its CLI keeps running; `terminal.open` on the session shows it again.
  z
    .object({ type: z.literal('terminal.detach'), ...request, sessionId: id, terminalId: id })
    .strict(),
  // Asks for `terminals.state`.
  z.object({ type: z.literal('terminal.list'), ...request }).strict(),
  z
    .object({
      type: z.literal('session.subscribe'),
      ...request,
      sessionId: id,
      afterSequence: z.number().int().nonnegative().default(0),
    })
    .strict(),
  z
    .object({
      type: z.literal('session.history'),
      ...request,
      sessionId: id,
      beforeSequence: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      type: z.literal('message.send'),
      ...request,
      sessionId: id,
      text: z.string().trim().min(1).max(16000),
      scenario: z.enum(['chat', 'tool', 'error']).default('chat'),
    })
    .strict(),
  z.object({ type: z.literal('run.cancel'), ...request, sessionId: id, runId: id }).strict(),
  z
    .object({
      type: z.literal('approval.reply'),
      ...request,
      sessionId: id,
      runId: id,
      approvalId: id,
      allowed: z.boolean(),
    })
    .strict(),
]);
export type Command = z.infer<typeof commandSchema>;
export const terminalControlSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('terminal.input'),
      sessionId: id,
      terminalId: id,
      data: z.string().min(1).max(8192),
    })
    .strict(),
  z
    .object({
      type: z.literal('terminal.resize'),
      sessionId: id,
      terminalId: id,
      cols: z.number().int().min(20).max(400),
      rows: z.number().int().min(5).max(160),
    })
    .strict(),
  z
    .object({
      type: z.literal('terminal.ack'),
      sessionId: id,
      terminalId: id,
      bytes: z.number().int().positive().max(MAX_FRAME_BYTES),
    })
    .strict(),
]);
export type TerminalControl = z.infer<typeof terminalControlSchema>;
// The secret that lets a client take back a connection the network dropped, and a count of frames.
const resumeKey = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const frameCount = z.number().int().nonnegative();
export const authSchema = z
  .object({
    type: z.literal('auth'),
    // Any number is accepted here: a client of another version holding the right token is told how to upgrade.
    protocolVersion: z.number().int().positive(),
    token: z.string().min(24).max(512),
    deviceName: z.string().trim().min(1).max(120),
    tunnel: z.boolean().default(false),
    // How the service reaches the desktop's SSH endpoint: through frp and its own port, or relayed over further WSS
    // connections the desktop opens to this service, which needs neither.
    tunnelTransport: z.enum(['frp', 'relay']).default('frp'),
    // A client that reconnects by itself asks to keep its connection, with its runs, terminal and tunnel, through a
    // network drop; the service then grants a key in `ready`.
    resumable: z.boolean().default(false),
    // Takes back such a connection; `received` counts the service frames that arrived before it dropped.
    resume: z
      .object({ connectionId: id, key: resumeKey, received: frameCount })
      .strict()
      .optional(),
  })
  .strict();
// How many frames of a resumable connection one side has received; sent now and then, so the other can let them go.
export const resumeAckSchema = z
  .object({ type: z.literal('resume.ack'), received: frameCount })
  .strict();
// The per-connection secret that admits the desktop's relay connections.
const relaySecret = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
// The first and only protocol frame of a relay connection. The service answers with RELAY_BEGIN when it hands the
// connection an SSH connection; from then on it carries that connection's bytes as binary frames.
export const tunnelAttachSchema = z
  .object({ type: z.literal('tunnel.attach'), connectionId: id, secret: relaySecret })
  .strict();
export type TunnelAttach = z.infer<typeof tunnelAttachSchema>;
export const RELAY_BEGIN = JSON.stringify({ type: 'tunnel.begin' });
// What a native terminal's CLI is doing, as its hooks report it: working, waiting for an answer (a permission or a
// question), or done with its turn. `starting` until the CLI first reports.
export const terminalStatusSchema = z.enum(['starting', 'busy', 'waiting', 'idle']);
export type TerminalStatus = z.infer<typeof terminalStatusSchema>;
export const terminalInfoSchema = z.object({
  terminalId: id,
  sessionId: id,
  status: terminalStatusSchema,
  // Whether a client is showing it.
  attached: z.boolean(),
  since: timestamp,
});
export type TerminalInfo = z.infer<typeof terminalInfoSchema>;
export const serverMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('ready'),
    protocolVersion: z.literal(PROTOCOL_VERSION),
    connectionId: id,
    adapter: z.enum(['simulation', 'claude-code']),
    model: z.string().optional(),
    // The service's own release version, and where it stands against the published releases if it follows them.
    version: versionSchema,
    update: serviceUpdateSchema.optional(),
    // The newest Windows installer the service holds, for clients that want to upgrade themselves.
    client: installerSchema.optional(),
    sessions: z.array(sessionSchema),
    // Granted to a resumable connection: how long the service keeps it after it dropped.
    resume: z.object({ key: resumeKey, graceMs: z.number().int().positive() }).optional(),
  }),
  z.object({
    type: z.literal('response'),
    requestId: id,
    ok: z.boolean(),
    sessionId: id.optional(),
    code: z.string().optional(),
    message: z.string().optional(),
  }),
  z.object({ type: z.literal('session.snapshot'), ...historyPageSchema.shape }),
  z.object({ type: z.literal('session.updated'), session: sessionSchema }),
  z.object({ type: z.literal('session.deleted'), sessionId: id }),
  z.object({ type: z.literal('session.event'), event: eventSchema }),
  z.object({ type: z.literal('account.state'), ...accountStateSchema.shape }),
  z.object({ type: z.literal('settings.state'), requestId: id, values: nativeSettingsSchema }),
  z.object({ type: z.literal('usage.summary'), requestId: id, ...usageSummarySchema.shape }),
  z.object({ type: z.literal('usage.page'), requestId: id, ...usagePageSchema.shape }),
  z.object({ type: z.literal('terminal.opened'), sessionId: id, terminalId: id }),
  z.object({
    type: z.literal('terminal.data'),
    sessionId: id,
    terminalId: id,
    data: z.string(),
    bytes: z.number().int().positive(),
  }),
  z.object({
    type: z.literal('terminal.closed'),
    sessionId: id,
    terminalId: id,
    exitCode: z.number().int().nullable(),
  }),
  // The terminals this connection runs, sent whenever one starts, ends, changes state or is shown or hidden.
  z.object({
    type: z.literal('terminals.state'),
    terminals: z.array(terminalInfoSchema),
  }),
  // Every version must keep reading this frame: with code `version_mismatch` it is how a client of another
  // protocol version learns the service's version and the installer it may fetch.
  z.object({
    type: z.literal('connection.error'),
    code: z.string(),
    message: z.string(),
    service: versionSchema.optional(),
    client: installerSchema.optional(),
  }),
  z.object({ type: z.literal('service.update'), ...serviceUpdateSchema.shape }),
  z.object({
    type: z.literal('tunnel.configure'),
    connectionId: id,
    serverAddr: z.string().min(1),
    serverPort: z.number().int().min(1).max(65535),
    remotePort: z.number().int().min(1).max(65535),
    token: z.string().min(24),
    certificate: z.string().min(1),
    serverName: z.string().min(1),
  }),
  z.object({ type: z.literal('tunnel.relay'), connectionId: id, secret: relaySecret }),
  z.object({ type: z.literal('tunnel.ready'), connectionId: id }),
  z.object({ type: z.literal('resume.ack'), received: frameCount }),
  // The answer to `auth.resume`, before the frames the client missed; `received` is what the service got.
  z.object({ type: z.literal('resumed'), connectionId: id, received: frameCount }),
  // From the local bridge to its own client only: the service connection is being re-established, or is back.
  z.object({ type: z.literal('connection.state'), state: z.enum(['reconnecting', 'connected']) }),
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;

export const tunnelCredentialsSchema = z
  .object({
    type: z.literal('tunnel.credentials'),
    connectionId: id,
    username: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[a-zA-Z0-9_.\\@-]+$/),
    privateKey: z.string().min(1).max(16384),
    hostPublicKey: z.string().regex(/^ssh-ed25519 [A-Za-z0-9+/=]+$/),
    powershellPath: z.string().min(1).max(2048),
    platform: z.enum(['win32', 'linux']).optional(),
    schedulesPath: z.string().min(1).max(4096).optional(),
  })
  .strict();
export type TunnelCredentials = z.infer<typeof tunnelCredentialsSchema>;

// One side of a resumable connection. Frames sent after sign-in are numbered in order and kept until the other side
// acknowledges them; after a reconnect each side replays what the other did not receive. WebSocket delivery is
// ordered, so counting frames is enough.
export class ResumeLog {
  sent = 0;
  received = 0;
  private frames: string[] = [];
  private size = 0;
  private acknowledged = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private acknowledge: (received: number) => void;
  private limit: number;
  constructor(acknowledge: (received: number) => void, limit = 16 * 1024 * 1024) {
    this.acknowledge = acknowledge;
    this.limit = limit;
  }
  // Keeps an outgoing frame; false once more is unacknowledged than the limit allows.
  record(frame: string) {
    this.sent++;
    this.frames.push(frame);
    this.size += frame.length;
    return this.size <= this.limit;
  }
  // The other side has these; they need not be kept.
  confirm(received: number) {
    const drop = Math.min(received - (this.sent - this.frames.length), this.frames.length);
    if (drop > 0) for (const frame of this.frames.splice(0, drop)) this.size -= frame.length;
  }
  // The frames after the first `received`, or null when they are not all held any more.
  since(received: number) {
    const first = this.sent - this.frames.length;
    if (received < first || received > this.sent) return null;
    return this.frames.slice(received - first);
  }
  // Counts an incoming frame; acknowledgments go out in batches.
  receive() {
    this.received++;
    if (this.received - this.acknowledged >= 64) this.flush();
    else this.timer ??= setTimeout(() => this.flush(), 1000);
  }
  flush() {
    this.stop();
    if (this.received === this.acknowledged) return;
    this.acknowledged = this.received;
    this.acknowledge(this.received);
  }
  stop() {
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
