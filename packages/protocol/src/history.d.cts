import type { DatabaseSync } from 'node:sqlite';
import type { HistoryPage, SessionEvent } from './index.ts';
export function readEvents(
  database: DatabaseSync,
  sessionId: string,
  after?: number,
  before?: number,
): SessionEvent[];
export function readHistory(
  database: DatabaseSync,
  sessionId: string,
  after?: number,
  before?: number,
  lower?: number,
): Pick<HistoryPage, 'mode' | 'events' | 'firstSequence' | 'lastSequence' | 'hasEarlier'>;
