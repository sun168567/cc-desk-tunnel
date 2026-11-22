import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { join } from 'node:path';
import { test } from 'node:test';
import { createProxyServer } from '../../server/src/server.ts';
import { promptText, serveAcp } from '../src/acp.mjs';
import { EXIT, Follow, findSession } from '../src/agent.mjs';
import { Service } from '../src/connection.mjs';
import { printing } from '../src/main.mjs';
import {
  answer,
  approve,
  deny,
  logs,
  next,
  printTask,
  status,
  stop,
  tell,
  wait,
} from '../src/tasks.mjs';

// The commands for programs and agents against a service of the offline simulation: its scripted runs ask for a
// tool, ask questions and plan, as Claude does, without a model or a command on this computer.
const token = 'agent-test-' + randomUUID();
const here = process.platform === 'win32' ? 'D:\\工作\\agent' : '/work/agent';

async function fixture(t, stepMs = 2) {
  const directory = mkdtempSync(join(tmpdir(), 'ccdt-agent-test-'));
  const server = createProxyServer({ token, dataDir: directory, stepMs });
  const url = (await server.listen(0)).replace('http', 'ws') + '/ws';
  const deviceId = randomUUID();
  const services = [];
  t.after(async () => {
    for (const service of services) service.end(false);
    await server.close();
    rmSync(directory, { recursive: true, force: true });
  });
  // A connection of this computer as ccdt makes it, straight to the service: no execution channel is needed for a
  // simulated run.
  async function connect() {
    const service = new Service();
    service.tunnel = false;
    service.bridge = { url, close: async () => {} };
    await service.open(token, deviceId);
    services.push(service);
    return service;
  }
  // What the commands print, and the context main.mjs gives them.
  function run() {
    const out = [];
    const err = [];
    const context = {
      here,
      out: (text) => out.push(text),
      err: (text) => err.push(text),
      newest: (sessions) => sessions.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      mine: (session) => session.projectPath === here,
      carried: () => true,
      connect,
      keep: async (service) => service,
      release: (service) => service.close().catch(() => {}),
    };
    return { context, out, err, json: () => JSON.parse(out.at(-1)) };
  }
  // A message sent as the window sends it, with the simulation's scenario.
  async function send(sessionId, scenario, text = '开始') {
    const service = await connect();
    await service.request({ type: 'message.send', sessionId, text, scenario });
    return service;
  }
  return { connect, run, send };
}

test('ccdt -p starts a session of this directory, waits for the turn and prints the reply', async (t) => {
  const f = await fixture(t);
  const a = f.run();
  assert.equal(await printTask(a.context, { 'output-format': 'json' }, '看一下项目'), EXIT.done);
  const result = a.json();
  assert.equal(result.state, 'completed');
  assert.match(result.result, /离线模拟回复/);
  assert.equal(result.is_error, false);
  const service = await f.connect();
  const session = service.sessions.get(result.session_id);
  assert.equal(session.projectPath, here);
  assert.equal(session.title, '看一下项目');
  // -c continues it, text output being the reply alone; stream-json says what happens as it happens.
  const b = f.run();
  assert.equal(await printTask(b.context, { continue: true }, '接着做'), EXIT.done);
  assert.match(b.out.join('\n'), /离线模拟回复/);
  assert.equal(service.sessions.size, 1);
  const c = f.run();
  assert.equal(
    await printTask(
      c.context,
      { session: result.session_id.slice(0, 6), 'output-format': 'stream-json' },
      '再来',
    ),
    EXIT.done,
  );
  const lines = c.out.map((line) => JSON.parse(line));
  assert.ok(lines.some((line) => line.type === 'text' && line.text));
  assert.ok(lines.some((line) => line.type === 'status' && line.status === 'completed'));
  assert.equal(lines.at(-1).type, 'result');
  assert.equal(lines.at(-1).state, 'completed');
  // --bg returns at once with the session.
  const d = f.run();
  assert.equal(await printTask(d.context, { bg: true }, '后台做'), EXIT.done);
  assert.match(d.out[0], /^[0-9a-f-]{36}$/);
  assert.match(d.err.join('\n'), /ccdt wait/);
});

test('a tool approval stops the wait for the caller, who approves it and waits again', async (t) => {
  const f = await fixture(t);
  const a = f.run();
  await printTask(a.context, { 'output-format': 'json' }, '准备');
  const id = a.json().session_id;
  await f.send(id, 'tool');
  const waited = f.run();
  assert.equal(await wait(waited.context, { json: true }, id.slice(0, 8)), EXIT.needsYou);
  const stopped = waited.json();
  assert.equal(stopped.state, 'awaiting_approval');
  assert.deepEqual(
    { kind: stopped.approval.kind, tool: stopped.approval.tool, input: stopped.approval.input },
    { kind: 'tool', tool: 'PowerShell', input: 'Get-Location' },
  );
  // What to do next is said in words.
  assert.match(next(stopped), /批准：ccdt approve \S+；拒绝：ccdt deny/);
  const seen = f.run();
  assert.equal(await status(seen.context, { json: true }, id), EXIT.needsYou);
  assert.equal(seen.json().state, 'awaiting_approval');
  // Answering a question is refused for an approval.
  await assert.rejects(answer(f.run().context, {}, id, ['是']), /请求批准，不是提问/);
  assert.equal(await approve(f.run().context, {}, id), EXIT.done);
  const after = f.run();
  assert.equal(await wait(after.context, { 'output-format': 'json' }, id), EXIT.done);
  assert.equal(after.json().state, 'completed');
  assert.match(after.json().result, /模拟工具已完成/);
  // Nothing waits any more.
  await assert.rejects(approve(f.run().context, {}, id), /没有等待批准或回答的请求/);
});

test('questions are answered in order; a plan is sent back with what to change', async (t) => {
  const f = await fixture(t);
  const a = f.run();
  await printTask(a.context, { 'output-format': 'json' }, '准备');
  const id = a.json().session_id;
  await f.send(id, 'question');
  const asked = f.run();
  assert.equal(await wait(asked.context, { json: true }, id), EXIT.needsYou);
  const question = asked.json();
  assert.equal(question.state, 'awaiting_answer');
  assert.deepEqual(
    question.approval.questions.map((item) => [item.question, item.multiSelect]),
    [
      ['这次改动要包含哪些部分？', true],
      ['什么时候开始？', false],
    ],
  );
  assert.deepEqual(question.approval.questions[1].options, ['现在', '稍后']);
  await assert.rejects(answer(f.run().context, {}, id, ['界面']), /问了 2 个问题/);
  await assert.rejects(approve(f.run().context, {}, id), /在提问/);
  assert.equal(await answer(f.run().context, {}, id, ['界面, 文档', '现在']), EXIT.done);
  const answered = f.run();
  assert.equal(await wait(answered.context, { json: true }, id), EXIT.done);
  assert.match(answered.json().result, /收到回答：界面, 文档；现在/);

  await f.send(id, 'plan');
  const planned = f.run();
  assert.equal(await wait(planned.context, { json: true }, id), EXIT.needsYou);
  assert.equal(planned.json().approval.kind, 'plan');
  assert.match(planned.json().approval.plan, /计划：整理设置页/);
  assert.equal(await deny(f.run().context, {}, id, '先只改文档'), EXIT.done);
  const denied = f.run();
  assert.equal(await wait(denied.context, { json: true }, id), EXIT.done);
  assert.match(denied.json().result, /按你的意见继续规划/);
});

test('a turn is stopped, a wait gives up at its timeout, and logs tell what happened', async (t) => {
  const f = await fixture(t, 40);
  const a = f.run();
  await printTask(a.context, { 'output-format': 'json' }, '准备');
  const id = a.json().session_id;
  await f.send(id, 'chat');
  const timed = f.run();
  assert.equal(await wait(timed.context, { json: true, timeout: '0.2' }, id), EXIT.running);
  assert.equal(timed.json().state, 'running');
  assert.match(next(timed.json()), /ccdt tell/);
  assert.equal(await stop(f.run().context, {}, id), EXIT.done);
  const stopped = f.run();
  assert.equal(await wait(stopped.context, { json: true }, id), EXIT.cancelled);
  assert.equal(stopped.json().state, 'cancelled');
  // tell starts the next turn of a session at rest.
  const told = f.run();
  assert.equal(await tell(told.context, {}, id, '换个方向'), EXIT.done);
  assert.match(told.err[0], /已发出/);
  const done = f.run();
  assert.equal(await wait(done.context, { json: true }, id), EXIT.done);
  assert.match(done.json().result, /离线模拟回复/);
  const read = f.run();
  assert.equal(await logs(read.context, { json: true, last: '3' }, id), EXIT.done);
  const items = read.json();
  assert.equal(items.length, 3);
  // The simulation replies in two messages after it.
  assert.deepEqual(items[0], { type: 'user', text: '换个方向' });
  assert.equal(items.at(-1).type, 'assistant');
});

test('a session is named by the start of its ID, once that tells it apart', () => {
  const sessions = [{ id: 'abc12345-0000' }, { id: 'abd12345-0000' }];
  assert.equal(findSession(sessions, 'ABC').id, 'abc12345-0000');
  assert.throws(() => findSession(sessions, 'ab'), /有 2 个会话以 ab 开头/);
  assert.throws(() => findSession(sessions, 'zz'), /没有会话 zz/);
  assert.throws(() => findSession(sessions, ''), /要写会话 ID/);
});

test('what is followed begins at the message sent, and ends where the run stops for someone', () => {
  const event = (sequence, payload) => ({ sessionId: 's', runId: 'r', sequence, payload });
  const followed = new Follow('s', 'mine');
  followed.apply(event(1, { type: 'message.user', messageId: 'earlier', text: '' }));
  followed.apply(event(2, { type: 'text.delta', messageId: 'm0', text: '旧的回复' }));
  assert.equal(followed.stopped({}), undefined);
  followed.apply(event(3, { type: 'message.user', messageId: 'mine', text: '' }));
  followed.apply(event(4, { type: 'run.status', status: 'running', connectionId: 'c' }));
  followed.apply(event(5, { type: 'text.delta', messageId: 'm1', text: '先看看。' }));
  followed.apply(event(6, { type: 'text.delta', messageId: 'm2', text: '后台任务在跑。' }));
  // A repeated event changes nothing.
  assert.equal(followed.apply(event(6, { type: 'text.delta', messageId: 'm2', text: 'x' })), false);
  assert.equal(followed.stopped({}), undefined);
  followed.apply(
    event(7, { type: 'run.status', status: 'running', connectionId: 'c', waiting: 'background' }),
  );
  assert.deepEqual(followed.stopped({}), { state: 'background' });
  assert.equal(followed.reply(), '后台任务在跑。');
  // The run gone with its end not read is a run that ended.
  followed.apply(event(8, { type: 'run.status', status: 'running', connectionId: 'c' }));
  assert.deepEqual(followed.stopped(null), { state: 'completed' });
});

// An ACP client of ccdt acp over a pair of pipes: what it is sent, and its answers to requests for permission.
function acpClient(f, choose) {
  const input = new PassThrough();
  const output = new PassThrough();
  const { context } = f.run();
  const messages = [];
  const waiting = new Map();
  let next = 1;
  const lines = createInterface({ input: output });
  lines.on('line', (line) => {
    const message = JSON.parse(line);
    messages.push(message);
    if (message.method === 'session/request_permission')
      input.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { outcome: choose(message.params) } })}\n`,
      );
    else if (message.id !== undefined && waiting.has(message.id)) {
      waiting.get(message.id)(message);
      waiting.delete(message.id);
    }
  });
  const served = serveAcp({ ...context, version: '0.0.0-test' }, { input, output });
  return {
    messages,
    served,
    request: (method, params) =>
      new Promise((resolve) => {
        const id = next++;
        waiting.set(id, resolve);
        input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      }),
    notify: (method, params) =>
      input.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`),
    updates: (sessionId) =>
      messages
        .filter(
          (message) =>
            message.method === 'session/update' && message.params.sessionId === sessionId,
        )
        .map((message) => message.params.update),
    end: () => input.end(),
  };
}

test('ccdt acp: a session of this directory, its reply streamed, and a tool put to the client and allowed', async (t) => {
  const f = await fixture(t);
  const asked = [];
  const client = acpClient(f, (params) => {
    asked.push(params);
    return params.options.some((option) => option.optionId === 'allow')
      ? { outcome: 'selected', optionId: 'allow' }
      : { outcome: 'selected', optionId: 'reject' };
  });
  const init = await client.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  assert.equal(init.result.protocolVersion, 1);
  assert.equal(init.result.agentCapabilities.loadSession, true);
  const created = await client.request('session/new', { cwd: here, mcpServers: [] });
  const sessionId = created.result.sessionId;
  assert.equal(created.result.modes.currentModeId, 'auto');
  const replied = await client.request('session/prompt', {
    sessionId,
    prompt: [
      { type: 'text', text: '看一下' },
      { type: 'resource_link', uri: 'file:///a.txt', name: 'a.txt' },
    ],
  });
  assert.equal(replied.result.stopReason, 'end_turn');
  const said = client
    .updates(sessionId)
    .filter((update) => update.sessionUpdate === 'agent_message_chunk')
    .map((update) => update.content.text)
    .join('');
  assert.match(said, /已收到：看一下\n@file:\/\/\/a\.txt/);
  assert.match(said, /离线模拟回复/);

  // A tool the window's message asks for is put to the client, which allows it.
  const service = await f.send(sessionId, 'tool');
  const done = await new Promise((resolve) => {
    const check = () => {
      const run = service.sessions.get(sessionId)?.activeRun;
      if (asked.length && run === null) resolve();
      else setTimeout(check, 20);
    };
    check();
  });
  void done;
  assert.equal(asked[0].toolCall.title, 'PowerShell');
  assert.equal(asked[0].toolCall.kind, 'execute');
  const updates = client.updates(sessionId);
  assert.ok(
    updates.some((update) => update.sessionUpdate === 'tool_call' && update.status === 'pending'),
  );
  assert.ok(
    updates.some(
      (update) => update.sessionUpdate === 'tool_call_update' && update.status === 'completed',
    ),
  );

  // set_mode configures the session.
  assert.deepEqual(
    (await client.request('session/set_mode', { sessionId, modeId: 'acceptEdits' })).result,
    {},
  );
  assert.equal((await f.connect()).sessions.get(sessionId).permissionMode, 'acceptEdits');
  // Unknown methods are refused.
  assert.equal((await client.request('session/fly', {})).error.code, -32601);
  client.end();
  assert.equal(await client.served, 0);
});

test('ccdt acp: a loaded session replays the newest page of its history', async (t) => {
  const f = await fixture(t);
  const client = acpClient(f, () => ({ outcome: 'cancelled' }));
  await client.request('initialize', { protocolVersion: 1 });
  const { result } = await client.request('session/new', { cwd: here, mcpServers: [] });
  const sessionId = result.sessionId;
  // The window sends a message that has Claude ask a question; once it waits, another client loads the session.
  const service = await f.send(sessionId, 'question');
  while (service.sessions.get(sessionId)?.activeRun?.status !== 'awaiting_approval')
    await new Promise((resolve) => setTimeout(resolve, 10));
  const loader = acpClient(f, () => ({ outcome: 'cancelled' }));
  await loader.request('initialize', { protocolVersion: 1 });
  const loaded = await loader.request('session/load', { sessionId, cwd: here, mcpServers: [] });
  assert.equal(loaded.result.modes.currentModeId, 'auto');
  const replayed = loader.updates(sessionId);
  assert.ok(
    replayed.some(
      (update) => update.sessionUpdate === 'user_message_chunk' && update.content.text === '开始',
    ),
  );
  assert.ok(replayed.some((update) => update.sessionUpdate === 'agent_message_chunk'));
  assert.ok(
    replayed.some(
      (update) => update.sessionUpdate === 'tool_call' && update.title === 'AskUserQuestion',
    ),
  );
  assert.equal(
    (await loader.request('session/load', { sessionId: 'nope', cwd: here })).error.message,
    '没有会话 nope：ccdt sessions --all --json 列出全部会话。',
  );
  client.end();
  loader.end();
  await Promise.all([client.served, loader.served]);
});

test('a prompt is the text of its blocks: files referred to by address, embedded ones with their text', () => {
  assert.equal(
    promptText([
      { type: 'text', text: '看看' },
      { type: 'resource_link', uri: 'file:///a.ts', name: 'a.ts' },
      { type: 'resource', resource: { uri: 'file:///b.ts', text: 'x = 1' } },
      { type: 'image', data: '', mimeType: 'image/png' },
    ]),
    '看看\n@file:///a.ts\n@file:///b.ts\n```\nx = 1\n```',
  );
});

test('with -p, -r takes the session it continues, as claude -p’s does; alone it still opens the list', () => {
  assert.deepEqual(printing(['-p', '-r', 'abc', '继续']), ['-p', '--session', 'abc', '继续']);
  assert.deepEqual(printing(['--resume', 'abc', '--print', 'x']), [
    '--session',
    'abc',
    '--print',
    'x',
  ]);
  assert.deepEqual(printing(['-r']), ['-r']);
  assert.deepEqual(printing(['-r', '--all']), ['-r', '--all']);
});
