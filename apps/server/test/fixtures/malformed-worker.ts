import { randomUUID } from 'node:crypto';
import type { CodexParentMessage } from '@cc-desk-tunnel/agent-ipc';

let generation = 0;

process.on('message', (message: CodexParentMessage) => {
  if (message.type === 'init') {
    generation = message.generation;
    process.send?.({ type: 'ready', generation });
    return;
  }
  if (message.type === 'shutdown') process.exit(0);
  if (message.type !== 'run.start' || message.generation !== generation) return;
  const sessionId = message.run.sessionId;
  process.send?.('nope');
  process.send?.({
    type: 'event',
    generation,
    sessionId,
    payload: { type: 'not-an-event' },
  });
  process.send?.({
    type: 'event',
    generation,
    sessionId,
    payload: { type: 'text.delta', messageId: randomUUID(), text: 'boom' },
  });
  process.send?.({
    type: 'event',
    generation,
    sessionId,
    payload: { type: 'text.delta', messageId: randomUUID(), text: '合法' },
  });
  process.send?.({
    type: 'run.finished',
    generation,
    sessionId,
    status: 'completed',
  });
});
