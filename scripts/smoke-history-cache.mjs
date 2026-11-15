import assert from 'node:assert/strict';

// Exercise the packaged preload, worker and shared SQL module on every desktop OS.
export async function smokeHistoryCache(page) {
  const result = await page.evaluate(async () => {
    const request = window.desktop.historyCache;
    const url = 'wss://cache-smoke.invalid/ws';
    const id = crypto.randomUUID(),
      runId = crypto.randomUUID(),
      now = new Date().toISOString();
    const session = {
      id,
      title: '缓存打包验证',
      projectPath: 'fixture',
      permissionMode: 'auto',
      createdAt: now,
      updatedAt: now,
      activeRun: null,
    };
    const event = {
      sessionId: id,
      runId,
      sequence: 1,
      createdAt: now,
      payload: { type: 'native.notice', text: '缓存 中文 😀' },
    };
    const { generation } = await request({ type: 'list', url });
    await request({
      type: 'save',
      url,
      session,
      events: [event],
      range: [0, 1],
      cursor: { epoch: crypto.randomUUID(), sequence: 1, hash: 'a'.repeat(64) },
      generation,
    });
    const saved = await request({ type: 'read', url, sessionId: id, offline: true });
    const stats = await request({ type: 'stats', url });
    await request({ type: 'clear', url });
    const cleared = await request({ type: 'stats', url });
    return { event: saved.value.events[0], expected: event, stats, cleared };
  });
  assert.deepEqual(result.event, result.expected);
  assert.equal(result.stats.events, 1);
  assert.equal(result.cleared.events, 0);
}
