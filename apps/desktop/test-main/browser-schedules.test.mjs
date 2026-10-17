import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  registerScheduleRequests,
  saveDesktopScheduleChanges,
  scheduleDescription,
  scheduleNextLabel,
  scheduleStamp,
} from '../src/browser-schedules.ts';
import { describeSchedule, stamp } from '../src/schedules.ts';
import { formatTasks, parseTasks } from '../src/schedules.ts';

function fixture() {
  let enabled;
  let request;
  let registrations = 0;
  const task = {
    id: 'task',
    name: 'Task',
    enabled: true,
    prompt: 'Work',
    schedule: { type: 'interval', minutes: 5 },
    target: { type: 'new', projectPath: '/project' },
    model: null,
    effort: null,
  };
  const runs = [];
  const writes = [];
  let version = 0;
  let file = formatTasks([task]);
  let acceptImmediately = true;
  const schedules = {
    tasks: [task],
    problems: [],
    path: '/schedules.json',
    remote: false,
    next: () => 12345,
    last: () => undefined,
    save: async () => {},
    runNow: async (value) => runs.push(value),
  };
  const dispose = registerScheduleRequests(
    {
      readRemoteSchedules: async () => ({
        path: '/schedules.json',
        text: file,
        revision: String(version),
      }),
      saveRemoteSchedules: async (text, revision) => {
        if (revision !== String(version)) throw new Error('定时任务已在其他页面或文件中更改。');
        file = text;
        version++;
        const tasks = parseTasks(text).tasks;
        writes.push(tasks);
        if (acceptImmediately) schedules.tasks = tasks;
      },
      onRemoteEnabledChanged(callback) {
        enabled = callback;
        callback(false);
        return () => {
          enabled = undefined;
        };
      },
      onRemoteRequest(methods, callback) {
        assert.deepEqual(methods, ['schedules:state', 'schedules:save', 'schedules:run-now']);
        registrations++;
        request = callback;
        return () => {
          request = undefined;
        };
      },
    },
    () => schedules,
  );
  return {
    task,
    schedules,
    runs,
    writes,
    updateFile: (text) => {
      file = text;
      version++;
    },
    delayRender: () => {
      acceptImmediately = false;
    },
    dispose,
    enable: (value) => enabled(value),
    request: (method, ...args) => request({ id: 'request', method, args }),
    listening: () => !!request,
    registrations: () => registrations,
  };
}

test('the schedule adapter registers no request handler until Web is enabled', () => {
  const host = fixture();
  assert.equal(host.registrations(), 0);
  assert.equal(host.listening(), false);
  host.enable(true);
  assert.equal(host.listening(), true);
  assert.equal(host.registrations(), 1);
  host.enable(false);
  assert.equal(host.listening(), false);
  host.enable(true);
  host.dispose();
  assert.equal(host.listening(), false);
  assert.deepEqual(host.runs, []);
});

test('a browser snapshot reads the current desktop scheduler without running it', async () => {
  const host = fixture();
  host.enable(true);
  const first = await host.request('schedules:state');
  assert.deepEqual(first.tasks, [host.task]);
  assert.deepEqual(first.timing, { task: { next: 12345, last: undefined } });
  assert.equal(first.timeZone, Intl.DateTimeFormat().resolvedOptions().timeZone);
  const last = { at: 23456, status: 'sent', text: '已发送' };
  host.schedules.next = () => 34567;
  host.schedules.last = () => last;
  const second = await host.request('schedules:state');
  assert.deepEqual(second.timing, { task: { next: 34567, last } });
  assert.deepEqual(host.runs, []);
  host.dispose();
});

test('browser manual execution uses the desktop task and its original runNow', async () => {
  const host = fixture();
  host.enable(true);
  assert.equal(await host.request('schedules:run-now', 'task'), null);
  assert.equal(host.runs.length, 1);
  assert.equal(host.runs[0], host.task);
  await assert.rejects(host.request('schedules:run-now', { ...host.task }), /任务已不存在/);
  await assert.rejects(host.request('schedules:run-now', 'deleted'), /任务已不存在/);
  await assert.rejects(host.request('schedules:state:publish', {}), /未知/);
  assert.equal(host.runs.length, 1);
  host.dispose();
});

test('a failed desktop manual execution is returned to the requesting browser', async () => {
  const host = fixture();
  host.enable(true);
  host.schedules.runNow = async () => {
    throw new Error('Desktop is closing');
  };
  await assert.rejects(host.request('schedules:run-now', 'task'), /Desktop is closing/);
  host.dispose();
});

test('browser edits conditionally save the file and reject broken or invalid task files', async () => {
  const host = fixture();
  host.enable(true);
  const task = { ...host.task, name: 'Updated', schedule: { type: 'interval', minutes: 10 } };
  const { revision } = await host.request('schedules:state');
  assert.equal(
    await host.request('schedules:save', JSON.stringify({ tasks: [task] }), revision),
    null,
  );
  assert.deepEqual(host.writes, [[task]]);
  assert.deepEqual((await host.request('schedules:state')).tasks, [task]);
  await assert.rejects(host.request('schedules:save', '{'), /JSON/);
  await assert.rejects(host.request('schedules:save', JSON.stringify({ tasks: [{}] })));
  await assert.rejects(host.request('schedules:save', { tasks: [] }), /文本/);
  assert.equal(host.writes.length, 1);
  host.dispose();
});

test('a stale browser cannot restore a deleted task, even before the desktop renderer catches up', async () => {
  const host = fixture();
  host.enable(true);
  host.delayRender();
  const { revision } = await host.request('schedules:state');
  const first = host.request('schedules:save', formatTasks([]), revision);
  const second = host.request(
    'schedules:save',
    formatTasks([{ ...host.task, name: 'Stale edit' }]),
    revision,
  );
  await first;
  await assert.rejects(second, /更改/);
  assert.deepEqual((await host.request('schedules:state')).tasks, []);
  assert.deepEqual(host.writes, [[]]);
  assert.deepEqual(host.schedules.tasks, [host.task]);
  host.dispose();
});

test('file changes are authoritative and never combine a new rule with stale desktop timing', async () => {
  const host = fixture();
  host.enable(true);
  const before = await host.request('schedules:state');
  const task = { ...host.task, schedule: { type: 'interval', minutes: 10 } };
  host.updateFile(formatTasks([task]));
  const snapshot = await host.request('schedules:state');
  assert.deepEqual(snapshot.tasks, [task]);
  assert.notEqual(snapshot.revision, before.revision);
  assert.deepEqual(snapshot.timing, {});
  await assert.rejects(host.request('schedules:run-now', task.id), /尚未就绪/);
  await assert.rejects(
    host.request('schedules:save', formatTasks([host.task]), before.revision),
    /更改/,
  );
  assert.deepEqual(host.writes, []);
  host.dispose();
});

test('invalid task files expose their errors without a writable snapshot revision', async () => {
  const host = fixture();
  host.enable(true);
  for (const text of ['{', JSON.stringify({ tasks: [{ id: 'invalid' }] })]) {
    host.updateFile(text);
    const snapshot = await host.request('schedules:state');
    assert.equal(snapshot.revision, null);
    assert.ok(snapshot.problems.length);
    assert.deepEqual(snapshot.timing, {});
    await assert.rejects(
      host.request('schedules:save', formatTasks([]), snapshot.revision),
      /最新/,
    );
  }
  assert.deepEqual(host.writes, []);
  host.dispose();
});

test('desktop edits keep the original save when Web is off and never upgrade or downgrade a shared draft', async () => {
  const ordinary = [];
  const conditional = [];
  const save = async (tasks) => ordinary.push(tasks);
  const compare = async (text, revision) =>
    conditional.push({ tasks: parseTasks(text).tasks, revision });
  await saveDesktopScheduleChanges(save, compare, false, []);
  assert.deepEqual(ordinary, [[]]);
  await assert.rejects(
    saveDesktopScheduleChanges(save, compare, true, [], undefined),
    /版本尚未就绪/,
  );
  await assert.rejects(saveDesktopScheduleChanges(save, compare, true, [], null), /版本尚未就绪/);
  await saveDesktopScheduleChanges(save, compare, true, [], 'original-revision');
  assert.deepEqual(conditional, [{ tasks: [], revision: 'original-revision' }]);
  await assert.rejects(
    saveDesktopScheduleChanges(save, compare, false, [], 'original-revision'),
    /共享编辑已结束/,
  );
  await assert.rejects(
    saveDesktopScheduleChanges(save, compare, false, [], null),
    /共享编辑已结束/,
  );
  assert.deepEqual(ordinary, [[]]);
});

test('desktop drafts cannot cross a sharing lifecycle but new disabled drafts keep the original save', async () => {
  const ordinary = [];
  const conditional = [];
  const save = async (tasks) => ordinary.push(tasks);
  const compare = async (text, revision) => conditional.push({ text, revision });
  await assert.rejects(
    saveDesktopScheduleChanges(save, compare, false, [], undefined, 0, 2),
    /共享状态已更改.*草稿已保留/,
  );
  await assert.rejects(
    saveDesktopScheduleChanges(save, compare, true, [], 'old-shared-revision', 1, 3),
    /共享状态已更改.*草稿已保留/,
  );
  assert.deepEqual(ordinary, []);
  assert.deepEqual(conditional, []);
  await saveDesktopScheduleChanges(save, compare, false, [], undefined, 2, 2);
  assert.deepEqual(ordinary, [[]]);
  await saveDesktopScheduleChanges(save, compare, true, [], 'current-revision', 3, 3);
  assert.equal(conditional[0].revision, 'current-revision');
});

test('browser schedule timestamps use the desktop timezone without changing desktop formatting', () => {
  const time = Date.UTC(2030, 0, 1, 0, 30);
  assert.equal(scheduleStamp(time, 'Asia/Tokyo'), '2030-01-01 09:30');
  assert.equal(scheduleStamp(time, 'America/New_York'), '2029-12-31 19:30');
  assert.equal(scheduleStamp(time), stamp(time));
  const local = { type: 'once', at: '2030-01-01T09:00' };
  assert.equal(scheduleDescription(local, 'America/New_York', true), '一次 · 2030-01-01 09:00');
  assert.equal(scheduleDescription(local), describeSchedule(local));
  const offset = { type: 'once', at: '2030-01-01T00:30:00Z' };
  assert.equal(scheduleDescription(offset, 'Asia/Tokyo', true), '一次 · 2030-01-01 09:30');
  assert.equal(scheduleDescription(offset, undefined, true), '一次 · 2030-01-01T00:30:00Z');
});

test('browser timing stays unknown until the desktop returns a snapshot', () => {
  assert.equal(scheduleNextLabel({ enabled: true }, undefined), '等待桌面客户端的调度状态');
  assert.equal(scheduleNextLabel({ enabled: false }, undefined), '已停用');
  assert.equal(scheduleNextLabel({ enabled: true }, null), '不会再运行');
});
