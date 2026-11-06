import type { SessionEvent, TurnStats } from '@cc-desk-tunnel/protocol';

export type ToolState =
  | 'requested'
  | 'approval'
  | 'running'
  | 'completed'
  | 'cancelled'
  | 'denied'
  | 'failed'
  | 'unknown';
export type TranscriptItem =
  | {
      kind: 'user' | 'assistant' | 'thinking';
      id: string;
      runId: string;
      text: string;
      delivery?: string;
      // Stands for the "continue" button: there is no message of the user's to show, edit or copy.
      continued?: boolean;
      // Asked in a terminal that continued the session; recorded as its CLI wrote it.
      terminal?: boolean;
      at: string;
      // A reply: when its last text arrived, which is when it was done (`at` is when it began).
      doneAt?: string;
    }
  | { kind: 'notice'; id: string; runId: string; text: string; error: boolean; at: string }
  // What the CLI said along the way, in its place among the steps.
  | { kind: 'note'; id: string; runId: string; text: string; at: string }
  | {
      kind: 'compact';
      id: string;
      runId: string;
      trigger?: string;
      at: string;
      // Set once the CLI reported the context compacted; without it the compaction is under way, or was cut off.
      endedAt?: string;
      previousTokens?: number | null;
    }
  | {
      kind: 'tool';
      id: string;
      runId: string;
      name: string;
      input: string;
      target: string;
      approvalId?: string;
      resolved: boolean;
      status: string;
      state: ToolState;
      at: string;
      // Set once the result arrived; a tool without it is still running or was left unfinished.
      endedAt?: string;
      output?: string;
      liveOutput?: string;
      elapsedSeconds?: number;
      // The task the call waits on in the foreground, which may be ended or sent to the background until it returns.
      taskId?: string;
      exitCode?: number | null;
    };

export function transcript(events: SessionEvent[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const byId = new Map<string, TranscriptItem>();
  const byApproval = new Map<string, Extract<TranscriptItem, { kind: 'tool' }>>();
  let compacting: Compact | undefined;
  const terminals = new Set<string>();
  function add(item: TranscriptItem) {
    items.push(item);
    byId.set(item.id, item);
  }
  for (const { runId, sequence, payload, createdAt: at } of events) {
    if (payload.type === 'run.status' && payload.surface === 'terminal') terminals.add(runId);
    // What the "continue" button sent is no words of the user's: the turn it starts shows a mark for it.
    if (payload.type === 'message.user')
      add({
        kind: 'user',
        id: payload.messageId,
        runId,
        text: payload.continued ? '继续' : payload.text,
        ...(payload.continued ? { continued: true } : {}),
        ...(terminals.has(runId) ? { terminal: true } : {}),
        at,
      });
    if (payload.type === 'message.delivery') {
      const item = byId.get(payload.messageId);
      if (item?.kind === 'user')
        item.delivery = {
          submitted: '已提交',
          queued: '等待原生处理',
          received: '原生已接收',
          not_sent: '未送达原生',
          unconfirmed: '接收未确认',
        }[payload.status];
    }
    if (payload.type === 'text.delta') {
      const existing = byId.get(payload.messageId);
      if (existing?.kind === 'assistant') {
        existing.text += payload.text;
        existing.doneAt = at;
      } else add({ kind: 'assistant', id: payload.messageId, runId, text: payload.text, at });
    }
    // Sessions recorded before summaries were requested hold thinking with nothing in it.
    if (payload.type === 'thinking.delta' && payload.text) {
      const id = `thinking-${payload.messageId}`;
      const existing = byId.get(id);
      if (existing?.kind === 'thinking') existing.text += payload.text;
      else add({ kind: 'thinking', id, runId, text: payload.text, at });
    }
    if (payload.type === 'tool.requested')
      add({
        kind: 'tool',
        id: payload.toolId,
        runId,
        name: payload.name,
        input: payload.input,
        target: payload.target,
        resolved: false,
        status: '已请求',
        state: 'requested',
        at,
      });
    if (payload.type === 'approval.requested') {
      const tool = byId.get(payload.toolId);
      if (tool?.kind === 'tool') {
        tool.approvalId = payload.approvalId;
        tool.status = '等待审批';
        tool.state = 'approval';
        byApproval.set(payload.approvalId, tool);
      }
    }
    if (payload.type === 'tool.input' || payload.type === 'tool.input.delta') {
      const tool = byId.get(payload.toolId);
      if (tool?.kind === 'tool')
        tool.input =
          payload.type === 'tool.input'
            ? payload.input
            : (tool.input === '{}' ? '' : tool.input) + payload.text;
    }
    if (payload.type === 'approval.resolved') {
      const tool = byApproval.get(payload.approvalId);
      if (tool?.kind === 'tool') {
        tool.resolved = true;
        tool.status = payload.allowed ? '运行中' : '已拒绝';
        tool.state = payload.allowed ? 'running' : 'denied';
      }
    }
    if (payload.type === 'tool.result') {
      const tool = byId.get(payload.toolId);
      if (tool?.kind === 'tool') {
        tool.resolved = true;
        tool.status = {
          completed: '已完成',
          cancelled: '已取消',
          denied: '已拒绝',
          failed: '失败',
          unknown: '结果未知',
        }[payload.status];
        tool.state = payload.status;
        tool.endedAt = at;
        tool.output = payload.output;
        tool.exitCode = payload.exitCode;
      }
    }
    if (payload.type === 'tool.output') {
      const tool = byId.get(payload.toolId);
      if (tool?.kind === 'tool') {
        tool.liveOutput = (tool.liveOutput ?? '') + payload.text;
        tool.status = '运行中';
        tool.state = 'running';
      }
    }
    if (payload.type === 'tool.task') {
      const tool = byId.get(payload.toolId);
      if (tool?.kind === 'tool') tool.taskId = payload.taskId;
    }
    if (payload.type === 'tool.progress') {
      const tool = byId.get(payload.toolId);
      if (tool?.kind === 'tool') {
        tool.elapsedSeconds = payload.elapsedSeconds;
        tool.status = '运行中';
        tool.state = 'running';
      }
    }
    // The CLI tells of a compaction with a status, often several times over, and of its end with a boundary: one
    // mark from the first to the boundary. A status that is no longer compacting says nothing; sessions recorded
    // earlier hold it as the word "status".
    if (payload.type === 'native.notice') {
      if (payload.text === 'compacting') {
        if (compacting?.runId !== runId) {
          compacting = { kind: 'compact', id: `compact-${sequence}`, runId, at };
          add(compacting);
        }
      } else if (!['null', 'status', 'requesting', 'idle'].includes(payload.text))
        add({ kind: 'note', id: `native-${sequence}`, runId, text: payload.text, at });
    }
    if (payload.type === 'native.compact') {
      let mark = compacting?.runId === runId ? compacting : undefined;
      if (!mark) {
        mark = { kind: 'compact', id: `compact-${sequence}`, runId, at };
        add(mark);
      }
      mark.trigger = payload.trigger;
      mark.previousTokens = payload.previousTokens;
      mark.endedAt = at;
      compacting = undefined;
    }
    if (payload.type === 'run.error')
      items.push({
        kind: 'notice',
        id: `error-${sequence}`,
        runId,
        text: payload.message,
        error: true,
        at,
      });
    if (payload.type === 'run.status' && payload.status === 'cancelled')
      items.push({
        kind: 'notice',
        id: `status-${sequence}`,
        runId,
        text: payload.reason ?? '已停止',
        error: false,
        at,
      });
  }
  return items;
}

type Tool = Extract<TranscriptItem, { kind: 'tool' }>;
type Text = Extract<TranscriptItem, { kind: 'user' | 'assistant' | 'thinking' }>;
export type Compact = Extract<TranscriptItem, { kind: 'compact' }>;
export type Notice = Extract<TranscriptItem, { kind: 'notice' | 'note' }>;
// What happened between two pieces of text the reader was shown: tools and thinking, folded into one line.
export type Work = { kind: 'work'; id: string; items: (Tool | Text)[] };
// A compaction is part of the work on a question, between the steps before and after it.
export type Step = Text | Work | Compact | Notice;
// One question and everything up to the next one. Once finished, only the question, the time taken and the
// answer stay in view; `steps` holds the rest.
export type Turn = {
  id: string;
  question?: Text;
  // The question was added while the previous one was still being worked on, inside the same run.
  joined?: boolean;
  steps: Step[];
  answer?: Text;
  // Said after the answer: how the run ended, and what was done after it before the next question.
  notices: Notice[];
  startedAt: string;
  endedAt?: string;
  // The "continue" button takes a stopped turn up again: the messages it sent, and how long the turn stood stopped.
  continuations: string[];
  pausedMs: number;
  tools: number;
  // What the turn used, reported by the service a moment after it ended.
  stats?: TurnStats;
  // How the run that ended the turn ended, when it did not finish: stopped by the user, or failed.
  outcome?: 'cancelled' | 'failed';
};

export function conversation(events: SessionEvent[]): Turn[] {
  // A run that goes on only for its background tasks has finished its turn; the turn a task starts reopens it.
  const ended = new Map<string, string>();
  const endedHow = new Map<string, string>();
  // Each time a run stopped working, finished or not: a question put in later ends the turn at the last of them.
  // A terminal that continues the session stops each time its CLI waits for the next prompt.
  const stops = new Map<string, string[]>();
  const stop = (runId: string, at: string) => stops.set(runId, [...(stops.get(runId) ?? []), at]);
  for (const { runId, createdAt, payload } of events)
    if (payload.type !== 'run.status') continue;
    else if (payload.surface === 'terminal' && payload.activity === 'idle') stop(runId, createdAt);
    else if (
      ['completed', 'cancelled', 'failed'].includes(payload.status) ||
      payload.waiting === 'background'
    ) {
      ended.set(runId, createdAt);
      endedHow.set(runId, payload.status);
      stop(runId, createdAt);
    } else if (payload.status === 'running') {
      ended.delete(runId);
      endedHow.delete(runId);
    }
  // How the run ended, when it did not finish.
  const outcome = (runId: string) => {
    const how = endedHow.get(runId);
    return how === 'cancelled' || how === 'failed' ? how : undefined;
  };
  const turns: Turn[] = [];
  // A terminal's turns are all of one run, which goes on while the terminal stays open, long after the last of them
  // perhaps: each ends with the last thing recorded of it.
  const seen = new Map<Turn, string>();
  const close = (turn: Turn, at: string | undefined) => {
    turn.endedAt = turn.question?.terminal ? (seen.get(turn) ?? at) : at;
  };
  let runId = '';
  for (const item of transcript(events)) {
    let turn = turns.at(-1);
    // What the turn was told on stopping stays where it was said, and the work goes on under it.
    if (turn && item.kind === 'user' && item.continued) {
      turn.steps.push(...turn.notices);
      turn.notices = [];
      turn.continuations.push(item.id);
      const stopped = ended.get(runId);
      if (stopped) turn.pausedMs += Math.max(0, Date.parse(item.at) - Date.parse(stopped));
      runId = item.runId;
      continue;
    }
    if (!turn || item.kind === 'user') {
      // A terminal's turns are all of one run, each asked once the one before was over.
      const joined = !!turn && item.runId === runId && !(item.kind === 'user' && item.terminal);
      // The next question closes the turn before it. One put in while the same run goes on closes it where the run
      // last stopped working, or else at the question; how the run ends later belongs to the turn it ends in.
      if (turn && !turn.endedAt && joined) {
        const from = turn.startedAt;
        close(turn, stops.get(runId)?.findLast((at) => at >= from && at <= item.at) ?? item.at);
      } else if (turn && !turn.endedAt) {
        close(turn, ended.get(runId) ?? item.at);
        turn.outcome = outcome(runId);
      }
      turn = {
        id: item.id,
        joined,
        steps: [],
        notices: [],
        startedAt: item.at,
        continuations: [],
        pausedMs: 0,
        tools: 0,
      };
      turns.push(turn);
    }
    runId = item.runId;
    const at = [
      item.at,
      'doneAt' in item ? item.doneAt : undefined,
      'endedAt' in item ? item.endedAt : undefined,
    ]
      .filter((value): value is string => !!value)
      .reduce((a, b) => (a > b ? a : b));
    // What the CLI said after the answer, such as a command done in the terminal, is no part of the turn's time.
    if (item.kind !== 'note' && (!seen.has(turn) || seen.get(turn)! < at)) seen.set(turn, at);
    if (item.kind === 'user') turn.question = item;
    else if (item.kind === 'notice') turn.notices.push(item);
    else if (item.kind === 'assistant' || item.kind === 'note' || item.kind === 'compact')
      turn.steps.push(item);
    else {
      const last = turn.steps.at(-1);
      if (last?.kind === 'work') last.items.push(item);
      else turn.steps.push({ kind: 'work', id: item.id, items: [item] });
      if (item.kind === 'tool') turn.tools++;
    }
  }
  const last = turns.at(-1);
  if (last && !last.endedAt && ended.has(runId)) {
    close(last, ended.get(runId));
    last.outcome = outcome(runId);
  } else if (last && !last.endedAt && last.question?.terminal) {
    const idle = stops.get(runId)?.findLast((at) => at >= last.startedAt);
    if (idle) close(last, idle);
  }
  // A page of history may start after the question a report belongs to. A turn taken up again is reported once
  // for each of its messages, and each report may come several times: the last one counts.
  const reports = new Map<string, TurnStats>();
  for (const { payload } of events)
    if (payload.type === 'turn.stats' && payload.messageId) reports.set(payload.messageId, payload);
  for (const turn of turns) {
    const parts = [turn.question?.id ?? '', ...turn.continuations].flatMap((id) => {
      const report = reports.get(id);
      return report ? [report] : [];
    });
    if (parts.length) turn.stats = parts.length === 1 ? parts[0] : combined(parts);
  }
  // What the CLI said once the answer was given stays in view under it.
  for (const turn of turns) {
    if (!turn.endedAt) continue;
    let end = turn.steps.length;
    while (turn.steps[end - 1]?.kind === 'note') end--;
    if (turn.steps[end - 1]?.kind !== 'assistant') continue;
    turn.notices.unshift(...(turn.steps.splice(end) as Notice[]));
    turn.answer = turn.steps.pop() as Text;
  }
  return turns;
}

// The figures of the runs of one turn, as one. The averages are weighed by what they average over.
function combined(parts: TurnStats[]): TurnStats {
  const sum = (value: (part: TurnStats) => number) =>
    parts.reduce((total, part) => total + value(part), 0);
  const timed = parts.filter((part) => part.ttftMs != null);
  const weight = (part: TurnStats) => Math.max(1, part.requests);
  const fast = parts.filter((part) => part.outputPerSecond);
  const seconds = fast.reduce(
    (total, part) => total + part.outputTokens / part.outputPerSecond!,
    0,
  );
  return {
    type: 'turn.stats',
    messageId: parts[0].messageId,
    requests: sum((part) => part.requests),
    inputTokens: sum((part) => part.inputTokens),
    outputTokens: sum((part) => part.outputTokens),
    cacheReadTokens: sum((part) => part.cacheReadTokens),
    cacheCreationTokens: sum((part) => part.cacheCreationTokens),
    modelMs: sum((part) => part.modelMs),
    ttftMs: timed.length
      ? timed.reduce((total, part) => total + part.ttftMs! * weight(part), 0) /
        timed.reduce((total, part) => total + weight(part), 0)
      : null,
    outputPerSecond: seconds
      ? fast.reduce((total, part) => total + part.outputTokens, 0) / seconds
      : null,
    partial: parts.some((part) => part.partial),
  };
}
