import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { EventPayload } from '@cc-desk-tunnel/protocol';
import { runClaude } from '../src/claude.ts';
import { NativeInput } from '../src/native-input.ts';
import { scriptedEnvironment, scriptedModel, turns } from './fixtures/scripted-model.ts';

// A removal Claude Code's own safety check stops, through the real Claude Code with a scripted model, in a session
// that bypasses permissions: the CLI asks all the same, and the service passes on that a safety check asks and why.
function bundledCli() {
  if (process.env.CLAUDE_PATH) return process.env.CLAUDE_PATH;
  try {
    const manifest = createRequire(import.meta.url).resolve(
      `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`,
    );
    const file = join(dirname(manifest), 'claude');
    return existsSync(file) ? file : null;
  } catch {
    return null;
  }
}
const cli = bundledCli();
const skip =
  process.platform === 'win32'
    ? 'the native adapter runs on Linux'
    : !cli
      ? 'no Claude Code installed for this system'
      : false;

test(
  'bypassing permissions, a removal the safety check cannot place is still asked about, and says why',
  { skip },
  async () => {
    const home = mkdtempSync(join(tmpdir(), 'safety-cli-'));
    const target = join(home, 'scratch');
    mkdirSync(target);
    writeFileSync(join(target, 'a.txt'), 'a');
    const sessionId = randomUUID();
    const model = await scriptedModel((request) =>
      turns(request) === 0
        ? [{ tool: 'Bash', input: { command: `cd ${target} && rm -f *` } }]
        : [{ text: '好了。' }],
    );
    const events: EventPayload[] = [];
    const asked: { kind: string; reason?: string; safetyCheck?: boolean }[] = [];
    const input = new NativeInput(sessionId, (event) => events.push(event));
    input.submit(randomUUID(), '清空 scratch 目录。');
    try {
      await runClaude(
        {
          executable: cli!,
          model: 'claude-sonnet-5-5',
          environment: scriptedEnvironment(model.url, home),
        },
        {
          sessionId,
          nativeRoot: sessionId,
          projectPath: home,
          execution: { platform: 'linux', shells: ['bash'] },
          permissionMode: 'bypassPermissions',
          input,
          dataDir: join(home, 'data'),
          resume: false,
          signal: new AbortController().signal,
          emit: (event) => events.push(event),
          approve: async (_toolId, kind, why) => {
            asked.push({ kind, ...why });
            return { allowed: false };
          },
          waiting: () => {},
          turnEnded: () => {},
          controls: {},
        },
      );
      assert.equal(asked.length, 1, JSON.stringify(asked));
      assert.equal(asked[0]!.kind, 'approval');
      assert.equal(asked[0]!.safetyCheck, true);
      assert.match(asked[0]!.reason ?? '', /rm/i);
      // Denied, the files stay.
      assert.ok(existsSync(join(target, 'a.txt')));
    } finally {
      await model.close();
      rmSync(home, { recursive: true, force: true });
    }
  },
);
