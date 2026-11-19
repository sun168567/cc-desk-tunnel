import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { EventPayload, PermissionMode } from '@cc-desk-tunnel/protocol';
import { runClaude } from '../src/claude.ts';
import type { PlanDecision } from '../src/claude.ts';
import { NativeInput } from '../src/native-input.ts';
import { results, scriptedEnvironment, scriptedModel, turns } from './fixtures/scripted-model.ts';
import type { ModelRequest, Script } from './fixtures/scripted-model.ts';

// Plan mode through the real Claude Code, the one the Agent SDK installs, run by the service's own adapter, with a
// scripted model in place of Claude: what the CLI does with a plan and the user's decision on it, and what the
// service makes of what it reports. `CLAUDE_PATH` names another CLI to run.
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

const PLAN = '# 计划：改进 README\n\n1. 补一段安装说明\n2. 补一段使用示例\n';
const strings = (value: unknown): string[] =>
  typeof value === 'string'
    ? [value]
    : Array.isArray(value)
      ? value.flatMap(strings)
      : value && typeof value === 'object'
        ? Object.values(value).flatMap(strings)
        : [];
// Where plan mode tells Claude to write its plan.
const planPath = (request: ModelRequest) =>
  strings(request.messages)
    .map((text) => text.match(/([^\s"'`<>]*[\\/]plans[\\/][^\s"'`<>]+?\.md)/)?.[1])
    .find(Boolean);
// Claude as plan mode asks it to be: the plan written to its file, then asked to be carried out; once approved, a
// file of the project written, and once sent back, more planning promised.
const planning =
  (work: string): Script =>
  (request) => {
    const path = planPath(request);
    const step = turns(request) - (path ? 1 : 0);
    if (step < 0) return [{ tool: 'Write', input: { file_path: path!, content: PLAN } }];
    if (step === 0) return [{ tool: 'ExitPlanMode', input: path ? {} : { plan: PLAN } }];
    if (step === 1)
      return results(request).some((result) => result.is_error)
        ? [{ text: '好的，按意见继续规划。' }]
        : [{ tool: 'Write', input: { file_path: work, content: 'hi\n' } }];
    return [{ text: '完成。' }];
  };

async function run(
  mode: PermissionMode,
  script: (work: string) => Script,
  decide: (kind: string) => { allowed: boolean; plan?: PlanDecision },
) {
  const home = mkdtempSync(join(tmpdir(), 'plan-cli-'));
  const sessionId = randomUUID();
  const work = join(home, 'data', 'native', sessionId, 'hello.txt');
  const model = await scriptedModel(script(work));
  const events: EventPayload[] = [];
  const asked: string[] = [];
  const input = new NativeInput(sessionId, (event) => events.push(event));
  input.submit(randomUUID(), '给 README 做个改进计划，然后执行。');
  try {
    const status = await runClaude(
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
        permissionMode: mode,
        input,
        dataDir: join(home, 'data'),
        resume: false,
        signal: new AbortController().signal,
        emit: (event) => events.push(event),
        approve: async (_toolId, kind) => {
          asked.push(kind);
          return decide(kind);
        },
        waiting: () => {},
        turnEnded: () => {},
        controls: {},
      },
    );
    const plans = join(home, '.claude', 'plans');
    const planId = events.find(
      (event) => event.type === 'tool.requested' && event.name === 'ExitPlanMode',
    );
    return {
      status,
      events,
      asked,
      requests: model.requests,
      wrote: existsSync(work),
      planFiles: existsSync(plans)
        ? readdirSync(plans).map((name) => readFileSync(join(plans, name), 'utf8'))
        : [],
      modes: events.flatMap((event) =>
        event.type === 'native.mode' ? [event.permissionMode] : [],
      ),
      // What the plan's request showed last.
      plan: events.findLast(
        (event) =>
          (event.type === 'tool.requested' || event.type === 'tool.input') &&
          planId?.type === 'tool.requested' &&
          event.toolId === planId.toolId,
      ),
    };
  } finally {
    await model.close();
    rmSync(home, { recursive: true, force: true });
  }
}
const said = (requests: ModelRequest[]) =>
  strings(requests.map((request) => request.messages)).join('\n');

test(
  'a plan approved in a mode is carried out in it, and the session is told of the mode',
  { skip },
  async () => {
    const result = await run('plan', planning, (kind) =>
      kind === 'plan' ? { allowed: true, plan: { mode: 'acceptEdits' } } : { allowed: true },
    );
    assert.equal(result.status, 'completed');
    // The CLI puts the plan in the input of the request; edits in the mode chosen are not asked about.
    assert.ok(result.plan?.type === 'tool.input' && result.plan.input.includes('补一段安装说明'));
    assert.deepEqual(result.asked, ['plan']);
    assert.deepEqual(result.modes, ['acceptEdits']);
    assert.ok(result.wrote);
  },
);

test(
  'a plan changed before it is approved is carried out as changed, and Claude is told so',
  { skip },
  async () => {
    const edited = '# 改过的计划\n\n1. 只补安装说明\n';
    const result = await run('plan', planning, (kind) =>
      kind === 'plan' ? { allowed: true, plan: { edited } } : { allowed: true },
    );
    assert.equal(result.status, 'completed');
    // The input shown is the plan carried out; the CLI writes it back to the plan file.
    assert.ok(result.plan?.type === 'tool.input' && result.plan.input.includes('只补安装说明'));
    assert.ok(result.planFiles.some((text) => text.includes('只补安装说明')));
    assert.match(said(result.requests), /edited by user/);
    // Approved without a mode, the CLI asks about edits: the next write is asked about.
    assert.deepEqual(result.modes, ['default']);
    assert.deepEqual(result.asked, ['plan', 'approval']);
  },
);

test(
  'a plan sent back reaches Claude with the feedback, and the mode stays',
  { skip },
  async () => {
    const result = await run('plan', planning, () => ({
      allowed: false,
      plan: { feedback: '先别动使用示例' },
    }));
    assert.equal(result.status, 'completed');
    assert.match(said(result.requests), /keep planning\. Their feedback:\n先别动使用示例/);
    assert.deepEqual(result.modes, []);
    assert.ok(!result.wrote);
  },
);

test('Claude going into plan mode by itself is told to the session', { skip }, async () => {
  const result = await run(
    'default',
    () => (request) =>
      turns(request) === 0 ? [{ tool: 'EnterPlanMode', input: {} }] : [{ text: '先调研。' }],
    () => ({ allowed: true }),
  );
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.modes, ['plan']);
  assert.deepEqual(result.asked, []);
});
