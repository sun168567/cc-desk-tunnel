import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  continues,
  isFragment,
  platformOf,
  snapshotSchema,
  sessionSchema,
  terminalStatuses,
} from '@cc-desk-tunnel/protocol';
import { deviceTerms } from './device-terms.ts';
import { DomainError } from './errors.ts';
import type {
  Device,
  Effort,
  EventPayload,
  HistoryPage,
  PermissionMode,
  Session,
  SessionEvent,
  SessionSnapshot,
} from '@cc-desk-tunnel/protocol';

function toolSummary(input: string) {
  try {
    const value = JSON.parse(input) as {
      command?: unknown;
      file_path?: unknown;
      questions?: { question?: unknown }[];
    };
    if (typeof value.command === 'string') return value.command;
    if (typeof value.file_path === 'string') return value.file_path;
    const question = value.questions?.find((item) => typeof item.question === 'string')?.question;
    if (typeof question === 'string') return question;
  } catch {
    // The raw input is still something the next thread can read.
  }
  return input;
}

type StoredSession = SessionSnapshot & { createRequestId: string };
const pageEvents = 1000;
const pageBytes = 512 * 1024;

// What goes beside the copy of the history made before it is rewritten.
const backupNote = (file: string) => `CC Desk Tunnel：会话历史备份

${file} 是升级前的会话库（sessions.sqlite）的完整副本，在服务端第一次以新版本启动、整理会话历史之前生成。

为什么会有它
  旧版本把 Claude 输出的每一小段文字各存为一条记录。新版本改为一段输出只存一条，并在升级时把已有的
  记录按同样的方式合并。合并不改变任何会话的内容，只减少记录的条数和文件的大小。这份副本是合并之前的原样。

什么时候用得上
  正常情况下用不上。合并后的会话库旧版本也能直接读取，退回旧版本不需要这份副本。
  只有在升级后发现某个会话的历史内容不对时，才需要用它恢复。

如何恢复
  1. 停止服务。
  2. 在数据目录里删除 sessions.sqlite、sessions.sqlite-wal、sessions.sqlite-shm（后两个可能不存在）。
  3. 把 ${file} 复制到数据目录，改名为 sessions.sqlite。
  4. 启动服务。服务会重新备份并再次合并。
  注意：恢复之后，升级以来新产生的会话和消息不在其中。

确认一切正常后，这个目录可以整个删除。

---

${file} is a full copy of the session library (sessions.sqlite) as it was before the service, started in a new
version for the first time, merged the records of streamed output: one record for a stretch of output where
there was one for each piece. No content changes. Older versions read the merged library as it is. To go back
to the copy: stop the service, delete sessions.sqlite, sessions.sqlite-wal and sessions.sqlite-shm from the
data directory, copy ${file} there as sessions.sqlite and start the service; what was added since the upgrade
is not in it. Once all is well this directory can be deleted.
`;

// Reading a session's native state when it is opened is not use of it: these do not move it up the list.
const stateReadings = new Set<EventPayload['type']>(['native.capabilities', 'native.metrics']);

export class SessionStore {
  directory: string;
  database: DatabaseSync;
  // Sessions as last read or written: an event is recorded without reading its session back.
  private known = new Map<string, { record: string; createRequestId: string }>();

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
      this.restoreUpdatedAt();
      this.mergeFragments();
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

  // Sessions that had only been looked at carry the time of that look; they get back the time of what last
  // happened in them.
  private restoreUpdatedAt() {
    if (this.database.prepare("SELECT 1 FROM migrations WHERE name = 'updated-at-activity'").get())
      return;
    const kinds = [...stateReadings].map((kind) => `'${kind}'`).join(', ');
    const last = this.database.prepare(
      'SELECT data FROM events WHERE session_id = ? ORDER BY sequence DESC LIMIT 1',
    );
    const activity = this.database.prepare(
      `SELECT data FROM events WHERE session_id = ? AND json_extract(data, '$.payload.type') NOT IN (${kinds})
      ORDER BY sequence DESC LIMIT 1`,
    );
    this.database.exec('BEGIN');
    try {
      for (const session of this.list()) {
        const row = last.get(session.id);
        if (!row) continue;
        const event = JSON.parse(String(row.data)) as SessionEvent;
        if (!stateReadings.has(event.payload.type) || session.updatedAt !== event.createdAt)
          continue;
        const before = activity.get(session.id);
        session.updatedAt = before
          ? (JSON.parse(String(before.data)) as SessionEvent).createdAt
          : session.createdAt;
        this.save(session);
      }
      this.database.prepare("INSERT INTO migrations VALUES ('updated-at-activity')").run();
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  // Output used to be stored a piece at a time and put together when read. It is stored whole now, and what
  // is already there is put together once, after a copy of the library has been set aside. An event that
  // takes in the ones before it keeps its own number, so the numbers clients hold stay good.
  private mergeFragments() {
    if (this.database.prepare("SELECT 1 FROM migrations WHERE name = 'merged-fragments'").get())
      return;
    const before = Number(
      this.database.prepare('SELECT COUNT(*) AS count FROM events').get()!.count,
    );
    if (!before) {
      this.database.prepare("INSERT INTO migrations VALUES ('merged-fragments')").run();
      return;
    }
    const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
    const backups = join(this.directory, 'backups', `history-${stamp}`);
    const file = `sessions-${stamp}.sqlite`;
    mkdirSync(backups, { recursive: true, mode: 0o700 });
    this.database.exec(`VACUUM INTO '${join(backups, file).replaceAll("'", "''")}'`);
    if (process.platform !== 'win32') chmodSync(join(backups, file), 0o600);
    writeFileSync(join(backups, 'README.txt'), backupNote(file), { mode: 0o600 });
    const rows = this.database.prepare(
      'SELECT sequence, data FROM events WHERE session_id = ? ORDER BY sequence',
    );
    const rewrite = this.database.prepare(
      'UPDATE events SET data = ? WHERE session_id = ? AND sequence = ?',
    );
    const remove = this.database.prepare(
      'DELETE FROM events WHERE session_id = ? AND sequence >= ? AND sequence < ?',
    );
    this.database.exec('BEGIN');
    try {
      for (const session of this.database.prepare('SELECT id FROM sessions').all()) {
        const id = String(session.id);
        // The stretch being put together: its first number, and its last event holding all of the text.
        let open: { first: number; event: SessionEvent; merged: boolean } | undefined;
        const close = () => {
          if (open?.merged) {
            remove.run(id, open.first, open.event.sequence);
            rewrite.run(JSON.stringify(open.event), id, open.event.sequence);
          }
          open = undefined;
        };
        for (const row of rows.all(id)) {
          const event = JSON.parse(String(row.data)) as SessionEvent;
          const payload = event.payload;
          const last = open?.event.payload;
          if (
            open &&
            last &&
            isFragment(payload) &&
            isFragment(last) &&
            event.runId === open.event.runId &&
            continues(last, payload)
          ) {
            open.event = { ...event, payload: { ...payload, text: last.text + payload.text } };
            open.merged = true;
            continue;
          }
          close();
          if (isFragment(payload)) open = { first: event.sequence, event, merged: false };
        }
        close();
      }
      this.database.prepare("INSERT INTO migrations VALUES ('merged-fragments')").run();
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    const after = Number(
      this.database.prepare('SELECT COUNT(*) AS count FROM events').get()!.count,
    );
    // Giving the space back is worth having and nothing depends on it.
    try {
      this.database.exec(
        'PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA wal_checkpoint(TRUNCATE);',
      );
    } catch {}
    console.log(
      `Session history merged: ${before} records are now ${after}. The library as it was is kept in ${backups}`,
    );
  }

  list(): Session[] {
    return this.database
      .prepare('SELECT metadata FROM sessions')
      .all()
      .map((row) => sessionSchema.parse(JSON.parse(String(row.metadata))))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  private entry(sessionId: string) {
    let entry = this.known.get(sessionId);
    if (!entry) {
      const row = this.database
        .prepare('SELECT metadata, create_request_id FROM sessions WHERE id = ?')
        .get(sessionId);
      if (!row) throw new DomainError('not_found', '会话不存在。');
      entry = {
        record: JSON.stringify(sessionSchema.parse(JSON.parse(String(row.metadata)))),
        createRequestId: String(row.create_request_id),
      };
      this.known.set(sessionId, entry);
    }
    return entry;
  }
  // The caller gets its own copy: what it changes counts once it is saved.
  get(sessionId: string): StoredSession {
    const entry = this.entry(sessionId);
    const store = this;
    return {
      session: JSON.parse(entry.record) as Session,
      createRequestId: entry.createRequestId,
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

  create(
    requestId: string,
    title: string,
    projectPath: string,
    device: Device,
    provider: Session['provider'] = 'claude',
    profileId = 'default',
  ): Session {
    const row = this.database
      .prepare('SELECT metadata FROM sessions WHERE create_request_id = ?')
      .get(requestId);
    if (row) {
      const session = sessionSchema.parse(JSON.parse(String(row.metadata)));
      if (
        ((!session.autoTitle || title !== '新会话') && session.title !== title) ||
        session.projectPath !== projectPath ||
        session.provider !== provider ||
        session.profileId !== profileId
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
      provider,
      profileId,
      device,
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
  // Copies a session and its events before `beforeSequence` under `id`, onto the computer that asked and
  // into its directory there. Without native history to resume, the copy also drops the events that would
  // claim there is one.
  fork(
    requestId: string,
    sourceId: string,
    id: string,
    title: string,
    native: boolean,
    place: { device: Device; projectPath?: string },
    beforeSequence?: number,
    codexThreadId?: string,
  ): Session {
    const { session: source } = this.get(sourceId);
    const now = new Date().toISOString();
    const session: Session = {
      ...source,
      id,
      title,
      device: place.device,
      projectPath: place.projectPath ?? source.projectPath,
      autoTitle: false,
      nativeRoot: native ? (source.nativeRoot ?? source.id) : undefined,
      createdAt: now,
      updatedAt: now,
      activeRun: null,
    };
    // Sharing the source thread would make both sessions continue the same one.
    // A new id is Codex's own fork. Without one, the copy is the transcript.
    if (source.provider === 'openai') {
      if (codexThreadId) session.codexThreadId = codexThreadId;
      else delete session.codexThreadId;
    }
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
          events,
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
      events,
      firstSequence: first,
      lastSequence: events.at(-1)?.sequence ?? 0,
      // Numbers are not consecutive in history that was merged, so the first of a session need not be 1.
      hasEarlier:
        !!first &&
        !!this.database
          .prepare('SELECT 1 FROM events WHERE session_id = ? AND sequence < ? LIMIT 1')
          .get(sessionId, first),
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
    if (!stateReadings.has(payload.type)) session.updatedAt = event.createdAt;
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
      this.known.delete(sessionId);
      throw error;
    }
    return event;
  }

  delete(sessionId: string): void {
    const { session } = this.get(sessionId);
    if (session.activeRun) throw new DomainError('run_active', '请先停止运行再删除会话。');
    this.database.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
    this.known.delete(sessionId);
  }
  configure(
    sessionId: string,
    permissionMode: PermissionMode,
    model?: string | null,
    effort?: Effort | null,
    provider?: Session['provider'],
    profileId?: string,
  ) {
    const { session } = this.get(sessionId);
    if (session.activeRun) throw new DomainError('run_active', '请先结束当前运行再修改审批模式。');
    const switching = !!provider && provider !== session.provider;
    if (switching) {
      const spoken = this.database
        .prepare(
          "SELECT 1 FROM events WHERE session_id = ? AND json_extract(data, '$.payload.type') = 'message.user' LIMIT 1",
        )
        .get(sessionId);
      if (spoken)
        throw new DomainError(
          'invalid_argument',
          '这个会话已经有对话。新建一个会话，再在底部选择模型。',
        );
      session.provider = provider;
      session.profileId = profileId ?? 'default';
      delete session.codexThreadId;
      delete session.nativeRoot;
      delete session.prompt;
    }
    session.permissionMode = permissionMode;
    if (model !== undefined) session.model = model;
    if (switching) session.effort = null;
    else if (effort !== undefined) session.effort = effort;
    session.updatedAt = new Date().toISOString();
    this.save(session);
    return session;
  }
  // Keeps the Codex thread for the next turn.
  rememberCodexThread(sessionId: string, threadId: string) {
    const trimmed = threadId.trim();
    if (!trimmed || trimmed.length > 200) return;
    const { session } = this.get(sessionId);
    if (session.provider !== 'openai' || session.codexThreadId === trimmed) return;
    session.codexThreadId = trimmed;
    this.save(session);
  }
  // Text the model can read when a fork starts a new thread. The message being sent now is left out;
  // it is the turn itself. Only the tail is kept, so a long session does not become the whole request.
  modelHistory(sessionId: string, exceptMessageId?: string) {
    const lines: string[] = [];
    const clip = (text: string) => {
      const flat = text.replace(/\s+/g, ' ').trim();
      return flat.length <= 2000 ? flat : `${flat.slice(0, 2000)}…`;
    };
    for (const event of this.events(sessionId)) {
      const payload = event.payload;
      if (payload.type === 'message.user') {
        if (payload.messageId === exceptMessageId) continue;
        lines.push(`User: ${clip(payload.text)}`);
      } else if (payload.type === 'text.delta' && payload.text)
        lines.push(`Assistant: ${clip(payload.text)}`);
      else if (payload.type === 'tool.requested')
        lines.push(`Tool ${payload.name}: ${clip(toolSummary(payload.input))}`);
      else if (payload.type === 'tool.result')
        lines.push(
          `Tool result ${payload.status}${payload.output ? `: ${clip(payload.output)}` : ''}`,
        );
    }
    const text = lines.join('\n\n');
    const limit = 24_000;
    return text.length <= limit ? text : text.slice(text.length - limit);
  }
  // A resume that never started drops the id, so the next message begins a new thread.
  forgetCodexThread(sessionId: string) {
    const { session } = this.get(sessionId);
    if (session.provider !== 'openai' || !session.codexThreadId) return;
    delete session.codexThreadId;
    this.save(session);
  }
  // Points the session at a project directory on a computer, which may be another one than it was on. What
  // Claude knows of either changes with the next message: `notice`.
  move(sessionId: string, projectPath: string, device: Device) {
    const { session } = this.get(sessionId);
    if (session.activeRun) throw new DomainError('run_active', '请先结束当前运行再更换项目。');
    if (session.projectPath === projectPath && session.device?.id === device.id) return session;
    session.projectPath = projectPath;
    session.device = device;
    session.updatedAt = new Date().toISOString();
    this.save(session);
    return session;
  }
  // A session from before computers were told apart becomes that of the first one to use it, where it is.
  claim(sessionId: string, device: Device) {
    const { session } = this.get(sessionId);
    if (session.device) return session;
    session.device = device;
    if (session.prompt) {
      session.prompt.device ??= device.id;
      if (session.prompt.told) session.prompt.told.device ??= device.id;
    }
    this.save(session);
    return session;
  }
  // A computer goes by the name it last signed in with, in every session that is on it.
  named(device: Device) {
    const changed: Session[] = [];
    for (const session of this.list())
      if (session.device?.id === device.id && session.device.name !== device.name) {
        session.device = device;
        this.save(session);
        changed.push(session);
      }
    return changed;
  }
  // The text that tells Claude what its system prompt no longer has right, to go in front of the user's next
  // message: a project directory or a computer other than the one it knows, from the prompt or from an
  // earlier notice. It is given out once.
  notice(sessionId: string) {
    const { session } = this.get(sessionId);
    const said = session.prompt;
    if (!said || said.compacted) return '';
    const known = said.told ?? said;
    const device = session.device?.id;
    if (known.projectPath === session.projectPath && known.device === device) return '';
    const platform = platformOf(session.device);
    said.told = { projectPath: session.projectPath, device, platform };
    this.save(session);
    const terms = deviceTerms(platform, session.projectPath);
    // The prompt's account of scripts and command lines holds for one system only.
    const system =
      (known.platform ?? 'win32') === platform
        ? ''
        : ` It runs another system than the one described so far, and this replaces what was said of scripts and command lines. For device-script: ${terms.script} ${terms.command}`;
    const paths = `The project directory is now ${JSON.stringify(session.projectPath)} (it was ${JSON.stringify(known.projectPath)}).`;
    return known.device === device
      ? `[CC Desk Tunnel: the user moved this session to another project on the device. ${paths} From now on use the new directory as the project directory, in place of the one given earlier.]\n\n`
      : `[CC Desk Tunnel: the user now continues this session from another of their computers, ${JSON.stringify(session.device!.name)}. From now on the device is that computer: ${terms.name}. ${paths} What the earlier computer had, its files, paths and running processes, is not on this one unless you find it there.${system}]\n\n`;
  }
  // What the system prompt of a run says. A prompt that changes costs the whole conversation's prompt cache,
  // so it stays what it first was — through moves, which `notice` tells Claude of — until a compaction,
  // which rewrites everything after the prompt anyway; the run after that says what is current.
  promptValues(sessionId: string) {
    const { session } = this.get(sessionId);
    const said = session.prompt;
    if (said && !said.compacted)
      return { projectPath: said.projectPath, platform: said.platform ?? 'win32' };
    const now = {
      projectPath: session.projectPath,
      device: session.device?.id,
      platform: platformOf(session.device),
    };
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
    const record = JSON.stringify(session);
    this.database.prepare('UPDATE sessions SET metadata = ? WHERE id = ?').run(record, session.id);
    const entry = this.known.get(session.id);
    if (entry) entry.record = record;
  }
  close() {
    this.database.close();
  }
}
