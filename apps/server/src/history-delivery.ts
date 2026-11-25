import type { ServerMessage } from '@cc-desk-tunnel/protocol';
import { phrase } from '@cc-desk-tunnel/i18n';
import { DomainError } from './errors.ts';

// One page at a time per window. Pulling each part keeps a slow history from filling the
// WebSocket's send queue; the stored page and its captured live fragment stay unchanged.
const PART_CHARACTERS = 32 * 1024;
const IN_FLIGHT_PARTS = 4;
const IDLE_MS = 30_000;

export class HistoryDelivery {
  private current?: {
    requestId: string;
    sessionId: string;
    text: string;
    offset: number;
    outstanding: number;
    timer?: ReturnType<typeof setTimeout>;
    resolve: () => void;
    reject: (error: Error) => void;
  };
  private send: (message: ServerMessage) => void;
  constructor(send: (message: ServerMessage) => void) {
    this.send = send;
  }

  deliver(requestId: string, sessionId: string, messages: ServerMessage[]) {
    this.cancel();
    const text = JSON.stringify(messages);
    if (text.length <= PART_CHARACTERS) {
      for (const message of messages) this.send(message);
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      this.current = {
        requestId,
        sessionId,
        text,
        offset: 0,
        outstanding: 0,
        resolve,
        reject,
      };
      this.fill();
    });
  }

  next(requestId: string) {
    const current = this.current;
    if (!current || current.requestId !== requestId) return;
    current.outstanding--;
    this.fill();
  }

  private fill() {
    const current = this.current!;
    clearTimeout(current.timer);
    if (current.offset === current.text.length && !current.outstanding) {
      this.current = undefined;
      current.resolve();
      return;
    }
    current.timer = setTimeout(() => {
      this.current = undefined;
      current.reject(new DomainError('history_stalled', phrase('service:history.stalled')));
    }, IDLE_MS);
    while (current.outstanding < IN_FLIGHT_PARTS && current.offset < current.text.length) {
      const data = current.text.slice(current.offset, current.offset + PART_CHARACTERS);
      current.offset += data.length;
      current.outstanding++;
      this.send({
        type: 'session.history.part',
        requestId: current.requestId,
        sessionId: current.sessionId,
        data,
        last: current.offset === current.text.length,
      });
    }
  }

  cancel(requestId?: string) {
    const current = this.current;
    if (!current || (requestId && current.requestId !== requestId)) return;
    this.current = undefined;
    clearTimeout(current.timer);
    current.reject(new DomainError('history_cancelled', phrase('service:history.cancelled')));
  }
}
