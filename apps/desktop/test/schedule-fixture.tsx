import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import SchedulePanel from '../src/SchedulePanel.tsx';
import { useRemoteScheduleRequests, useWorkbenchSchedules } from '../src/browser-schedules.ts';
import type { RemoteScheduleRequest, ScheduleSnapshot } from '../src/browser-schedules.ts';
import { formatTasks, parseTasks } from '../src/schedules.ts';
import type { Task } from '../src/schedules.ts';

export function mount(remote: boolean) {
  const task: Task = {
    id: 'example',
    name: '示例任务',
    enabled: true,
    prompt: '检查项目',
    schedule: { type: 'interval', minutes: 5 },
    target: { type: 'new', projectPath: '/project' },
    model: null,
    effort: null,
  };
  let text = formatTasks([task]);
  let revision = 0;
  let changed: ((text: string) => void) | undefined;
  const enabledChanged = new Set<(enabled: boolean) => void>();
  let handle: ((request: RemoteScheduleRequest) => unknown | Promise<unknown>) | undefined;
  const fixture = {
    snapshot: {
      tasks: [task],
      revision: '0',
      problems: [],
      path: '/schedules.json',
      timeZone: 'Asia/Singapore',
      timing: { example: { next: Date.now() + 300_000 } },
    } as ScheduleSnapshot | null,
    reads: 0,
    sends: [] as Task[],
    runNow: [] as string[],
    saves: [] as { text: string; revision: string }[],
    revision: undefined as string | null | undefined,
    editGeneration: undefined as number | undefined,
    intervals: [] as number[],
    showPanel: (_show: boolean) => {},
    enable: (enabled: boolean) => enabledChanged.forEach((callback) => callback(enabled)),
    request: (method: string, ...args: unknown[]) => {
      if (!handle) throw new Error('Web is disabled');
      return handle({ id: 'fixture-request', method, args });
    },
    refresh: async () => {},
  };
  const interval = window.setInterval.bind(window);
  window.setInterval = ((...args: Parameters<typeof window.setInterval>) => {
    fixture.intervals.push(args[1] ?? 0);
    return interval(...args);
  }) as typeof window.setInterval;
  const host = {
    remote,
    loadSchedules: async () => ({ path: '/schedules.json', text }),
    saveSchedules: async (value: string) => {
      text = value;
      revision++;
      if (fixture.snapshot) fixture.snapshot.tasks = parseTasks(text).tasks;
    },
    readRemoteSchedules: async () => ({
      path: '/schedules.json',
      text,
      revision: String(revision),
    }),
    saveRemoteSchedules: async (value: string, expected: string) => {
      fixture.saves.push({ text: value, revision: expected });
      if (expected !== (remote ? fixture.snapshot?.revision : String(revision)))
        throw new Error(
          '定时任务已在其他页面或文件中更改。草稿已保留，请核对最新任务后重新打开编辑。',
        );
      text = value;
      revision++;
      if (fixture.snapshot) {
        fixture.snapshot.tasks = parseTasks(text).tasks;
        fixture.snapshot.revision = String(revision);
      }
      changed?.(text);
    },
    onSchedulesChanged: (callback: (text: string) => void) => {
      changed = callback;
      return () => {
        changed = undefined;
      };
    },
    scheduleState: async () => {
      fixture.reads++;
      return structuredClone(fixture.snapshot);
    },
    runScheduleNow: async (id: string) => {
      fixture.runNow.push(id);
    },
    onRemoteEnabledChanged: (callback: (enabled: boolean) => void) => {
      enabledChanged.add(callback);
      callback(false);
      return () => {
        enabledChanged.delete(callback);
      };
    },
    onRemoteRequest: (_methods: string[], callback: typeof handle) => {
      handle = callback;
      return () => {
        handle = undefined;
      };
    },
  };
  window.desktop = host as unknown as NonNullable<Window['desktop']>;
  function Fixture() {
    const [show, setShow] = useState(true);
    const schedules = useWorkbenchSchedules(async (value) => {
      fixture.sends.push(value);
      return true;
    });
    useRemoteScheduleRequests(schedules);
    fixture.showPanel = setShow;
    fixture.refresh = schedules.refresh ?? (async () => {});
    fixture.revision = schedules.revision;
    fixture.editGeneration = schedules.editGeneration;
    return show ? (
      <SchedulePanel schedules={schedules} sessions={[]} projects={[]} capabilities={null} />
    ) : (
      <div>其他页面</div>
    );
  }
  const root = createRoot(document.getElementById('root')!);
  root.render(<Fixture />);
  window.scheduleFixture = fixture;
}

declare global {
  interface Window {
    scheduleFixture: {
      snapshot: ScheduleSnapshot | null;
      reads: number;
      sends: Task[];
      runNow: string[];
      saves: { text: string; revision: string }[];
      revision: string | null | undefined;
      editGeneration?: number;
      intervals: number[];
      showPanel: (show: boolean) => void;
      enable: (enabled: boolean) => void;
      request: (method: string, ...args: unknown[]) => unknown | Promise<unknown>;
      refresh: () => Promise<void>;
    };
  }
}
