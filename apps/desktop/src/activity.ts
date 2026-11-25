import type { T } from './i18n.ts';
import type { TranscriptItem, Work } from './transcript.ts';

type Tool = Extract<TranscriptItem, { kind: 'tool' }>;
export type Category = 'command' | 'edit' | 'read' | 'search' | 'web' | 'agent' | 'other';

const categories: Record<string, Category> = {
  Bash: 'command',
  PowerShell: 'command',
  Edit: 'edit',
  MultiEdit: 'edit',
  Write: 'edit',
  NotebookEdit: 'edit',
  Read: 'read',
  Grep: 'search',
  Glob: 'search',
  WebFetch: 'web',
  WebSearch: 'web',
  Agent: 'agent',
  Task: 'agent',
};
// The words for a category's calls: one while it runs, one once done, and for a run of them, what is being done
// and what was (session:tool.<category>).
const verbs = (t: T, category: Category) => ({
  running: t(`session:tool.${category}.running`),
  done: t(`session:tool.${category}.done`),
  doing: t(`session:tool.${category}.doing`),
  did: (count: number) => t(`session:tool.${category}.did`, { count }),
});
// The states a call's line names instead of its verb.
const outcomes: Tool['state'][] = ['approval', 'denied', 'cancelled', 'failed', 'unknown'];
// A line that begins with words of a list starts with a capital where the language has them.
const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

function fields(input: string): Record<string, unknown> {
  try {
    const value = JSON.parse(input);
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}
const text = (value: unknown) => (typeof value === 'string' ? value : '');
const lineCount = (value: unknown) => (text(value) ? text(value).split('\n').length : 0);
const fileName = (value: unknown) => text(value).split(/[\\/]/).at(-1) ?? '';

export const categoryOf = (tool: Tool): Category => categories[tool.name] ?? 'other';
export const isRunning = (tool: Tool) =>
  !tool.endedAt && tool.state !== 'denied' && tool.state !== 'approval';

// One line for a tool call: what it did, to what, and for edits how many lines went in and out.
export function describe(t: T, tool: Tool, active: boolean) {
  const category = categoryOf(tool);
  const input = fields(tool.input);
  let subject = '';
  let added = 0;
  let removed = 0;
  if (category === 'command')
    subject = text(input.description) || (text(input.command) || tool.input).trim().split('\n')[0];
  else if (category === 'edit') {
    subject = fileName(input.file_path ?? input.notebook_path);
    const edits = Array.isArray(input.edits) ? (input.edits as Record<string, unknown>[]) : [input];
    for (const edit of edits) {
      added += lineCount(edit.new_string ?? edit.content ?? edit.new_source);
      removed += lineCount(edit.old_string);
    }
  } else if (category === 'read') subject = fileName(input.file_path);
  else if (category === 'search') subject = text(input.pattern) || text(input.query);
  else if (category === 'web') subject = text(input.url) || text(input.query);
  else if (category === 'agent') subject = text(input.description);
  else subject = tool.name;
  const running = active && isRunning(tool);
  return {
    category,
    verb: outcomes.includes(tool.state)
      ? t(`session:toolState.${tool.state}`)
      : verbs(t, category)[running ? 'running' : 'done'],
    subject,
    added,
    removed,
    running,
    failed: ['failed', 'denied', 'cancelled', 'unknown'].includes(tool.state),
  };
}

// The folded line for a run of tool calls: what is happening now, or what was done.
export function summarize(t: T, work: Work, active: boolean, latest: boolean) {
  const tools = work.items.filter((item): item is Tool => item.kind === 'tool');
  const waiting = tools.find((tool) => tool.state === 'approval');
  const running = active ? tools.filter(isRunning) : [];
  const started = work.items[0].at;
  const last = work.items.at(-1)!;
  const ended = running.length
    ? undefined
    : tools.reduce(
        (latest, tool) => (tool.endedAt && tool.endedAt > latest ? tool.endedAt : latest),
        last.at,
      );
  let label: string;
  if (waiting)
    label = t(
      waiting.name === 'AskUserQuestion'
        ? 'session:work.waitingAnswer'
        : 'session:work.waitingApproval',
    );
  else if (running.length) {
    const what = [...new Set(running.map((tool) => verbs(t, categoryOf(tool)).doing))].slice(0, 2);
    label = sentence(t('session:work.doing', { what }));
  } else if (!tools.length)
    label = t(active && latest ? 'session:work.thinking' : 'session:work.thought');
  else {
    const counts = new Map<Category, number>();
    for (const tool of tools) counts.set(categoryOf(tool), (counts.get(categoryOf(tool)) ?? 0) + 1);
    const what = [...counts].map(([category, count]) => verbs(t, category).did(count));
    const failed = tools.filter((tool) => ['failed', 'unknown'].includes(tool.state)).length;
    label = sentence(
      failed
        ? t('session:work.didFailed', { what, count: failed })
        : t('session:work.did', { what }),
    );
  }
  return {
    label,
    waiting: !!waiting,
    running: running.length > 0 || (!tools.length && active && latest),
    started,
    ended,
  };
}

export function duration(t: T, from: string, to: string | number) {
  const ms = Math.max(0, (typeof to === 'number' ? to : Date.parse(to)) - Date.parse(from));
  const seconds = Math.floor(ms / 1000);
  if (seconds < 10) return t('common:span.seconds', { s: (ms / 1000).toFixed(1) });
  if (seconds < 60) return t('common:span.seconds', { s: seconds });
  if (seconds < 3600)
    return t('common:span.minutes', { m: Math.floor(seconds / 60), s: seconds % 60 });
  return t('common:span.hours', {
    h: Math.floor(seconds / 3600),
    m: Math.floor((seconds % 3600) / 60),
  });
}
