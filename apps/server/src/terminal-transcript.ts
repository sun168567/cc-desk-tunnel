import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import type { EventPayload, TerminalActivity } from '@cc-desk-tunnel/protocol';
import { ClaudeStream, printed } from './claude-stream.ts';
import { settingsPath as userSettingsPath } from './native-settings.ts';

// Fields the CLI's record keeps beside the message, which `getSessionMessages` passes through.
type Entry = SessionMessage & {
  isCompactSummary?: boolean;
  is_meta?: boolean;
  timestamp?: string;
  origin?: { kind?: string };
};
type Block = { type?: unknown; text?: unknown };

const tag = (text: string, name: string) =>
  text.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1];

// What a terminal that continues a session added to the CLI's record of it, as the events a chat run would have
// recorded: prompts, answers, tool calls and their results, compactions and what local commands printed. The record
// keeps no streaming, approvals or thinking left unwritten, so those do not come back. `known` is what the record
// held when the terminal opened; a compaction keeps some of it after the summary, and that is not shown twice.
export function terminalEvents(
  messages: SessionMessage[],
  known: ReadonlySet<string>,
  record: (event: EventPayload, at?: string) => void,
) {
  let at: string | undefined;
  const emit = (event: EventPayload) => record(event, at);
  const stream = new ClaudeStream(emit);
  let answer: unknown;
  for (const entry of messages as Entry[]) {
    if (known.has(entry.uuid) || entry.parent_tool_use_id) continue;
    at = entry.timestamp;
    if (entry.isCompactSummary) {
      emit({ type: 'native.compact', trigger: 'unknown', previousTokens: null });
      continue;
    }
    // The CLI's own notes to the model, and messages it wrote on the user's behalf, such as a task's report.
    if (entry.type === 'system' || entry.is_meta) continue;
    if (entry.origin?.kind && entry.origin.kind !== 'human') continue;
    const message = entry.message as { id?: unknown; content?: unknown };
    if (entry.type === 'assistant') {
      // What the CLI writes in place of an answer to a turn the user interrupted.
      const blocks = message.content as Block[] | undefined;
      if (
        (message as { model?: unknown }).model === '<synthetic>' &&
        blocks?.length === 1 &&
        blocks[0]?.text === 'No response requested.'
      )
        continue;
      // One answer is recorded as a message per content block, all with the answer's ID.
      if (message.id !== answer) {
        answer = message.id;
        stream.messageId = randomUUID();
      }
      stream.requested = true;
      stream.accept({ type: 'assistant', message });
      continue;
    }
    const content = message.content;
    if (typeof content === 'string') {
      const output = tag(content, 'local-command-stdout');
      if (output !== undefined) {
        if (output.trim())
          emit({ type: 'text.delta', messageId: randomUUID(), text: printed(output) });
        continue;
      }
      const command = tag(content, 'command-name');
      const text = command
        ? [command, tag(content, 'command-args')?.trim()].filter(Boolean).join(' ')
        : content;
      emit({ type: 'message.user', messageId: randomUUID(), text, scenario: 'chat' });
      continue;
    }
    if (!Array.isArray(content)) continue;
    const text = (content as Block[])
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text as string)
      .filter((part) => !part.startsWith('<system-reminder>'))
      .join('\n');
    if (text) emit({ type: 'message.user', messageId: randomUUID(), text, scenario: 'chat' });
    if ((content as Block[]).some((block) => block?.type === 'tool_result'))
      stream.accept({ type: 'user', message });
  }
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
