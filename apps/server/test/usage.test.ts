import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { UsageLog, createUsageReceiver, telemetryEnvironment } from '../src/usage.ts';

const hour = 3600_000;
const base = Date.parse('2026-10-06T00:00:00.000Z');
function record(at: number, values: Record<string, string | number>, name = 'api_request') {
  return {
    timeUnixNano: `${at}000000`,
    body: { stringValue: `claude_code.${name}` },
    attributes: Object.entries({
      'event.name': name,
      'event.timestamp': new Date(at).toISOString(),
      'user.email': 'user@example.invalid',
      ...values,
    }).map(([key, value]) => ({
      key,
      value:
        typeof value === 'string'
          ? { stringValue: value }
          : Number.isInteger(value)
            ? { intValue: value }
            : { doubleValue: value },
    })),
  };
}
const request = (at: number, id: string, extra: Record<string, string | number> = {}) =>
  record(at, {
    'session.id': '4f0c9d0e-1111-4222-8333-444455556666',
    model: 'claude-opus-5-5',
    input_tokens: 10,
    output_tokens: 200,
    cache_read_tokens: 1000,
    cache_creation_tokens: 50,
    cost_usd: 0.5,
    duration_ms: 3000,
    ttft_ms: 1000,
    request_id: id,
    query_source: 'sdk',
    ...extra,
  });
const batch = (...logRecords: unknown[]) => ({ resourceLogs: [{ scopeLogs: [{ logRecords }] }] });

test('collector keeps model requests only, once each, without account identity', () => {
  const database = new DatabaseSync(':memory:');
  const log = new UsageLog(database);
  assert.equal(
    log.ingest(
      batch(
        record(base, { prompt: '<REDACTED>' }, 'user_prompt'),
        request(base, 'req_1'),
        request(base + 1, 'req_2'),
      ),
    ),
    2,
  );
  assert.equal(log.ingest(batch(request(base, 'req_1'))), 0);
  assert.equal(log.ingest({ unexpected: true }), 0);
  const columns = (
    database.prepare('PRAGMA table_info(api_requests)').all() as { name: string }[]
  ).map((column) => column.name);
  assert.ok(!columns.some((name) => /email|user|account|prompt/.test(name)));
  const page = log.query({ limit: 1, bucketMinutes: 60, offsetMinutes: 0 }, () => '标题');
  assert.equal(page.rows.length, 1);
  assert.equal(page.hasMore, true);
  assert.deepEqual(
    { ...page.rows[0], id: 0 },
    {
      id: 0,
      at: new Date(base + 1).toISOString(),
      sessionId: '4f0c9d0e-1111-4222-8333-444455556666',
      sessionTitle: '标题',
      model: 'claude-opus-5-5',
      inputTokens: 10,
      outputTokens: 200,
      cacheReadTokens: 1000,
      cacheCreationTokens: 50,
      costUsd: 0.5,
      durationMs: 3000,
      ttftMs: 1000,
      source: 'sdk',
    },
  );
  assert.equal(page.totals.requests, 2);
  assert.equal(page.totals.costUsd, 1);
  assert.equal(page.totals.outputPerSecond, 100);
  assert.equal(
    log.query(
      { limit: 1, beforeId: page.rows[0].id, bucketMinutes: 60, offsetMinutes: 0 },
      () => null,
    ).hasMore,
    false,
  );
});

test('filters, buckets in the viewer time zone, and retention limits', () => {
  const log = new UsageLog(new DatabaseSync(':memory:'), 35, 3);
  log.ingest(
    batch(
      request(base - 30 * hour, 'a', { model: 'claude-haiku-4-5' }),
      request(base - 2 * hour, 'b'),
      request(base + hour, 'c', { model: 'claude-haiku-4-5', ttft_ms: 5000, duration_ms: 4000 }),
      request(base + 2 * hour, 'd'),
    ),
  );
  const range = {
    from: new Date(base - 3 * hour).toISOString(),
    to: new Date(base + 3 * hour).toISOString(),
    limit: 100,
    offsetMinutes: 480,
  };
  const daily = log.query({ ...range, bucketMinutes: 1440 }, () => null);
  // 22:00, 01:00 and 02:00 UTC are all the same calendar day at UTC+8.
  assert.deepEqual(
    daily.series.map((item) => [item.at, item.requests]),
    [['2026-10-05T16:00:00.000Z', 3]],
  );
  assert.deepEqual(daily.models, ['claude-haiku-4-5', 'claude-opus-5-5']);
  const haiku = log.query({ ...range, bucketMinutes: 60, model: 'claude-haiku-4-5' }, () => null);
  assert.equal(haiku.totals.requests, 1);
  assert.equal(haiku.totals.outputPerSecond, null);
  assert.deepEqual(haiku.models, daily.models);
  log.prune(base + 3 * hour);
  assert.equal(
    log.query({ limit: 100, bucketMinutes: 60, offsetMinutes: 0 }, () => null).totals.requests,
    3,
  );
  log.prune(base + 40 * 24 * hour);
  assert.equal(
    log.query({ limit: 100, bucketMinutes: 60, offsetMinutes: 0 }, () => null).totals.requests,
    0,
  );
});

test('period statistics follow the official windows, including early resets and expiry', () => {
  const log = new UsageLog(new DatabaseSync(':memory:'));
  const limits = (fiveHour: [number, number], week: [number, number]) => ({
    windows: [
      {
        name: 'five_hour',
        utilization: fiveHour[0],
        resetsAt: new Date(fiveHour[1]).toISOString(),
      },
      { name: 'seven_day', utilization: week[0], resetsAt: new Date(week[1]).toISOString() },
    ],
  });
  const weekEnd = base + 5 * 24 * hour;
  log.ingest(batch(request(base - 3 * 24 * hour, 'old'), request(base + hour, 'w1')));
  log.observe(limits([20, base + 5 * hour], [30, weekEnd]), base + hour + 1);
  const count = (now: number) =>
    Object.fromEntries(log.summary(now).windows.map((window) => [window.name, window.requests]));
  // First observation: the period start is derived from the reported reset time.
  assert.deepEqual(count(base + hour + 2), { five_hour: 1, seven_day: 1 });
  assert.equal(
    log.summary(base + hour + 2).windows[1].startedAt,
    new Date(weekEnd - 7 * 24 * hour).toISOString(),
  );

  // Sub-second jitter in the reported reset time is not a new period.
  log.ingest(batch(request(base + 2 * hour, 'w2')));
  log.observe(limits([40, base + 5 * hour + 900], [31, weekEnd - 700]), base + 2 * hour + 1);
  assert.deepEqual(count(base + 2 * hour + 2), { five_hour: 2, seven_day: 2 });

  // Past the reset time and before any new report, the old period's requests no longer count.
  assert.deepEqual(count(base + 6 * hour), { five_hour: 0, seven_day: 2 });
  assert.equal(log.summary(base + 6 * hour).windows[0].utilization, null);

  // A new five-hour window starts with the first request after expiry.
  log.ingest(batch(request(base + 7 * hour, 'w3')));
  log.observe(limits([5, base + 12 * hour], [32, weekEnd]), base + 7 * hour + 1);
  assert.deepEqual(count(base + 7 * hour + 2), { five_hour: 1, seven_day: 3 });

  // A reset granted early clears the weekly utilization while its reset time stays; statistics restart too.
  log.ingest(batch(request(base + 8 * hour, 'w4')));
  log.observe(limits([10, base + 12 * hour], [0, weekEnd]), base + 8 * hour + 1);
  assert.deepEqual(count(base + 8 * hour + 2), { five_hour: 2, seven_day: 1 });
});

test('a period survives jitter and repeated readings, and a cut-short one is restored', () => {
  const database = new DatabaseSync(':memory:');
  const log = new UsageLog(database);
  const weekEnd = base + 3 * 24 * hour;
  const weekStart = new Date(weekEnd - 7 * 24 * hour).toISOString();
  const reading = (utilization: number, at: number, resetsAt: number | null = weekEnd) => ({
    measuredAt: new Date(at).toISOString(),
    windows: [
      {
        name: 'seven_day',
        utilization,
        resetsAt: resetsAt === null ? null : new Date(resetsAt).toISOString(),
      },
    ],
  });
  const started = () => log.summary(base + 3 * hour).windows[0].startedAt;
  log.ingest(batch(request(base, 'j1')));
  log.observe(reading(45, base + hour));
  // Two readings a few milliseconds apart, the later one a point lower.
  log.observe(reading(44, base + hour + 36));
  assert.equal(started(), weekStart);
  // Another session's long turn emits the reading it took earlier once more.
  log.observe(reading(47, base + 2 * hour));
  log.observe(reading(30, base + hour + 10), base + 2 * hour + 5);
  assert.equal(started(), weekStart);
  assert.equal(log.summary(base + 3 * hour).windows[0].utilization, 47);
  assert.equal(log.summary(base + 3 * hour).windows[0].requests, 1);
  // Even a larger positive correction is not evidence that the quota has reset.
  log.observe(reading(38, base + 2 * hour + 100));
  assert.equal(started(), weekStart);
  log.observe(reading(0, base + 2 * hour + 100));
  assert.equal(log.summary(base + 3 * hour).windows[0].utilization, 38);

  // An expired window is reported empty and without a reset time; its next period is told by the new one.
  const five = (utilization: number, at: number, resetsAt: number | null) => ({
    measuredAt: new Date(at).toISOString(),
    windows: [
      {
        name: 'five_hour',
        utilization,
        resetsAt: resetsAt === null ? null : new Date(resetsAt).toISOString(),
      },
    ],
  });
  const fiveStart = () =>
    log.summary(base + 9 * hour).windows.find((window) => window.name === 'five_hour')!.startedAt;
  log.observe(five(2, base + hour, base + 5 * hour));
  log.observe(five(0, base + 6 * hour, null));
  log.observe(five(1, base + 7 * hour, base + 11.5 * hour));
  assert.equal(fiveStart(), new Date(base + 6.5 * hour).toISOString());

  // A database written before the fix: the start is put back once, and the records stay.
  const old = new DatabaseSync(':memory:');
  new UsageLog(old).ingest(batch(request(Date.now() - hour, 'kept')));
  const resetsAt = Date.now() + 2 * 24 * hour;
  old.exec("DELETE FROM migrations WHERE name = 'usage-window-start'");
  old
    .prepare('INSERT INTO usage_windows VALUES (?, ?, ?, ?, ?)')
    .run('seven_day', Date.now() - 60_000, resetsAt, 51, Date.now() - 1000);
  const records = old.prepare('SELECT * FROM api_requests ORDER BY id').all();
  const restored = new UsageLog(old).summary().windows[0];
  assert.equal(restored.startedAt, new Date(resetsAt - 7 * 24 * hour).toISOString());
  assert.equal(restored.requests, 1);
  assert.deepEqual(old.prepare('SELECT * FROM api_requests ORDER BY id').all(), records);
  // Recovery is once only; a later explicitly observed reset must survive a restart.
  old.prepare('UPDATE usage_windows SET started_at = ?').run(Date.now() - 500);
  new UsageLog(old);
  assert.ok(
    Number(old.prepare('SELECT started_at FROM usage_windows').get()!.started_at) >
      Date.now() - 5000,
  );
});

test('period recovery preserves an early reset recorded in the original quota events', () => {
  const db = new DatabaseSync(':memory:');
  const log = new UsageLog(db);
  const now = Date.now();
  const end = now + 2 * 24 * hour;
  log.ingest(batch(request(now - 4 * hour, 'before-reset'), request(now - hour, 'after-reset')));
  db.exec(
    "DELETE FROM migrations WHERE name = 'usage-window-start'; CREATE TABLE events (data TEXT NOT NULL)",
  );
  db.prepare('INSERT INTO usage_windows VALUES (?, ?, ?, ?, ?)').run(
    'seven_day',
    now - 60000,
    end,
    20,
    now,
  );
  const insert = db.prepare('INSERT INTO events VALUES (?)');
  for (const [at, utilization] of [
    [now - 3 * hour, 60],
    [now - 2 * hour, 0],
    [now - hour, 20],
  ]) {
    insert.run(
      JSON.stringify({
        createdAt: new Date(at).toISOString(),
        payload: {
          type: 'native.metrics',
          rateLimits: {
            available: true,
            measuredAt: new Date(at).toISOString(),
            windows: [{ name: 'seven_day', resetsAt: new Date(end).toISOString(), utilization }],
          },
        },
      }),
    );
  }
  const records = db.prepare('SELECT * FROM api_requests ORDER BY id').all();
  const events = db.prepare('SELECT * FROM events').all();
  const recovered = new UsageLog(db).summary().windows[0];
  assert.equal(recovered.requests, 1);
  assert.equal(recovered.startedAt, new Date(now - 3 * hour).toISOString());
  assert.deepEqual(db.prepare('SELECT * FROM api_requests ORDER BY id').all(), records);
  assert.deepEqual(db.prepare('SELECT * FROM events').all(), events);
});

test('loopback receiver accepts OTLP JSON log exports', async () => {
  const log = new UsageLog(new DatabaseSync(':memory:'));
  const receiver = createUsageReceiver(log);
  const endpoint = await receiver.listen();
  try {
    assert.match(endpoint, /^http:\/\/127\.0\.0\.1:\d+\/v1\/logs$/);
    assert.equal(telemetryEnvironment(endpoint).OTEL_EXPORTER_OTLP_LOGS_ENDPOINT, endpoint);
    const post = (body: string, path = '') =>
      fetch(endpoint + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
    assert.equal(
      (await post(JSON.stringify(batch(request(base, 'http', { input_tokens: '12' }))))).status,
      200,
    );
    assert.equal((await post('not json')).status, 400);
    assert.equal((await post('{}', '/other')).status, 404);
    const page = log.query({ limit: 10, bucketMinutes: 60, offsetMinutes: 0 }, () => null);
    assert.equal(page.rows.length, 1);
    assert.equal(page.rows[0].inputTokens, 12);
  } finally {
    await receiver.close();
  }
});
