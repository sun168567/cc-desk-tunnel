import { randomUUID } from 'node:crypto';
import { closeSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import type { EventPayload, NativeMetrics, TerminalActivity } from '@cc-desk-tunnel/protocol';
import { ClaudeStream, printed } from './claude-stream.ts';
import { cacheTtl } from './idle-compaction.ts';
import { settingsPath as userSettingsPath } from './native-settings.ts';

// Fields the CLI's record keeps beside the message, which `getSessionMessages` passes through. `compact` is what the
// boundary before a compaction's summary says of it, which only the record itself has (see `terminalRecord`).
type Entry = SessionMessage & {
  isCompactSummary?: boolean;
  is_meta?: boolean;
  timestamp?: string;
  origin?: { kind?: string };
  compact?: { trigger?: unknown; preTokens?: unknown };
};
type Block = { type?: unknown; text?: unknown };

const tag = (text: string, name: string) =>
  text.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1];
// What a command printed, as one line of plain text: without colours and Markdown's code marks.
const plain = (text: string) =>
  text
    .replace(/\u001b\[[\d;]*m/g, '')
    .replaceAll('`', '')
    .trim();
// Commands that end the terminal, which says so itself.
const LEAVING = new Set(['/exit', '/quit']);

// What a terminal that continues a session added to the CLI's record of it, as the events a chat run would have
// recorded: prompts, answers, tool calls and their results, compactions. The record keeps no streaming, approvals or
// thinking left unwritten, so those do not come back. What is read of it comes in parts, as the CLI writes it and once
// more whole as a turn ends (see `terminalRecord`); `known` is what was read before, which a compaction keeps some of
// after the summary, and that is not shown twice. An answer the record holds as several parts stays one message.
export class TerminalTranscript {
  private stream: ClaudeStream;
  private answer: unknown;
  private at: string | undefined;
  private emit: (event: EventPayload) => void;
  // A command of the CLI's own, until what comes next says whether it printed something (a local command) or asked
  // the model (a prompt of its own, a question as any other).
  private command: string | undefined;
  // A compaction's summary was just read: the /compact the CLI records again after it, and what it printed, are left
  // out, the question and the mark already said so.
  private compacted = false;
  private skipPrinted = false;
  // How long the prompt cache the turn's requests wrote lasts (see `cacheTtl`), until it is taken as the turn ends.
  private written: '5m' | '1h' | undefined;
  // Compactions read, and how many of them were asked about (see `compactedSince`).
  private compactions = 0;
  private told = 0;
  constructor(record: (event: EventPayload, at?: string) => void) {
    this.emit = (event) => record(event, this.at);
    this.stream = new ClaudeStream(this.emit);
  }
  accept(messages: SessionMessage[], known: ReadonlySet<string>) {
    for (const entry of messages as Entry[]) {
      if (known.has(entry.uuid) || entry.parent_tool_use_id) continue;
      this.at = entry.timestamp;
      const message = entry.message as { id?: unknown; content?: unknown; usage?: unknown };
      const content = entry.type === 'user' ? message.content : undefined;
      const output = typeof content === 'string' ? tag(content, 'local-command-stdout') : undefined;
      if (this.command !== undefined && output === undefined) this.question(this.command);
      if (entry.isCompactSummary) {
        this.compacted = true;
        this.compactions++;
        this.emit({
          type: 'native.compact',
          trigger: typeof entry.compact?.trigger === 'string' ? entry.compact.trigger : 'unknown',
          previousTokens:
            typeof entry.compact?.preTokens === 'number' ? entry.compact.preTokens : null,
        });
        continue;
      }
      // The CLI's own notes to the model, and messages it wrote on the user's behalf, such as a task's report.
      if (entry.type === 'system' || entry.is_meta) continue;
      if (entry.origin?.kind && entry.origin.kind !== 'human') continue;
      if (output !== undefined) {
        // What a local command printed. The window has its own controls for what these do, and some are of the
        // terminal alone: one line says what was done.
        const command = this.command;
        this.command = undefined;
        if (this.skipPrinted) this.skipPrinted = false;
        else if (command && !LEAVING.has(command.split(' ')[0]))
          this.emit({
            type: 'native.notice',
            text: `在终端里执行了 ${command}${plain(output) ? `：${plain(output)}` : ''}`,
          });
        continue;
      }
      const wasCompacted = this.compacted;
      this.compacted = false;
      if (entry.type === 'assistant') {
        // What the CLI writes in place of an answer to a turn the user interrupted.
        const blocks = message.content as Block[] | undefined;
        if (
          (message as { model?: unknown }).model === '<synthetic>' &&
          blocks?.length === 1 &&
          blocks[0]?.text === 'No response requested.'
        )
          continue;
        const ttl = cacheTtl(message.usage);
        if (ttl && this.written !== '1h') this.written = ttl;
        // One answer is recorded as a message per content block, all with the answer's ID.
        if (message.id !== this.answer) {
          this.answer = message.id;
          this.stream.messageId = randomUUID();
        }
        this.stream.requested = true;
        this.stream.accept({ type: 'assistant', message });
        continue;
      }
      if (typeof content === 'string') {
        const command = tag(content, 'command-name');
        if (!command) {
          this.question(content);
          continue;
        }
        const text = [command, tag(content, 'command-args')?.trim()].filter(Boolean).join(' ');
        if (wasCompacted && command === '/compact') this.skipPrinted = true;
        else this.command = text;
        continue;
      }
      if (!Array.isArray(content)) continue;
      const text = (content as Block[])
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text as string)
        .filter((part) => !part.startsWith('<system-reminder>'))
        .join('\n');
      if (text) this.question(text);
      if ((content as Block[]).some((block) => block?.type === 'tool_result'))
        this.stream.accept({ type: 'user', message });
    }
  }
  // A command that printed nothing was a question to the model after all; so is one the record holds nothing after.
  settle() {
    if (this.command !== undefined) this.question(this.command);
  }
  // Whether a compaction was read since this was last asked.
  compactedSince() {
    const since = this.compactions > this.told;
    this.told = this.compactions;
    return since;
  }
  // How long the cache the turn wrote lasts; the next turn starts counting anew.
  cacheTtl() {
    const written = this.written;
    this.written = undefined;
    return written;
  }
  private question(text: string) {
    this.command = undefined;
    this.emit({ type: 'message.user', messageId: randomUUID(), text, scenario: 'chat' });
  }
}

// The messages read in one go, as a chat run's events (see `TerminalTranscript`).
export function terminalEvents(
  messages: SessionMessage[],
  known: ReadonlySet<string>,
  record: (event: EventPayload, at?: string) => void,
) {
  const transcript = new TerminalTranscript(record);
  transcript.accept(messages, known);
  transcript.settle();
}

// What the CLI appended to its record of the session since `offset`, up to the last whole line, and where the next
// read starts: the prompts and answers of the main conversation, as `getSessionMessages` gives them. A turn shows as
// it goes, part by part, without reading the whole record anew each time; what the record holds is read whole again
// as the turn ends, which also tells a rewind (see `importTerminal`).
export function terminalRecord(path: string, offset: number) {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return { messages: [], offset };
  }
  // The record was written anew, as by a rewind: what it holds now is read as the turn ends.
  if (size < offset) return { messages: [], offset: size };
  if (size === offset) return { messages: [], offset };
  const buffer = Buffer.alloc(size - offset);
  const file = openSync(path, 'r');
  try {
    readSync(file, buffer, 0, buffer.length, offset);
  } finally {
    closeSync(file);
  }
  const end = buffer.lastIndexOf(10) + 1;
  const boundaries = new Map<string, Entry['compact']>();
  const messages: SessionMessage[] = [];
  for (const line of buffer.subarray(0, end).toString('utf8').split('\n')) {
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    if (raw?.type === 'system' && raw.subtype === 'compact_boundary')
      boundaries.set(String(raw.uuid), raw.compactMetadata as Entry['compact']);
    if ((raw?.type !== 'user' && raw?.type !== 'assistant') || raw.isSidechain) continue;
    if (typeof raw.uuid !== 'string') continue;
    messages.push({
      type: raw.type,
      uuid: raw.uuid,
      session_id: String(raw.sessionId ?? ''),
      message: raw.message,
      parent_tool_use_id: null,
      timestamp: raw.timestamp,
      ...(raw.isMeta ? { is_meta: true } : {}),
      ...(raw.isCompactSummary
        ? { isCompactSummary: true, compact: boundaries.get(String(raw.parentUuid)) }
        : {}),
      ...(raw.origin ? { origin: raw.origin } : {}),
    } as unknown as SessionMessage);
  }
  return { messages, offset: offset + end };
}

// How full the context window is, as the CLI last showed it in its status line (CLI 2.1.293): the tokens the last
// request read, of the model's window. The status line says nothing of what they are made of. Its window is the
// model's even where the CLI settings set a smaller one to compact by (`autoCompactWindow`), which the CLI's /context
// and the SDK count by instead; so is it counted here, in whole percents as theirs.
export function statusLineContext(
  status: unknown,
  compactWindow?: number | null,
): NativeMetrics['context'] {
  const { model, context_window: window } = (status ?? {}) as {
    model?: { id?: unknown };
    context_window?: {
      context_window_size?: unknown;
      current_usage?: Record<string, unknown> | null;
    };
  };
  const full = window?.context_window_size;
  const usage = window?.current_usage;
  if (typeof full !== 'number' || full <= 0 || !usage) return null;
  const size = compactWindow && compactWindow > 0 ? Math.min(full, compactWindow) : full;
  const used = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']
    .map((name) => usage[name])
    .reduce<number>((sum, value) => sum + (typeof value === 'number' ? value : 0), 0);
  return {
    model: typeof model?.id === 'string' ? model.id : '',
    usedTokens: used,
    windowTokens: size,
    percentage: Math.round((used / size) * 100),
    measuredAt: new Date().toISOString(),
    categories: [],
  };
}

// A terminal that continues a session learns from the CLI's hooks what it is doing and which native session it is
// in: `/clear` and `/resume` move it to another. Each hook appends what it was given, a line of JSON, to a file of the
// terminal's own, which the service reads as it grows.
const HOOKED = [
  'SessionStart',
  'UserPromptSubmit',
  'PermissionRequest',
  'PostToolUse',
  'PostToolUseFailure',
  'Notification',
  'Stop',
];
// Its status line command also keeps the last of what the CLI hands it at `statusPath`, which carries the quota its
// replies were answered with (see `statusLineQuota`). A status line of the user's own, from these settings or the user
// settings these take the place of, is still run on the same input and shows as before.
export function terminalSettings(
  path: string,
  hooksPath: string,
  settingsPath?: string,
  statusPath?: string,
  ownSettingsPath = userSettingsPath(),
) {
  const settings = settingsPath ? JSON.parse(readFileSync(settingsPath, 'utf8')) : {};
  const hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
  const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
  for (const name of HOOKED)
    hooks[name] = [
      ...(Array.isArray(hooks[name]) ? hooks[name] : []),
      { hooks: [{ type: 'command', command: `{ cat; echo; } >> ${quote(hooksPath)}` }] },
    ];
  let statusLine = settings.statusLine;
  if (statusPath) {
    const own = [settings.statusLine, userStatusLine(ownSettingsPath)].find(
      (line) => line?.type === 'command' && typeof line.command === 'string',
    );
    const keep = `s=$(cat); printf '%s\\n' "$s" > ${quote(`${statusPath}.new`)} && mv -f ${quote(`${statusPath}.new`)} ${quote(statusPath)}`;
    statusLine = own
      ? { ...own, command: `${keep}; printf '%s' "$s" | {\n${own.command}\n}` }
      : { type: 'command', command: keep };
  }
  writeFileSync(path, JSON.stringify({ ...settings, hooks, statusLine }), { mode: 0o600 });
}
function userStatusLine(path: string) {
  try {
    return JSON.parse(readFileSync(path, 'utf8')).statusLine;
  } catch {
    return undefined;
  }
}

export type TerminalHook = {
  hook_event_name?: unknown;
  session_id?: unknown;
  transcript_path?: unknown;
  notification_type?: unknown;
};
// The hooks written since `offset`, up to the last whole line, and where the next read starts.
export function terminalHooks(hooksPath: string, offset = 0) {
  let buffer: Buffer;
  try {
    buffer = readFileSync(hooksPath);
  } catch {
    return { hooks: [], offset };
  }
  const end = buffer.lastIndexOf(10) + 1;
  if (end <= offset) return { hooks: [], offset };
  const hooks = buffer
    .subarray(offset, end)
    .toString('utf8')
    .split('\n')
    .flatMap((line): TerminalHook[] => {
      try {
        const hook: unknown = JSON.parse(line);
        return hook && typeof hook === 'object' ? [hook] : [];
      } catch {
        return [];
      }
    });
  return { hooks, offset: end };
}

// What a hook says the CLI is doing: working on a prompt, waiting for the user to allow a tool or answer it, or done
// with the turn and waiting for the next prompt. A tool that ran, or failed, was allowed, so the CLI is working again.
// The CLI 2.1.293 runs PermissionRequest as the dialog opens, and no Notification for it. A turn the user interrupts
// runs no hook and leaves nothing in the CLI's record; the CLI tells it has been waiting for a prompt a while later
// (`idle_prompt`), or the next prompt does.
export function terminalActivity(hook: TerminalHook): TerminalActivity | undefined {
  switch (hook.hook_event_name) {
    case 'UserPromptSubmit':
    case 'PostToolUse':
    case 'PostToolUseFailure':
      return 'working';
    case 'PermissionRequest':
      return 'waiting';
    case 'Notification':
      if (hook.notification_type === 'idle_prompt') return 'idle';
      return hook.notification_type === 'permission_prompt' ||
        hook.notification_type === 'elicitation_dialog'
        ? 'waiting'
        : undefined;
    case 'SessionStart':
    case 'Stop':
      return 'idle';
  }
}
