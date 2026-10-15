import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { CodexParentMessage, CodexWorkerMessage } from '@cc-desk-tunnel/agent-ipc';

const worker = fileURLToPath(new URL('../src/worker.ts', import.meta.url));
const executable = fileURLToPath(new URL('./fixtures/app-server.mjs', import.meta.url));

test('Codex control plane logs in, streams, declines, and interrupts without a project path', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'cc-desk-codex-'));
  const child = fork(worker, [], {
    execArgv: [],
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    env: { ...process.env, CLAUDE_CONFIG_DIR: 'hidden', ANTHROPIC_API_KEY: 'hidden' },
  });
  t.after(() => {
    child.kill();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const inbox: CodexWorkerMessage[] = [];
  child.on('message', (message: CodexWorkerMessage) => inbox.push(message));
  const send = (message: CodexParentMessage) => child.send(message);

  send({
    type: 'init',
    generation: 1,
    dataDir,
    config: { executable, profileId: 'test' },
  });
  await take(child, inbox, (message) => message.type === 'ready');

  const loginId = randomUUID();
  send({ type: 'account.login', generation: 1, id: loginId });
  const login = await take(
    child,
    inbox,
    (message) => message.type === 'reply' && message.id === loginId,
  );
  assert.equal(login.type, 'reply');
  if (login.type !== 'reply' || !login.ok) throw new Error('login failed');
  const started = login.result as { url: string; userCode: string };
  assert.equal(started.url, 'https://auth.openai.com/codex/device');
  assert.equal(started.userCode, 'ABCD-1234');
  await take(child, inbox, (message) => message.type === 'login.exit' && message.succeeded);

  const statusId = randomUUID();
  send({ type: 'account.status', generation: 1, id: statusId });
  const status = await take(
    child,
    inbox,
    (message) => message.type === 'reply' && message.id === statusId,
  );
  if (status.type !== 'reply' || !status.ok) throw new Error('status failed');
  assert.deepEqual(status.result, { loggedIn: true, accountType: 'chatgpt' });

  const modelId = randomUUID();
  send({ type: 'model.list', generation: 1, id: modelId });
  const models = await take(
    child,
    inbox,
    (message) => message.type === 'reply' && message.id === modelId,
  );
  if (models.type !== 'reply' || !models.ok) throw new Error('models failed');
  assert.deepEqual(models.result, { models: [{ id: 'gpt-test', displayName: 'Test' }] });

  const sessionId = randomUUID();
  send({
    type: 'run.start',
    generation: 1,
    run: { sessionId, runId: randomUUID(), messageId: randomUUID(), text: 'ping' },
  });
  const delta = await take(
    child,
    inbox,
    (message) => message.type === 'event' && message.payload.type === 'text.delta',
  );
  assert.equal(delta.type, 'event');
  assert.equal(delta.payload.type, 'text.delta');
  assert.equal(delta.payload.text, 'pong');
  const done = await take(child, inbox, (message) => message.type === 'run.finished');
  assert.equal(done.type, 'run.finished');
  assert.equal(done.status, 'completed');
  assert.equal(done.unknown, false);
  assert.equal(done.threadId, 'thr_test');

  const modeled = randomUUID();
  send({
    type: 'run.start',
    generation: 1,
    run: {
      sessionId: modeled,
      runId: randomUUID(),
      messageId: randomUUID(),
      text: 'echo-model',
      model: 'gpt-test',
    },
  });
  const echoed = await take(
    child,
    inbox,
    (message) =>
      message.type === 'event' &&
      message.sessionId === modeled &&
      message.payload.type === 'text.delta',
  );
  assert.equal(echoed.type, 'event');
  assert.equal(echoed.payload.type, 'text.delta');
  assert.equal(echoed.payload.text, 'gpt-test');
  await take(child, inbox, (message) => message.type === 'run.finished' && message.sessionId === modeled);

  const denied = randomUUID();
  send({
    type: 'run.start',
    generation: 1,
    run: { sessionId: denied, runId: randomUUID(), messageId: randomUUID(), text: 'deny this' },
  });
  const askedTool = await take(
    child,
    inbox,
    (message) =>
      message.type === 'event' &&
      message.sessionId === denied &&
      message.payload.type === 'tool.requested',
  );
  assert.equal(askedTool.type, 'event');
  assert.equal(askedTool.payload.type, 'tool.requested');
  assert.equal(askedTool.payload.name, 'Bash');
  assert.match(askedTool.payload.input, /echo probe-deny/);
  const approval = await take(child, inbox, (message) => message.type === 'approval.requested');
  assert.equal(approval.type, 'approval.requested');
  assert.equal(approval.waiting, 'approval');
  send({
    type: 'approval.resolve',
    generation: 1,
    sessionId: denied,
    approvalId: approval.approvalId,
    allowed: false,
  });
  const tool = await take(
    child,
    inbox,
    (message) => message.type === 'event' && message.payload.type === 'tool.result',
  );
  assert.equal(tool.type, 'event');
  assert.equal(tool.payload.type, 'tool.result');
  assert.equal(tool.payload.status, 'denied');
  const deniedDone = await take(
    child,
    inbox,
    (message) => message.type === 'run.finished' && message.sessionId === denied,
  );
  assert.equal(deniedDone.type, 'run.finished');
  assert.equal(deniedDone.status, 'completed');

  const asked = randomUUID();
  send({
    type: 'run.start',
    generation: 1,
    run: { sessionId: asked, runId: randomUUID(), messageId: randomUUID(), text: 'ask this' },
  });
  const questionTool = await take(
    child,
    inbox,
    (message) =>
      message.type === 'event' &&
      message.sessionId === asked &&
      message.payload.type === 'tool.requested',
  );
  assert.equal(questionTool.type, 'event');
  assert.equal(questionTool.payload.type, 'tool.requested');
  assert.equal(questionTool.payload.name, 'AskUserQuestion');
  const question = await take(
    child,
    inbox,
    (message) => message.type === 'approval.requested' && message.sessionId === asked,
  );
  assert.equal(question.type, 'approval.requested');
  assert.equal(question.waiting, 'question');
  assert.equal(question.kind, 'question');
  send({
    type: 'approval.resolve',
    generation: 1,
    sessionId: asked,
    approvalId: question.approvalId,
    allowed: true,
    answers: { 继续吗: '是' },
  });
  const answer = await take(
    child,
    inbox,
    (message) =>
      message.type === 'event' &&
      message.sessionId === asked &&
      message.payload.type === 'text.delta',
  );
  assert.equal(answer.type, 'event');
  assert.equal(answer.payload.type, 'text.delta');
  assert.equal(answer.payload.text, JSON.stringify({ go: { answers: ['是'] } }));
  await take(child, inbox, (message) => message.type === 'run.finished' && message.sessionId === asked);

  const askedOld = randomUUID();
  send({
    type: 'run.start',
    generation: 1,
    run: { sessionId: askedOld, runId: randomUUID(), messageId: randomUUID(), text: 'ask-old' },
  });
  const oldQuestion = await take(
    child,
    inbox,
    (message) => message.type === 'approval.requested' && message.sessionId === askedOld,
  );
  assert.equal(oldQuestion.type, 'approval.requested');
  assert.equal(oldQuestion.waiting, 'question');
  send({
    type: 'approval.resolve',
    generation: 1,
    sessionId: askedOld,
    approvalId: oldQuestion.approvalId,
    allowed: false,
  });
  const oldAnswer = await take(
    child,
    inbox,
    (message) =>
      message.type === 'event' &&
      message.sessionId === askedOld &&
      message.payload.type === 'text.delta',
  );
  assert.equal(oldAnswer.type, 'event');
  assert.equal(oldAnswer.payload.type, 'text.delta');
  assert.equal(oldAnswer.payload.text, 'decline');
  await take(
    child,
    inbox,
    (message) => message.type === 'run.finished' && message.sessionId === askedOld,
  );

  const sleeping = randomUUID();
  send({
    type: 'run.start',
    generation: 1,
    run: { sessionId: sleeping, runId: randomUUID(), messageId: randomUUID(), text: 'sleep 60' },
  });
  send({ type: 'run.abort', generation: 1, sessionId: sleeping });
  const stopped = await take(
    child,
    inbox,
    (message) => message.type === 'run.finished' && message.sessionId === sleeping,
  );
  assert.equal(stopped.type, 'run.finished');
  assert.equal(stopped.status, 'cancelled');
  assert.equal(stopped.unknown, false);

  const missing = randomUUID();
  send({
    type: 'run.start',
    generation: 1,
    run: {
      sessionId: missing,
      runId: randomUUID(),
      messageId: randomUUID(),
      text: 'resume',
      resumeThreadId: 'thr_missing',
    },
  });
  const failure = await take(
    child,
    inbox,
    (message) =>
      message.type === 'event' &&
      message.sessionId === missing &&
      message.payload.type === 'run.error',
  );
  assert.equal(failure.type, 'event');
  assert.equal(failure.payload.type, 'run.error');
  assert.match(failure.payload.message, /thread not found/);
  const missingDone = await take(
    child,
    inbox,
    (message) => message.type === 'run.finished' && message.sessionId === missing,
  );
  assert.equal(missingDone.type, 'run.finished');
  assert.equal(missingDone.status, 'failed');
  assert.equal(missingDone.threadId, undefined);
  assert.equal(missingDone.dropThread, true);

  send({ type: 'shutdown', generation: 1 });
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
});

test('a turn starts with the Codex approval policy for that session', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'cc-desk-codex-policy-'));
  const child = fork(worker, [], { execArgv: [], stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  t.after(async () => {
    child.kill();
    await new Promise((resolve) => setTimeout(resolve, 200));
    rmSync(dataDir, { recursive: true, force: true });
  });
  const inbox: CodexWorkerMessage[] = [];
  child.on('message', (message: CodexWorkerMessage) => inbox.push(message));
  const send = (message: CodexParentMessage) => child.send(message);
  send({
    type: 'init',
    generation: 1,
    dataDir,
    config: { executable, profileId: 'test' },
  });
  await take(child, inbox, (message) => message.type === 'ready');

  const planned = randomUUID();
  send({
    type: 'run.start',
    generation: 1,
    run: {
      sessionId: planned,
      runId: randomUUID(),
      messageId: randomUUID(),
      text: 'echo-policy',
      permissionMode: 'plan',
    },
  });
  const planText = await take(
    child,
    inbox,
    (message) => message.type === 'event' && message.payload.type === 'text.delta',
  );
  assert.equal(planText.type, 'event');
  assert.equal(planText.payload.type, 'text.delta');
  assert.equal(planText.payload.text, JSON.stringify({ approval: 'on-request', sandbox: 'readOnly' }));
  await take(child, inbox, (message) => message.type === 'run.finished');

  const bypassed = randomUUID();
  send({
    type: 'run.start',
    generation: 1,
    run: {
      sessionId: bypassed,
      runId: randomUUID(),
      messageId: randomUUID(),
      text: 'echo-policy',
      permissionMode: 'bypassPermissions',
    },
  });
  const bypassText = await take(
    child,
    inbox,
    (message) =>
      message.type === 'event' &&
      message.sessionId === bypassed &&
      message.payload.type === 'text.delta',
  );
  assert.equal(bypassText.type, 'event');
  assert.equal(bypassText.payload.type, 'text.delta');
  assert.equal(
    bypassText.payload.text,
    JSON.stringify({ approval: 'never', sandbox: 'dangerFullAccess' }),
  );

  const rejected = randomUUID();
  send({
    type: 'run.start',
    generation: 1,
    run: {
      sessionId: rejected,
      runId: randomUUID(),
      messageId: randomUUID(),
      text: 'reject-policy',
      permissionMode: 'plan',
    },
  });
  const failed = await take(
    child,
    inbox,
    (message) => message.type === 'event' && message.sessionId === rejected,
  );
  assert.equal(failed.type, 'event');
  assert.equal(failed.payload.type, 'run.error');
  if (failed.payload.type === 'run.error') assert.match(failed.payload.message, /没有开始/);
  await take(child, inbox, (message) => message.type === 'run.finished' && message.sessionId === rejected);
});

function take(
  child: ChildProcess,
  inbox: CodexWorkerMessage[],
  predicate: (message: CodexWorkerMessage) => boolean,
) {
  const pull = () => {
    const index = inbox.findIndex(predicate);
    if (index < 0) return undefined;
    return inbox.splice(index, 1)[0];
  };
  const existing = pull();
  if (existing) return Promise.resolve(existing);
  return new Promise<CodexWorkerMessage>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off('message', look);
      reject(new Error('timed out waiting for Codex worker'));
    }, 5000);
    const look = () => {
      const found = pull();
      if (!found) return;
      clearTimeout(timer);
      child.off('message', look);
      resolve(found);
    };
    child.on('message', look);
    look();
  });
}
