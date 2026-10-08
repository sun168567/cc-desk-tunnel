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
// [while running, once done, group phrase while running, group phrase once done]
const words: Record<Category, [string, string, string, (count: number) => string]> = {
  command: ['运行', '已运行', '运行命令', (count) => `运行了 ${count} 条命令`],
  edit: ['编辑', '已编辑', '编辑文件', (count) => `编辑了 ${count} 个文件`],
  read: ['读取', '已读取', '读取文件', (count) => `读取了 ${count} 个文件`],
  search: ['搜索', '已搜索', '搜索', (count) => `搜索了 ${count} 次`],
  web: ['检索', '已检索', '检索网页', (count) => `检索了 ${count} 个网页`],
  agent: ['子任务', '子任务完成', '执行子任务', (count) => `执行了 ${count} 个子任务`],
  other: ['调用', '已调用', '调用工具', (count) => `调用了 ${count} 个工具`],
};
const outcomes: Partial<Record<Tool['state'], string>> = {
  approval: '等待审批',
  denied: '已拒绝',
  cancelled: '已取消',
  failed: '失败',
  unknown: '结果未知',
};

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
export function describe(tool: Tool, active: boolean) {
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
    verb: outcomes[tool.state] ?? words[category][running ? 0 : 1],
    subject,
    added,
    removed,
    running,
    failed: ['failed', 'denied', 'cancelled', 'unknown'].includes(tool.state),
  };
}

// The folded line for a run of tool calls: what is happening now, or what was done.
export function summarize(work: Work, active: boolean, latest: boolean) {
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
  if (waiting) label = waiting.name === 'AskUserQuestion' ? '等待回答' : '等待审批';
  else if (running.length)
    label = `正在${[...new Set(running.map((tool) => words[categoryOf(tool)][2]))].slice(0, 2).join('、')}`;
  else if (!tools.length) label = active && latest ? '正在思考' : '思考';
  else {
    const counts = new Map<Category, number>();
    for (const tool of tools) counts.set(categoryOf(tool), (counts.get(categoryOf(tool)) ?? 0) + 1);
    label = [...counts].map(([category, count]) => words[category][3](count)).join('，');
    const failed = tools.filter((tool) => ['failed', 'unknown'].includes(tool.state)).length;
    if (failed) label += `，${failed} 项未成功`;
  }
  return {
    label,
    waiting: !!waiting,
    running: running.length > 0 || (!tools.length && active && latest),
    started,
    ended,
  };
}

export function duration(from: string, to: string | number) {
  const ms = Math.max(0, (typeof to === 'number' ? to : Date.parse(to)) - Date.parse(from));
  const seconds = Math.floor(ms / 1000);
  if (seconds < 10) return `${(ms / 1000).toFixed(1)} 秒`;
  if (seconds < 60) return `${seconds} 秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
  return `${Math.floor(seconds / 3600)} 小时 ${Math.floor((seconds % 3600) / 60)} 分`;
}
