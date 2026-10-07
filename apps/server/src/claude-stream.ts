import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Effort, EventPayload, PermissionMode } from '@cc-desk-tunnel/protocol';

const jsonObject = z.record(z.string(), z.unknown());
export type NativeTool = {
  id: string;
  name: string;
  input: Record<string, unknown>;
  finished: boolean;
  denied?: boolean;
};
export class ClaudeStream {
  emit: (event: EventPayload) => void;
  tools = new Map<string, NativeTool>();
  messageId = randomUUID();
  streamed = false;
  thinkingStreamed = false;
  result: { failed: boolean; text: string } | null = null;
  blocks = new Map<number, string>();
  requestedPermissionMode?: PermissionMode;
  requestedEffort?: Effort | null;
  constructor(
    emit: (event: EventPayload) => void,
    permissionMode?: PermissionMode,
    effort?: Effort | null,
  ) {
    this.emit = emit;
    this.requestedPermissionMode = permissionMode;
    this.requestedEffort = effort;
  }
  tool(name: string, input: Record<string, unknown>, id: string = randomUUID()): NativeTool {
    const sameId = this.tools.get(id);
    if (sameId) {
      sameId.input = input;
      this.emit({ type: 'tool.input', toolId: id, input: JSON.stringify(input, null, 2) });
      return sameId;
    }
    const tool = { id, name, input, finished: false };
    this.tools.set(id, tool);
    this.emit({
      type: 'tool.requested',
      toolId: id,
      name,
      input: JSON.stringify(input, null, 2),
      target: 'Linux',
    });
    return tool;
  }
  accept(value: unknown) {
    const message = jsonObject.parse(value);
    if (message.type === 'system') {
      if (message.subtype === 'init') {
        this.emit({
          type: 'native.session',
          nativeSessionId: z.uuid().parse(message.session_id),
          model: String(message.model ?? ''),
          version: String(message.claude_code_version ?? ''),
          requestedPermissionMode: this.requestedPermissionMode,
          permissionMode:
            typeof message.permissionMode === 'string' ? message.permissionMode : undefined,
          requestedEffort: this.requestedEffort,
          effort:
            typeof message.effort === 'string'
              ? (message.effort as Effort)
              : message.effort === null
                ? null
                : undefined,
        });
        if (
          this.requestedPermissionMode &&
          message.permissionMode !== this.requestedPermissionMode
        ) {
          this.emit({
            type: 'native.notice',
            text: `请求审批模式 ${this.requestedPermissionMode}；原生进程实际报告 ${String(message.permissionMode ?? '未知')}。`,
          });
        }
      } else if (message.subtype === 'compact_boundary') {
        const metadata = jsonObject.parse(message.compact_metadata ?? {});
        this.emit({
          type: 'native.compact',
          trigger: String(metadata.trigger ?? 'unknown'),
          previousTokens: typeof metadata.pre_tokens === 'number' ? metadata.pre_tokens : null,
        });
      } else if (['status', 'informational'].includes(String(message.subtype))) {
        const text =
          typeof message.content === 'string'
            ? message.content
            : typeof message.message === 'string'
              ? message.message
              : String(message.status ?? message.subtype);
        this.emit({ type: 'native.notice', text });
      }
    }
    if (message.type === 'tool_progress') {
      this.emit({
        type: 'tool.progress',
        toolId: z.string().parse(message.tool_use_id),
        elapsedSeconds: z.number().nonnegative().parse(message.elapsed_time_seconds),
      });
    }
    if (message.type === 'stream_event') {
      const event = jsonObject.parse(message.event);
      if (event.type === 'message_start') {
        this.messageId = randomUUID();
        this.streamed = false;
        this.thinkingStreamed = false;
        this.blocks.clear();
      }
      if (event.type === 'content_block_start') {
        const block = jsonObject.parse(event.content_block);
        if (block.type === 'tool_use') {
          const tool = this.tool(
            z.string().parse(block.name),
            jsonObject.parse(block.input),
            z.string().parse(block.id),
          );
          this.blocks.set(z.number().parse(event.index), tool.id);
        }
      }
      if (event.type === 'content_block_delta') {
        const delta = jsonObject.parse(event.delta);
        if (delta.type === 'text_delta') {
          this.streamed = true;
          this.emit({
            type: 'text.delta',
            messageId: this.messageId,
            text: z.string().parse(delta.text),
          });
        }
        // A model that keeps its reasoning to itself still sends the block, with nothing in it.
        if (delta.type === 'thinking_delta' && delta.thinking) {
          this.thinkingStreamed = true;
          this.emit({
            type: 'thinking.delta',
            messageId: this.messageId,
            text: z.string().parse(delta.thinking),
          });
        }
        if (delta.type === 'input_json_delta') {
          const toolId = this.blocks.get(z.number().parse(event.index));
          if (toolId)
            this.emit({
              type: 'tool.input.delta',
              toolId,
              text: z.string().parse(delta.partial_json),
            });
        }
      }
    }
    if (message.type === 'assistant') {
      const assistant = jsonObject.parse(message.message);
      for (const value of z.array(jsonObject).parse(assistant.content)) {
        if (value.type === 'text' && !this.streamed)
          this.emit({
            type: 'text.delta',
            messageId: this.messageId,
            text: z.string().parse(value.text),
          });
        if (
          value.type === 'thinking' &&
          !this.thinkingStreamed &&
          typeof value.thinking === 'string' &&
          value.thinking
        )
          this.emit({ type: 'thinking.delta', messageId: this.messageId, text: value.thinking });
        if (value.type === 'tool_use')
          this.tool(
            z.string().parse(value.name),
            jsonObject.parse(value.input),
            z.string().parse(value.id),
          );
      }
    }
    if (message.type === 'user') {
      const user = jsonObject.parse(message.message);
      if (!Array.isArray(user.content)) return;
      for (const value of z.array(jsonObject).parse(user.content)) {
        if (value.type !== 'tool_result') continue;
        const toolId = z.string().parse(value.tool_use_id);
        const tool = this.tools.get(toolId);
        if (tool) tool.finished = true;
        const output =
          typeof value.content === 'string' ? value.content : JSON.stringify(value.content);
        const exitCode: number | null = null;
        const status: 'completed' | 'failed' | 'denied' | 'cancelled' = tool?.denied
          ? 'denied'
          : value.is_error
            ? 'failed'
            : 'completed';
        this.emit({ type: 'tool.result', toolId, status, output: output ?? '', exitCode });
      }
    }
    if (message.type === 'result') {
      this.result = {
        failed: message.is_error === true || message.subtype !== 'success',
        text: String(
          message.result ?? (Array.isArray(message.errors) ? message.errors.join('\n') : ''),
        ),
      };
      if (this.result.failed)
        this.emit({
          type: 'run.error',
          code: String(message.subtype ?? 'cli_failure'),
          message: this.result.text || 'Claude Code run failed.',
        });
    }
  }
}
