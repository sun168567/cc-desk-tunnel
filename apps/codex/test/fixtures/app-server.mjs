import { createInterface } from 'node:readline';
import { sep } from 'node:path';

const home = process.env.CODEX_HOME ?? '';
const isolated =
  home.includes(`${sep}providers${sep}openai${sep}`) &&
  !process.env.CLAUDE_CONFIG_DIR &&
  !Object.keys(process.env).some((key) => key.startsWith('ANTHROPIC_'));

let signedIn = false;
let turn = 0;
let lastModel = '';
let resumed = false;
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');

createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (!isolated) {
    if (message.id !== undefined)
      send({ id: message.id, error: { message: 'Codex home is not isolated.' } });
    return;
  }
  if (message.method === 'initialize') {
    send({ id: message.id, result: {} });
    return;
  }
  if (message.method === 'initialized') return;
  if (message.method === 'account/read') {
    send({
      id: message.id,
      result: signedIn
        ? { account: { type: 'chatgpt' }, requiresOpenaiAuth: true }
        : { account: null, requiresOpenaiAuth: true },
    });
    return;
  }
  if (message.method === 'account/login/start') {
    send({
      id: message.id,
      result: {
        type: 'chatgptDeviceCode',
        loginId: 'login-1',
        verificationUrl: 'https://auth.openai.com/codex/device',
        userCode: 'ABCD-1234',
      },
    });
    signedIn = true;
    setTimeout(
      () =>
        send({
          method: 'account/login/completed',
          params: { loginId: 'login-1', success: true, error: null },
        }),
      20,
    );
    return;
  }
  if (message.method === 'account/login/cancel') {
    send({ id: message.id, result: {} });
    return;
  }
  if (message.method === 'account/logout') {
    signedIn = false;
    send({ id: message.id, result: {} });
    return;
  }
  if (message.method === 'model/list') {
    send({ id: message.id, result: { models: [{ id: 'gpt-test', displayName: 'Test' }] } });
    return;
  }
  if (message.method === 'thread/resume') {
    const threadId = message.params?.threadId;
    if (threadId === 'thr_test' || threadId === 'thr_fork') {
      resumed = true;
      if (typeof message.params?.model === 'string') lastModel = message.params.model;
      send({ id: message.id, result: { thread: { id: threadId } } });
    } else send({ id: message.id, error: { message: 'thread not found' } });
    return;
  }
  if (message.method === 'thread/compact') {
    const threadId = message.params?.threadId;
    if (threadId === 'thr_test' || threadId === 'thr_fork') send({ id: message.id, result: {} });
    else send({ id: message.id, error: { message: 'thread not found' } });
    return;
  }
  if (message.method === 'thread/fork') {
    if (message.params?.threadId === 'thr_copy') {
      send({ id: message.id, error: { message: 'unknown method thread/fork' } });
      return;
    }
    if (message.params?.threadId === 'thr_test') {
      send({ id: message.id, result: { thread: { id: 'thr_fork' } } });
      return;
    }
    send({ id: message.id, error: { message: 'thread not found' } });
    return;
  }
  if (message.method === 'item/commandExecution/cancel') {
    if (message.params?.itemId === 'cmd_stuck') {
      send({ id: message.id, error: { message: 'unknown method item/commandExecution/cancel' } });
      return;
    }
    send({ id: message.id, result: {} });
    send({
      method: 'item/completed',
      params: {
        item: { id: message.params?.itemId, type: 'commandExecution', status: 'cancelled' },
      },
    });
    send({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
    return;
  }
  if (message.method === 'thread/start') {
    const keys = Object.keys(message.params ?? {});
    lastModel = typeof message.params?.model === 'string' ? message.params.model : '';
    if (keys.some((key) => key !== 'model')) {
      send({ id: message.id, error: { message: 'project or sandbox fields are not accepted' } });
      return;
    }
    send({ id: message.id, result: { thread: { id: 'thr_test' } } });
    return;
  }
  if (message.method === 'turn/start') {
    turn += 1;
    const turnId = 'turn_' + turn;
    const text = message.params?.input?.[0]?.text ?? '';
    if (message.params?.approvalPolicy && text.includes('reject-policy')) {
      send({ id: message.id, error: { message: 'unknown field approvalPolicy' } });
      return;
    }
    if (text.includes('echo-policy')) {
      send({ id: message.id, result: { turn: { id: turnId, status: 'inProgress' } } });
      send({
        method: 'item/agentMessage/delta',
        params: {
          delta: JSON.stringify({
            approval: message.params?.approvalPolicy ?? null,
            sandbox: message.params?.sandboxPolicy?.type ?? null,
          }),
        },
      });
      send({ method: 'turn/completed', params: { turn: { id: turnId, status: 'completed' } } });
      return;
    }
    send({ id: message.id, result: { turn: { id: turnId, status: 'inProgress' } } });
    if (text.includes('background-cmd') || text.includes('background-stuck')) {
      send({
        method: 'item/started',
        params: {
          item: {
            id: text.includes('background-stuck') ? 'cmd_stuck' : 'cmd_1',
            type: 'commandExecution',
            command: 'sleep 30',
            status: 'inProgress',
          },
        },
      });
      return;
    }
    const continued = resumed;
    resumed = false;
    if (text.includes('usage')) {
      const reset = Math.floor(Date.now() / 1000) + 3600;
      send({
        method: 'thread/tokenUsage/updated',
        params: {
          tokenUsage: {
            last: { inputTokens: 12, cachedInputTokens: 3, outputTokens: 4, totalTokens: 16 },
            total: { inputTokens: 12, cachedInputTokens: 3, outputTokens: 4, totalTokens: 16 },
            modelContextWindow: 1000,
          },
        },
      });
      send({
        method: 'account/rateLimits/updated',
        params: {
          rateLimits: {
            primary: { usedPercent: 96, windowDurationMins: 300, resetsAt: reset },
            secondary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: reset },
          },
        },
      });
      send({ method: 'item/agentMessage/delta', params: { delta: 'pong' } });
      send({ method: 'turn/completed', params: { turn: { id: turnId, status: 'completed' } } });
      return;
    }
    if (text.includes('echo-input')) {
      send({ method: 'item/agentMessage/delta', params: { delta: text } });
      send({ method: 'turn/completed', params: { turn: { id: turnId, status: 'completed' } } });
      return;
    }
    if (text.includes('echo-model')) {
      send({ method: 'item/agentMessage/delta', params: { delta: lastModel || 'config' } });
      send({ method: 'turn/completed', params: { turn: { id: turnId, status: 'completed' } } });
      return;
    }
    if (text.includes('sleep')) return;
    if (text.includes('edit')) {
      send({
        id: 'srv-' + turn,
        method: 'item/fileChange/requestApproval',
        params: { itemId: 'item_' + turn, threadId: message.params.threadId, turnId },
      });
      return;
    }
    if (text.includes('ask-old') || text.includes('ask')) {
      send({
        id: 'srv-' + turn,
        method: text.includes('ask-old') ? 'tool/requestUserInput' : 'item/tool/requestUserInput',
        params: {
          itemId: 'item_' + turn,
          threadId: message.params.threadId,
          turnId,
          isBlocking: true,
          questions: [
            {
              id: 'go',
              header: '确认',
              question: '继续吗',
              options: [{ label: '是', description: '继续' }],
            },
          ],
        },
      });
      return;
    }
    if (text.includes('deny')) {
      send({
        id: 'srv-' + turn,
        method: 'item/commandExecution/requestApproval',
        params: { itemId: 'item_' + turn, threadId: message.params.threadId, turnId, command: 'echo probe-deny' },
      });
      return;
    }
    send({ method: 'item/agentMessage/delta', params: { delta: continued ? 'resumed' : 'pong' } });
    send({ method: 'turn/completed', params: { turn: { id: turnId, status: 'completed' } } });
    return;
  }
  if (message.method === 'turn/steer') {
    const text = message.params?.input?.[0]?.text ?? '';
    send({ id: message.id, result: {} });
    send({ method: 'item/agentMessage/delta', params: { delta: `steered:${text}` } });
    send({
      method: 'turn/completed',
      params: { turn: { id: message.params?.expectedTurnId, status: 'completed' } },
    });
    return;
  }
  if (message.method === 'account/rateLimits/read') {
    const reset = Math.floor(Date.now() / 1000) + 3600;
    send({
      id: message.id,
      result: {
        rateLimits: {
          primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: reset },
          secondary: { usedPercent: 8, windowDurationMins: 10080, resetsAt: reset },
        },
      },
    });
    return;
  }
  if (message.method === 'turn/interrupt') {
    send({ id: message.id, result: {} });
    send({
      method: 'turn/completed',
      params: { turn: { id: message.params.turnId, status: 'interrupted' } },
    });
    return;
  }
  if (message.result?.decision || message.result?.action || message.result?.answers) {
    const denied = message.result.decision === 'decline' || message.result.action === 'decline';
    if (message.result.answers)
      send({
        method: 'item/agentMessage/delta',
        params: { delta: JSON.stringify(message.result.answers) },
      });
    else if (message.result.action)
      send({ method: 'item/agentMessage/delta', params: { delta: message.result.action } });
    send({
      method: 'item/completed',
      params: { item: { id: 'item_' + turn, status: denied ? 'declined' : 'completed' } },
    });
    send({ method: 'turn/completed', params: { turn: { id: 'turn_' + turn, status: 'completed' } } });
  }
});
