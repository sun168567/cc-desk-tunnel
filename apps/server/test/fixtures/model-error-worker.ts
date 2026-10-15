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
  process.send?.({
    type: 'event',
    generation,
    sessionId: message.run.sessionId,
    payload: { type: 'run.error', code: 'model_error', message: '这个模型不可用。' },
  });
  process.send?.({
    type: 'run.finished',
    generation,
    sessionId: message.run.sessionId,
    status: 'failed',
  });
});
