import { useCallback, useEffect, useRef, useState } from 'react';
import { describeSchedule, formatTasks, parseTasks, stamp, useSchedules } from './schedules.ts';
import type { Outcome, Schedule, Schedules, Task } from './schedules.ts';

export type ScheduleSnapshot = {
  tasks: Task[];
  revision: string | null;
  problems: string[];
  path: string;
  timeZone: string;
  timing: Record<string, { next: number | null; last?: Outcome }>;
};
export type WorkbenchSchedules = Omit<Schedules, 'next' | 'save'> & {
  remote: boolean;
  revision?: string | null;
  editGeneration?: number;
  timeZone?: string;
  next: (task: Task) => number | null | undefined;
  refresh?: () => Promise<void>;
  save: (tasks: Task[], revision?: string | null, editGeneration?: number) => Promise<void>;
};
export type RemoteScheduleRequest = { id: string; method: string; args: unknown[] };
export type ScheduleRequests = {
  readRemoteSchedules: () => Promise<{ path: string; text: string; revision: string }>;
  saveRemoteSchedules: (text: string, revision: string) => Promise<void>;
  onRemoteEnabledChanged?: (callback: (enabled: boolean) => void) => () => void;
  onRemoteRequest?: (
    methods: string[],
    callback: (request: RemoteScheduleRequest) => unknown | Promise<unknown>,
  ) => () => void;
};

// The desktop owns both the clock and run progress. Read its existing scheduler only when a browser asks.
export function registerScheduleRequests(
  host: ScheduleRequests,
  current: () => WorkbenchSchedules,
) {
  let unsubscribe: (() => void) | undefined;
  let writing: Promise<unknown> = Promise.resolve();
  const read = async () => {
    const file = await host.readRemoteSchedules();
    const parsed = parseTasks(file.text);
    const schedules = current();
    const valid = !parsed.broken && !parsed.problems.length;
    // The file is authoritative for edits. Until the original hook accepts it, its old progress must
    // not be paired with a new rule, even when that task still has the same ID.
    const ready = valid && JSON.stringify(parsed.tasks) === JSON.stringify(schedules.tasks);
    const tasks = parsed.broken ? schedules.tasks : parsed.tasks;
    return {
      tasks,
      revision: valid ? file.revision : null,
      problems: parsed.broken ? [parsed.broken] : parsed.problems,
      path: file.path,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      timing: ready
        ? Object.fromEntries(
            tasks.map((task) => [
              task.id,
              { next: schedules.next(task) ?? null, last: schedules.last(task) },
            ]),
          )
        : {},
    } satisfies ScheduleSnapshot;
  };
  const stop = host.onRemoteEnabledChanged?.((enabled) => {
    unsubscribe?.();
    unsubscribe = undefined;
    if (!enabled) return;
    unsubscribe = host.onRemoteRequest?.(
      ['schedules:state', 'schedules:save', 'schedules:run-now'],
      async ({ method, args }) => {
        if (method === 'schedules:state') return read();
        if (method === 'schedules:save') {
          if (typeof args[0] !== 'string') throw new Error('定时任务配置应为 JSON 文本。');
          const parsed = parseTasks(args[0]);
          if (parsed.broken || parsed.problems.length)
            throw new Error(parsed.broken ?? parsed.problems.join('\n'));
          if (typeof args[1] !== 'string') throw new Error('请先读取最新的定时任务配置。');
          const revision = args[1];
          const operation = writing.then(() =>
            host.saveRemoteSchedules(formatTasks(parsed.tasks), revision),
          );
          writing = operation.catch(() => {});
          await operation;
          return null;
        }
        if (method === 'schedules:run-now') {
          const snapshot = await read();
          if (!snapshot.tasks.some((task) => task.id === args[0]))
            throw new Error('定时任务已不存在，请刷新任务列表。');
          if (!snapshot.revision || !snapshot.timing[String(args[0])])
            throw new Error('定时任务已更改或尚未就绪，请等待桌面客户端更新后重试。');
          const schedules = current();
          const task = schedules.tasks.find((task) => task.id === args[0]);
          if (!task) throw new Error('定时任务已不存在，请刷新任务列表。');
          await schedules.runNow(task);
          return null;
        }
        throw new Error('未知的定时任务操作。');
      },
    );
  });
  return () => {
    stop?.();
    unsubscribe?.();
  };
}

export function useRemoteScheduleRequests(schedules: WorkbenchSchedules) {
  const current = useRef(schedules);
  current.current = schedules;
  useEffect(() => {
    if (window.desktop?.remote || !window.desktop) return;
    const host = window.desktop;
    if (!host.readRemoteSchedules || !host.saveRemoteSchedules) return;
    return registerScheduleRequests(
      {
        ...host,
        readRemoteSchedules: host.readRemoteSchedules,
        saveRemoteSchedules: host.saveRemoteSchedules,
      },
      () => current.current,
    );
  }, []);
}

function useBrowserSchedules(): WorkbenchSchedules {
  const [snapshot, setSnapshot] = useState<ScheduleSnapshot | null>(null);
  const [available, setAvailable] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const active = useRef(false);
  const reading = useRef<Promise<void> | null>(null);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const refresh = useCallback(() => {
    if (reading.current) return reading.current;
    reading.current = (async () => {
      try {
        const next = await window.desktop!.scheduleState!();
        if (!active.current) return;
        if (next) setSnapshot(next);
        setAvailable(!!next);
        setFailure(null);
      } catch (error) {
        if (!active.current) return;
        setAvailable(false);
        setFailure(error instanceof Error ? error.message : '桌面客户端的调度状态读取失败。');
      } finally {
        reading.current = null;
      }
    })();
    return reading.current;
  }, []);
  return {
    tasks: snapshot?.tasks ?? [],
    revision: available ? snapshot?.revision : null,
    problems: [...(snapshot?.problems ?? []), ...(failure ? [failure] : [])],
    path: snapshot?.path ?? '',
    remote: true,
    timeZone: available ? snapshot?.timeZone : undefined,
    next: (task) =>
      task.enabled ? (available ? snapshot?.timing[task.id]?.next : undefined) : null,
    last: (task) => (available ? snapshot?.timing[task.id]?.last : undefined),
    refresh,
    save: async (tasks, revision) => {
      if (!available) throw new Error('请先读取有效的定时任务配置。');
      if (!revision) throw new Error('编辑时任务版本尚未就绪。草稿已保留，请重新打开编辑。');
      try {
        await window.desktop!.saveRemoteSchedules!(formatTasks(tasks), revision);
      } finally {
        // A read started before the write is not its resulting snapshot. Wait it out, then read again,
        // including on conflicts so the list is current while the editor keeps its unsaved draft.
        await reading.current;
        await refresh();
      }
    },
    runNow: async (task) => {
      await window.desktop!.runScheduleNow!(task.id);
      await refresh();
    },
  };
}

// The automatic scheduler is unchanged. Only editing an actively shared list needs compare-and-save;
// a draft begun before sharing (or while its version was unavailable) must not acquire a newer version.
export async function saveDesktopScheduleChanges(
  save: Schedules['save'],
  conditionalSave: ScheduleRequests['saveRemoteSchedules'] | undefined,
  shared: boolean,
  tasks: Task[],
  revision?: string | null,
  editGeneration = 0,
  currentGeneration = 0,
) {
  if (editGeneration !== currentGeneration)
    throw new Error('共享状态已更改。草稿已保留，请核对最新任务后重新打开编辑。');
  if (!shared) {
    if (revision !== undefined)
      throw new Error('共享编辑已结束。草稿已保留，请核对最新任务后重新打开编辑。');
    return save(tasks);
  }
  if (typeof revision !== 'string' || !conditionalSave)
    throw new Error('编辑时任务版本尚未就绪。草稿已保留，请重新打开编辑。');
  return conditionalSave(formatTasks(tasks), revision);
}

function useDesktopSchedules(
  send: (task: Task, due: number) => Promise<boolean>,
  report?: (task: Task, outcome: Outcome) => void,
): WorkbenchSchedules {
  const schedules = useSchedules(send, report);
  const [sharing, setSharing] = useState({ enabled: false, generation: 0 });
  const sharingNow = useRef(sharing);
  const [version, setVersion] = useState<{
    tasks: Task[];
    revision: string | null;
    generation: number;
  } | null>(null);
  useEffect(
    () =>
      window.desktop?.onRemoteEnabledChanged?.((enabled) => {
        if (sharingNow.current.enabled === enabled) return;
        // Count transitions at receipt, not in an effect: React may batch a complete on/off cycle.
        sharingNow.current = { enabled, generation: sharingNow.current.generation + 1 };
        setSharing(sharingNow.current);
      }),
    [],
  );
  useEffect(() => {
    if (!sharing.enabled || !window.desktop?.readRemoteSchedules) return;
    let active = true;
    const tasks = schedules.tasks;
    void window.desktop.readRemoteSchedules().then(
      (file) => {
        if (!active) return;
        const parsed = parseTasks(file.text);
        const matches =
          !parsed.broken &&
          !parsed.problems.length &&
          JSON.stringify(parsed.tasks) === JSON.stringify(tasks);
        setVersion({
          tasks,
          revision: matches ? file.revision : null,
          generation: sharing.generation,
        });
      },
      () => {
        if (active) setVersion({ tasks, revision: null, generation: sharing.generation });
      },
    );
    return () => {
      active = false;
    };
  }, [sharing, schedules.tasks, schedules.problems]);
  return {
    ...schedules,
    remote: false,
    revision: sharing.enabled
      ? version?.tasks === schedules.tasks && version.generation === sharing.generation
        ? version.revision
        : null
      : undefined,
    editGeneration: sharing.generation,
    save: (tasks, revision, editGeneration) =>
      saveDesktopScheduleChanges(
        schedules.save,
        window.desktop?.saveRemoteSchedules,
        sharingNow.current.enabled,
        tasks,
        revision,
        editGeneration,
        sharingNow.current.generation,
      ),
  };
}

export function useWorkbenchSchedules(
  send: (task: Task, due: number) => Promise<boolean>,
  report?: (task: Task, outcome: Outcome) => void,
): WorkbenchSchedules {
  // The host is selected before App mounts and stays fixed for this renderer's lifetime.
  // A browser never mounts the desktop hook, so it has no automatic timer or progress writer.
  if (window.desktop?.remote) return useBrowserSchedules();
  return useDesktopSchedules(send, report);
}

export function scheduleStamp(time: number, timeZone?: string) {
  if (!timeZone) return stamp(time);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(time)
      .map(({ type, value }) => [type, value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}
export function scheduleDescription(schedule: Schedule, timeZone?: string, remote = false) {
  if (!remote || schedule.type !== 'once') return describeSchedule(schedule);
  // An offset-free rule names the desktop's wall clock, not the browser's timezone.
  const local = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(schedule.at);
  return `一次 · ${local ? schedule.at.slice(0, 16).replace('T', ' ') : timeZone ? scheduleStamp(new Date(schedule.at).getTime(), timeZone) : schedule.at}`;
}
export function scheduleNextLabel(task: Task, next: number | null | undefined, timeZone?: string) {
  if (!task.enabled) return '已停用';
  if (next === undefined) return '等待桌面客户端的调度状态';
  return next === null ? '不会再运行' : `下次 ${scheduleStamp(next, timeZone)}`;
}
