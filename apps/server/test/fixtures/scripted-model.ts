import { createServer } from 'node:http';
import type { Server } from 'node:http';

// A stand-in for the Anthropic Messages API that Claude Code talks to through ANTHROPIC_BASE_URL, as it would to a
// gateway: each request of the conversation is answered by the script with the blocks of the next reply, text or a
// tool call. What the CLI sent is kept, to see what Claude was told. No model, account or network is involved.
export type Block = { text: string } | { tool: string; input: Record<string, unknown> };
export type ModelRequest = {
  model?: string;
  stream?: boolean;
  tools?: { name: string }[];
  messages?: { role: string; content: unknown }[];
};
export type Script = (request: ModelRequest) => Block[];

// What the conversation has been answered with so far, and the results the last user turn carries.
export const turns = (request: ModelRequest) =>
  (request.messages ?? []).filter((message) => message.role === 'assistant').length;
export function results(request: ModelRequest) {
  const last = (request.messages ?? []).at(-1);
  return Array.isArray(last?.content)
    ? (last.content as { type: string; is_error?: boolean; content?: unknown }[]).filter(
        (block) => block.type === 'tool_result',
      )
    : [];
}
// A request of the conversation itself, rather than one of the CLI's side requests.
export const conversing = (request: ModelRequest) => !!request.tools?.length;

export async function scriptedModel(script: Script) {
  const requests: ModelRequest[] = [];
  let tools = 0;
  let count = 0;
  const server: Server = createServer(async (incoming, response) => {
    let body = '';
    for await (const chunk of incoming) body += chunk;
    const path = new URL(incoming.url ?? '/', 'http://model').pathname;
    if (path === '/v1/messages/count_tokens') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ input_tokens: 1000 }));
      return;
    }
    if (incoming.method !== 'POST' || path !== '/v1/messages') {
      response.writeHead(incoming.method === 'HEAD' ? 200 : 404).end();
      return;
    }
    const request = JSON.parse(body) as ModelRequest;
    requests.push(request);
    const content = (conversing(request) ? script(request) : [{ text: '标题' }]).map((block) =>
      'tool' in block
        ? { type: 'tool_use', id: `toolu_${++tools}`, name: block.tool, input: block.input }
        : { type: 'text', text: block.text },
    );
    const stop = content.some((block) => block.type === 'tool_use') ? 'tool_use' : 'end_turn';
    const message = {
      id: `msg_${++count}`,
      type: 'message',
      role: 'assistant',
      model: request.model ?? 'scripted',
      content: [] as unknown[],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 100,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    };
    if (!request.stream) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ...message, content, stop_reason: stop }));
      return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const send = (type: string, data: object) =>
      response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    send('message_start', { message });
    content.forEach((block, index) => {
      if (block.type === 'text') {
        send('content_block_start', { index, content_block: { type: 'text', text: '' } });
        send('content_block_delta', { index, delta: { type: 'text_delta', text: block.text } });
      } else {
        send('content_block_start', { index, content_block: { ...block, input: {} } });
        send('content_block_delta', {
          index,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
        });
      }
      send('content_block_stop', { index });
    });
    send('message_delta', {
      delta: { stop_reason: stop, stop_sequence: null },
      usage: { output_tokens: 20 },
    });
    send('message_stop', {});
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  return {
    url,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// What Claude Code needs to talk to the scripted model only: its own home, a credential for the gateway, and no
// traffic of its own to anywhere else.
export const scriptedEnvironment = (url: string, home: string): Record<string, string> => ({
  HOME: home,
  USERPROFILE: home,
  CLAUDE_CONFIG_DIR: `${home}/.claude`,
  ANTHROPIC_BASE_URL: url,
  ANTHROPIC_AUTH_TOKEN: 'scripted-model',
  ANTHROPIC_API_KEY: '',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1',
  CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
  DISABLE_TELEMETRY: '1',
  DISABLE_ERROR_REPORTING: '1',
  DISABLE_AUTOUPDATER: '1',
});
