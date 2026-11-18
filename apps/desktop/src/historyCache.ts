import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import type { SessionEvent } from '@cc-desk-tunnel/protocol';

// The history read from the service, kept in this browser profile (one per connection on the desktop) so that a
// session opened again shows at once and asks the service only for what came since.
//
// A session's events never change once recorded, and a session's id is never used again, so what is kept stays
// true until the session is deleted or the service rewrites its history (it then names it anew). What is kept is
// never trusted on its own: opening a session tells the service which event it ends at, and the service says if
// that no longer holds. Anything going wrong here only means reading from the service, as without it.
//
// Each session's record says which stretches of it are held whole, as ranges (after, through]: every event
// numbered above `after` up to `through`. A write says what it covers itself, from what the service sent, so it
// holds whatever was written before it, and IndexedDB runs the transactions in the order they were made.

export type Range = [after: number, through: number];
type Held = { id: string; ranges: Range[] };
type Kept = { sessionId: string; sequence: number; size: number; event: SessionEvent };
export type HeldPage = { events: SessionEvent[]; hasEarlier: boolean };

// The service's page: whole runs, up to about this many events or this much text.
const pageEvents = 1000;
const pageSize = 512 * 1024;

export function addRange(ranges: Range[], range: Range): Range[] {
  const joined: Range[] = [];
  for (const [after, through] of [...ranges, range].sort((a, b) => a[0] - b[0])) {
    if (through <= after) continue;
    const last = joined.at(-1);
    if (last && after <= last[1]) last[1] = Math.max(last[1], through);
    else joined.push([after, through]);
  }
  return joined;
}
// The stretch held right below `before`, if there is any to read.
export function heldBelow(ranges: Range[], before: number) {
  return ranges.find(([after, through]) => after < before - 1 && through >= before - 1);
}
// Where a page fetched below `before` can stop: the end of what is held further down.
export function heldUnder(ranges: Range[], before: number) {
  return Math.max(0, ...ranges.filter(([, through]) => through < before - 1).map(([, t]) => t));
}

const done = (transaction: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = transaction.onabort = () => reject(transaction.error);
  });
const result = <T>(request: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
const all = (sessionId: string) => IDBKeyRange.bound([sessionId, 0], [sessionId, Infinity]);

export class HistoryCache {
  // Known once a service has said which history it keeps; until then nothing kept is used.
  historyId: string | null = null;
  private database: Promise<IDBDatabase | null>;

  constructor(name = 'history') {
    this.database =
      typeof indexedDB === 'undefined'
        ? Promise.resolve(null)
        : new Promise<IDBDatabase | null>((resolve) => {
            const request = indexedDB.open(name, 1);
            // A later layout starts over rather than converting what is kept.
            request.onupgradeneeded = () => {
              const database = request.result;
              for (const store of [...database.objectStoreNames]) database.deleteObjectStore(store);
              database.createObjectStore('about');
              database.createObjectStore('sessions', { keyPath: 'id' });
              database.createObjectStore('events', { keyPath: ['sessionId', 'sequence'] });
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = request.onblocked = () => resolve(null);
          });
  }
  get ready() {
    return this.historyId !== null;
  }

  // Every operation makes its transaction when the database is open, in the order they were asked for.
  private run<T>(
    stores: string[],
    mode: IDBTransactionMode,
    work: (transaction: IDBTransaction) => Promise<T> | T,
  ): Promise<T | null> {
    return this.database.then(async (database) => {
      if (!database) return null;
      const transaction = database.transaction(stores, mode);
      const [value] = await Promise.all([work(transaction), done(transaction)]);
      return value;
    });
  }
  // Writes are best effort: a failed one leaves the service to supply what it would have held.
  private quietly(work: Promise<unknown>) {
    work.catch((error: unknown) => console.warn('对话缓存写入失败', error));
  }

  // The history the service keeps now. Kept history of another one, or of another protocol, goes.
  use(historyId: string) {
    this.historyId = historyId;
    const name = `${historyId}/${PROTOCOL_VERSION}`;
    this.quietly(
      this.run(['about', 'sessions', 'events'], 'readwrite', async (transaction) => {
        const about = transaction.objectStore('about');
        if ((await result(about.get('history'))) === name) return;
        transaction.objectStore('sessions').clear();
        transaction.objectStore('events').clear();
        about.put(name, 'history');
      }),
    );
  }
  // Sessions the service no longer has, deleted while this client was away, go.
  retain(sessionIds: string[]) {
    const known = new Set(sessionIds);
    this.quietly(
      this.run(['sessions', 'events'], 'readwrite', async (transaction) => {
        for (const id of await result(transaction.objectStore('sessions').getAllKeys()))
          if (!known.has(String(id))) this.remove(transaction, String(id));
      }),
    );
  }
  write(sessionId: string, events: SessionEvent[], range: Range) {
    if (!this.ready || (!events.length && range[1] <= range[0])) return;
    this.quietly(
      this.run(['sessions', 'events'], 'readwrite', async (transaction) => {
        const store = transaction.objectStore('events');
        for (const event of events)
          store.put({
            sessionId,
            sequence: event.sequence,
            size: JSON.stringify(event).length,
            event,
          } satisfies Kept);
        const sessions = transaction.objectStore('sessions');
        const held = (await result(sessions.get(sessionId))) as Held | undefined;
        sessions.put({ id: sessionId, ranges: addRange(held?.ranges ?? [], range) } satisfies Held);
      }),
    );
  }
  drop(sessionId: string) {
    this.quietly(
      this.run(['sessions', 'events'], 'readwrite', (transaction) =>
        this.remove(transaction, sessionId),
      ),
    );
  }
  clear() {
    this.quietly(
      this.run(['sessions', 'events'], 'readwrite', (transaction) => {
        transaction.objectStore('sessions').clear();
        transaction.objectStore('events').clear();
      }),
    );
  }
  private remove(transaction: IDBTransaction, sessionId: string) {
    transaction.objectStore('sessions').delete(sessionId);
    transaction.objectStore('events').delete(all(sessionId));
  }

  // The newest page held of a session, to show while the service is asked for what came since.
  async latest(sessionId: string): Promise<HeldPage | null> {
    if (!this.ready) return null;
    return this.read(sessionId, (ranges) => ranges.at(-1), Infinity).catch(() => null);
  }
  // The page held right below `before`, or where the service's page can stop if none is held.
  async earlier(sessionId: string, before: number): Promise<HeldPage | { after: number } | null> {
    if (!this.ready) return null;
    try {
      let ranges: Range[] = [];
      const page = await this.read(sessionId, (held) => heldBelow((ranges = held), before), before);
      return page?.events.length ? page : { after: heldUnder(ranges, before) };
    } catch {
      return null;
    }
  }
  // Whole runs from the end of a held stretch down, as the service pages them.
  private async read(
    sessionId: string,
    stretch: (ranges: Range[]) => Range | undefined,
    before: number,
  ): Promise<HeldPage | null> {
    return this.run(['sessions', 'events'], 'readonly', async (transaction) => {
      const held = (await result(transaction.objectStore('sessions').get(sessionId))) as
        Held | undefined;
      const range = held && stretch(held.ranges);
      if (!range) return null;
      const events: SessionEvent[] = [];
      let size = 0;
      let more = false;
      await new Promise<void>((resolve, reject) => {
        const request = transaction
          .objectStore('events')
          .openCursor(
            IDBKeyRange.bound(
              [sessionId, range[0]],
              [sessionId, Math.min(before, range[1] + 1)],
              true,
              true,
            ),
            'prev',
          );
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return resolve();
          const kept = cursor.value as Kept;
          const full = events.length >= pageEvents || size >= pageSize;
          if (full && kept.event.runId !== events.at(-1)!.runId) {
            more = true;
            return resolve();
          }
          events.push(kept.event);
          size += kept.size;
          cursor.continue();
        };
      });
      return { events: events.reverse(), hasEarlier: more || range[0] > 0 };
    });
  }

  async stats() {
    const counts = await this.run(['sessions', 'events'], 'readonly', async (transaction) => ({
      sessions: await result(transaction.objectStore('sessions').count()),
      events: await result(transaction.objectStore('events').count()),
    })).catch(() => null);
    if (!counts) return null;
    const estimate = await navigator.storage?.estimate?.().catch(() => undefined);
    return { ...counts, bytes: estimate?.usage ?? null };
  }
}
