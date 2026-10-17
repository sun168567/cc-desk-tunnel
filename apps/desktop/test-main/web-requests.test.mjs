import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWebRequests } from '../electron/web-requests.cjs';

function fixture(t) {
  const messages = [];
  let current;
  const sender = () => ({
    destroyed: false,
    failures: 0,
    isDestroyed() {
      return this.destroyed;
    },
    send(channel, value) {
      if (this.failures > 0) {
        this.failures--;
        throw new Error('IPC dispatch failed');
      }
      messages.push({ sender: this, channel, value });
    },
  });
  const first = (current = sender());
  const requests = createWebRequests({ window: () => ({ webContents: current }) });
  t.after(() => requests.cancel());
  const state = async (viewId) => {
    const result = requests.invoke('client:state', [], viewId);
    const last = messages.at(-1);
    if (last?.value.method === 'client:state' && last.value.viewId === viewId)
      requests.reply(last.sender, { id: last.value.id, ok: true, result: null });
    return result;
  };
  return { requests, messages, first, sender, state, select: (value) => (current = value) };
}

test('internal detach is ordered after state and needs no slot from the full business request pool', async (t) => {
  const f = fixture(t);
  for (let index = 0; index < 16; index++) await f.state(`view-${index}`);
  const pending = Promise.allSettled(
    Array.from({ length: 128 }, () => f.requests.invoke('client:info', [])),
  );
  await assert.rejects(f.requests.invoke('client:info', []), /请求过多/);
  for (let index = 0; index < 16; index++)
    await f.requests.invoke('client:detach', [], `view-${index}`);
  assert.equal(f.messages.filter(({ value }) => value.method === 'client:detach').length, 16);
  await assert.rejects(f.requests.invoke('client:info', []), /请求过多/);
  await f.requests.invoke('client:detach', [], 'view-0');
  await f.requests.invoke('client:detach', [], 'never-registered');
  assert.equal(f.messages.length, 16 + 128 + 16);
  assert.ok(
    f.messages
      .slice(-16)
      .every(({ sender, channel }) => sender === f.first && channel === 'remote:request'),
  );
  f.requests.cancel();
  assert.ok((await pending).every(({ status }) => status === 'rejected'));
});

test('view registration is bounded and repeated state reads do not use another slot', async (t) => {
  const f = fixture(t);
  for (let index = 0; index < 16; index++) await f.state(`view-${index}`);
  await f.state('view-0');
  await assert.rejects(f.state('extra'), /页面过多/);
  await f.requests.invoke('client:detach', [], 'view-0');
  await f.state('extra');
});

test('closing before the state reply keeps state registration ahead of its cleanup notification', async (t) => {
  const f = fixture(t);
  const reading = f.requests.invoke('client:state', [], 'view');
  await f.requests.invoke('client:detach', [], 'view');
  assert.deepEqual(
    f.messages.map(({ value }) => value.method),
    ['client:state', 'client:detach'],
  );
  f.requests.reply(f.first, { id: f.messages[0].value.id, ok: true, result: null });
  await reading;
  // A late reply does not register the closed view again.
  for (let index = 0; index < 16; index++) await f.state(`next-${index}`);
});

test('cleanup stays with its original renderer and never targets a replacement window', async (t) => {
  const f = fixture(t);
  await f.state('old');
  const replacement = f.sender();
  f.select(replacement);
  await f.requests.invoke('client:detach', [], 'old');
  assert.equal(f.messages.at(-1).sender, f.first);
  await f.state('replacement');
  replacement.destroyed = true;
  const count = f.messages.length;
  f.select(f.first);
  await f.requests.invoke('client:detach', [], 'replacement');
  assert.equal(f.messages.length, count);
  await f.state('next');
});

test('a failed initial state send does not leak a view registration', async (t) => {
  const f = fixture(t);
  f.first.failures = 20;
  for (let index = 0; index < 20; index++)
    await assert.rejects(f.state(`failed-${index}`), /IPC dispatch failed/);
  for (let index = 0; index < 16; index++) await f.state(`view-${index}`);
  assert.equal(f.messages.length, 16);
});

test('a failed detach send is retained and retried without replaying accepted business requests', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t);
  await f.state('view');
  f.first.failures = 1;
  await f.requests.invoke('client:detach', [], 'view');
  assert.equal(f.messages.length, 1);
  t.mock.timers.tick(250);
  assert.deepEqual(
    f.messages.map(({ value }) => value.method),
    ['client:state', 'client:detach'],
  );
  t.mock.timers.tick(1000);
  assert.equal(f.messages.length, 2);
});

test('destroying a renderer or cancelling Web clears retained cleanup without sending elsewhere', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t);
  await f.state('destroyed');
  f.first.failures = 1;
  await f.requests.invoke('client:detach', [], 'destroyed');
  f.first.destroyed = true;
  const replacement = f.sender();
  f.select(replacement);
  t.mock.timers.tick(250);
  await f.state('cancelled');
  replacement.failures = 1;
  await f.requests.invoke('client:detach', [], 'cancelled');
  f.requests.cancel();
  t.mock.timers.tick(1000);
  assert.deepEqual(
    f.messages.map(({ value }) => value.method),
    ['client:state', 'client:state'],
  );
  for (let index = 0; index < 16; index++) await f.state(`reopened-${index}`);
});
