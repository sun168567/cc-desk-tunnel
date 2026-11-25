import { useState } from 'react';
import { Trans } from 'react-i18next';
import { CalendarClock, Pencil, Play, Plus, Trash2 } from 'lucide-react';
import type { Effort, NativeCapabilities, Session } from '@cc-desk-tunnel/protocol';
import { folderName } from './paths.ts';
import {
  describeSchedule,
  outcomeText,
  parseTasks,
  stamp,
  weekdayName,
  weekdays,
} from './schedules.ts';
import type { Schedule, Schedules, Task } from './schedules.ts';
import { IconButton } from './ui.tsx';
import { modelName } from './modelNames.ts';
import HelpLink from './HelpLink.tsx';
import { useT } from './i18n.ts';

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
const kinds = ['once', 'daily', 'weekly', 'interval'] as const;
// Where Anthropic says what a subscription sign-in is meant for.
const usagePolicy = 'https://code.claude.com/docs/en/legal-and-compliance';

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
  const t = useT();
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
        const checked = parseTasks(t, JSON.stringify({ tasks: [taskOf(form)] }));
        if (!checked.tasks[0])
          return setFailure(checked.problems[0] ?? t('schedules:problem.incomplete'));
        save(checked.tasks[0]).catch((error: Error) => setFailure(error.message));
      }}
    >
      <label>
        {t('schedules:form.name')}
        <input
          aria-label={t('schedules:form.nameLabel')}
          value={form.name}
          maxLength={80}
          onChange={(event) => change({ name: event.target.value })}
        />
      </label>
      <label>
        {t('schedules:form.prompt')}
        <textarea
          aria-label={t('schedules:form.prompt')}
          rows={6}
          value={form.prompt}
          maxLength={15000}
          onChange={(event) => change({ prompt: event.target.value })}
        />
      </label>
      <div className="schedule-fields">
        <label>
          {t('schedules:form.repeat')}
          <select
            aria-label={t('schedules:form.repeatLabel')}
            value={form.kind}
            onChange={(event) => change({ kind: event.target.value as Form['kind'] })}
          >
            {kinds.map((kind) => (
              <option key={kind} value={kind}>
                {t(`schedules:form.kind.${kind}`)}
              </option>
            ))}
          </select>
        </label>
        {form.kind === 'once' && (
          <label>
            {t('schedules:form.time')}
            <input
              aria-label={t('schedules:form.timeLabel')}
              type="datetime-local"
              value={form.at}
              onChange={(event) => change({ at: event.target.value })}
            />
          </label>
        )}
        {(form.kind === 'daily' || form.kind === 'weekly') && (
          <label>
            {t('schedules:form.time')}
            <input
              aria-label={t('schedules:form.timeLabel')}
              type="time"
              value={form.time}
              onChange={(event) => change({ time: event.target.value })}
            />
          </label>
        )}
        {form.kind === 'interval' && (
          <label>
            {t('schedules:form.interval')}
            <input
              aria-label={t('schedules:form.intervalLabel')}
              type="number"
              min={5}
              value={form.minutes}
              onChange={(event) => change({ minutes: event.target.value })}
            />
          </label>
        )}
      </div>
      {form.kind === 'weekly' && (
        <div className="schedule-days" role="group" aria-label={t('schedules:form.days')}>
          {weekdays.map((day) => (
            <label key={day}>
              <input
                type="checkbox"
                checked={form.days.includes(day)}
                onChange={(event) =>
                  change({
                    days: event.target.checked
                      ? [...form.days, day]
                      : form.days.filter((other) => other !== day),
                  })
                }
              />
              {t('schedules:dayBox', { day: weekdayName(t, day) })}
            </label>
          ))}
        </div>
      )}
      <div className="schedule-fields">
        <label>
          {t('schedules:form.target')}
          <select
            aria-label={t('schedules:form.target')}
            value={form.target}
            onChange={(event) => change({ target: event.target.value as Form['target'] })}
          >
            <option value="session">{t('schedules:form.targetKind.session')}</option>
            <option value="new">{t('schedules:form.targetKind.new')}</option>
          </select>
        </label>
        {form.target === 'session' ? (
          <label>
            {t('schedules:form.session')}
            <select
              aria-label={t('schedules:form.sessionLabel')}
              value={form.sessionId}
              onChange={(event) => change({ sessionId: event.target.value })}
            >
              {!session && (
                <option value={form.sessionId}>{t('schedules:form.sessionGone')}</option>
              )}
              {sessions.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title} · {folderName(item.projectPath)}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <label>
            {t('schedules:form.project')}
            <input
              aria-label={t('schedules:form.project')}
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
          {t('schedules:form.model')}
          <select
            aria-label={t('schedules:form.modelLabel')}
            value={form.model}
            onChange={(event) => change({ model: event.target.value })}
          >
            <option value="">{t('schedules:form.keep')}</option>
            {models.map((model) => (
              <option key={model} value={model}>
                {(() => {
                  const found = capabilities?.models.find((item) => item.value === model);
                  return found ? modelName(found) : model;
                })()}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('schedules:form.effort')}
          <select
            aria-label={t('schedules:form.effortLabel')}
            value={form.effort}
            onChange={(event) => change({ effort: event.target.value })}
          >
            <option value="">{t('schedules:form.keep')}</option>
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
            {t('schedules:form.notAuto')}
          </p>
        )}
      {form.target === 'session' && session?.permissionMode === 'bypassPermissions' && (
        <p className="schedule-warning" role="status">
          {t('schedules:form.bypass')}
        </p>
      )}
      {failure && (
        <p className="error-text" role="alert">
          {failure}
        </p>
      )}
      <div className="schedule-actions">
        <button type="button" className="button" onClick={cancel}>
          {t('common:cancel')}
        </button>
        <button type="submit" className="button primary">
          {t('schedules:form.save')}
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
  const t = useT();
  // `null` is a new task; `undefined` shows the overview.
  const [editing, setEditing] = useState<Task | null | undefined>(undefined);
  const [removing, setRemoving] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const { tasks } = schedules;
  const store = (next: Task[]) =>
    schedules.save(next).catch((error: Error) => setFailure(error.message));
  const where = (task: Task) => {
    if (task.target.type === 'new')
      return t('schedules:where.new', { folder: folderName(task.target.projectPath) });
    const { sessionId } = task.target;
    return sessions.find((session) => session.id === sessionId)?.title ?? t('schedules:where.gone');
  };
  return (
    <>
      <aside className="sidebar">
        <div className="sidebar-brand">
          <span className="brand">{t('schedules:title')}</span>
          <HelpLink article="schedules" title={t('schedules:help')} />
        </div>
        <button type="button" className="side-action" onClick={() => setEditing(null)}>
          <Plus />
          {t('schedules:new')}
        </button>
        <nav className="session-list" aria-label={t('schedules:list')}>
          <div className="list-heading">{t('schedules:heading')}</div>
          {tasks.length === 0 && <p className="project-empty">{t('schedules:empty')}</p>}
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
                  aria-label={t('schedules:row.enable', { name: task.name })}
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
                    {describeSchedule(t, task.schedule)} · {where(task)}
                  </small>
                  <small>
                    {task.enabled
                      ? next
                        ? t('schedules:row.next', { time: stamp(next) })
                        : t('schedules:row.never')
                      : t('schedules:row.disabled')}
                    {last &&
                      ` · ${t('schedules:row.last', { time: stamp(last.at), outcome: outcomeText(t, last) })}`}
                  </small>
                  <span className="schedule-row-actions">
                    <IconButton
                      title={t('schedules:row.run', { name: task.name })}
                      onClick={() => void schedules.runNow(task)}
                    >
                      <Play />
                    </IconButton>
                    <IconButton
                      title={t('schedules:row.edit', { name: task.name })}
                      onClick={() => setEditing(task)}
                    >
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
                        {t('schedules:row.confirmDelete')}
                      </button>
                    ) : (
                      <IconButton
                        title={t('schedules:row.delete', { name: task.name })}
                        onClick={() => setRemoving(task.id)}
                      >
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
        <section className="page" aria-label={t('schedules:title')}>
          {editing !== undefined ? (
            <div className="page-body">
              <h1 className="page-title">{editing ? t('schedules:edit') : t('schedules:new')}</h1>
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
                <h2>{t('schedules:intro.title')}</h2>
                <p className="muted">{t('schedules:intro.text')}</p>
                <button type="button" className="button primary" onClick={() => setEditing(null)}>
                  {t('schedules:new')}
                </button>
              </div>
              <ul className="page-notes muted">
                <li>{t('schedules:intro.when')}</li>
                <li>{t('schedules:intro.approval')}</li>
                <li>
                  <Trans
                    t={t}
                    i18nKey="schedules:intro.policy"
                    components={{
                      link: (
                        <button
                          type="button"
                          className="text-link"
                          onClick={() =>
                            window.desktop
                              ? void window.desktop.openExternal(usagePolicy)
                              : void window.open(usagePolicy)
                          }
                        />
                      ),
                    }}
                  />
                </li>
                {schedules.path && (
                  <li>
                    <Trans
                      t={t}
                      i18nKey="schedules:intro.file"
                      values={{ path: schedules.path }}
                      components={{ code: <code /> }}
                    />
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
