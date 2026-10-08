import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { snapshotSchema, sessionSchema, terminalStatuses } from '@cc-desk-tunnel/protocol';
import { DomainError } from './errors.ts';
import type {
  Effort,
  EventPayload,
  HistoryPage,
  PermissionMode,
  Session,
  SessionEvent,
  SessionSnapshot,
} from '@cc-desk-tunnel/protocol';

type StoredSession = SessionSnapshot & { createRequestId: string };
const pageEvents = 1000;
const pageBytes = 512 * 1024;

function batchHistory(events: SessionEvent[]) {
  const result: SessionEvent[] = [];
  for (const event of events) {
    const previous = result.at(-1);
    const current = event.payload;
    const last = previous?.payload;
    if (
      previous &&
      last &&
      event.runId === previous.runId &&
      ((current.type === 'text.delta' &&
        last.type === 'text.delta' &&
        current.messageId === last.messageId) ||
        (current.type === 'thinking.delta' &&
          last.type === 'thinking.delta' &&
          current.messageId === last.messageId) ||
        (current.type === 'tool.input.delta' &&
          last.type === 'tool.input.delta' &&
          current.toolId === last.toolId) ||
        (current.type === 'tool.output' &&
          last.type === 'tool.output' &&
          current.toolId === last.toolId &&
          current.stream === last.stream))
    ) {
      result[result.length - 1] = {
        ...event,
        payload: { ...current, text: (last as typeof current).text + current.text },
      };
    } else result.push(event);
  }
  return result;
}

export class SessionStore {
  directory: string;
  database: DatabaseSync;

  constructor(directory: string) {
    this.directory = directory;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(join(directory, 'sessions.sqlite'));
    if (process.platform !== 'win32') chmodSync(join(directory, 'sessions.sqlite'), 0o600);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, metadata TEXT NOT NULL, create_request_id TEXT UNIQUE NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL, run_id TEXT NOT NULL, data TEXT NOT NULL,
        PRIMARY KEY (session_id, sequence)
      );
      CREATE INDEX IF NOT EXISTS events_run ON events(session_id, run_id, sequence);
      CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY);
    `);
    try {
      this.importJson();
      for (const session of this.list()) {
        if (!session.activeRun) continue;
        const { id: runId, connectionId } = session.activeRun;
        const events = this.runEvents(session.id, runId);
        const native = events.some((event) => event.payload.type === 'native.session');
        for (const event of events) {
          if (event.payload.type !== 'message.user') continue;
          const messageId = event.payload.messageId;
          const delivery = events.findLast(
            (item) =>
              item.payload.type === 'message.delivery' && item.payload.messageId === messageId,
          )?.payload;
          if (
            delivery?.type === 'message.delivery' &&
            ['submitted', 'queued'].includes(delivery.status)
          )
            this.append(session.id, runId, {
              type: 'message.delivery',
              messageId,
              status: delivery.status === 'submitted' ? 'not_sent' : 'unconfirmed',
            });
        }
        for (const event of events) {
          if (event.payload.type !== 'tool.requested') continue;
          const toolId = event.payload.toolId;
          if (
            events.some(
              (item) => item.payload.type === 'tool.result' && item.payload.toolId === toolId,
            )
          )
            continue;
          this.append(session.id, runId, {
            type: 'tool.result',
            toolId,
            status: native ? 'unknown' : 'cancelled',
            output: native
              ? '服务重启；工具最终执行结果未确认，不能自动重放。'
              : '服务重启；模拟工具未执行。',
            exitCode: null,
          });
        }
        this.append(session.id, runId, {
          type: 'run.status',
          status: 'cancelled',
          connectionId,
          reason: '服务重启，运行未重放。',
        });
      }
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  private importJson() {
    if (this.database.prepare('SELECT name FROM migrations WHERE name = ?').get('json-import'))
      return;
    this.database.exec('BEGIN');
    try {
      for (const file of readdirSync(this.directory).filter((file) => file.endsWith('.json'))) {
        const value = JSON.parse(readFileSync(join(this.directory, file), 'utf8'));
        const record = snapshotSchema.parse(value);
        if (
          file !== `${record.session.id}.json` ||
          typeof value.createRequestId !== 'string' ||
          record.events.some(
            (event, index) => event.sessionId !== record.session.id || event.sequence !== index + 1,
          )
        )
          throw new Error(`Invalid legacy session: ${file}`);
        this.database
          .prepare('INSERT INTO sessions VALUES (?, ?, ?)')
          .run(record.session.id, JSON.stringify(record.session), value.createRequestId);
        const insert = this.database.prepare('INSERT INTO events VALUES (?, ?, ?, ?)');
        for (const event of record.events)
          insert.run(event.sessionId, event.sequence, event.runId, JSON.stringify(event));
      }
      this.database.prepare('INSERT INTO migrations VALUES (?)').run('json-import');
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  list(): Session[] {
    return this.database
      .prepare('SELECT metadata FROM sessions')
      .all()
      .map((row) => sessionSchema.parse(JSON.parse(String(row.metadata))))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  get(sessionId: string): StoredSession {
    const row = this.database
      .prepare('SELECT metadata, create_request_id FROM sessions WHERE id = ?')
      .get(sessionId);
    if (!row) throw new DomainError('not_found', '会话不存在。');
    const store = this;
    return {
      session: sessionSchema.parse(JSON.parse(String(row.metadata))),
      createRequestId: String(row.create_request_id),
      get events() {
        return store.events(sessionId);
      },
    };
  }

  private events(sessionId: string, after = 0, before = Number.MAX_SAFE_INTEGER) {
    return this.database
      .prepare(
        'SELECT data FROM events WHERE session_id = ? AND sequence > ? AND sequence < ? ORDER BY sequence',
      )
      .all(sessionId, after, before)
      .map((row) => JSON.parse(String(row.data)) as SessionEvent);
  }
  private runEvents(sessionId: string, runId: string) {
    return this.database
      .prepare('SELECT data FROM events WHERE session_id = ? AND run_id = ? ORDER BY sequence')
      .all(sessionId, runId)
      .map((row) => JSON.parse(String(row.data)) as SessionEvent);
  }
  private lastSequence(sessionId: string) {
    return Number(
      this.database
        .prepare('SELECT COALESCE(MAX(sequence), 0) AS value FROM events WHERE session_id = ?')
        .get(sessionId)!.value,
    );
  }
  hasNativeContext(sessionId: string) {
    return !!this.database
      .prepare(
        "SELECT 1 FROM events WHERE session_id = ? AND json_extract(data, '$.payload.type') = 'native.session' LIMIT 1",
      )
      .get(sessionId);
  }
  userMessage(sessionId: string, messageId: string) {
    const row = this.database
      .prepare(
        "SELECT data FROM events WHERE session_id = ? AND json_extract(data, '$.payload.messageId') = ? AND json_extract(data, '$.payload.type') = 'message.user' LIMIT 1",
      )
      .get(sessionId, messageId);
    return row ? (JSON.parse(String(row.data)) as SessionEvent) : undefined;
  }

  create(requestId: string, title: string, projectPath: string): Session {
    const row = this.database
      .prepare('SELECT metadata FROM sessions WHERE create_request_id = ?')
      .get(requestId);
    if (row) {
      const session = sessionSchema.parse(JSON.parse(String(row.metadata)));
      if (
        ((!session.autoTitle || title !== '新会话') && session.title !== title) ||
        session.projectPath !== projectPath
      )
        throw new DomainError('request_conflict', '请求 ID 已被其他内容使用。');
      return session;
    }
    const now = new Date().toISOString();
    const session: Session = {
      id: randomUUID(),
      title,
      autoTitle: title === '新会话',
      projectPath,
      permissionMode: 'auto',
      model: null,
      effort: null,
      createdAt: now,
      updatedAt: now,
      activeRun: null,
    };
    this.database
      .prepare('INSERT INTO sessions VALUES (?, ?, ?)')
      .run(session.id, JSON.stringify(session), requestId);
    return session;
  }

  created(requestId: string) {
    const row = this.database
      .prepare('SELECT metadata FROM sessions WHERE create_request_id = ?')
      .get(requestId);
    return row ? sessionSchema.parse(JSON.parse(String(row.metadata))) : undefined;
  }
  // Where a fork that stops before this message cuts the history. Only a message that started its run
  // qualifies: cutting at one added mid-run would leave half a run behind.
  forkPoint(sessionId: string, messageId: string) {
    const event = this.userMessage(sessionId, messageId);
    if (!event) throw new DomainError('not_found', '消息不存在。');
    if (this.runEvents(sessionId, event.runId)[0]!.sequence !== event.sequence)
      throw new DomainError('fork_point', '运行途中追加的消息不能作为分叉点。');
    return event.sequence;
  }
  // Copies a session and its events before `beforeSequence` under `id`. Without native history to resume,
  // the copy also drops the events that would claim there is one.
  fork(
    requestId: string,
    sourceId: string,
    id: string,
    title: string,
    native: boolean,
    beforeSequence?: number,
  ): Session {
    const { session: source } = this.get(sourceId);
    const now = new Date().toISOString();
    const session: Session = {
      ...source,
      id,
      title,
      autoTitle: false,
      nativeRoot: native ? (source.nativeRoot ?? source.id) : undefined,
      createdAt: now,
      updatedAt: now,
      activeRun: null,
    };
    const events = this.events(sourceId, 0, beforeSequence).filter(
      ({ payload }) =>
        native || (payload.type !== 'native.session' && payload.type !== 'native.context'),
    );
    this.database.exec('BEGIN');
    try {
      this.database
        .prepare('INSERT INTO sessions VALUES (?, ?, ?)')
        .run(id, JSON.stringify(session), requestId);
      const insert = this.database.prepare('INSERT INTO events VALUES (?, ?, ?, ?)');
      events.forEach((event, index) => {
        const payload =
          'nativeSessionId' in event.payload
            ? { ...event.payload, nativeSessionId: id }
            : event.payload;
        const copy: SessionEvent = { ...event, sessionId: id, sequence: index + 1, payload };
        insert.run(id, copy.sequence, copy.runId, JSON.stringify(copy));
      });
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    return session;
  }

  snapshot(sessionId: string, afterSequence = 0): SessionSnapshot {
    const { session } = this.get(sessionId);
    if (afterSequence > this.lastSequence(sessionId))
      throw new DomainError('invalid_cursor', '恢复游标超出历史范围。');
    return { session, events: this.events(sessionId, afterSequence) };
  }

  history(
    sessionId: string,
    requestId: string,
    afterSequence = 0,
    beforeSequence?: number,
  ): HistoryPage {
    const { session } = this.get(sessionId);
    const last = this.lastSequence(sessionId);
    if (afterSequence > last || (beforeSequence !== undefined && beforeSequence > last + 1))
      throw new DomainError('invalid_cursor', '历史游标超出范围。');
    if (afterSequence > 0) {
      const size = this.database
        .prepare(
          'SELECT COUNT(*) AS count, COALESCE(SUM(length(data)), 0) AS bytes FROM events WHERE session_id = ? AND sequence > ?',
        )
        .get(sessionId, afterSequence)!;
      if (Number(size.count) <= pageEvents && Number(size.bytes) <= pageBytes) {
        const events = this.events(sessionId, afterSequence);
        return {
          session,
          requestId,
          mode: 'append',
          events: batchHistory(events),
          firstSequence: events[0]?.sequence ?? 0,
          lastSequence: last,
          hasEarlier: false,
        };
      }
    }
    // Keep a complete run together: a single unusually large run may exceed the soft page budget.
    const groups = this.database
      .prepare(
        `
      SELECT run_id, MIN(sequence) AS first, COUNT(*) AS count, SUM(length(data)) AS bytes
      FROM events WHERE session_id = ? AND sequence < ? GROUP BY run_id ORDER BY first DESC LIMIT 1000
    `,
      )
      .all(sessionId, beforeSequence ?? last + 1);
    let first = 0,
      count = 0,
      bytes = 0;
    for (const group of groups) {
      if (
        first &&
        (count + Number(group.count) > pageEvents || bytes + Number(group.bytes) > pageBytes)
      )
        break;
      first = Number(group.first);
      count += Number(group.count);
      bytes += Number(group.bytes);
    }
    const events = first ? this.events(sessionId, first - 1, beforeSequence) : [];
    return {
      session,
      requestId,
      mode: beforeSequence === undefined ? 'replace' : 'prepend',
      events: batchHistory(events),
      firstSequence: first,
      lastSequence: events.at(-1)?.sequence ?? 0,
      hasEarlier: first > 1,
    };
  }

  append(sessionId: string, runId: string, payload: EventPayload): SessionEvent {
    const { session } = this.get(sessionId);
    const event: SessionEvent = {
      sessionId,
      runId,
      sequence: this.lastSequence(sessionId) + 1,
      createdAt: new Date().toISOString(),
      payload,
    };
    session.updatedAt = event.createdAt;
    if (payload.type === 'run.status')
      session.activeRun = terminalStatuses.has(payload.status)
        ? null
        : {
            id: runId,
            status: payload.status,
            connectionId: payload.connectionId,
            ...(payload.surface ? { surface: payload.surface } : {}),
            ...(payload.waiting ? { waiting: payload.waiting } : {}),
          };
    this.database.exec('BEGIN');
    try {
      this.database
        .prepare('INSERT INTO events VALUES (?, ?, ?, ?)')
        .run(sessionId, event.sequence, runId, JSON.stringify(event));
      this.save(session);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    return event;
  }

  delete(sessionId: string): void {
    const { session } = this.get(sessionId);
    if (session.activeRun) throw new DomainError('run_active', '请先停止运行再删除会话。');
    this.database.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
  }
  configure(
    sessionId: string,
    permissionMode: PermissionMode,
    model?: string | null,
    effort?: Effort | null,
  ) {
    const { session } = this.get(sessionId);
    if (session.activeRun) throw new DomainError('run_active', '请先结束当前运行再修改审批模式。');
    session.permissionMode = permissionMode;
    if (model !== undefined) session.model = model;
    if (effort !== undefined) session.effort = effort;
    session.updatedAt = new Date().toISOString();
    this.save(session);
    return session;
  }
  // Points the session at another project. Once Claude has been told a path, the one it knows is kept until
  // the next message tells it of the move.
  move(sessionId: string, projectPath: string) {
    const { session } = this.get(sessionId);
    if (session.activeRun) throw new DomainError('run_active', '请先结束当前运行再更换项目。');
    if (session.projectPath === projectPath) return session;
    if (this.hasNativeContext(sessionId)) {
      const known = session.movedFrom ?? session.projectPath;
      session.movedFrom = known === projectPath ? undefined : known;
    }
    session.projectPath = projectPath;
    session.updatedAt = new Date().toISOString();
    this.save(session);
    return session;
  }
  // The text that tells Claude what its system prompt no longer has right, to go in front of the user's next
  // message: a move it has not heard of, and a PowerShell path on the connection in use that is not the one
  // it knows. Each is given out once.
  notice(sessionId: string, powershellPath?: string) {
    const { session } = this.get(sessionId);
    let text = '';
    if (session.movedFrom) {
      text += `[CC Desk Tunnel: the user moved this session to another Windows project. The project directory is now ${JSON.stringify(session.projectPath)} (it was ${JSON.stringify(session.movedFrom)}). From now on use the new directory as the project cwd, in place of the one given earlier.]\n\n`;
      session.movedFrom = undefined;
    }
    const said = session.prompt;
    const known = said && !said.compacted && (said.toldPowershellPath ?? said.powershellPath);
    if (said && known && powershellPath && known !== powershellPath) {
      text += `[CC Desk Tunnel: the PowerShell executable on the connected Windows computer is now ${JSON.stringify(powershellPath)} (it was ${JSON.stringify(known)}). From now on use the new path, in place of the one given earlier.]\n\n`;
      said.toldPowershellPath = powershellPath;
    }
    if (text) this.save(session);
    return text;
  }
  // What the system prompt of a run says, given the PowerShell path of the connection it runs on. A prompt
  // that changes costs the whole conversation's prompt cache, so it stays what it first was — through moves
  // and reconnects, which `notice` tells Claude of — until a compaction, which rewrites everything after
  // the prompt anyway; the run after that says what is current.
  promptValues(sessionId: string, powershellPath: string) {
    const { session } = this.get(sessionId);
    const said = session.prompt;
    if (said && !said.compacted) {
      if (!said.powershellPath) {
        said.powershellPath = powershellPath;
        this.save(session);
      }
      return { projectPath: said.projectPath, powershellPath: said.powershellPath };
    }
    const now = { projectPath: session.projectPath, powershellPath };
    session.prompt = now;
    this.save(session);
    return now;
  }
  compacted(sessionId: string) {
    const { session } = this.get(sessionId);
    if (!session.prompt || session.prompt.compacted) return;
    session.prompt.compacted = true;
    this.save(session);
  }
  rename(sessionId: string, title: string) {
    const { session } = this.get(sessionId);
    if (session.activeRun) throw new DomainError('run_active', '请先结束当前运行再改名。');
    session.title = title;
    session.autoTitle = false;
    session.updatedAt = new Date().toISOString();
    this.save(session);
    return session;
  }
  renameNative(sessionId: string, title: string) {
    const { session } = this.get(sessionId);
    session.title = title;
    this.save(session);
    return session;
  }
  private save(session: Session) {
    this.database
      .prepare('UPDATE sessions SET metadata = ? WHERE id = ?')
      .run(JSON.stringify(session), session.id);
  }
  close() {
    this.database.close();
  }
}
