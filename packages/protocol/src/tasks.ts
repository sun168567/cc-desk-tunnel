import type { EventPayload } from './index.ts';

// Claude Code keeps a list of the steps of a longer piece of work and shows it as a checklist: today with TaskCreate
// and TaskUpdate, before them with TodoWrite, which writes the whole list each time. The service records those calls
// as any other tool's; this follows them to the list as it stands, for a client to show. TaskCreate tells the ID it
// gave in its output ("Task #3 created…"); one that does not is counted in order, as the CLI numbers them.
export type TaskStatus = 'pending' | 'in_progress' | 'completed';
export type Task = { id: string; content: string; activeForm?: string; status: TaskStatus };

const TOOLS = new Set(['TaskCreate', 'TaskUpdate', 'TodoWrite']);
const STATUSES = new Set<string>(['pending', 'in_progress', 'completed']);
const parse = (text: string): Record<string, unknown> | null => {
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};
const words = (value: unknown) => (typeof value === 'string' && value.trim() ? value : undefined);

export class TaskList {
  private calls = new Map<string, { name: string; input: string }>();
  private tasks = new Map<string, Task>();
  private counted = 0;

  // Takes one event of the session, in order; true when the list changed.
  apply(payload: EventPayload): boolean {
    if (payload.type === 'tool.requested') {
      if (TOOLS.has(payload.name))
        this.calls.set(payload.toolId, { name: payload.name, input: payload.input });
      return false;
    }
    if (payload.type === 'tool.input') {
      const call = this.calls.get(payload.toolId);
      if (call) call.input = payload.input;
      return false;
    }
    if (payload.type !== 'tool.result') return false;
    const call = this.calls.get(payload.toolId);
    if (!call) return false;
    this.calls.delete(payload.toolId);
    if (payload.status !== 'completed') return false;
    const input = parse(call.input) ?? {};
    if (call.name === 'TodoWrite') {
      const todos = Array.isArray(input.todos) ? input.todos : [];
      this.tasks.clear();
      todos.forEach((todo: Record<string, unknown>, index) => {
        const content = words(todo?.content);
        if (!content) return;
        const id = String(index + 1);
        this.tasks.set(id, {
          id,
          content,
          activeForm: words(todo.activeForm),
          status: STATUSES.has(String(todo.status)) ? (todo.status as TaskStatus) : 'pending',
        });
      });
      return true;
    }
    if (call.name === 'TaskCreate') {
      const content = words(input.subject);
      if (!content) return false;
      const told = /#(\d+)/.exec(payload.output)?.[1];
      const id = told ?? String(this.counted + 1);
      this.counted = Math.max(this.counted, Number(id) || 0);
      this.tasks.set(id, { id, content, activeForm: words(input.activeForm), status: 'pending' });
      return true;
    }
    const id = words(input.taskId);
    const task = id && this.tasks.get(id);
    if (!task) return false;
    if (input.status === 'deleted') this.tasks.delete(id);
    else {
      if (STATUSES.has(String(input.status))) task.status = input.status as TaskStatus;
      task.content = words(input.subject) ?? task.content;
      task.activeForm = words(input.activeForm) ?? task.activeForm;
    }
    return true;
  }
  get list(): Task[] {
    return [...this.tasks.values()].map((task) => ({ ...task }));
  }
}

// The list as the events leave it.
export function tasksOf(payloads: Iterable<EventPayload>) {
  const list = new TaskList();
  for (const payload of payloads) list.apply(payload);
  return list.list;
}
