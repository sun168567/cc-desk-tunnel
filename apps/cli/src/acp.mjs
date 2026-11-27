import { basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { TaskList, terminalStatuses } from '@cc-desk-tunnel/protocol';
import { Follow, catchUp, findSession } from './agent.mjs';
import { t } from './i18n.mjs';

// `ccdt acp`: Claude Code on the service as an agent of the Agent Client Protocol (agentclientprotocol.com), over
// standard input and output, for the editors and agents that speak it (Zed, JetBrains, acpx…). It is a translation of
// the service's own conversation, as the desktop client shows it: an ACP session is a session of the service, whose
// approvals and history every window shows too; whichever answers an approval first decides it.

export const ACP_VERSION = 1;

// The permission modes of a session, as an ACP client offers them to choose from.
const MODES = ['auto', 'default', 'acceptEdits', 'plan', 'bypassPermissions'];
const modeList = () =>
  MODES.map((id) => ({
    id,
    name: t(`cli:acp.mode.${id}.name`),
    description: t(`cli:acp.mode.${id}.detail`),
  }));
const modes = (current) => ({ currentModeId: current ?? 'auto', availableModes: modeList() });
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const DEFAULT = 'default';

// What a client offers to choose for a session (ACP's session config options), most used first: the model, how hard
// it reasons, and the permission mode. `models` is the account's list as Claude Code last gave it, or empty while
// none has been read; the model chosen is then the only one offered. The choices are the desktop client's.
export function sessionOptions({ mode, model, effort }, models = []) {
  const current =
    models.find((row) => row.value === (model ?? DEFAULT)) ??
    (model ? models.find((row) => row.resolvedModel === model) : undefined);
  const rows = current
    ? models
    : [
        { value: model ?? DEFAULT, displayName: model ?? t('cli:acp.default'), description: '' },
        ...models,
      ];
  const levels = current?.supportedEffortLevels ?? [];
  return [
    {
      id: 'model',
      name: t('cli:acp.model'),
      category: 'model',
      type: 'select',
      currentValue: current?.value ?? model ?? DEFAULT,
      options: rows.map((row) => ({
        value: row.value,
        name: row.displayName,
        ...(row.description ? { description: row.description } : {}),
      })),
    },
    ...(levels.length
      ? [
          {
            id: 'effort',
            name: t('cli:acp.effort'),
            category: 'thought_level',
            type: 'select',
            currentValue: effort && levels.includes(effort) ? effort : DEFAULT,
            options: [
              { value: DEFAULT, name: t('cli:acp.default') },
              ...levels.map((level) => ({
                value: level,
                name: EFFORTS.includes(level) ? t(`cli:acp.level.${level}`) : level,
              })),
            ],
          },
        ]
      : []),
    {
      id: 'mode',
      name: t('cli:acp.mode.title'),
      category: 'mode',
      type: 'select',
      currentValue: mode ?? 'auto',
      options: modeList().map(({ id, name, description }) => ({ value: id, name, description })),
    },
  ];
}

const KINDS = {
  Bash: 'execute',
  PowerShell: 'execute',
  BashOutput: 'execute',
  Read: 'read',
  NotebookRead: 'read',
  Edit: 'edit',
  MultiEdit: 'edit',
  Write: 'edit',
  NotebookEdit: 'edit',
  Grep: 'search',
  Glob: 'search',
  LS: 'search',
  ToolSearch: 'search',
  WebFetch: 'fetch',
  WebSearch: 'fetch',
  Task: 'think',
  Agent: 'think',
  EnterPlanMode: 'switch_mode',
  ExitPlanMode: 'switch_mode',
};
const parse = (text) => {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? value : undefined;
  } catch {
    return undefined;
  }
};
const line = (text, length = 120) => {
  const words = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return words.length > length ? `${words.slice(0, length)}…` : words;
};
// How a tool call is named to the client: what it does, as far as its input tells.
function toolCall(name, input) {
  const value = parse(input);
  const what =
    value?.description ??
    value?.command ??
    value?.file_path ??
    value?.path ??
    value?.pattern ??
    value?.url ??
    value?.query ??
    value?.prompt;
  return {
    title: what ? `${name}: ${line(what)}` : name,
    kind: KINDS[name] ?? 'other',
    rawInput: value ?? (input ? { input } : {}),
  };
}
const text = (words) => ({ type: 'text', text: words });

// What a prompt's content blocks say, as one message: text as it is, a file referred to by its address, an embedded
// one with its text.
export function promptText(blocks = []) {
  return blocks
    .map((block) =>
      block.type === 'text'
        ? block.text
        : block.type === 'resource_link'
          ? `@${block.uri}`
          : block.type === 'resource' && typeof block.resource?.text === 'string'
            ? `@${block.resource.uri}\n\`\`\`\n${block.resource.text}\n\`\`\``
            : '',
    )
    .filter(Boolean)
    .join('\n')
    .trim();
}

export async function serveAcp(context, { input = process.stdin, output = process.stdout } = {}) {
  let service;
  let connecting;
  // The ACP sessions served, by the service's session ID which is their ID too.
  const sessions = new Map();
  const asked = new Map();
  // The account's models as Claude Code last gave them in any session served, for the sessions made after.
  let models = [];
  let nextId = 1;
  const write = (message) => output.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  const notify = (sessionId, update) =>
    write({ method: 'session/update', params: { sessionId, update } });
  // A request to the client, such as for permission; its answer resolves it.
  const ask = (method, params) =>
    new Promise((resolve, reject) => {
      const id = `ccdt-${nextId++}`;
      asked.set(id, { resolve, reject });
      write({ id, method, params });
    });

  // One connection to the service for every session, with this computer's execution channel for runs on it; made
  // again after it is lost.
  async function connected(session) {
    if (service && !service.ended) return service;
    connecting ??= (async () => {
      const made = await context.connect();
      made.on('message', route);
      made.once('end', () => {
        if (service === made) service = undefined;
      });
      service = made;
      return made;
    })().finally(() => (connecting = undefined));
    const made = await connecting;
    return session ? await kept(made, session) : made;
  }
  async function kept(made, session) {
    const after = await context.keep(made, session);
    if (after !== made) {
      after.on('message', route);
      service = after;
    }
    return after;
  }

  // What the service says of a session, passed on as ACP updates.
  function route(message) {
    const id = message.sessionId ?? message.event?.sessionId ?? message.session?.id;
    const served = id && sessions.get(id);
    if (!served) return;
    if (message.type === 'session.fragment') {
      const payload = message.payload;
      if (payload.type === 'text.delta') {
        served.streamed.add(payload.messageId);
        notify(id, {
          sessionUpdate: 'agent_message_chunk',
          content: text(payload.text),
          messageId: payload.messageId,
        });
      } else if (payload.type === 'thinking.delta') {
        served.streamed.add(payload.messageId);
        notify(id, {
          sessionUpdate: 'agent_thought_chunk',
          content: text(payload.text),
          messageId: payload.messageId,
        });
      }
    } else if (message.type === 'session.event') {
      if (served.follow.apply(message.event)) translate(served, message.event.payload, true);
      served.wake?.();
    } else if (message.type === 'session.updated') {
      // A choice made in a window, or by Claude entering plan mode, shows in the client too.
      chosen(served, message.session);
      served.wake?.();
    }
  }
  // The session's model, effort and mode as the service holds them; a change is told to the client.
  function chosen(served, session) {
    const before = JSON.stringify([served.mode, served.model, served.effort]);
    if (session.permissionMode && session.permissionMode !== served.mode) {
      served.mode = session.permissionMode;
      notify(served.id, { sessionUpdate: 'current_mode_update', currentModeId: served.mode });
    }
    if ('model' in session) served.model = session.model ?? null;
    if ('effort' in session) served.effort = session.effort ?? null;
    if (JSON.stringify([served.mode, served.model, served.effort]) !== before) offered(served);
  }
  const options = (served) => sessionOptions(served, models);
  function offered(served) {
    if (served.open)
      notify(served.id, { sessionUpdate: 'config_option_update', configOptions: options(served) });
  }

  // A recorded event as ACP says it. Text is passed on as it streams; a stretch recorded whole is said here only where
  // none of it streamed, as when it is replayed or arrived while the connection was being made again.
  function translate(served, payload, live) {
    const id = served.id;
    // Claude Code's task list is ACP's plan, given whole each time it changes.
    if (served.tasks.apply(payload))
      notify(id, {
        sessionUpdate: 'plan',
        entries: served.tasks.list.map((task) => ({
          content: task.content,
          priority: 'medium',
          status: task.status,
        })),
      });
    switch (payload.type) {
      case 'message.user':
        if (!live)
          notify(id, {
            sessionUpdate: 'user_message_chunk',
            content: text(payload.text),
            messageId: payload.messageId,
          });
        break;
      case 'text.delta':
      case 'thinking.delta':
        if (!served.streamed.has(payload.messageId))
          notify(id, {
            sessionUpdate:
              payload.type === 'text.delta' ? 'agent_message_chunk' : 'agent_thought_chunk',
            content: text(payload.text),
            messageId: payload.messageId,
          });
        break;
      case 'tool.requested':
        notify(id, {
          sessionUpdate: 'tool_call',
          toolCallId: payload.toolId,
          ...toolCall(payload.name, payload.input),
          status: 'pending',
        });
        break;
      case 'tool.input': {
        const tool = served.follow.tools.get(payload.toolId);
        notify(id, {
          sessionUpdate: 'tool_call_update',
          toolCallId: payload.toolId,
          ...toolCall(tool?.name ?? '', payload.input),
        });
        break;
      }
      case 'tool.result':
        notify(id, {
          sessionUpdate: 'tool_call_update',
          toolCallId: payload.toolId,
          status: payload.status === 'completed' ? 'completed' : 'failed',
          ...(payload.output
            ? { content: [{ type: 'content', content: text(payload.output.slice(0, 20000)) }] }
            : {}),
        });
        break;
      case 'approval.requested':
        if (live) void permission(served, payload.approvalId);
        break;
      case 'native.mode':
        chosen(served, { permissionMode: payload.permissionMode });
        break;
      case 'native.capabilities':
        if (JSON.stringify(payload.models) !== JSON.stringify(models)) {
          models = payload.models;
          offered(served);
        }
        break;
      case 'native.title':
        notify(id, { sessionUpdate: 'session_info_update', title: payload.title });
        break;
      case 'run.error':
        notify(id, {
          sessionUpdate: 'agent_message_chunk',
          content: text(`\n\n[${payload.message}]`),
        });
        break;
    }
  }

  // Claude waits on a tool or its plan: the client is asked. A question has no ACP form: it is said as text and the
  // turn ends, and the next prompt is the answer, as a message written in the chat is.
  async function permission(served, approvalId) {
    const approval = served.follow.pending();
    if (!approval || approval.approvalId !== approvalId) return;
    if (approval.kind === 'question') {
      served.question = true;
      notify(served.id, {
        sessionUpdate: 'agent_message_chunk',
        content: text(
          `\n\n${approval.questions
            .map(
              (item, index) =>
                `${index + 1}. ${item.question}${item.options.length ? t('cli:acp.options', { options: item.options.join(' / ') }) : ''}`,
            )
            .join('\n')}\n\n${t('cli:acp.replyToAnswer')}`,
        ),
      });
      served.wake?.();
      return;
    }
    const plan = approval.kind === 'plan';
    const options = plan
      ? [
          { optionId: 'auto', name: t('cli:acp.plan.auto'), kind: 'allow_once' },
          { optionId: 'acceptEdits', name: t('cli:acp.plan.acceptEdits'), kind: 'allow_once' },
          { optionId: 'default', name: t('cli:acp.plan.default'), kind: 'allow_once' },
          { optionId: 'reject', name: t('cli:acp.plan.reject'), kind: 'reject_once' },
        ]
      : [
          { optionId: 'allow', name: t('cli:acp.allow'), kind: 'allow_once' },
          { optionId: 'reject', name: t('cli:acp.reject'), kind: 'reject_once' },
        ];
    const tool = served.follow.tools.get(approval.toolId);
    let outcome;
    try {
      ({ outcome } = await ask('session/request_permission', {
        sessionId: served.id,
        toolCall: {
          toolCallId: approval.toolId,
          ...toolCall(tool?.name ?? '', tool?.input),
          status: 'pending',
          ...(plan ? { content: [{ type: 'content', content: text(approval.plan) }] } : {}),
        },
        options,
      }));
    } catch {
      return;
    }
    // Answered meanwhile in a window, or the turn cancelled: nothing is sent.
    if (outcome?.outcome !== 'selected' || !served.follow.approvals.has(approvalId)) return;
    const allowed = outcome.optionId !== 'reject';
    await (
      await connected()
    )
      .request({
        type: 'approval.reply',
        sessionId: served.id,
        runId: approval.runId,
        approvalId,
        allowed,
        ...(plan && allowed ? { plan: { mode: outcome.optionId } } : {}),
      })
      .catch((error) => context.err(t('cli:acp.replyFailed', { reason: error.message })));
  }

  function served(sessionId) {
    const found = sessions.get(sessionId);
    if (!found)
      throw Object.assign(new Error(t('cli:acp.noSession', { id: sessionId })), { code: -32602 });
    return found;
  }
  function serve(session) {
    const entry = {
      id: session.id,
      follow: new Follow(session.id),
      streamed: new Set(),
      tasks: new TaskList(),
      question: false,
      wake: undefined,
      mode: session.permissionMode ?? 'auto',
      model: session.model ?? null,
      effort: session.effort ?? null,
      // Told to the client: before it has the session's ID, nothing is said of it.
      open: false,
    };
    sessions.set(session.id, entry);
    return entry;
  }
  const ignored = (servers) => {
    if (servers?.length)
      context.err(t('cli:acp.mcpIgnored', { names: servers.map((server) => server.name) }));
  };

  // A choice made in the client, kept by the service for the session's next turns as a window's is. `answered`: the
  // client gets the options back in the answer to its request, not in an update besides.
  async function configure(entry, change, answered = false) {
    const next = { mode: entry.mode, model: entry.model, effort: entry.effort, ...change };
    await (
      await connected()
    ).request({
      type: 'session.configure',
      sessionId: entry.id,
      permissionMode: next.mode,
      ...('model' in change ? { model: next.model } : {}),
      ...('effort' in change ? { effort: next.effort } : {}),
    });
    const modeChanged = next.mode !== entry.mode;
    Object.assign(entry, next);
    if (modeChanged)
      notify(entry.id, { sessionUpdate: 'current_mode_update', currentModeId: entry.mode });
    if (!answered) offered(entry);
  }

  const methods = {
    initialize: () => ({
      protocolVersion: ACP_VERSION,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: false, audio: false, embeddedContext: true },
        mcpCapabilities: { http: false, sse: false },
        sessionCapabilities: { close: {} },
      },
      authMethods: [],
      agentInfo: { name: 'ccdt', title: 'CC Desk Tunnel', version: context.version },
    }),
    async 'session/new'({ cwd, mcpServers }) {
      ignored(mcpServers);
      const made = await connected();
      const response = await made.request({
        type: 'session.create',
        title: (basename(cwd) || cwd).slice(0, 120),
        projectPath: cwd,
      });
      const session = made.sessions.get(response.sessionId) ?? { id: response.sessionId };
      await kept(made, session);
      const entry = serve(session);
      // The models are what Claude Code says it offers. A new session holds them as Claude Code last gave them in
      // any session; failing that they are read once, for the first session, as the desktop client reads them. A run
      // gives them again; a service that cannot read them now leaves the model chosen alone.
      if (!models.length)
        await catchUp(made, entry.follow, (event, live) =>
          translate(entry, event.payload, live),
        ).catch(() => {});
      if (!models.length)
        await Promise.race([
          made.request({ type: 'session.status', sessionId: session.id }).catch(() => {}),
          new Promise((resolve) => setTimeout(resolve, 15000).unref?.()),
        ]);
      entry.open = true;
      return {
        sessionId: session.id,
        modes: modes(entry.mode),
        configOptions: options(entry),
      };
    },
    // The newest page of its history is replayed; what is earlier stays in the windows.
    async 'session/load'({ sessionId, mcpServers }) {
      ignored(mcpServers);
      const made = await connected();
      const session = findSession([...made.sessions.values()], sessionId);
      const entry = serve(session);
      const snapshot = await catchUp(made, entry.follow, (event, live) =>
        translate(entry, event.payload, live),
      );
      if (snapshot?.session) chosen(entry, snapshot.session);
      entry.open = true;
      return { modes: modes(entry.mode), configOptions: options(entry) };
    },
    // The client is done with the session here; it stays on the service, as every session does.
    'session/close'({ sessionId }) {
      sessions.delete(sessionId);
      return {};
    },
    async 'session/set_mode'({ sessionId, modeId }) {
      await configure(served(sessionId), { mode: modeId });
      return {};
    },
    // A model chosen starts at its own default effort, as in the desktop client.
    async 'session/set_config_option'({ sessionId, configId, value }) {
      const entry = served(sessionId);
      const option = options(entry).find((item) => item.id === configId);
      if (!option)
        throw Object.assign(new Error(t('cli:acp.noOption', { id: configId })), { code: -32602 });
      if (!option.options.some((item) => item.value === value))
        throw Object.assign(new Error(t('cli:acp.noValue', { option: option.name, value })), {
          code: -32602,
        });
      await configure(
        entry,
        configId === 'model'
          ? { model: value === DEFAULT ? null : value, effort: null }
          : configId === 'effort'
            ? { effort: value === DEFAULT ? null : value }
            : { mode: value },
        true,
      );
      return { configOptions: options(entry) };
    },
    async 'session/prompt'({ sessionId, prompt }) {
      const entry = served(sessionId);
      const words = promptText(prompt);
      if (!words) throw Object.assign(new Error(t('cli:acp.noText')), { code: -32602 });
      let made = await connected();
      made = await kept(made, made.sessions.get(sessionId) ?? { id: sessionId });
      entry.question = false;
      // The message's events may come before the answer to it: what is followed begins at it from the start. What was
      // learnt of the session's tools and approvals stays.
      const messageId = randomUUID();
      entry.follow = Object.assign(new Follow(sessionId, messageId), {
        tools: entry.follow.tools,
        approvals: entry.follow.approvals,
        seen: entry.follow.seen,
      });
      await made.request({ type: 'message.send', sessionId, text: words, requestId: messageId });
      return { stopReason: await turn(entry) };
    },
  };

  // Until the turn ends, Claude waits on a question, or the connection is lost and made again.
  async function turn(entry) {
    for (;;) {
      const made = service;
      const status = entry.follow.status;
      if (entry.question) return 'end_turn';
      if (entry.follow.started && status) {
        if (status.status === 'cancelled') return 'cancelled';
        if (status.status === 'failed')
          throw Object.assign(
            new Error(
              entry.follow.errors.join(t('cli:next.errorSeparator')) || t('cli:next.failed'),
            ),
            {
              code: -32603,
            },
          );
        if (terminalStatuses.has(status.status) || status.waiting === 'background')
          return 'end_turn';
      }
      await new Promise((resolve) => {
        const done = () => {
          made?.off('end', done);
          resolve();
        };
        entry.wake = done;
        if (!made || made.ended) done();
        else made.once('end', done);
      });
      entry.wake = undefined;
      if (!service || service.ended) {
        // Made again, the run is caught up with from the newest page of its history.
        for (let wait = 1000; ; wait = Math.min(wait * 2, 15000)) {
          try {
            const again = await connected({ id: entry.id });
            await catchUp(again, entry.follow, (event) => translate(entry, event.payload, true));
            break;
          } catch (error) {
            if (error.code === 'unauthorized' || error.code === 'version_mismatch') throw error;
            await new Promise((resolve) => setTimeout(resolve, wait));
          }
        }
      }
    }
  }

  async function handle(message) {
    if (message.method === undefined) {
      const waiting = asked.get(message.id);
      if (!waiting) return;
      asked.delete(message.id);
      if (message.error) waiting.reject(new Error(message.error.message));
      else waiting.resolve(message.result ?? {});
      return;
    }
    if (message.method === 'session/cancel') {
      const entry = sessions.get(message.params?.sessionId);
      const run = entry && service?.sessions.get(entry.id)?.activeRun;
      if (run)
        await service
          .request({ type: 'run.cancel', sessionId: entry.id, runId: run.id })
          .catch(() => {});
      return;
    }
    const method = methods[message.method];
    if (message.id === undefined) return;
    if (!method)
      return write({
        id: message.id,
        error: { code: -32601, message: t('cli:acp.unsupported', { method: message.method }) },
      });
    try {
      write({ id: message.id, result: (await method(message.params ?? {})) ?? null });
    } catch (error) {
      write({
        id: message.id,
        error: {
          code: typeof error.code === 'number' ? error.code : -32603,
          message: error.message,
        },
      });
    }
  }

  const lines = createInterface({ input });
  for await (const raw of lines) {
    if (!raw.trim()) continue;
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      write({ id: null, error: { code: -32700, message: t('cli:acp.notJson') } });
      continue;
    }
    void handle(message);
  }
  for (const waiting of asked.values()) waiting.reject(new Error(t('cli:acp.inputEnded')));
  await service?.close().catch(() => {});
  return 0;
}
