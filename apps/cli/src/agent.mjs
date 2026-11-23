import { randomUUID } from 'node:crypto';
import { terminalStatuses } from '@cc-desk-tunnel/protocol';

// What ccdt does for programs and other agents rather than for a person at a terminal: a message sent to a session
// and its run followed until it stops for someone. Everything goes through the service's own conversation, as the
// desktop client's does: the session, its approvals and its history are the same ones every window shows.

// The exit codes of these commands, which an agent can act on without reading the text.
export const EXIT = {
  done: 0,
  error: 1,
  // Claude waits on an approval or on an answer to its question.
  needsYou: 2,
  failed: 3,
  cancelled: 4,
  connection: 5,
  // Still at work when the wait ended (`--timeout`).
  running: 6,
};

export const said = (message, code = EXIT.error) =>
  Object.assign(new Error(message), { exit: code });

// A session named by its ID or the start of it.
export function findSession(sessions, ref) {
  const key = String(ref ?? '')
    .trim()
    .toLowerCase();
  if (!key) throw said('要写会话 ID（可只写开头几位）：ccdt sessions --json 列出这个目录的会话。');
  const found = sessions.filter((session) => session.id.startsWith(key));
  if (found.length === 1) return found[0];
  throw said(
    found.length
      ? `有 ${found.length} 个会话以 ${ref} 开头，请多写几位。`
      : `没有会话 ${ref}：ccdt sessions --all --json 列出全部会话。`,
  );
}

// The latest page of the session's history, which also subscribes this connection to what follows. A page too long
// for one frame comes in parts, each asked for in turn.
export function subscribe(service, sessionId) {
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    let parts = '';
    const finish = (error, snapshot) => {
      service.off('message', listen);
      service.off('end', ended);
      if (error) reject(error);
      else resolve(snapshot);
    };
    const ended = () => finish(said('连接已关闭。', EXIT.connection));
    const listen = (message) => {
      if (message.requestId !== requestId) return;
      if (message.type === 'session.snapshot') finish(undefined, message);
      else if (message.type === 'session.history.part') {
        parts += message.data;
        service.send({ type: 'session.history.next', requestId });
        if (message.last)
          finish(
            undefined,
            JSON.parse(parts).find((part) => part.type === 'session.snapshot'),
          );
      } else if (message.type === 'response' && !message.ok)
        finish(said(message.message ?? '读取会话失败。'));
    };
    service.on('message', listen);
    service.once('end', ended);
    service.send({ type: 'session.subscribe', requestId, sessionId });
  });
}

// The newest page of the session's history, read for `follow`. Events that come meanwhile, which may be newer than
// some on the page or among them, wait for it and are applied after it, in order. `each(event, live)` is told of
// every event new to `follow`: `live` for one that came while the page was read.
export async function catchUp(service, follow, each = () => {}) {
  follow.held = [];
  let snapshot, held;
  try {
    snapshot = await subscribe(service, follow.sessionId);
  } finally {
    held = follow.held;
    follow.held = undefined;
  }
  for (const event of snapshot?.events ?? []) if (follow.apply(event)) each(event, false);
  for (const event of held) if (follow.apply(event)) each(event, true);
  return snapshot;
}

const QUESTION = 'AskUserQuestion';
const PLAN = 'ExitPlanMode';
const parse = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};
// What Claude asks to be allowed, as a program can read it.
function described(approval, tools) {
  const tool = tools.get(approval.toolId) ?? { name: '', input: '' };
  if (tool.name === QUESTION)
    return {
      kind: 'question',
      questions: (parse(tool.input)?.questions ?? []).map((item) => ({
        question: item.question,
        options: (item.options ?? []).map((option) => option.label),
        multiSelect: !!item.multiSelect,
      })),
    };
  if (tool.name === PLAN) return { kind: 'plan', plan: parse(tool.input)?.plan ?? tool.input };
  return {
    kind: 'tool',
    tool: tool.name,
    input: parse(tool.input) ?? tool.input,
    ...(approval.reason ? { reason: approval.reason } : {}),
    ...(approval.safetyCheck ? { safetyCheck: true } : {}),
  };
}

// The state of one session's run as its events tell it, from the user message `since` on (or the latest one).
export class Follow {
  constructor(sessionId, since) {
    this.sessionId = sessionId;
    this.since = since;
    this.started = !since;
    this.seen = 0;
    this.texts = new Map();
    this.tools = new Map();
    this.approvals = new Map();
    this.status = undefined;
    this.runId = undefined;
    this.errors = [];
  }
  apply(event) {
    if (event.sessionId !== this.sessionId) return false;
    if (this.held) return (this.held.push(event), false);
    if (event.sequence <= this.seen) return false;
    this.seen = event.sequence;
    const payload = event.payload;
    switch (payload.type) {
      case 'message.user':
        // Without a message of its own, what is followed begins at the latest one.
        if (!this.since || (!this.started && payload.messageId === this.since)) {
          this.started = true;
          this.texts.clear();
          this.errors = [];
        }
        break;
      case 'text.delta':
        if (this.started)
          this.texts.set(
            payload.messageId,
            (this.texts.get(payload.messageId) ?? '') + payload.text,
          );
        break;
      case 'tool.requested':
        this.tools.set(payload.toolId, { name: payload.name, input: payload.input });
        break;
      case 'tool.input': {
        const tool = this.tools.get(payload.toolId);
        if (tool) tool.input = payload.input;
        break;
      }
      case 'approval.requested':
        this.approvals.set(payload.approvalId, { ...payload, runId: event.runId });
        break;
      case 'approval.resolved':
        this.approvals.delete(payload.approvalId);
        break;
      case 'run.status':
        this.status = payload;
        this.runId = event.runId;
        if (terminalStatuses.has(payload.status)) this.approvals.clear();
        break;
      case 'run.error':
        if (this.started) this.errors.push(payload.message);
        break;
    }
    return true;
  }
  // The approval Claude waits on, with what a program needs to answer it.
  pending() {
    const approval = [...this.approvals.values()].at(-1);
    return approval && { ...approval, ...described(approval, this.tools) };
  }
  // Claude's last words since the message followed.
  reply() {
    return (
      [...this.texts.values()]
        .filter((text) => text.trim())
        .at(-1)
        ?.trim() ?? ''
    );
  }
  // Where the run stopped for someone or ended, or undefined while it goes on. `activeRun` is the session's as the
  // service last said it, which tells a run that ended from one whose end is not in the page read.
  stopped(activeRun) {
    if (!this.started) return undefined;
    const status = this.status;
    if (activeRun === null && (!status || !terminalStatuses.has(status.status)))
      return { state: 'completed' };
    if (!status) return undefined;
    if (terminalStatuses.has(status.status)) return { state: status.status };
    if (status.status === 'awaiting_approval') {
      const approval = this.pending();
      if (approval)
        return {
          state: approval.kind === 'question' ? 'awaiting_answer' : 'awaiting_approval',
          approval,
        };
    }
    if (status.status === 'running' && status.waiting === 'background')
      return { state: 'background' };
    return undefined;
  }
  result(stop) {
    const approval =
      stop.approval &&
      (({ approvalId: _a, toolId: _t, runId: _r, type: _y, ...rest }) => rest)(stop.approval);
    return {
      session_id: this.sessionId,
      state: stop.state,
      result: this.reply(),
      is_error: stop.state === 'failed',
      ...(approval ? { approval } : {}),
      ...(this.errors.length ? { errors: this.errors } : {}),
    };
  }
}

export const exitOf = (state) =>
  ({
    completed: EXIT.done,
    background: EXIT.done,
    awaiting_approval: EXIT.needsYou,
    awaiting_answer: EXIT.needsYou,
    failed: EXIT.failed,
    cancelled: EXIT.cancelled,
    running: EXIT.running,
  })[state] ?? EXIT.error;

// Follows a session's run until it stops for someone or ends, or `timeoutMs` passes. `follow` carries what was learnt
// over a lost connection: the caller signs in again and calls this once more with it. `past` is a stop already known,
// such as background tasks running when the wait began, which is waited past to the next one. `onEvent` sees every
// event and fragment as it arrives, for output that streams.
export async function follow(service, follow, { deadline, past, onEvent } = {}) {
  const stop = () => {
    const found = follow.stopped(service.sessions.get(follow.sessionId)?.activeRun ?? null);
    return found && found.state !== past ? found : undefined;
  };
  let wake;
  const listen = (message) => {
    if (message.type === 'session.event' && message.event.sessionId === follow.sessionId) {
      if (follow.apply(message.event)) onEvent?.(message.event.payload, false);
      wake?.();
    } else if (message.type === 'session.fragment' && message.sessionId === follow.sessionId)
      onEvent?.(message.payload, true);
    else if (message.type === 'session.updated' && message.session.id === follow.sessionId)
      wake?.();
  };
  service.on('message', listen);
  try {
    const snapshot = await catchUp(service, follow, (event, live) => {
      if (live) onEvent?.(event.payload, false);
    });
    if (snapshot?.session) service.sessions.set(snapshot.session.id, snapshot.session);
    for (;;) {
      const found = stop();
      if (found) return found;
      if (deadline !== undefined && Date.now() >= deadline) return { state: 'running' };
      await new Promise((resolve, reject) => {
        const timer =
          deadline === undefined
            ? undefined
            : setTimeout(resolve, Math.max(0, deadline - Date.now()));
        const ended = () => reject(said('连接已关闭。', EXIT.connection));
        wake = () => {
          clearTimeout(timer);
          service.off('end', ended);
          resolve();
        };
        service.once('end', ended);
        if (service.ended) ended();
      });
      wake = undefined;
    }
  } finally {
    service.off('message', listen);
  }
}
