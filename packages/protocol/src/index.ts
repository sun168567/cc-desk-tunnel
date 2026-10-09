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
  precomputeCompactionEnabled: toggle,
  autoDreamEnabled: toggle,
  subagentPromptCacheTtl: z.enum(['5m', '1h']).nullable(),
  fallbackModel: z.array(z.string().trim().min(1).max(200)).min(1).max(5).nullable(),
  askUserQuestionTimeout: z.enum(['60s', '5m', '10m', 'never']).nullable(),
  bashOutputMaxChars: z.number().int().min(4000).max(128_000).nullable(),
  // The CLI also takes an object of custom texts here; the GUI only offers hiding the attribution, and shows
  // anything else as unset.
  attribution: z.literal(false).nullable(),
  includeGitInstructions: toggle,
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
// What a run waits for. In `awaiting_approval`: a decision on a tool, or an answer to a question Claude asked.
// While `running`, `background`: Claude has finished its turn and only the background tasks it started go on.
export const waitingSchema = z.enum(['approval', 'question', 'background']);
export const terminalStatuses = new Set<RunStatus>(['completed', 'cancelled', 'failed']);
export type RunStatus = z.infer<typeof runStatusSchema>;

const scenarioSchema = z.enum(['chat', 'tool', 'question', 'error']);
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
    scenario: scenarioSchema,
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
    waiting: waitingSchema.optional(),
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
  // The background tasks alive in the run's CLI; each list replaces the one before.
  z.object({
    type: z.literal('native.tasks'),
    tasks: z.array(z.object({ id: z.string().min(1), kind: z.string(), description: z.string() })),
  }),
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
  // What the system prompt of the session's native runs says. It is kept word for word until a compaction,
  // which loses the prompt cache anyway: a move to another project, or a PowerShell path that differs on the
  // connection in use, is told to Claude with the user's next message instead (`toldPowershellPath` is the
  // path it was last told that way).
  prompt: z
    .object({
      projectPath: z.string(),
      powershellPath: z.string().optional(),
      toldPowershellPath: z.string().optional(),
      compacted: z.boolean().optional(),
    })
    .optional(),
  // The project path Claude was last told, while the move away from it has not been mentioned to it yet.
  movedFrom: z.string().optional(),
  createdAt: timestamp,
  updatedAt: timestamp,
  activeRun: z
    .object({
      id,
      status: runStatusSchema,
      connectionId: id,
      surface: z.enum(['chat', 'terminal']).optional(),
      waiting: waitingSchema.optional(),
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
  // Points a session at another Windows project directory.
  z
    .object({
      type: z.literal('session.move'),
      ...request,
      sessionId: id,
      projectPath: z.string().trim().min(1).max(2048),
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
    })
    .strict(),
  z
    .object({ type: z.literal('terminal.close'), ...request, sessionId: id, terminalId: id })
    .strict(),
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
      scenario: scenarioSchema.default('chat'),
    })
    .strict(),
  z.object({ type: z.literal('run.cancel'), ...request, sessionId: id, runId: id }).strict(),
  z
    .object({
      type: z.literal('run.task.stop'),
      ...request,
      sessionId: id,
      runId: id,
      taskId: z.string().min(1).max(200),
    })
    .strict(),
  z
    .object({
      type: z.literal('approval.reply'),
      ...request,
      sessionId: id,
      runId: id,
      approvalId: id,
      allowed: z.boolean(),
      // The answers to a question Claude asked, keyed by the question's text.
      answers: z.record(z.string().max(2000), z.string().max(4000)).optional(),
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
export const authSchema = z
  .object({
    type: z.literal('auth'),
    // Any number is accepted here: a client of another version holding the right token is told how to upgrade.
    protocolVersion: z.number().int().positive(),
    token: z.string().min(24).max(512),
    deviceName: z.string().trim().min(1).max(120),
    tunnel: z.boolean().default(false),
  })
  .strict();
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
  z.object({ type: z.literal('tunnel.ready'), connectionId: id }),
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
  })
  .strict();
export type TunnelCredentials = z.infer<typeof tunnelCredentialsSchema>;
