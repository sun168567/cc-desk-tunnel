import type { Session, SessionEvent } from '@cc-desk-tunnel/protocol';
import type { ProxyClient } from './client.ts';
import { localeOf, t } from './i18n.ts';
import { conversation, planOf } from './transcript.ts';
import type { Step, Turn } from './transcript.ts';
import { pictureNote, toolPictures } from './pictures.ts';

// A fence longer than any run of backticks inside, so the content cannot close it early.
function fenced(text: string) {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}\n${text}\n${fence}`;
}

// A picture a tool looked at is named by its type and size, not written out as its data.
function toolOutput(output: string) {
  const pictures = toolPictures(output);
  return pictures
    ? [pictures.text, ...pictures.pictures.map((picture) => pictureNote(t, picture))]
        .filter(Boolean)
        .join('\n')
    : output;
}

// What an export holds: every step (`all`), or only the questions and the answers, with what the user said while a
// turn went on (`said`) or without it (`answers`); of every turn, or of the last `turns`.
export type ExportOptions = { content: 'all' | 'said' | 'answers'; turns?: number };

// The turns an export covers. A turn of something said while the one before still went on is a question of its own;
// a count of turns counts the others.
function covered(turns: Turn[], options: ExportOptions) {
  if (!options.turns) return turns;
  const asked = turns.flatMap((turn, index) => (turn.joined ? [] : [index]));
  return asked.length > options.turns ? turns.slice(asked.at(-options.turns)) : turns;
}

// The session as one Markdown document: questions, answers, and, for `all`, under each answer what was done to reach
// it — thinking, tool calls with their input and output — folded into <details>.
export function markdown(
  session: Session,
  events: SessionEvent[],
  options: ExportOptions = { content: 'all' },
) {
  const parts = [
    `# ${session.title}`,
    t('session:export.header', {
      path: session.projectPath,
      time: new Date().toLocaleString(localeOf(t)),
    }),
  ];
  const toolSummary = (name: string, status: string) =>
    `<summary>${t('session:export.tool', { name })} · ${status}</summary>`;
  const step = (item: Step): string[] => {
    if (item.kind === 'assistant') return [item.text];
    if (item.kind === 'notice' || item.kind === 'note') return [`> ${item.text}`];
    if (item.kind === 'compact')
      return [
        `> ${t(item.endedAt ? 'session:compact.done' : 'session:compact.unfinished')}${item.previousTokens == null ? '' : ` · ${t('session:compact.before', { tokens: item.previousTokens.toLocaleString(localeOf(t)) })}`}`,
      ];
    if (item.kind === 'tool') {
      const found = planOf(item.input);
      return found
        ? [`### ${t('session:plan.title')} · ${item.status}\n\n${found.plan}`]
        : [
            `<details>\n${toolSummary(item.name, item.status)}\n\n${fenced(item.input)}\n</details>`,
          ];
    }
    if (item.kind !== 'work') return [];
    return item.items.map((work) =>
      work.kind === 'tool'
        ? `<details>\n${toolSummary(work.name, work.status)}\n\n${fenced(work.input)}\n\n${work.output ? fenced(toolOutput(work.output)) : ''}\n</details>`
        : `<details>\n<summary>${t('session:tool.thinking')}</summary>\n\n${work.text}\n</details>`,
    );
  };
  for (const turn of covered(conversation(events, t), options)) {
    const question = turn.question?.continued ? undefined : turn.question;
    if (question && (options.content !== 'answers' || !turn.joined))
      parts.push(
        `## ${t('session:export.you')} · ${new Date(question.at).toLocaleString(localeOf(t))}`,
        question.text,
      );
    const body = [
      ...(options.content === 'all' ? turn.steps.flatMap(step) : []),
      ...(turn.answer ? [turn.answer.text] : []),
    ];
    if (body.length) parts.push('## Claude Code', ...body);
    if (options.content === 'all')
      for (const notice of turn.notices) parts.push(`> ${notice.text}`);
  }
  return `${parts.join('\n\n')}\n`;
}

// Only part of a long session is in memory. The rest is read page by page, from the disk where it is kept and from
// the service otherwise, without being shown; for the last turns, only as far back as they go.
export async function exportSession(client: ProxyClient, session: Session, options: ExportOptions) {
  if (client.state.selectedId !== session.id) client.select(session.id);
  await client.waitForHistory(session.id);
  let events = client.shown(session.id);
  const history = client.state.history[session.id];
  // One turn more than asked for: the oldest of what is read may have begun on a page before.
  const enough = () =>
    !!options.turns &&
    conversation(events, t).filter((turn) => !turn.joined).length > options.turns;
  if (history?.hasEarlier && !enough())
    for await (const page of client.earlierPages(session.id, history.firstSequence)) {
      events = [...page, ...events];
      if (enough()) break;
    }
  const text = markdown(session, events, options);
  const name = `${session.title.replace(/[\\/:*?"<>|\r\n]+/g, ' ').trim() || t('session:export.untitled')}.md`;
  if (window.desktop) return window.desktop.saveFile(name, text);
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }));
  link.download = name;
  link.click();
  URL.revokeObjectURL(link.href);
  return true;
}
