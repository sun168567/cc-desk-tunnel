import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ParentMessage } from '@cc-desk-tunnel/agent-ipc';

const values = {
  autoCompactEnabled: null,
  autoCompactWindow: null,
  alwaysThinkingEnabled: null,
  showThinkingSummaries: null,
  fastMode: null,
  autoContinueAtUsageLimit: null,
  switchModelsOnFlag: null,
  autoMemoryEnabled: null,
  fileCheckpointingEnabled: null,
  promptCacheTtl: null,
  language: null,
  precomputeCompactionEnabled: null,
  autoDreamEnabled: null,
  subagentPromptCacheTtl: null,
  fallbackModel: null,
  askUserQuestionTimeout: null,
  bashOutputMaxChars: null,
  attribution: null,
  includeGitInstructions: null,
  toolSearch: null,
};

process.on('message', (message: ParentMessage) => {
  if (message.type === 'init') {
    appendFileSync(join(message.dataDir, 'claude-starts'), `${message.generation}\n`);
    process.send?.({ type: 'ready', generation: message.generation });
    return;
  }
  if (message.type === 'shutdown') process.exit(0);
  if (message.id && message.type === 'settings.get')
    process.send?.({
      type: 'reply',
      generation: message.generation,
      id: message.id,
      ok: true,
      result: values,
    });
});
