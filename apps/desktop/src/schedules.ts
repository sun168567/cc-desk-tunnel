import { useCallback, useEffect, useRef, useState } from 'react';
import { effortSchema } from '@cc-desk-tunnel/protocol';
import type { Effort } from '@cc-desk-tunnel/protocol';

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
export type Outcome = { at: number; status: 'sent' | 'missed' | 'failed'; text: string };
type Progress = Record<string, { key: string; base: number; last?: Outcome }>;

export const guide = [
  'CC Desk Tunnel 客户端的定时任务。到点时客户端向会话发送一条带“定时任务”标签的消息，内容为 prompt。',
  '修改本文件后几秒内生效，无需重启；格式不对的任务不会运行，并在客户端“定时任务”面板里提示原因。',
  '任务字段：id（任意不重复字符串）、name、enabled（true/false）、prompt（不超过 15000 字）、schedule、target、model、effort。',
  'schedule 四选一，时间均为本机时间：{"type":"once","at":"2026-01-31T09:00"}、{"type":"daily","time":"09:00"}、',
  '{"type":"weekly","days":[1,3,5],"time":"09:00"}（1=周一 … 7=周日）、{"type":"interval","minutes":60}（不少于 5）。',
  'target 二选一：{"type":"session","sessionId":"…"} 接续已有会话；{"type":"new","projectPath":"D:\\\\项目"} 每次新开会话。',
  'model 与 effort 可为 null（不改动会话当前设置）；effort 取 low / medium / high / xhigh / max。',
  '只在客户端运行并已连接时触发；晚于计划 10 分钟仍无法发送的那一次会跳过。无人值守时会话应使用自动审批，否则会停在审批处。',
];
export const grace = 10 * 60_000;
const clock = /^([01]\d|2[0-3]):[0-5]\d$/;

function parseTask(value: unknown): Task {
  const fail = (reason: string): never => {
    throw new Error(reason);
  };
  if (!value || typeof value !== 'object') return fail('不是对象');
  const task = value as Record<string, unknown>;
  const text = (key: string, max: number) => {
    const field = task[key];
    if (typeof field !== 'string' || !field.trim() || field.length > max)
      return fail(`${key} 应为不超过 ${max} 字的非空文本`);
    return field as string;
  };
  const schedule = task.schedule as Record<string, unknown> | undefined;
  const target = task.target as Record<string, unknown> | undefined;
  const time = () =>
    typeof schedule?.time === 'string' && clock.test(schedule.time)
      ? schedule.time
      : fail('schedule.time 应为 HH:MM');
  let rule: Schedule;
  if (schedule?.type === 'once')
    rule =
      typeof schedule.at === 'string' && !Number.isNaN(new Date(schedule.at).getTime())
        ? { type: 'once', at: schedule.at }
        : fail('schedule.at 应为 2026-01-31T09:00 形式的时间');
  else if (schedule?.type === 'daily') rule = { type: 'daily', time: time() };
  else if (schedule?.type === 'weekly') {
    const days = schedule.days;
    if (
      !Array.isArray(days) ||
      !days.length ||
      days.some((day) => !Number.isInteger(day) || day < 1 || day > 7)
    )
      return fail('schedule.days 应为 1 到 7 的数组');
    rule = { type: 'weekly', days: [...new Set(days as number[])].sort(), time: time() };
  } else if (schedule?.type === 'interval')
    rule =
      Number.isInteger(schedule.minutes) && (schedule.minutes as number) >= 5
        ? { type: 'interval', minutes: schedule.minutes as number }
        : fail('schedule.minutes 应为不小于 5 的整数');
  else return fail('schedule.type 应为 once / daily / weekly / interval');
  let where: Target;
  if (target?.type === 'session' && typeof target.sessionId === 'string' && target.sessionId)
    where = { type: 'session', sessionId: target.sessionId };
  else if (target?.type === 'new' && typeof target.projectPath === 'string' && target.projectPath)
    where = { type: 'new', projectPath: target.projectPath };
  else return fail('target 应为 {"type":"session","sessionId"} 或 {"type":"new","projectPath"}');
  const effort = task.effort == null ? null : effortSchema.safeParse(task.effort).data;
  if (effort === undefined) return fail('effort 应为 low / medium / high / xhigh / max 或 null');
  if (task.model != null && (typeof task.model !== 'string' || !task.model.trim()))
    return fail('model 应为模型名或 null');
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
export function parseTasks(text: string): { tasks: Task[]; problems: string[]; broken?: string } {
  let list: unknown;
  try {
    list = text.trim() ? (JSON.parse(text) as { tasks?: unknown }).tasks : [];
  } catch (error) {
    return { tasks: [], problems: [], broken: `不是有效的 JSON：${(error as Error).message}` };
  }
  if (!Array.isArray(list)) return { tasks: [], problems: [], broken: '缺少 tasks 数组' };
  const tasks: Task[] = [];
  const problems: string[] = [];
  list.forEach((value, index) => {
    const name = (value as { name?: unknown } | null)?.name;
    const label = typeof name === 'string' && name ? `“${name}”` : `第 ${index + 1} 个任务`;
    try {
      const task = parseTask(value);
      if (tasks.some((other) => other.id === task.id)) throw new Error('id 与其他任务重复');
      tasks.push(task);
    } catch (error) {
      problems.push(`${label}：${(error as Error).message}`);
    }
  });
  return { tasks, problems };
}
export function formatTasks(tasks: Task[]) {
  return JSON.stringify({ 说明: guide, tasks }, null, 2) + '\n';
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
const weekdays = ['一', '二', '三', '四', '五', '六', '日'];
export function describeSchedule(schedule: Schedule) {
  if (schedule.type === 'once') return `一次 · ${stamp(new Date(schedule.at).getTime())}`;
  if (schedule.type === 'daily') return `每天 ${schedule.time}`;
  if (schedule.type === 'weekly')
    return `每周${schedule.days.map((day) => weekdays[day - 1]).join('、')} ${schedule.time}`;
  return schedule.minutes % 60 ? `每 ${schedule.minutes} 分钟` : `每 ${schedule.minutes / 60} 小时`;
}
export function stamp(time: number) {
  const date = new Date(time);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
// The message a due task sends: the user's prompt under a line saying where it came from.
export function taskMessage(task: Task, due: number) {
  return `[定时任务「${task.name}」· 计划时间 ${stamp(due)}]\n\n${task.prompt}`;
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
async function loadFile(): Promise<{ path: string; text: string }> {
  if (window.desktop) return window.desktop.loadSchedules(formatTasks([]));
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
) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [problems, setProblems] = useState<string[]>([]);
  const [path, setPath] = useState('');
  const [progress, setProgress] = useState<Progress>(readProgress);
  const current = useRef({ tasks, progress, send, report });
  current.current = { tasks, progress, send, report };
  const busy = useRef(false);

  const record = useCallback((update: (progress: Progress) => Progress) => {
    const next = update(current.current.progress);
    current.current.progress = next;
    localStorage.setItem(progressKey, JSON.stringify(next));
    setProgress(next);
  }, []);
  const accept = useCallback(
    (text: string) => {
      const parsed = parseTasks(text);
      setProblems(parsed.broken ? [`配置文件未采用：${parsed.broken}`] : parsed.problems);
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
  useEffect(() => {
    void loadFile().then((file) => {
      setPath(file.path);
      accept(file.text);
    });
    return window.desktop?.onSchedulesChanged(accept);
  }, [accept]);

  const settle = useCallback(
    (task: Task, status: Outcome['status'], text: string) => {
      if (status !== 'sent') current.current.report?.(task, { at: Date.now(), status, text });
      record((progress) => ({
        ...progress,
        [task.id]: {
          ...progress[task.id]!,
          base: Date.now(),
          last: { at: Date.now(), status, text },
        },
      }));
    },
    [record],
  );
  const attempt = useCallback(
    async (task: Task, due: number) => {
      try {
        if (!(await current.current.send(task, due))) return false;
        settle(task, 'sent', '已发送');
      } catch (error) {
        settle(task, 'failed', error instanceof Error ? error.message : '发送失败');
      }
      return true;
    },
    [settle],
  );
  useEffect(() => {
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
          if (Date.now() - due > grace) settle(task, 'missed', `错过了 ${stamp(due)} 的一次`);
          else await attempt(task, due);
        }
      } finally {
        busy.current = false;
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 15_000);
    return () => clearInterval(timer);
  }, [attempt, settle]);

  const save = useCallback(
    async (tasks: Task[]) => {
      const text = formatTasks(tasks);
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
      if (!(await attempt(task, Date.now())))
        settle(task, 'failed', '现在无法发送：未连接，或目标会话正在运行');
    },
  };
  return result;
}
