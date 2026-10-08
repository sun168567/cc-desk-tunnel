import type { Session, SessionEvent } from '@cc-desk-tunnel/protocol';
import type { ProxyClient } from './client.ts';
import { conversation } from './transcript.ts';
import type { Step } from './transcript.ts';

// A fence longer than any run of backticks inside, so the content cannot close it early.
function fenced(text: string) {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}\n${text}\n${fence}`;
}

// The whole session as one Markdown document: questions, answers, and under each answer what was done to
// reach it — thinking, tool calls with their input and output — folded into <details>.
export function markdown(session: Session, events: SessionEvent[]) {
  const parts = [
    `# ${session.title}`,
    `- 项目：\`${session.projectPath}\`\n- 导出时间：${new Date().toLocaleString('zh-CN')}`,
  ];
  const step = (item: Step): string[] => {
    if (item.kind === 'assistant') return [item.text];
    if (item.kind !== 'work') return [];
    return item.items.map((work) =>
      work.kind === 'tool'
        ? `<details>\n<summary>工具 ${work.name} · ${work.status}</summary>\n\n${fenced(work.input)}\n\n${work.output ? fenced(work.output) : ''}\n</details>`
        : `<details>\n<summary>思考</summary>\n\n${work.text}\n</details>`,
    );
  };
  for (const turn of conversation(events)) {
    if (turn.question)
      parts.push(
        `## 你 · ${new Date(turn.question.at).toLocaleString('zh-CN')}`,
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
  const settled = () =>
    new Promise<void>((resolve, reject) => {
      const started = Date.now();
      const check = () => {
        const history = client.state.history[session.id];
        if (history && !history.loading && !history.loadingEarlier) resolve();
        else if (Date.now() - started > 30000) reject(new Error('读取会话历史超时。'));
        else setTimeout(check, 50);
      };
      check();
    });
  await settled();
  while (client.state.history[session.id]?.hasEarlier) {
    await client.loadEarlier(session.id);
    await settled();
  }
  const text = markdown(session, client.state.events[session.id] ?? []);
  const name = `${session.title.replace(/[\\/:*?"<>|\r\n]+/g, ' ').trim() || '会话'}.md`;
  if (window.desktop) return window.desktop.saveFile(name, text);
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }));
  link.download = name;
  link.click();
  URL.revokeObjectURL(link.href);
  return true;
}
