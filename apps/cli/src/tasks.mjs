import { basename } from 'node:path';
import { EXIT, Follow, exitOf, findSession, follow, said, subscribe } from './agent.mjs';
import { t } from './i18n.mjs';

// The commands of ccdt for programs and other agents: `ccdt -p` as `claude -p` is written, and the commands that
// follow a session afterwards. `context` brings what main.mjs knows: how to sign in, and how to make sure this
// computer's execution channel is there for a run on it.

const short = (id) => id.slice(0, 8);
const clip = (text, length = 200) => {
  const line = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return line.length > length ? `${line.slice(0, length)}…` : line;
};

// What to do next, said to whoever reads the error output: the words a program needs to carry on.
export function next(result) {
  const id = short(result.session_id);
  const approval = result.approval;
  switch (result.state) {
    case 'awaiting_approval':
      return [
        approval.kind === 'plan'
          ? t('cli:next.plan', { plan: approval.plan })
          : t(approval.safetyCheck ? 'cli:next.approvalSafety' : 'cli:next.approval', {
              tool: approval.tool,
              input: clip(
                typeof approval.input === 'string'
                  ? approval.input
                  : JSON.stringify(approval.input),
              ),
            }),
        approval.reason && t('cli:next.reason', { reason: approval.reason }),
        approval.kind === 'plan'
          ? t('cli:next.approvePlan', { id })
          : t('cli:next.approveTool', { id }),
        t('cli:next.afterReplyOrWindow'),
      ]
        .filter(Boolean)
        .join('\n');
    case 'awaiting_answer':
      return [
        t('cli:next.asking'),
        ...approval.questions.map(
          (item, index) =>
            `${index + 1}. ${item.question}${
              item.options.length
                ? t(item.multiSelect ? 'cli:next.optionsMulti' : 'cli:next.options', {
                    options: item.options.join(' / '),
                  })
                : ''
            }`,
        ),
        t('cli:next.answer', { id }),
        t('cli:next.afterReply'),
      ].join('\n');
    case 'background':
      return t('cli:next.background', { id });
    case 'running':
      return t('cli:next.running', { id });
    case 'failed':
      return result.errors?.length
        ? t('cli:next.failedWith', { errors: result.errors.join(t('cli:next.errorSeparator')) })
        : t('cli:next.failed');
    case 'cancelled':
      return t('cli:next.cancelled');
    default:
      return undefined;
  }
}

// Prints a result as asked: the reply alone (text), or one JSON object.
function print(context, result, format) {
  if (format === 'json') context.out(JSON.stringify(result));
  else {
    if (result.result) context.out(result.result);
    const words = next(result);
    if (words) context.err(words);
  }
  return exitOf(result.state);
}

// One line of JSON per thing that happens, for a caller that shows the run as it goes. Text arrives in pieces
// (fragments); the event recorded once a stretch is over repeats it whole and is left out here. Claude's reasoning
// comes only where the CLI setting to show it is on, as in the windows.
export function streamer(context) {
  return (payload, fragment) => {
    const line = (value) => context.out(JSON.stringify(value));
    if (payload.type === 'text.delta' && fragment)
      line({ type: 'text', message_id: payload.messageId, text: payload.text });
    else if (payload.type === 'thinking.delta' && fragment)
      line({ type: 'thinking', message_id: payload.messageId, text: payload.text });
    else if (payload.type === 'tool.requested')
      line({ type: 'tool', tool_id: payload.toolId, name: payload.name, input: payload.input });
    else if (payload.type === 'tool.result')
      line({
        type: 'tool_result',
        tool_id: payload.toolId,
        status: payload.status,
        output: clip(payload.output, 2000),
      });
    else if (payload.type === 'run.status')
      line({
        type: 'status',
        status: payload.status,
        ...(payload.waiting ? { waiting: payload.waiting } : {}),
      });
    else if (payload.type === 'run.error') line({ type: 'error', message: payload.message });
  };
}

// Said where a run on this computer goes on after ccdt has let go of its connection.
const uncarried = () => t('cli:task.uncarried');

// Follows the run to where it stops, signing in again after a lost connection, and prints the result.
async function await_(
  context,
  service,
  session,
  since,
  { format, timeoutMs, past, answered } = {},
) {
  const followed = new Follow(session.id, since);
  if (answered) followed.answered.add(answered);
  const deadline = timeoutMs ? Date.now() + timeoutMs : undefined;
  const onEvent = format === 'stream-json' ? streamer(context) : undefined;
  for (let wait = 1000; ; wait = Math.min(wait * 2, 15000)) {
    try {
      const stop = await follow(service, followed, { deadline, past, onEvent });
      await context.release(service);
      const result = followed.result(stop);
      if (format === 'stream-json') {
        context.out(JSON.stringify({ type: 'result', ...result }));
        const words = next(result);
        if (words) context.err(words);
        return exitOf(result.state);
      }
      return print(context, result, format);
    } catch (error) {
      if (error.exit !== EXIT.connection || !service.ended) throw error;
      context.err(t('cli:task.reconnecting'));
      await new Promise((resolve) => setTimeout(resolve, wait));
      try {
        service = await context.keep(await context.connect(), session);
      } catch (failure) {
        if (failure.code === 'unauthorized' || failure.code === 'version_mismatch') throw failure;
      }
    }
  }
}

const formatOf = (values) => {
  const format = values['output-format'] ?? (values.json ? 'json' : 'text');
  if (!['text', 'json', 'stream-json'].includes(format)) throw said(t('cli:task.badFormat'));
  return format;
};
const timeoutOf = (values) => {
  if (values.timeout === undefined) return undefined;
  const seconds = Number(values.timeout);
  if (!(seconds > 0)) throw said(t('cli:task.badTimeout'));
  return seconds * 1000;
};

// The session settings a task asks for, applied before its message; the rest stay as the session has them.
async function configure(service, session, values) {
  const mode = values['permission-mode'];
  if (!mode && !values.model && !values.effort) return;
  await service.request({
    type: 'session.configure',
    sessionId: session.id,
    permissionMode: mode ?? session.permissionMode ?? 'auto',
    ...(values.model ? { model: values.model } : {}),
    ...(values.effort ? { effort: values.effort } : {}),
  });
}

// `ccdt -p "task"`: a new session of this directory's project (or -c the latest, -r <ID> a given one) is sent the
// task, and the reply printed once Claude's turn ends or it waits on someone. `--bg` sends it and returns at once.
export async function printTask(context, values, prompt) {
  const format = formatOf(values);
  const text = prompt.trim();
  if (!text) throw said(t('cli:task.noText'));
  let service = await context.connect();
  const all = [...service.sessions.values()];
  let session;
  if (values.session) session = findSession(all, values.session);
  else if (values.continue) {
    session = context.newest(all.filter((other) => context.mine(other)))[0];
    if (!session) throw said(t('cli:task.noSession'));
  } else {
    const response = await service.request({
      type: 'session.create',
      title: clip(values.title ?? text, 60) || basename(context.here),
      projectPath: context.here,
    });
    session = service.sessions.get(response.sessionId) ?? {
      id: response.sessionId,
      projectPath: context.here,
      permissionMode: 'auto',
    };
  }
  await configure(service, session, values);
  service = await context.keep(service, session);
  const sent = await service.request({ type: 'message.send', sessionId: session.id, text });
  const since = sent.requestId;
  if (values.bg) {
    // A run on this computer needs its execution channel: another connection of it keeps it from here on.
    await context.release(service);
    const result = { session_id: session.id, state: 'running', result: '' };
    if (format === 'text') context.out(session.id);
    else context.out(JSON.stringify(result));
    context.err(
      `${t('cli:task.sent', { id: short(session.id) })}${context.carried(session) ? '' : `\n${uncarried()}`}`,
    );
    return EXIT.done;
  }
  return await await_(context, service, session, since, {
    format,
    timeoutMs: timeoutOf(values),
  });
}

// The session a command names. `channel`: the command may start or keep a run on this computer, which needs its
// execution channel; the others only read or answer and open none.
async function opened(context, ref, channel = false) {
  const service = await context.connect(channel ? undefined : false);
  const session = findSession([...service.sessions.values()], ref);
  return { service, session };
}

function state(session, stop) {
  const run = session.activeRun;
  if (run?.surface === 'terminal') return 'terminal';
  if (stop) return stop.state;
  return run ? 'running' : 'idle';
}

// `ccdt status <ID>`: what the session is doing now and what it waits on.
export async function status(context, values, ref) {
  const { service, session } = await opened(context, ref);
  const followed = new Follow(session.id);
  const snapshot = await subscribe(service, session.id);
  for (const event of snapshot?.events ?? []) followed.apply(event);
  const current = snapshot?.session ?? session;
  await context.release(service);
  const stop = current.activeRun ? followed.stopped(current.activeRun) : undefined;
  const latest = (snapshot?.events ?? [])
    .filter((event) =>
      ['tool.requested', 'text.delta', 'message.user'].includes(event.payload.type),
    )
    .at(-1)?.payload;
  // A tool's input arrives whole after it was asked for.
  const last =
    latest?.type === 'tool.requested'
      ? { ...latest, input: followed.tools.get(latest.toolId)?.input ?? latest.input }
      : latest;
  const result = {
    session_id: current.id,
    title: current.title,
    project: current.projectPath,
    ...(current.device ? { device: current.device.name } : {}),
    state: state(current, stop),
    ...(stop?.approval ? { approval: followed.result(stop).approval } : {}),
    ...(last
      ? {
          last:
            last.type === 'tool.requested'
              ? { tool: last.name, input: clip(last.input) }
              : { [last.type === 'message.user' ? 'user' : 'text']: clip(last.text) },
        }
      : {}),
    reply: followed.reply(),
    updated_at: current.updatedAt,
  };
  if (values.json) context.out(JSON.stringify(result));
  else {
    const states = [
      'idle',
      'running',
      'background',
      'awaiting_approval',
      'awaiting_answer',
      'terminal',
    ];
    context.out(
      [
        t('cli:status.line', {
          title: current.title,
          id: short(current.id),
          state: states.includes(result.state)
            ? t(`cli:status.state.${result.state}`)
            : result.state,
        }),
        last?.type === 'tool.requested' &&
          t('cli:status.latest', { tool: last.name, input: clip(last.input, 120) }),
        result.reply && t('cli:status.reply', { reply: clip(result.reply, 300) }),
      ]
        .filter(Boolean)
        .join('\n'),
    );
    if (stop?.approval) context.err(next(followed.result(stop)));
  }
  return stop ? exitOf(stop.state) : EXIT.done;
}

// `ccdt tell <ID> "…"`: a message to the session. While Claude works it joins the turn under way, which is how
// a run is steered; otherwise it starts the next turn.
export async function tell(context, values, ref, text) {
  if (!text.trim()) throw said(t('cli:task.noTell'));
  let { service, session } = await opened(context, ref, true);
  // Whether it joins a turn under way, as the session was before it was sent.
  const running = !!session.activeRun;
  service = await context.keep(service, session);
  await service.request({ type: 'message.send', sessionId: session.id, text: text.trim() });
  await context.release(service);
  if (values.json)
    context.out(JSON.stringify({ session_id: session.id, sent: true, joined: running }));
  context.err(
    `${t(running ? 'cli:task.added' : 'cli:task.told', { id: short(session.id) })}${running || context.carried(session) ? '' : `\n${uncarried()}`}`,
  );
  return EXIT.done;
}

// `ccdt wait <ID>`: until Claude's turn ends, it waits on someone, or the run ends. Waiting begun while only
// background tasks run waits for what comes after them.
export async function wait(context, values, ref) {
  let { service, session } = await opened(context, ref, true);
  const run = session.activeRun;
  if (run?.surface === 'terminal') throw said(t('cli:task.inTerminal'));
  service = await context.keep(service, session);
  return await await_(context, service, session, undefined, {
    format: formatOf(values),
    timeoutMs: timeoutOf(values),
    past: run?.waiting === 'background' ? 'background' : undefined,
  });
}

// `ccdt stop <ID>`: ends the turn under way, as the stop button does.
export async function stop(context, values, ref) {
  const { service, session } = await opened(context, ref);
  const run = session.activeRun;
  if (!run) {
    await context.release(service);
    context.err(t('cli:task.notRunning'));
    return EXIT.done;
  }
  await service.request({ type: 'run.cancel', sessionId: session.id, runId: run.id });
  await context.release(service);
  if (values.json) context.out(JSON.stringify({ session_id: session.id, stopped: true }));
  else context.err(t('cli:task.stopped'));
  return EXIT.done;
}

// What Claude waits on in the session now, read from its latest history. Unless only the answer is sent (`bg`),
// the command goes on as Claude does, which on this computer needs its execution channel.
async function waitingOn(context, ref, bg) {
  const { service, session } = await opened(context, ref, !bg);
  const followed = new Follow(session.id);
  const snapshot = await subscribe(service, session.id);
  for (const event of snapshot?.events ?? []) followed.apply(event);
  const approval =
    (snapshot?.session ?? session).activeRun?.status === 'awaiting_approval' && followed.pending();
  if (!approval) {
    await context.release(service);
    throw said(t('cli:task.nothingWaiting'));
  }
  return { service, session, approval };
}

// The answer sent, and Claude followed to where it stops next, as `ccdt -p` does: what it goes on to run on this
// computer needs the channel up before the answer lets it. `--bg` sends the answer alone.
async function reply(context, values, service, session, approval, answer) {
  if (!values.bg) service = await context.keep(service, session);
  await service.request({
    type: 'approval.reply',
    sessionId: session.id,
    runId: approval.runId,
    approvalId: approval.approvalId,
    ...answer,
  });
  if (!values.bg)
    return await await_(context, service, session, undefined, {
      format: formatOf(values),
      timeoutMs: timeoutOf(values),
      answered: approval.approvalId,
    });
  await context.release(service);
  if (values.json || formatOf(values) !== 'text')
    context.out(JSON.stringify({ session_id: session.id, answered: true }));
  context.err(
    `${t('cli:task.replied', { id: short(session.id) })}${context.carried(session) ? '' : `\n${uncarried()}`}`,
  );
  return EXIT.done;
}

// `ccdt approve <ID>`: allows the tool or the plan Claude waits on, as the button in the window does.
export async function approve(context, values, ref) {
  const { service, session, approval } = await waitingOn(context, ref, values.bg);
  if (approval.kind === 'question') {
    await context.release(service);
    throw said(t('cli:task.askingNotApproval', { id: short(session.id) }));
  }
  if (values.mode && !['auto', 'acceptEdits', 'default'].includes(values.mode))
    throw said(t('cli:task.badMode'));
  return reply(context, values, service, session, approval, {
    allowed: true,
    ...(approval.kind === 'plan' && values.mode ? { plan: { mode: values.mode } } : {}),
  });
}

// `ccdt deny <ID> [reason]`: refuses it; for a plan the reason is what Claude plans further by. A question is
// left unanswered.
export async function deny(context, values, ref, reason) {
  const { service, session, approval } = await waitingOn(context, ref, values.bg);
  return reply(context, values, service, session, approval, {
    allowed: false,
    ...(approval.kind === 'plan' && reason.trim() ? { plan: { feedback: reason.trim() } } : {}),
  });
}

// `ccdt answer <ID> <answer>…`: one answer per question, in their order; several choices joined with commas.
export async function answer(context, values, ref, answers) {
  const { service, session, approval } = await waitingOn(context, ref, values.bg);
  if (approval.kind !== 'question') {
    await context.release(service);
    throw said(t('cli:task.approvalNotAsking', { id: short(session.id) }));
  }
  if (answers.length !== approval.questions.length) {
    await context.release(service);
    throw said(
      `${t('cli:task.answerCount', { count: approval.questions.length })}\n${approval.questions.map((item, index) => `${index + 1}. ${item.question}`).join('\n')}`,
    );
  }
  return reply(context, values, service, session, approval, {
    allowed: true,
    answers: Object.fromEntries(
      approval.questions.map((item, index) => [item.question, answers[index]]),
    ),
  });
}

// `ccdt logs <ID>`: what the session said and did lately, from the newest page of its history.
export async function logs(context, values, ref) {
  const { service, session } = await opened(context, ref);
  const snapshot = await subscribe(service, session.id);
  await context.release(service);
  const items = [];
  const texts = new Map();
  for (const { payload } of snapshot?.events ?? []) {
    if (payload.type === 'message.user') items.push({ type: 'user', text: payload.text });
    else if (payload.type === 'text.delta') {
      const item = texts.get(payload.messageId);
      if (item) item.text += payload.text;
      else {
        const created = { type: 'assistant', text: payload.text };
        texts.set(payload.messageId, created);
        items.push(created);
      }
    } else if (payload.type === 'tool.requested')
      items.push({
        type: 'tool',
        tool_id: payload.toolId,
        name: payload.name,
        input: clip(payload.input, 500),
      });
    else if (payload.type === 'tool.input') {
      const tool = items.findLast(
        (item) => item.type === 'tool' && item.tool_id === payload.toolId,
      );
      if (tool) tool.input = clip(payload.input, 500);
    } else if (payload.type === 'tool.result') {
      const tool = items.findLast(
        (item) => item.type === 'tool' && item.tool_id === payload.toolId,
      );
      if (tool) tool.status = payload.status;
    } else if (payload.type === 'run.error') items.push({ type: 'error', text: payload.message });
  }
  const count = Number(values.last ?? 20);
  const shown = items
    .filter((item) => item.type !== 'assistant' || item.text.trim())
    .slice(-Math.max(1, count));
  if (values.json) context.out(JSON.stringify(shown));
  else
    context.out(
      shown
        .map((item) =>
          item.type === 'tool'
            ? `· ${item.name} ${clip(item.input, 160)}${item.status ? t('cli:logs.status', { status: item.status }) : ''}`
            : item.type === 'user'
              ? `> ${item.text.trim()}`
              : item.type === 'error'
                ? `! ${item.text}`
                : item.text.trim(),
        )
        .join('\n\n'),
    );
  return EXIT.done;
}
