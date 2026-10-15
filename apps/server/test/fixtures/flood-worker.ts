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
  const messageId = randomUUID();
  for (let index = 0; index < 250; index++) {
    process.send?.({
      type: 'event',
      generation,
      sessionId: message.run.sessionId,
      payload: { type: 'text.delta', messageId, text: 'x' },
    });
  }
});
