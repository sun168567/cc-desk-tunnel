import { useState } from 'react';
import { CalendarClock, Pencil, Play, Plus, Trash2 } from 'lucide-react';
import type { Effort, NativeCapabilities, Session } from '@cc-desk-tunnel/protocol';
import { folderName } from './paths.ts';
import { describeSchedule, parseTasks, stamp } from './schedules.ts';
import type { Schedule, Schedules, Task } from './schedules.ts';
import { IconButton } from './ui.tsx';

// The editor's fields: every kind of rule and target keeps its own input, so switching kinds loses nothing.
type Form = {
  id: string;
  enabled: boolean;
  name: string;
  prompt: string;
  kind: Schedule['type'];
  at: string;
  time: string;
  days: number[];
  minutes: string;
  target: 'session' | 'new';
  sessionId: string;
  projectPath: string;
  model: string;
  effort: string;
};
const efforts: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const weekdays = ['一', '二', '三', '四', '五', '六', '日'];

function formOf(task: Task | null, sessions: Session[], projects: string[]): Form {
  const rule = task?.schedule;
  return {
    id: task?.id ?? crypto.randomUUID(),
    enabled: task?.enabled ?? true,
    name: task?.name ?? '',
    prompt: task?.prompt ?? '',
    kind: rule?.type ?? 'daily',
    at: rule?.type === 'once' ? rule.at : stamp(Date.now() + 3_600_000).replace(' ', 'T'),
    time: rule?.type === 'daily' || rule?.type === 'weekly' ? rule.time : '09:00',
    days: rule?.type === 'weekly' ? rule.days : [1, 2, 3, 4, 5],
    minutes: String(rule?.type === 'interval' ? rule.minutes : 60),
    target: task?.target.type ?? (sessions.length ? 'session' : 'new'),
    sessionId: task?.target.type === 'session' ? task.target.sessionId : (sessions[0]?.id ?? ''),
    projectPath:
      task?.target.type === 'new'
        ? task.target.projectPath
        : (projects[0] ?? sessions[0]?.projectPath ?? ''),
    model: task?.model ?? '',
    effort: task?.effort ?? '',
  };
}
function taskOf(form: Form) {
  const schedule =
    form.kind === 'once'
      ? { type: form.kind, at: form.at }
      : form.kind === 'daily'
        ? { type: form.kind, time: form.time }
        : form.kind === 'weekly'
          ? { type: form.kind, days: form.days, time: form.time }
          : { type: form.kind, minutes: Number(form.minutes) };
  return {
    id: form.id,
    name: form.name.trim(),
    enabled: form.enabled,
    prompt: form.prompt.trim(),
    schedule,
    target:
      form.target === 'session'
        ? { type: form.target, sessionId: form.sessionId }
        : { type: form.target, projectPath: form.projectPath.trim() },
    model: form.model || null,
    effort: form.effort || null,
  };
}

function Editor({
  task,
  sessions,
  projects,
  capabilities,
  save,
  cancel,
}: {
  task: Task | null;
  sessions: Session[];
  projects: string[];
  capabilities: NativeCapabilities | null;
  save: (task: Task) => Promise<void>;
  cancel: () => void;
}) {
  const [form, setForm] = useState(() => formOf(task, sessions, projects));
  const [failure, setFailure] = useState<string | null>(null);
  const change = (values: Partial<Form>) => {
    setFailure(null);
    setForm((current) => ({ ...current, ...values }));
  };
  const session = sessions.find((item) => item.id === form.sessionId);
  const models = [
    ...new Set([...(capabilities?.models.map((model) => model.value) ?? []), form.model]),
  ].filter(Boolean);
  return (
    <form
      className="schedule-form"
      onSubmit={(event) => {
        event.preventDefault();
        // The same check the file goes through, so the window cannot write a task it would then refuse.
        const checked = parseTasks(JSON.stringify({ tasks: [taskOf(form)] }));
        if (!checked.tasks[0]) return setFailure(checked.problems[0] ?? '任务内容不完整。');
        save(checked.tasks[0]).catch((error: Error) => setFailure(error.message));
      }}
    >
      <label>
        名称
        <input
          aria-label="任务名称"
          value={form.name}
          maxLength={80}
          onChange={(event) => change({ name: event.target.value })}
        />
      </label>
      <label>
        提示词
        <textarea
          aria-label="提示词"
          rows={6}
          value={form.prompt}
          maxLength={15000}
          onChange={(event) => change({ prompt: event.target.value })}
        />
      </label>
      <div className="schedule-fields">
        <label>
          重复
          <select
            aria-label="重复规则"
            value={form.kind}
            onChange={(event) => change({ kind: event.target.value as Form['kind'] })}
          >
            <option value="once">仅一次</option>
            <option value="daily">每天</option>
            <option value="weekly">每周</option>
            <option value="interval">按间隔</option>
          </select>
        </label>
        {form.kind === 'once' && (
          <label>
            时间
            <input
              aria-label="运行时间"
              type="datetime-local"
              value={form.at}
              onChange={(event) => change({ at: event.target.value })}
            />
          </label>
        )}
        {(form.kind === 'daily' || form.kind === 'weekly') && (
          <label>
            时间
            <input
              aria-label="运行时间"
              type="time"
              value={form.time}
              onChange={(event) => change({ time: event.target.value })}
            />
          </label>
        )}
        {form.kind === 'interval' && (
          <label>
            间隔（分钟）
            <input
              aria-label="间隔分钟"
              type="number"
              min={5}
              value={form.minutes}
              onChange={(event) => change({ minutes: event.target.value })}
            />
          </label>
        )}
      </div>
      {form.kind === 'weekly' && (
        <div className="schedule-days" role="group" aria-label="星期">
          {weekdays.map((name, index) => (
            <label key={name}>
              <input
                type="checkbox"
                checked={form.days.includes(index + 1)}
                onChange={(event) =>
                  change({
                    days: event.target.checked
                      ? [...form.days, index + 1]
                      : form.days.filter((day) => day !== index + 1),
                  })
                }
              />
              周{name}
            </label>
          ))}
        </div>
      )}
      <div className="schedule-fields">
        <label>
          发送到
          <select
            aria-label="发送到"
            value={form.target}
            onChange={(event) => change({ target: event.target.value as Form['target'] })}
          >
            <option value="session">接续已有会话</option>
            <option value="new">每次新开会话</option>
          </select>
        </label>
        {form.target === 'session' ? (
          <label>
            会话
            <select
              aria-label="目标会话"
              value={form.sessionId}
              onChange={(event) => change({ sessionId: event.target.value })}
            >
              {!session && <option value={form.sessionId}>（会话已不存在）</option>}
              {sessions.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title} · {folderName(item.projectPath)}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <label>
            项目目录
            <input
              aria-label="项目目录"
              list="schedule-projects"
              value={form.projectPath}
              onChange={(event) => change({ projectPath: event.target.value })}
            />
            <datalist id="schedule-projects">
              {[...new Set([...projects, ...sessions.map((item) => item.projectPath)])].map(
                (path) => (
                  <option key={path} value={path} />
                ),
              )}
            </datalist>
          </label>
        )}
      </div>
      <div className="schedule-fields">
        <label>
          模型
          <select
            aria-label="任务模型"
            value={form.model}
            onChange={(event) => change({ model: event.target.value })}
          >
            <option value="">不改动</option>
            {models.map((model) => (
              <option key={model} value={model}>
                {capabilities?.models.find((item) => item.value === model)?.displayName ?? model}
              </option>
            ))}
          </select>
        </label>
        <label>
          推理强度
          <select
            aria-label="任务推理强度"
            value={form.effort}
            onChange={(event) => change({ effort: event.target.value })}
          >
            <option value="">不改动</option>
            {efforts.map((effort) => (
              <option key={effort} value={effort}>
                {effort}
              </option>
            ))}
          </select>
        </label>
      </div>
      {form.target === 'session' && session && session.permissionMode !== 'auto' && (
        <p className="schedule-warning" role="status">
          这个会话不是自动审批：无人值守时任务会停在审批处，直到有人处理。
        </p>
      )}
      {failure && (
        <p className="error-text" role="alert">
          {failure}
        </p>
      )}
      <div className="schedule-actions">
        <button type="button" className="button" onClick={cancel}>
          取消
        </button>
        <button type="submit" className="button primary">
          保存任务
        </button>
      </div>
    </form>
  );
}

// The tasks are listed in the side column; the main area holds the editor, or says what the page is for.
export default function SchedulePanel({
  schedules,
  sessions,
  projects,
  capabilities,
}: {
  schedules: Schedules;
  sessions: Session[];
  projects: string[];
  capabilities: NativeCapabilities | null;
}) {
  // `null` is a new task; `undefined` shows the overview.
  const [editing, setEditing] = useState<Task | null | undefined>(undefined);
  const [removing, setRemoving] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const { tasks } = schedules;
  const store = (next: Task[]) =>
    schedules.save(next).catch((error: Error) => setFailure(error.message));
  const where = (task: Task) => {
    if (task.target.type === 'new') return `新会话 · ${folderName(task.target.projectPath)}`;
    const { sessionId } = task.target;
    return sessions.find((session) => session.id === sessionId)?.title ?? '会话已不存在';
  };
  return (
    <>
      <aside className="sidebar">
        <div className="sidebar-brand">
          <span className="brand">定时任务</span>
        </div>
        <button type="button" className="side-action" onClick={() => setEditing(null)}>
          <Plus />
          新建任务
        </button>
        <nav className="session-list" aria-label="任务列表">
          <div className="list-heading">任务</div>
          {tasks.length === 0 && <p className="project-empty">暂无已安排的任务</p>}
          {tasks.map((task) => {
            const next = schedules.next(task);
            const last = schedules.last(task);
            return (
              <div
                key={task.id}
                className={`schedule-row ${editing?.id === task.id ? 'selected' : ''}`}
              >
                <input
                  type="checkbox"
                  aria-label={`启用 ${task.name}`}
                  checked={task.enabled}
                  onChange={(event) =>
                    void store(
                      tasks.map((item) =>
                        item.id === task.id ? { ...item, enabled: event.target.checked } : item,
                      ),
                    )
                  }
                />
                <span>
                  <strong>{task.name}</strong>
                  <small>
                    {describeSchedule(task.schedule)} · {where(task)}
                  </small>
                  <small>
                    {task.enabled ? (next ? `下次 ${stamp(next)}` : '不会再运行') : '已停用'}
                    {last && ` · 上次 ${stamp(last.at)} ${last.text}`}
                  </small>
                  <span className="schedule-row-actions">
                    <IconButton
                      title={`立即运行 ${task.name}`}
                      onClick={() => void schedules.runNow(task)}
                    >
                      <Play />
                    </IconButton>
                    <IconButton title={`编辑 ${task.name}`} onClick={() => setEditing(task)}>
                      <Pencil />
                    </IconButton>
                    {removing === task.id ? (
                      <button
                        type="button"
                        className="button danger"
                        onClick={() => {
                          setRemoving(null);
                          if (editing?.id === task.id) setEditing(undefined);
                          void store(tasks.filter((item) => item.id !== task.id));
                        }}
                      >
                        确认删除
                      </button>
                    ) : (
                      <IconButton title={`删除 ${task.name}`} onClick={() => setRemoving(task.id)}>
                        <Trash2 />
                      </IconButton>
                    )}
                  </span>
                </span>
              </div>
            );
          })}
        </nav>
      </aside>
      <main className="workspace">
        <section className="page" aria-label="定时任务">
          {editing !== undefined ? (
            <div className="page-body">
              <h1 className="page-title">{editing ? '编辑任务' : '新建任务'}</h1>
              <div className="card">
                <Editor
                  key={editing?.id ?? 'new'}
                  task={editing}
                  sessions={sessions}
                  projects={projects}
                  capabilities={capabilities}
                  cancel={() => setEditing(undefined)}
                  save={async (task) => {
                    await schedules.save(
                      tasks.some((item) => item.id === task.id)
                        ? tasks.map((item) => (item.id === task.id ? task : item))
                        : [...tasks, task],
                    );
                    setEditing(undefined);
                  }}
                />
              </div>
            </div>
          ) : (
            <div className="page-body page-center">
              <div className="empty-state">
                <CalendarClock />
                <h2>安排任务</h2>
                <p className="muted">
                  到点时由这台电脑上的客户端向会话发送一条带“定时任务”标签的消息，让 Claude Code
                  替你处理重复的事。
                </p>
                <button type="button" className="button primary" onClick={() => setEditing(null)}>
                  新建任务
                </button>
              </div>
              <ul className="page-notes muted">
                <li>只在客户端运行并已连接时触发；晚于计划 10 分钟仍发不出的那一次会跳过。</li>
                <li>无人值守时请让目标会话使用自动审批，否则会停在审批处。</li>
                {schedules.path && (
                  <li>
                    配置文件 <code>{schedules.path}</code>
                    ：可以直接编辑，也可以让 Claude 代为设置，几秒内生效。
                  </li>
                )}
              </ul>
              {[...schedules.problems, ...(failure ? [failure] : [])].map((problem) => (
                <p key={problem} className="error-text" role="alert">
                  {problem}
                </p>
              ))}
            </div>
          )}
        </section>
      </main>
    </>
  );
}
