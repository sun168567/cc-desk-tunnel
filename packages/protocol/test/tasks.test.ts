import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TaskList, tasksOf } from '../src/index.ts';
import type { EventPayload } from '../src/index.ts';

const target = 'Linux' as const;
const call = (toolId: string, name: string, input: unknown): EventPayload => ({
  type: 'tool.requested',
  toolId,
  name,
  input: JSON.stringify(input),
  target,
});
const done = (
  toolId: string,
  output = '',
  status: 'completed' | 'failed' = 'completed',
): EventPayload => ({
  type: 'tool.result',
  toolId,
  status,
  output,
  exitCode: null,
});

test('the task list follows TaskCreate and TaskUpdate, by the IDs the CLI gave', () => {
  const list = new TaskList();
  assert.equal(list.apply(call('a', 'TaskCreate', { subject: '读代码', description: '' })), false);
  assert.equal(list.apply(done('a', 'Task #1 created successfully: 读代码')), true);
  list.apply(call('b', 'TaskCreate', { subject: '改代码', activeForm: '正在改代码' }));
  // The input may come after the call, complete.
  list.apply({
    type: 'tool.input',
    toolId: 'b',
    input: JSON.stringify({ subject: '修改代码', activeForm: '正在修改' }),
  });
  list.apply(done('b', 'Task #2 created successfully: 修改代码'));
  list.apply(call('c', 'TaskUpdate', { taskId: '1', status: 'completed' }));
  list.apply(done('c', 'Updated task #1 status'));
  list.apply(call('d', 'TaskUpdate', { taskId: '2', status: 'in_progress' }));
  list.apply(done('d'));
  assert.deepEqual(list.list, [
    { id: '1', content: '读代码', activeForm: undefined, status: 'completed' },
    { id: '2', content: '修改代码', activeForm: '正在修改', status: 'in_progress' },
  ]);
  // A call that failed changes nothing; a task deleted leaves the list; another tool is not followed.
  list.apply(call('e', 'TaskUpdate', { taskId: '2', status: 'completed' }));
  assert.equal(list.apply(done('e', 'error', 'failed')), false);
  list.apply(call('f', 'TaskUpdate', { taskId: '1', status: 'deleted' }));
  list.apply(done('f'));
  list.apply(call('g', 'Bash', { command: 'ls' }));
  assert.equal(list.apply(done('g', 'Task #9 created')), false);
  assert.deepEqual(
    list.list.map((task) => [task.id, task.status]),
    [['2', 'in_progress']],
  );
});

test('an output without the ID is counted in order; TodoWrite writes the whole list', () => {
  assert.deepEqual(
    tasksOf([
      call('a', 'TaskCreate', { subject: '甲' }),
      done('a', 'created'),
      call('b', 'TaskCreate', { subject: '乙' }),
      done('b'),
      call('c', 'TaskUpdate', { taskId: '2', status: 'completed' }),
      done('c'),
    ]).map((task) => [task.id, task.content, task.status]),
    [
      ['1', '甲', 'pending'],
      ['2', '乙', 'completed'],
    ],
  );
  assert.deepEqual(
    tasksOf([
      call('a', 'TodoWrite', {
        todos: [
          { content: '一', status: 'completed', activeForm: '做一' },
          { content: '二', status: 'in_progress', activeForm: '做二' },
          { content: '', status: 'pending', activeForm: '' },
        ],
      }),
      done('a'),
    ]),
    [
      { id: '1', content: '一', activeForm: '做一', status: 'completed' },
      { id: '2', content: '二', activeForm: '做二', status: 'in_progress' },
    ],
  );
});
