import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HistoryCache } from '../electron/history-cache.cjs';
import { ProxyClient } from '../src/client.ts';
import { transcript } from '../src/transcript.ts';
import { SessionStore } from '../../server/src/store.ts';
import { createProxyServer } from '../../server/src/server.ts';

const wait = async (fn) => {
  const until = Date.now() + 5000;
  while (!fn()) {
    if (Date.now() > until) throw Error('Timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ccdt-cache-'));
  const store = new SessionStore(join(dir, 'server'));
  const device = { id: randomUUID(), name: '缓存测试' };
  const session = store.create(randomUUID(), 'history', 'D:\\fixture', device);
  for (let n = 0; n < 5; n++) {
    const run = randomUUID();
    store.append(session.id, run, {
      type: 'message.user',
      messageId: randomUUID(),
      text: `question ${n}`,
      scenario: 'chat',
    });
    store.append(session.id, run, {
      type: 'text.delta',
      messageId: randomUUID(),
      text: `answer ${n} 中文😀` + 'x'.repeat(290000),
    });
  }
  const cache = new HistoryCache(join(dir, 'cache'));
  const url = 'wss://example.test/ws';
  const cleanup = [];
  t.after(async () => {
    for (const close of cleanup) await close();
    await cache.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const save = async (
    page,
    lower = page.hasEarlier ? page.firstSequence - 1 : 0,
    reset = false,
    generation = 0,
  ) =>
    cache.request({
      type: 'save',
      url,
      session: page.session,
      events: page.events,
      cursor: page.cursor,
      range: [lower, page.lastSequence],
      reset,
      generation,
    });
  return { dir, store, device, session, cache, url, save, cleanup };
}

test('disk pages reuse server pagination, preserve older ranges, and keep service namespaces apart', async (t) => {
  const { store, session, cache, url, save } = fixture(t);
  let page = store.history(session.id, randomUUID());
  await save(page);
  assert.deepEqual(
    (await cache.request({ type: 'read', url, sessionId: session.id })).value.events,
    page.events,
  );
  const latest = page;
  const oldest = store.history(session.id, randomUUID(), 0, 3);
  await save(oldest);
  const gap = (
    await cache.request({
      type: 'read',
      url,
      sessionId: session.id,
      beforeSequence: latest.firstSequence,
    })
  ).value;
  assert.equal(gap.missingAfter, oldest.lastSequence);
  const offline = (
    await cache.request({
      type: 'read',
      url,
      sessionId: session.id,
      beforeSequence: latest.firstSequence,
      offline: true,
    })
  ).value;
  assert.equal(offline.gap, true);
  assert.deepEqual(offline.events, oldest.events);
  let before = latest.firstSequence;
  do {
    page = store.history(session.id, randomUUID(), 0, before, oldest.lastSequence);
    await save(page, page.hasEarlier ? page.firstSequence - 1 : oldest.lastSequence);
    before = page.firstSequence;
  } while (page.hasEarlier);
  const events = [];
  before = undefined;
  do {
    page = (
      await cache.request({
        type: 'read',
        url,
        sessionId: session.id,
        beforeSequence: before,
        offline: true,
      })
    ).value;
    assert.equal(page.gap, false);
    events.unshift(...page.events);
    before = page.firstSequence;
  } while (page.hasEarlier);
  assert.deepEqual(transcript(events), transcript(store.snapshot(session.id).events));
  assert.deepEqual((await cache.request({ type: 'list', url: 'wss://other.test/ws' })).value, []);
  assert.equal((await cache.request({ type: 'stats', url })).events, 10);
});

test('clear rejects late writes, releases disk space and permits fresh data', async (t) => {
  const { store, session, cache, url, save } = fixture(t);
  const page = store.history(session.id, randomUUID());
  await save(page);
  const before = await cache.request({ type: 'stats', url });
  const clearing = cache.request({ type: 'clear', url });
  const stale = save(page);
  await Promise.all([clearing, stale]);
  const after = await cache.request({ type: 'stats', url });
  assert.equal(after.events, 0);
  assert.ok(after.bytes < before.bytes);
  await save(page, 0, false, 1);
  assert.equal((await cache.request({ type: 'stats', url })).events, page.events.length);
  await cache.request({ type: 'catalog', url, sessions: [] });
  assert.equal((await cache.request({ type: 'stats', url })).events, 0);
});

test('cache keeps opaque events through worker restart and sparse history ranges', async (t) => {
  const { dir, store, session, cache, url, save } = fixture(t);
  const page = store.history(session.id, randomUUID());
  page.events = [
    { ...page.events[0], sequence: 1, payload: { type: 'future.event', extra: { foo: 'bar' } } },
    { ...page.events[1], sequence: 9 },
  ];
  page.lastSequence = 9;
  page.firstSequence = 1;
  page.hasEarlier = false;
  await save(page);
  const other = new HistoryCache(join(dir, 'cache'));
  try {
    const read = (await other.request({ type: 'read', url, sessionId: session.id, offline: true }))
      .value;
    assert.deepEqual(read.events, page.events);
    assert.equal(read.hasEarlier, false);
  } finally {
    await other.close();
  }
  // The original worker can continue after the second reader closes.
  assert.equal((await cache.request({ type: 'stats', url })).events, 2);
});

test('actual client restores disk history, fetches only changes, and resets a divergent server history', async (t) => {
  const { store, session, device, cache, dir, cleanup } = fixture(t);
  const token = 'test-token-' + randomUUID();
  const service = createProxyServer({ token, dataDir: join(dir, 'server'), host: '127.0.0.1' });
  const url = (await service.listen(0)).replace('http:', 'ws:') + '/ws';

  async function connect() {
    const client = new ProxyClient();
    client.useCache(url, (command) => cache.request(command));
    client.connect(url, token, device, false);
    await wait(() => client.state.status === 'connected');
    return client;
  }
  let client = await connect();
  cleanup.push(
    () => client.disconnect(),
    () => service.close(),
  );
  client.select(session.id);
  await client.waitForHistory(session.id);
  assert.ok(client.state.events[session.id]?.length);
  const initial = client.state.events[session.id];
  await cache.request({ type: 'stats', url });
  client.disconnect();
  client = await connect();
  let parts = 0;
  client.socket.addEventListener('message', ({ data }) => {
    if (JSON.parse(data).type === 'session.history.part') parts++;
  });
  client.select(session.id);
  await client.waitForHistory(session.id);
  assert.deepEqual(client.state.events[session.id], initial);
  assert.equal(parts, 0);
  client.disconnect();
  await client.openOffline();
  client.select(session.id);
  await client.waitForHistory(session.id);
  assert.equal(client.socket, null);
  assert.deepEqual(client.state.events[session.id], initial);
  const last = initial.at(-1);
  const changed = { ...last, payload: { ...last.payload, text: 'server corrected' } };
  service.store.database
    .prepare('UPDATE events SET data=? WHERE session_id=? AND sequence=?')
    .run(JSON.stringify(changed), session.id, last.sequence);
  client.disconnect();
  client = await connect();
  client.select(session.id);
  await client.waitForHistory(session.id);
  assert.equal(client.state.events[session.id].at(-1).payload.text, 'server corrected');
  await cache.request({ type: 'stats', url });
  assert.equal(
    (await cache.request({ type: 'read', url, sessionId: session.id })).value.events.at(-1).payload
      .text,
    'server corrected',
  );
  // A long absence returns the latest page; previously read pages remain on disk and bridge the gap.
  while (client.state.history[session.id].hasEarlier) await client.loadEarlier(session.id);
  client.disconnect();
  for (let n = 0; n < 4; n++)
    service.store.append(session.id, randomUUID(), {
      type: 'native.notice',
      text: `new ${n} ` + 'n'.repeat(300000),
    });
  client = await connect();
  client.select(session.id);
  await client.waitForHistory(session.id);
  let remotePages = 0;
  const request = client.request.bind(client);
  client.request = (command) => {
    if (command.type === 'session.history') remotePages++;
    return request(command);
  };
  while (client.state.history[session.id].hasEarlier) await client.loadEarlier(session.id);
  assert.deepEqual(client.state.events[session.id], service.store.snapshot(session.id).events);
  assert.equal(remotePages, 3, 'only three missing new pages travel over the socket');
  client.disconnect();
  service.store.database
    .prepare('DELETE FROM events WHERE session_id=? AND sequence>4')
    .run(session.id);
  client = await connect();
  client.select(session.id);
  await client.waitForHistory(session.id);
  assert.equal(client.state.history[session.id].lastSequence, 4);
  await cache.request({ type: 'stats', url });
  assert.equal(
    (await cache.request({ type: 'stats', url })).events,
    client.state.events[session.id].length,
  );
});
