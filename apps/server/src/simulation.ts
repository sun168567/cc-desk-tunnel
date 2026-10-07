import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Command, EventPayload } from '@cc-desk-tunnel/protocol';
import type { Run } from './server.ts';

type Host = {
  stepMs: number;
  projectPath: () => string;
  emit: (payload: EventPayload) => void;
  finish: (status: 'completed' | 'failed', reason?: string) => void;
};

// The offline adapter: scripted replies and one fake tool, so the GUI and protocol can be exercised without a model,
// a tunnel or any real command.
export async function simulate(
  run: Run,
  command: Extract<Command, { type: 'message.send' }>,
  { stepMs, projectPath, emit, finish }: Host,
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
    if (command.scenario === 'tool') {
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
      emit({ type: 'run.status', status: 'awaiting_approval', connectionId: run.owner.id });
      const allowed = await decision;
      if (run.controller.signal.aborted) return;
      run.decide = undefined;
      emit({ type: 'approval.resolved', approvalId: run.approvalId, allowed });
      emit({ type: 'run.status', status: 'running', connectionId: run.owner.id });
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
