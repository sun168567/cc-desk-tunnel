import type { CodexParentMessage } from '@cc-desk-tunnel/agent-ipc';

process.on('message', (message: CodexParentMessage) => {
  if (message.type === 'shutdown') process.exit(0);
});
