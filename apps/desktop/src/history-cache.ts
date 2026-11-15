import type { HistoryCursor, Session, SessionEvent } from '@cc-desk-tunnel/protocol';
export type CachedPage = {
  session: Session;
  events: SessionEvent[];
  firstSequence: number;
  lastSequence: number;
  hasEarlier: boolean;
  cursor: HistoryCursor;
  gap: boolean;
};
export type CacheStats = { bytes: number; sessions: number; events: number };
export type CacheCommand = { url: string } & (
  | { type: 'list' | 'stats' | 'clear' }
  | { type: 'catalog'; sessions: Session[] }
  | { type: 'metadata'; session: Session }
  | { type: 'remove'; sessionId: string }
  | { type: 'read'; sessionId: string; beforeSequence?: number; offline: boolean }
  | {
      type: 'save';
      session: Session;
      events: SessionEvent[];
      cursor: HistoryCursor;
      range: [number, number];
      reset?: boolean;
      generation: number;
    }
);
export type CacheReply = {
  value: Session[] | CachedPage | { missingAfter: number } | null;
  generation: number;
};
export type CachePort = (command: CacheCommand) => Promise<unknown>;

// Persistent history uses the same events as the live client; this adapter owns only local writes.
export class ClientHistoryCache {
  generation = 0;
  readonly url: string;
  private port: CachePort;
  private failed: (error: Error) => void;
  constructor(url: string, port: CachePort, failed: (error: Error) => void) {
    this.url = url;
    this.port = port;
    this.failed = failed;
  }
  async list() {
    const result = (await this.port({ type: 'list', url: this.url })) as CacheReply;
    this.generation = Math.max(this.generation, result.generation);
    return result.value as Session[];
  }
  async read(sessionId: string, beforeSequence?: number, offline = false) {
    const result = (await this.port({
      type: 'read',
      url: this.url,
      sessionId,
      beforeSequence,
      offline,
    })) as CacheReply;
    this.generation = Math.max(this.generation, result.generation);
    return result.value as CachedPage | { missingAfter: number } | null;
  }
  write(
    command:
      | Omit<Extract<CacheCommand, { type: 'save' }>, 'url'>
      | { type: 'catalog'; sessions: Session[] }
      | { type: 'metadata'; session: Session }
      | { type: 'remove'; sessionId: string },
  ) {
    void this.port({ ...command, url: this.url }).catch((error) =>
      this.failed(error instanceof Error ? error : new Error(String(error))),
    );
  }
  stats() {
    return this.port({ type: 'stats', url: this.url }) as Promise<CacheStats>;
  }
  async clear() {
    const result = (await this.port({ type: 'clear', url: this.url })) as CacheReply;
    this.generation = Math.max(this.generation, result.generation);
  }
}
