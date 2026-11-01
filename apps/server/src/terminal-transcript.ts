import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import type { EventPayload } from '@cc-desk-tunnel/protocol';
import { ClaudeStream, printed } from './claude-stream.ts';

// Fields the CLI's record keeps beside the message, which `getSessionMessages` passes through.
type Entry = SessionMessage & {
  isCompactSummary?: boolean;
  is_meta?: boolean;
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
  emit: (event: EventPayload) => void,
) {
  const stream = new ClaudeStream(emit);
  let answer: unknown;
  for (const entry of messages as Entry[]) {
    if (known.has(entry.uuid) || entry.parent_tool_use_id) continue;
    if (entry.isCompactSummary) {
      emit({ type: 'native.compact', trigger: 'unknown', previousTokens: null });
      continue;
    }
    // The CLI's own notes to the model, and messages it wrote on the user's behalf, such as a task's report.
    if (entry.type === 'system' || entry.is_meta) continue;
    if (entry.origin?.kind && entry.origin.kind !== 'human') continue;
    const message = entry.message as { id?: unknown; content?: unknown };
    if (entry.type === 'assistant') {
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

// A terminal that continues a session learns from the CLI's SessionStart hook which native session it is in:
// `/clear` and `/resume` move it to another. The hook appends what it was given to a file of the terminal's own.
export function terminalSettings(path: string, hooksPath: string, settingsPath?: string) {
  const settings = settingsPath ? JSON.parse(readFileSync(settingsPath, 'utf8')) : {};
  const hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
  const quoted = `'${hooksPath.replaceAll("'", "'\\''")}'`;
  hooks.SessionStart = [
    ...(Array.isArray(hooks.SessionStart) ? hooks.SessionStart : []),
    { hooks: [{ type: 'command', command: `{ cat; echo; } >> ${quoted}` }] },
  ];
  writeFileSync(path, JSON.stringify({ ...settings, hooks }), { mode: 0o600 });
}

// The native sessions the terminal's CLI started or resumed, in order.
export function terminalSessions(hooksPath: string) {
  let text = '';
  try {
    text = readFileSync(hooksPath, 'utf8');
  } catch {
    return [];
  }
  return text.split('\n').flatMap((line) => {
    try {
      const id: unknown = JSON.parse(line).session_id;
      return typeof id === 'string' ? [id] : [];
    } catch {
      return [];
    }
  });
}
