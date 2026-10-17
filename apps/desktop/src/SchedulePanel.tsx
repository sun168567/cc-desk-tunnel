import { useEffect, useRef, useState } from 'react';
import { CalendarClock, Pencil, Play, Plus, Trash2 } from 'lucide-react';
import type { Effort, NativeCapabilities, Session } from '@cc-desk-tunnel/protocol';
import { folderName } from './paths.ts';
import { parseTasks } from './schedules.ts';
import type { Schedule, Task } from './schedules.ts';
import { scheduleDescription, scheduleNextLabel, scheduleStamp } from './browser-schedules.ts';
import type { WorkbenchSchedules } from './browser-schedules.ts';
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
// Where Anthropic says what a subscription sign-in is meant for.
const usagePolicy = 'https://code.claude.com/docs/en/legal-and-compliance';

function formOf(
  task: Task | null,
  sessions: Session[],
  projects: string[],
  timeZone?: string,
  remote = false,
): Form {
  const rule = task?.schedule;
  return {
    id: task?.id ?? crypto.randomUUID(),
    enabled: task?.enabled ?? true,
    name: task?.name ?? '',
    prompt: task?.prompt ?? '',
    kind: rule?.type ?? 'daily',
    at:
      rule?.type === 'once'
        ? rule.at
        : remote && !timeZone
          ? ''
          : scheduleStamp(Date.now() + 3_600_000, timeZone).replace(' ', 'T'),
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
  timeZone,
  remote,
  revision,
  editGeneration,
  save,
  cancel,
}: {
  task: Task | null;
  sessions: Session[];
  projects: string[];
  capabilities: NativeCapabilities | null;
  timeZone?: string;
  remote: boolean;
  revision?: string | null;
  editGeneration?: number;
  save: (task: Task, revision?: string | null, editGeneration?: number) => Promise<void>;
  cancel: () => void;
}) {
  const [form, setForm] = useState(() => formOf(task, sessions, projects, timeZone, remote));
  const [failure, setFailure] = useState<string | null>(null);
  // Polling may refresh the list while this form stays open. Its draft still belongs to the version
  // it was opened from; assigning the latest revision here would silently overwrite another edit.
  // Keep the sharing generation too, including drafts opened before a complete Web on/off cycle.
  const draft = useRef({ revision, editGeneration });
  const awaitingTimeZone = useRef(remote && !timeZone && task?.schedule.type !== 'once');
  const timeEdited = useRef(false);
  useEffect(() => {
    if (!awaitingTimeZone.current || !timeZone) return;
    awaitingTimeZone.current = false;
    // A late host timezone only supplies an untouched default; it must never replace the draft.
    if (!timeEdited.current)
      setForm((current) =>
        current.at
          ? current
          : { ...current, at: scheduleStamp(Date.now() + 3_600_000, timeZone).replace(' ', 'T') },
      );
  }, [timeZone]);
  const change = (values: Partial<Form>) => {
    if (values.at !== undefined) timeEdited.current = true;
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
        save(checked.tasks[0], draft.current.revision, draft.current.editGeneration).catch(
          (error: Error) => setFailure(error.message),
        );
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
      {form.target === 'session' &&
        session &&
        session.permissionMode !== 'auto' &&
        session.permissionMode !== 'bypassPermissions' && (
          <p className="schedule-warning" role="status">
            这个会话不是自动审批：无人值守时任务会停在审批处，直到有人处理。
          </p>
        )}
      {form.target === 'session' && session?.permissionMode === 'bypassPermissions' && (
        <p className="schedule-warning" role="status">
          这个会话绕过权限：无人值守时任务做任何事都不会询问。
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
        <button type="submit" className="button primary" disabled={remote && !timeZone}>
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
  schedules: WorkbenchSchedules;
  sessions: Session[];
  projects: string[];
  capabilities: NativeCapabilities | null;
}) {
  // `null` is a new task; `undefined` shows the overview.
  const [editing, setEditing] = useState<Task | null | undefined>(undefined);
  const [removing, setRemoving] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const { tasks } = schedules;
  const refresh = schedules.refresh;
  useEffect(() => {
    if (!refresh) return;
    const read = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    read();
    const timer = setInterval(read, 3000);
    document.addEventListener('visibilitychange', read);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', read);
    };
  }, [refresh]);
  const store = (next: Task[]) =>
    schedules
      .save(next, schedules.revision, schedules.editGeneration)
      .catch((error: Error) => setFailure(error.message));
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
                    {scheduleDescription(task.schedule, schedules.timeZone, schedules.remote)} ·{' '}
                    {where(task)}
                  </small>
                  <small>
                    {scheduleNextLabel(task, next, schedules.timeZone)}
                    {last && ` · 上次 ${scheduleStamp(last.at, schedules.timeZone)} ${last.text}`}
                  </small>
                  <span className="schedule-row-actions">
                    <IconButton
                      title={`立即运行 ${task.name}`}
                      onClick={() =>
                        void schedules
                          .runNow(task)
                          .catch((error: Error) => setFailure(error.message))
                      }
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
          {schedules.remote && (
            <p className="page-notes muted" role="status">
              {schedules.timeZone
                ? `按桌面客户端时区 ${schedules.timeZone} 显示和编辑时间；自动任务仅由桌面客户端触发。`
                : '等待桌面客户端的调度状态和时区；浏览器不会自行推算或触发自动任务。'}
            </p>
          )}
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
                  timeZone={schedules.timeZone}
                  remote={schedules.remote}
                  revision={schedules.revision}
                  editGeneration={schedules.editGeneration}
                  cancel={() => setEditing(undefined)}
                  save={async (task, revision, editGeneration) => {
                    await schedules.save(
                      tasks.some((item) => item.id === task.id)
                        ? tasks.map((item) => (item.id === task.id ? task : item))
                        : [...tasks, task],
                      revision,
                      editGeneration,
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
                  到点时由{schedules.remote ? '桌面客户端所在电脑' : '这台电脑'}
                  上的客户端向会话发送一条带“定时任务”标签的消息，让 Claude Code 替你处理重复的事。
                </p>
                <button type="button" className="button primary" onClick={() => setEditing(null)}>
                  新建任务
                </button>
              </div>
              <ul className="page-notes muted">
                <li>只在客户端运行并已连接时触发；晚于计划 10 分钟仍发不出的那一次会跳过。</li>
                <li>无人值守时请让目标会话使用自动审批，否则会停在审批处。</li>
                <li>
                  任务由程序自动发送。用订阅账号登录时，官方的额度按普通的个人使用设定，自动发送是否合适请对照
                  <button
                    type="button"
                    className="text-link"
                    onClick={() =>
                      window.desktop
                        ? void window.desktop.openExternal(usagePolicy)
                        : void window.open(usagePolicy)
                    }
                  >
                    官方的使用说明
                  </button>
                  自行判断。
                </li>
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
