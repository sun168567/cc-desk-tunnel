import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Command, EventPayload, PermissionMode } from '@cc-desk-tunnel/protocol';
import { keepPlanning, type PlanDecision } from './claude.ts';
import type { Run } from './server.ts';

type Host = {
  stepMs: number;
  projectPath: () => string;
  permissionMode: () => PermissionMode;
  emit: (payload: EventPayload) => void;
  finish: (status: 'completed' | 'failed', reason?: string) => void;
};

// What the simulated model asks in the `question` scenario, in the official tool's input format.
const question = {
  questions: [
    {
      question: '这次改动要包含哪些部分？',
      header: '范围',
      multiSelect: true,
      options: [
        { label: '界面', description: '页面布局与样式' },
        { label: '服务端', description: '协议与服务端逻辑' },
        { label: '文档', description: '说明与变更记录' },
      ],
    },
    {
      question: '什么时候开始？',
      header: '时间',
      multiSelect: false,
      options: [
        { label: '现在', description: '立即开始' },
        { label: '稍后', description: '先不动，等进一步确认' },
      ],
    },
  ],
};

// What the simulated model plans in the `plan` scenario, with the input Claude Code gives its ExitPlanMode tool.
const plan = {
  plan: '# 计划：整理设置页\n\n1. 读一遍现有设置页的结构\n2. 把“常规”拆成“窗口”和“会话”两组\n3. 补上说明文字和界面测试\n',
  planFilePath: '/data/home/.claude/plans/simulated-plan.md',
};

// The offline adapter: scripted replies and one fake tool, so the GUI and protocol can be exercised without a model,
// a tunnel or any real command.
export async function simulate(
  run: Run,
  command: Extract<Command, { type: 'message.send' }>,
  { stepMs, projectPath, permissionMode, emit, finish }: Host,
) {
  const pause = () => delay(stepMs, undefined, { signal: run.controller.signal });
  const stream = async (text: string) => {
    const messageId = randomUUID();
    for (const textPart of text.match(/[\s\S]{1,12}/gu) ?? []) {
      await pause();
      emit({ type: 'text.delta', messageId, text: textPart });
    }
  };
  try {
    await stream(`已收到：${command.text}\n\n`);
    if (command.scenario === 'error') {
      await pause();
      emit({
        type: 'run.error',
        code: 'simulated_failure',
        message: '模拟上游连接失败；没有执行本机命令。',
      });
      finish('failed', '模拟上游错误');
      return;
    }
    if (command.scenario === 'question') {
      run.toolId = randomUUID();
      run.approvalId = randomUUID();
      const reply = new Promise<Record<string, string> | undefined>((resolve) => {
        run.decide = (allowed, answers) => resolve(allowed ? (answers ?? {}) : undefined);
      });
      emit({
        type: 'tool.requested',
        toolId: run.toolId,
        name: 'AskUserQuestion',
        input: JSON.stringify(question, null, 2),
        target: 'Windows (simulation)',
      });
      emit({ type: 'approval.requested', approvalId: run.approvalId, toolId: run.toolId });
      emit({
        type: 'run.status',
        status: 'awaiting_approval',
        connectionId: run.connectionId,
        waiting: 'question',
      });
      const answers = await reply;
      if (run.controller.signal.aborted) return;
      run.decide = undefined;
      emit({ type: 'approval.resolved', approvalId: run.approvalId, allowed: !!answers });
      emit({ type: 'run.status', status: 'running', connectionId: run.connectionId });
      run.toolFinished = true;
      const chosen = Object.values(answers ?? {}).join('；');
      emit({
        type: 'tool.result',
        toolId: run.toolId,
        status: answers ? 'completed' : 'denied',
        output: answers ? chosen : '用户没有回答。',
        exitCode: null,
      });
      await stream(answers ? `收到回答：${chosen}` : '没有得到回答，本轮到此为止。');
    } else if (command.scenario === 'plan') {
      // Claude enters plan mode by itself where the session is not in it, as Claude Code lets it without asking.
      if (permissionMode() !== 'plan') {
        const entered = randomUUID();
        emit({
          type: 'tool.requested',
          toolId: entered,
          name: 'EnterPlanMode',
          input: '{}',
          target: 'Windows (simulation)',
        });
        emit({ type: 'native.mode', permissionMode: 'plan' });
        emit({
          type: 'tool.result',
          toolId: entered,
          status: 'completed',
          output: 'Entered plan mode.',
          exitCode: null,
        });
      }
      await stream('先看了一下现有结构，计划如下。');
      // A message that asks for a long plan gets one, to be read in part and opened whole.
      const planned = command.text.includes('长计划')
        ? {
            ...plan,
            plan:
              plan.plan +
              Array.from(
                { length: 30 },
                (_, index) => `\n## 细节 ${index + 1}\n\n第 ${index + 1} 处要改的地方和理由。\n`,
              ).join(''),
          }
        : plan;
      run.toolId = randomUUID();
      run.approvalId = run.planApproval = randomUUID();
      const reply = new Promise<{ allowed: boolean; decision?: PlanDecision }>((resolve) => {
        run.decide = (allowed, _answers, decision) => resolve({ allowed, decision });
      });
      emit({
        type: 'tool.requested',
        toolId: run.toolId,
        name: 'ExitPlanMode',
        input: JSON.stringify(planned, null, 2),
        target: 'Windows (simulation)',
      });
      // Claude Code asks for the approval a while after the model has asked for the tool: the plan is on screen
      // before it can be decided.
      await delay(300, undefined, { signal: run.controller.signal });
      emit({ type: 'approval.requested', approvalId: run.approvalId, toolId: run.toolId });
      emit({ type: 'run.status', status: 'awaiting_approval', connectionId: run.connectionId });
      const { allowed, decision } = await reply;
      if (run.controller.signal.aborted) return;
      run.decide = run.planApproval = undefined;
      emit({
        type: 'approval.resolved',
        approvalId: run.approvalId,
        allowed,
        ...(allowed && decision?.mode ? { mode: decision.mode } : {}),
        ...(allowed && decision?.edited ? { edited: true } : {}),
      });
      if (allowed && decision?.edited)
        emit({
          type: 'tool.input',
          toolId: run.toolId,
          input: JSON.stringify({ ...planned, plan: decision.edited }, null, 2),
        });
      emit({ type: 'run.status', status: 'running', connectionId: run.connectionId });
      // As Claude Code does: approved, it works in the mode chosen, or asks about edits where none was.
      if (allowed) emit({ type: 'native.mode', permissionMode: decision?.mode ?? 'default' });
      run.toolFinished = true;
      emit({
        type: 'tool.result',
        toolId: run.toolId,
        status: allowed ? 'completed' : 'denied',
        output: allowed
          ? `User has approved your plan. You can now start coding.\n\n## Approved Plan:\n${decision?.edited ?? planned.plan}`
          : keepPlanning(decision?.feedback),
        exitCode: null,
      });
      await stream(
        allowed ? '按批准的计划开始执行（模拟，未改动文件）。' : '好的，按你的意见继续规划。',
      );
    } else if (command.scenario === 'tool') {
      run.toolId = randomUUID();
      run.approvalId = randomUUID();
      const decision = new Promise<boolean>((resolve) => {
        run.decide = resolve;
      });
      emit({
        type: 'tool.requested',
        toolId: run.toolId,
        name: 'PowerShell',
        input: 'Get-Location',
        target: 'Windows (simulation)',
      });
      emit({ type: 'approval.requested', approvalId: run.approvalId, toolId: run.toolId });
      emit({ type: 'run.status', status: 'awaiting_approval', connectionId: run.connectionId });
      const allowed = await decision;
      if (run.controller.signal.aborted) return;
      run.decide = undefined;
      emit({ type: 'approval.resolved', approvalId: run.approvalId, allowed });
      emit({ type: 'run.status', status: 'running', connectionId: run.connectionId });
      if (allowed) await pause();
      run.toolFinished = true;
      emit({
        type: 'tool.result',
        toolId: run.toolId,
        status: allowed ? 'completed' : 'denied',
        output: allowed
          ? `${projectPath()}\n（模拟输出；未执行真实命令）`
          : '用户拒绝；模拟工具未执行。',
        exitCode: allowed ? 0 : null,
      });
      await stream(
        allowed
          ? '模拟工具已完成。项目仍保留在 Windows，本轮没有读取或修改真实文件。'
          : '已遵循拒绝决定，本轮未执行工具。',
      );
    } else {
      await stream(
        '这是 **离线模拟回复**。\n\n- 项目目标：Windows\n- 服务适配器：模拟\n- 没有调用 Claude 或其他模型\n\n可继续发送消息。',
      );
    }
    finish('completed');
  } catch (error) {
    if (run.controller.signal.aborted) return;
    console.error('Simulation failed:', error instanceof Error ? error.name : 'unknown');
    emit({ type: 'run.error', code: 'internal_error', message: '模拟运行失败。' });
    finish('failed', '模拟运行失败');
  }
}
