import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { effortSchema } from '@cc-desk-tunnel/protocol';
import type { Effort } from '@cc-desk-tunnel/protocol';
import { useT } from './i18n.ts';
import type { T } from './i18n.ts';

// Scheduled tasks belong to this computer: a task is a message the client sends by itself when its time
// comes. They live in one JSON file the user, this window and Claude (over SSH) may all edit; the file
// explains its own format, and a task that does not fit it is reported instead of run.
export type Schedule =
  | { type: 'once'; at: string }
  | { type: 'daily'; time: string }
  | { type: 'weekly'; days: number[]; time: string }
  | { type: 'interval'; minutes: number };
export type Target = { type: 'session'; sessionId: string } | { type: 'new'; projectPath: string };
export type Task = {
  id: string;
  name: string;
  enabled: boolean;
  prompt: string;
  schedule: Schedule;
  target: Target;
  model: string | null;
  effort: Effort | null;
};
// What the last due time came to; kept apart from the file so that running a task never rewrites it.
// `due` is the time a missed run was for, and `error` why one failed; one run at once that could not be
// sent then is `blocked`.
export type Outcome = {
  at: number;
  status: 'sent' | 'missed' | 'failed' | 'blocked';
  due?: number;
  error?: string;
};
type Progress = Record<string, { key: string; base: number; last?: Outcome }>;

// The file's own account of its format, for whoever edits it: written in the window's language, under a key
// of that language too. Reading the file ignores it.
const guide = [
  'intro',
  'reload',
  'fields',
  'schedule',
  'weekly',
  'target',
  'model',
  'when',
] as const;
export const grace = 10 * 60_000;
const clock = /^([01]\d|2[0-3]):[0-5]\d$/;

function parseTask(t: T, value: unknown): Task {
  const fail = (reason: string): never => {
    throw new Error(reason);
  };
  if (!value || typeof value !== 'object') return fail(t('schedules:problem.notObject'));
  const task = value as Record<string, unknown>;
  const text = (key: string, max: number) => {
    const field = task[key];
    if (typeof field !== 'string' || !field.trim() || field.length > max)
      return fail(t('schedules:problem.text', { field: key, max }));
    return field as string;
  };
  const schedule = task.schedule as Record<string, unknown> | undefined;
  const target = task.target as Record<string, unknown> | undefined;
  const time = () =>
    typeof schedule?.time === 'string' && clock.test(schedule.time)
      ? schedule.time
      : fail(t('schedules:problem.time'));
  let rule: Schedule;
  if (schedule?.type === 'once')
    rule =
      typeof schedule.at === 'string' && !Number.isNaN(new Date(schedule.at).getTime())
        ? { type: 'once', at: schedule.at }
        : fail(t('schedules:problem.at'));
  else if (schedule?.type === 'daily') rule = { type: 'daily', time: time() };
  else if (schedule?.type === 'weekly') {
    const days = schedule.days;
    if (
      !Array.isArray(days) ||
      !days.length ||
      days.some((day) => !Number.isInteger(day) || day < 1 || day > 7)
    )
      return fail(t('schedules:problem.days'));
    rule = { type: 'weekly', days: [...new Set(days as number[])].sort(), time: time() };
  } else if (schedule?.type === 'interval')
    rule =
      Number.isInteger(schedule.minutes) && (schedule.minutes as number) >= 5
        ? { type: 'interval', minutes: schedule.minutes as number }
        : fail(t('schedules:problem.minutes'));
  else return fail(t('schedules:problem.type'));
  let where: Target;
  if (target?.type === 'session' && typeof target.sessionId === 'string' && target.sessionId)
    where = { type: 'session', sessionId: target.sessionId };
  else if (target?.type === 'new' && typeof target.projectPath === 'string' && target.projectPath)
    where = { type: 'new', projectPath: target.projectPath };
  else return fail(t('schedules:problem.target'));
  const effort = task.effort == null ? null : effortSchema.safeParse(task.effort).data;
  if (effort === undefined) return fail(t('schedules:problem.effort'));
  if (task.model != null && (typeof task.model !== 'string' || !task.model.trim()))
    return fail(t('schedules:problem.model'));
  return {
    id: text('id', 120),
    name: text('name', 80),
    enabled: task.enabled !== false,
    prompt: text('prompt', 15000),
    schedule: rule,
    target: where,
    model: (task.model as string | null | undefined) ?? null,
    effort,
  };
}
// Reads the file's text. A task that cannot be understood is left out and named in `problems`; text that is
// not the expected JSON at all yields `broken`, and the caller keeps what it had.
export function parseTasks(
  t: T,
  text: string,
): { tasks: Task[]; problems: string[]; broken?: string } {
  let list: unknown;
  try {
    list = text.trim() ? (JSON.parse(text) as { tasks?: unknown }).tasks : [];
  } catch (error) {
    const reason = (error as Error).message;
    return { tasks: [], problems: [], broken: t('schedules:problem.notJson', { reason }) };
  }
  if (!Array.isArray(list))
    return { tasks: [], problems: [], broken: t('schedules:problem.noTasks') };
  const tasks: Task[] = [];
  const problems: string[] = [];
  list.forEach((value, index) => {
    const name = (value as { name?: unknown } | null)?.name;
    const label =
      typeof name === 'string' && name
        ? t('schedules:problem.named', { name })
        : t('schedules:problem.numbered', { n: index + 1 });
    try {
      const task = parseTask(t, value);
      if (tasks.some((other) => other.id === task.id))
        throw new Error(t('schedules:problem.duplicateId'));
      tasks.push(task);
    } catch (error) {
      problems.push(t('schedules:problem.task', { label, reason: (error as Error).message }));
    }
  });
  return { tasks, problems };
}
export function formatTasks(t: T, tasks: Task[]) {
  const about = guide.map((line) => t(`schedules:file.guide.${line}`));
  return JSON.stringify({ [t('schedules:file.key')]: about, tasks }, null, 2) + '\n';
}

function at(day: Date, time: string) {
  const [hours, minutes] = time.split(':').map(Number);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), hours, minutes).getTime();
}
// The first time the rule fires after `after`, in local time; null when it never will again.
export function nextRun(schedule: Schedule, after: number): number | null {
  if (schedule.type === 'once') {
    const time = new Date(schedule.at).getTime();
    return time > after ? time : null;
  }
  if (schedule.type === 'interval') return after + schedule.minutes * 60_000;
  for (let offset = 0; offset <= 7; offset++) {
    const day = new Date(after);
    day.setDate(day.getDate() + offset);
    if (schedule.type === 'weekly' && !schedule.days.includes(day.getDay() || 7)) continue;
    const time = at(day, schedule.time);
    if (time > after) return time;
  }
  return null;
}
// Monday is 1 and Sunday 7, as in the file.
export const weekdays = [1, 2, 3, 4, 5, 6, 7] as const;
export const weekdayName = (t: T, day: number) =>
  t(`schedules:weekday.${String(day) as `${(typeof weekdays)[number]}`}`);
export function describeSchedule(t: T, schedule: Schedule) {
  if (schedule.type === 'once')
    return t('schedules:rule.once', { time: stamp(new Date(schedule.at).getTime()) });
  if (schedule.type === 'daily') return t('schedules:rule.daily', { time: schedule.time });
  if (schedule.type === 'weekly')
    return t('schedules:rule.weekly', {
      days: schedule.days.map((day) => weekdayName(t, day)),
      time: schedule.time,
    });
  return schedule.minutes % 60
    ? t('schedules:rule.minutes', { count: schedule.minutes })
    : t('schedules:rule.hours', { count: schedule.minutes / 60 });
}
export function stamp(time: number) {
  const date = new Date(time);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
// The message a due task sends: the user's prompt under a line saying where it came from.
export function taskMessage(t: T, task: Task, due: number) {
  return `${t('schedules:message', { name: task.name, time: stamp(due) })}\n\n${task.prompt}`;
}
export function outcomeText(t: T, outcome: Outcome) {
  if (outcome.status === 'sent') return t('schedules:outcome.sent');
  if (outcome.status === 'missed')
    return t('schedules:outcome.missed', { time: stamp(outcome.due ?? outcome.at) });
  if (outcome.status === 'blocked') return t('schedules:outcome.blocked');
  return outcome.error ?? t('schedules:outcome.failed');
}

const storageKey = 'proxy-schedules';
const progressKey = 'proxy-schedule-progress';
function readProgress(): Progress {
  try {
    const value = JSON.parse(localStorage.getItem(progressKey) ?? '{}');
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}
async function loadFile(t: T): Promise<{ path: string; text: string }> {
  if (window.desktop) return window.desktop.loadSchedules(formatTasks(t, []));
  return { path: '', text: localStorage.getItem(storageKey) ?? '' };
}

export type Schedules = {
  tasks: Task[];
  // Tasks in the file that were left out, and why.
  problems: string[];
  path: string;
  next: (task: Task) => number | null;
  last: (task: Task) => Outcome | undefined;
  save: (tasks: Task[]) => Promise<void>;
  runNow: (task: Task) => Promise<void>;
};
// Keeps the tasks in step with the file and sends each one when it is due. `send` delivers a task's message:
// it answers false while that is not possible yet (not connected, the session is busy) and rejects when it
// went wrong.
// `report` hears of every run that did not go out.
export function useSchedules(
  send: (task: Task, due: number) => Promise<boolean>,
  report?: (task: Task, outcome: Outcome) => void,
  enabled = true,
) {
  const t = useT();
  const [tasks, setTasks] = useState<Task[]>([]);
  // The file's text as last read, kept so that what is wrong with it is said again in a new language.
  const [file, setFile] = useState('');
  const [path, setPath] = useState('');
  const [progress, setProgress] = useState<Progress>(readProgress);
  const current = useRef({ tasks, progress, send, report, t });
  current.current = { tasks, progress, send, report, t };
  const busy = useRef(false);

  const record = useCallback((update: (progress: Progress) => Progress) => {
    const next = update(current.current.progress);
    current.current.progress = next;
    localStorage.setItem(progressKey, JSON.stringify(next));
    setProgress(next);
  }, []);
  const accept = useCallback(
    (text: string) => {
      const parsed = parseTasks(current.current.t, text);
      setFile(text);
      // A file that cannot be read at all changes nothing: the tasks already loaded keep running.
      if (parsed.broken) return;
      setTasks(parsed.tasks);
      // A task counts from the moment it appears or its rule changes, never from before.
      record((progress) =>
        Object.fromEntries(
          parsed.tasks.map((task) => {
            const key = JSON.stringify(task.schedule);
            const known = progress[task.id];
            return [task.id, known?.key === key ? known : { key, base: Date.now() }];
          }),
        ),
      );
    },
    [record],
  );
  const problems = useMemo(() => {
    const parsed = parseTasks(t, file);
    return parsed.broken
      ? [t('schedules:problem.refused', { reason: parsed.broken })]
      : parsed.problems;
  }, [t, file]);
  useEffect(() => {
    if (!enabled) return;
    void loadFile(current.current.t).then((file) => {
      setPath(file.path);
      accept(file.text);
    });
    return window.desktop?.onSchedulesChanged(accept);
  }, [accept, enabled]);

  const settle = useCallback(
    (task: Task, result: Omit<Outcome, 'at'>) => {
      const last = { at: Date.now(), ...result };
      if (last.status !== 'sent') current.current.report?.(task, last);
      record((progress) => ({
        ...progress,
        [task.id]: { ...progress[task.id]!, base: Date.now(), last },
      }));
    },
    [record],
  );
  const attempt = useCallback(
    async (task: Task, due: number) => {
      try {
        if (!(await current.current.send(task, due))) return false;
        settle(task, { status: 'sent' });
      } catch (error) {
        settle(task, {
          status: 'failed',
          error: error instanceof Error ? error.message : undefined,
        });
      }
      return true;
    },
    [settle],
  );
  useEffect(() => {
    if (!enabled) return;
    const tick = async () => {
      if (busy.current) return;
      busy.current = true;
      try {
        for (const task of current.current.tasks) {
          const state = current.current.progress[task.id];
          if (!task.enabled || !state) continue;
          const due = nextRun(task.schedule, state.base);
          if (due === null || due > Date.now()) continue;
          // While it cannot be sent it is tried again on every tick, until it is too late to be worth it.
          if (Date.now() - due > grace) settle(task, { status: 'missed', due });
          else await attempt(task, due);
        }
      } finally {
        busy.current = false;
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 15_000);
    return () => clearInterval(timer);
  }, [attempt, settle, enabled]);

  const save = useCallback(
    async (tasks: Task[]) => {
      const text = formatTasks(current.current.t, tasks);
      if (window.desktop) await window.desktop.saveSchedules(text);
      else localStorage.setItem(storageKey, text);
      accept(text);
    },
    [accept],
  );
  const result: Schedules = {
    tasks,
    problems,
    path,
    next: (task) => {
      const state = progress[task.id];
      return task.enabled && state ? nextRun(task.schedule, state.base) : null;
    },
    last: (task) => progress[task.id]?.last,
    save,
    runNow: async (task) => {
      if (!(await attempt(task, Date.now()))) settle(task, { status: 'blocked' });
    },
  };
  return result;
}
