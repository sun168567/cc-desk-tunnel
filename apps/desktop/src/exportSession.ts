import type { Session, SessionEvent } from '@cc-desk-tunnel/protocol';
import type { ProxyClient } from './client.ts';
import { localeOf, t } from './i18n.ts';
import { conversation, planOf } from './transcript.ts';
import type { Step } from './transcript.ts';
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

// The whole session as one Markdown document: questions, answers, and under each answer what was done to
// reach it — thinking, tool calls with their input and output — folded into <details>.
export function markdown(session: Session, events: SessionEvent[]) {
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
  for (const turn of conversation(events, t)) {
    if (turn.question && !turn.question.continued)
      parts.push(
        `## ${t('session:export.you')} · ${new Date(turn.question.at).toLocaleString(localeOf(t))}`,
        turn.question.text,
      );
    const body = [...turn.steps.flatMap(step), ...(turn.answer ? [turn.answer.text] : [])];
    if (body.length) parts.push('## Claude Code', ...body);
    for (const notice of turn.notices) parts.push(`> ${notice.text}`);
  }
  return `${parts.join('\n\n')}\n`;
}

// Only part of a long session is in memory; the rest is fetched page by page before writing.
export async function exportSession(client: ProxyClient, session: Session) {
  if (client.state.selectedId !== session.id) client.select(session.id);
  await client.waitForHistory(session.id);
  while (client.state.history[session.id]?.hasEarlier) {
    await client.loadEarlier(session.id);
    await client.waitForHistory(session.id);
  }
  const text = markdown(session, client.shown(session.id));
  const name = `${session.title.replace(/[\\/:*?"<>|\r\n]+/g, ' ').trim() || t('session:export.untitled')}.md`;
  if (window.desktop) return window.desktop.saveFile(name, text);
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }));
  link.download = name;
  link.click();
  URL.revokeObjectURL(link.href);
  return true;
}
