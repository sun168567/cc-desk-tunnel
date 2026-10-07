import { createServer } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import type { ServerMessage } from '@cc-desk-tunnel/protocol';

type Summary = Omit<Extract<ServerMessage, { type: 'usage.summary' }>, 'type' | 'requestId'>;
type Page = Omit<Extract<ServerMessage, { type: 'usage.page' }>, 'type' | 'requestId'>;
type RateLimits = {
  windows: { name: string; utilization: number | null; resetsAt: string | null }[];
};
export type UsageQuery = {
  from?: string;
  to?: string;
  model?: string;
  beforeId?: number;
  limit: number;
  bucketMinutes: number;
  offsetMinutes: number;
};

const windowLength: Record<string, number> = { five_hour: 5 * 3600_000 };
const lengthOf = (name: string) =>
  windowLength[name] ?? (name.startsWith('seven_day') ? 7 * 24 * 3600_000 : undefined);
const totals = `COUNT(*) AS requests, COALESCE(SUM(input_tokens), 0) AS inputTokens, COALESCE(SUM(output_tokens), 0) AS outputTokens,
  COALESCE(SUM(cache_read_tokens), 0) AS cacheReadTokens, COALESCE(SUM(cache_creation_tokens), 0) AS cacheCreationTokens,
  COALESCE(SUM(cost_usd), 0) AS costUsd`;

// The official CLI reports every model request through its own OpenTelemetry log export; the Linux service is the
// collector. Costs are the CLI's API-price estimate for each request, not a subscription bill.
export function telemetryEnvironment(endpoint: string): Record<string, string> {
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_LOGS_EXPORTER: 'otlp',
    OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: 'http/json',
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: endpoint,
    OTEL_LOGS_EXPORT_INTERVAL: '2000',
  };
}

export class UsageLog {
  database: DatabaseSync;
  retentionDays: number;
  maxRows: number;
  constructor(database: DatabaseSync, retentionDays = 35, maxRows = 200_000) {
    this.database = database;
    this.retentionDays = retentionDays;
    this.maxRows = maxRows;
    database.exec(`
      CREATE TABLE IF NOT EXISTS api_requests (
        id INTEGER PRIMARY KEY, at INTEGER NOT NULL, session_id TEXT, model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
        cache_read_tokens INTEGER NOT NULL, cache_creation_tokens INTEGER NOT NULL,
        cost_usd REAL NOT NULL, duration_ms INTEGER NOT NULL, ttft_ms INTEGER, source TEXT, request_id TEXT UNIQUE
      );
      CREATE INDEX IF NOT EXISTS api_requests_at ON api_requests(at);
      CREATE TABLE IF NOT EXISTS usage_windows (
        name TEXT PRIMARY KEY, started_at INTEGER NOT NULL, resets_at INTEGER, utilization REAL, observed_at INTEGER NOT NULL
      );
    `);
    this.prune();
  }
  // Accepts one OTLP/HTTP JSON log export and keeps only the model request records.
  ingest(body: unknown) {
    const insert = this.database.prepare(`INSERT OR IGNORE INTO api_requests
      (at, session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd, duration_ms, ttft_ms, source, request_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    let stored = 0;
    for (const resource of asArray((body as { resourceLogs?: unknown })?.resourceLogs))
      for (const scope of asArray(resource?.scopeLogs))
        for (const record of asArray(scope?.logRecords)) {
          const fields = new Map<string, string | number>();
          for (const attribute of asArray(record?.attributes)) {
            const value =
              attribute?.value?.stringValue ??
              attribute?.value?.intValue ??
              attribute?.value?.doubleValue;
            if (typeof attribute?.key === 'string' && value !== undefined)
              fields.set(attribute.key, value);
          }
          if (fields.get('event.name') !== 'api_request') continue;
          const number = (name: string) => {
            const value = Number(fields.get(name));
            return Number.isFinite(value) && value >= 0 ? value : 0;
          };
          const text = (name: string) => {
            const value = fields.get(name);
            return typeof value === 'string' && value ? value.slice(0, 200) : null;
          };
          const at =
            Date.parse(String(fields.get('event.timestamp'))) ||
            Math.floor(Number(record.timeUnixNano) / 1e6) ||
            Date.now();
          stored += Number(
            insert.run(
              at,
              text('session.id'),
              text('model') ?? 'unknown',
              number('input_tokens'),
              number('output_tokens'),
              number('cache_read_tokens'),
              number('cache_creation_tokens'),
              number('cost_usd'),
              number('duration_ms'),
              fields.has('ttft_ms') ? number('ttft_ms') : null,
              text('query_source'),
              text('request_id'),
            ).changes,
          );
        }
    return stored;
  }
  // Statistics follow the official quota periods. A period ends when the reported reset time moves or the utilization
  // drops, which also covers resets granted outside the normal schedule.
  observe(rateLimits: RateLimits, now = Date.now()) {
    for (const window of rateLimits.windows) {
      const previous = this.database
        .prepare(
          'SELECT started_at, resets_at, utilization, observed_at FROM usage_windows WHERE name = ?',
        )
        .get(window.name) as
        | {
            started_at: number;
            resets_at: number | null;
            utilization: number | null;
            observed_at: number;
          }
        | undefined;
      const resetsAt = window.resetsAt ? Date.parse(window.resetsAt) || null : null;
      const length = lengthOf(window.name);
      const expected = resetsAt && length ? resetsAt - length : undefined;
      let startedAt = previous?.started_at ?? Math.min(now, expected ?? now);
      if (
        previous &&
        ((resetsAt !== null &&
          previous.resets_at !== null &&
          Math.abs(resetsAt - previous.resets_at) > 5 * 60_000) ||
          (window.utilization !== null &&
            previous.utilization !== null &&
            window.utilization < previous.utilization))
      )
        // The reset happened between the two observations; the reported period start is used when it falls in between.
        startedAt = Math.min(now, Math.max(previous.observed_at, expected ?? now));
      this.database
        .prepare(
          `INSERT INTO usage_windows (name, started_at, resets_at, utilization, observed_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET started_at = excluded.started_at, resets_at = excluded.resets_at,
          utilization = excluded.utilization, observed_at = excluded.observed_at`,
        )
        .run(window.name, startedAt, resetsAt, window.utilization, now);
    }
  }
  summary(now = Date.now()): Summary {
    const windows = this.database
      .prepare('SELECT name, started_at, resets_at, utilization FROM usage_windows ORDER BY rowid')
      .all() as {
      name: string;
      started_at: number;
      resets_at: number | null;
      utilization: number | null;
    }[];
    const first = this.database.prepare('SELECT MIN(at) AS at FROM api_requests').get() as {
      at: number | null;
    };
    return {
      retentionDays: this.retentionDays,
      firstRecordAt: first.at ? new Date(first.at).toISOString() : null,
      windows: windows.map((window) => {
        // Past the reset time nothing has been reported yet for the next period; only later requests can belong to it.
        const expired = window.resets_at !== null && window.resets_at <= now;
        const startedAt = expired ? window.resets_at! : window.started_at;
        return {
          name: window.name,
          startedAt: new Date(startedAt).toISOString(),
          resetsAt: window.resets_at && !expired ? new Date(window.resets_at).toISOString() : null,
          utilization: expired ? null : window.utilization,
          ...(this.database
            .prepare(`SELECT ${totals} FROM api_requests WHERE at >= ?`)
            .get(startedAt) as Omit<
            Summary['windows'][number],
            'name' | 'startedAt' | 'resetsAt' | 'utilization'
          >),
        };
      }),
    };
  }
  query(query: UsageQuery, title: (sessionId: string) => string | null): Page {
    const conditions = ['at >= ?', 'at < ?'];
    const range: (string | number)[] = [
      query.from ? Date.parse(query.from) : 0,
      query.to ? Date.parse(query.to) : Number.MAX_SAFE_INTEGER,
    ];
    const filtered = [...conditions, ...(query.model ? ['model = ?'] : [])].join(' AND ');
    const values = [...range, ...(query.model ? [query.model] : [])];
    const rows = this.database
      .prepare(
        `SELECT id, at, session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
        cost_usd, duration_ms, ttft_ms, source FROM api_requests
      WHERE ${filtered}${query.beforeId ? ' AND id < ?' : ''} ORDER BY id DESC LIMIT ?`,
      )
      .all(...values, ...(query.beforeId ? [query.beforeId] : []), query.limit + 1) as Record<
      string,
      number | string | null
    >[];
    const total = this.database
      .prepare(
        `SELECT ${totals}, COALESCE(SUM(duration_ms), 0) AS durationMs, AVG(ttft_ms) AS ttftMs,
        SUM(CASE WHEN ttft_ms IS NOT NULL AND duration_ms > ttft_ms THEN output_tokens END) AS streamedTokens,
        SUM(CASE WHEN ttft_ms IS NOT NULL AND duration_ms > ttft_ms THEN duration_ms - ttft_ms END) AS streamedMs
      FROM api_requests WHERE ${filtered}`,
      )
      .get(...values) as Record<string, number | null>;
    const bucket = query.bucketMinutes * 60_000,
      offset = query.offsetMinutes * 60_000;
    const series = this.database
      .prepare(
        `SELECT CAST((at + ?) / ? AS INTEGER) AS bucket, COUNT(*) AS requests, SUM(cost_usd) AS costUsd,
        SUM(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens) AS tokens
      FROM api_requests WHERE ${filtered} GROUP BY bucket ORDER BY bucket`,
      )
      .all(offset, bucket, ...values) as {
      bucket: number;
      requests: number;
      costUsd: number;
      tokens: number;
    }[];
    const { streamedTokens, streamedMs, ...sums } = total;
    return {
      rows: rows.slice(0, query.limit).map((row) => ({
        id: row.id as number,
        at: new Date(row.at as number).toISOString(),
        sessionId: row.session_id as string | null,
        sessionTitle: row.session_id ? title(row.session_id as string) : null,
        model: row.model as string,
        inputTokens: row.input_tokens as number,
        outputTokens: row.output_tokens as number,
        cacheReadTokens: row.cache_read_tokens as number,
        cacheCreationTokens: row.cache_creation_tokens as number,
        costUsd: row.cost_usd as number,
        durationMs: row.duration_ms as number,
        ttftMs: row.ttft_ms as number | null,
        source: row.source as string | null,
      })),
      hasMore: rows.length > query.limit,
      totals: {
        ...(sums as Page['totals']),
        outputPerSecond: streamedTokens && streamedMs ? streamedTokens / (streamedMs / 1000) : null,
      },
      // The model list ignores the model filter so the filter can be changed from any selection.
      models: (
        this.database
          .prepare(
            `SELECT DISTINCT model FROM api_requests WHERE ${conditions.join(' AND ')} ORDER BY model`,
          )
          .all(...range) as { model: string }[]
      ).map((row) => row.model),
      series: series.map((item) => ({
        at: new Date(item.bucket * bucket - offset).toISOString(),
        requests: item.requests,
        tokens: item.tokens,
        costUsd: item.costUsd,
      })),
    };
  }
  prune(now = Date.now()) {
    this.database
      .prepare('DELETE FROM api_requests WHERE at < ?')
      .run(now - this.retentionDays * 24 * 3600_000);
    this.database
      .prepare(
        'DELETE FROM api_requests WHERE id <= (SELECT id FROM api_requests ORDER BY id DESC LIMIT 1 OFFSET ?)',
      )
      .run(this.maxRows);
  }
}
function asArray(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

// Loopback only: the CLI processes on this host are the only senders.
export function createUsageReceiver(log: UsageLog) {
  const server = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/logs') {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) request.destroy();
      else chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        log.ingest(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        response.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
      } catch {
        response.writeHead(400).end();
      }
    });
  });
  const timer = setInterval(() => log.prune(), 3600_000);
  timer.unref();
  return {
    async listen() {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          server.off('error', reject);
          resolve();
        });
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No listening address');
      return `http://127.0.0.1:${address.port}/v1/logs`;
    },
    async close() {
      clearInterval(timer);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
