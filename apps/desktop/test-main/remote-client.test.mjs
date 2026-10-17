import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import { ProxyClient, RequestInterruptedError } from '../src/client.ts';
import { RemoteClient, createRemoteClientAdapter } from '../src/remote-client.ts';

const turn = () => new Promise((resolve) => setImmediate(resolve));
function fixture(t) {
  const client = new ProxyClient();
  const sessionId = randomUUID();
  const calls = [];
  const messages = [];
  let localTerminal = null;
  let handle = async () => undefined;
  const late = [];
  let deliver = () => {};
  client.update({
    status: 'connected',
    connectionId: randomUUID(),
    sessions: [{ id: sessionId, title: 'one', activeRun: null }],
    selectedId: sessionId,
  });
  client.serviceNow = () => 123456;
  client.activityAt = (id) => (id === sessionId ? 123000 : 0);
  client.request = async (command, onFinal) => {
    calls.push(command);
    try {
      const result = (await handle(command)) ?? {
        type: 'response',
        ok: true,
        requestId: randomUUID(),
        sessionId,
      };
      onFinal?.(result);
      return result;
    } catch (error) {
      if (/请求超时/.test(String(error))) late.push({ command, onFinal });
      else onFinal?.(error);
      throw error;
    }
  };
  client.fetch = async (command) => {
    calls.push({ fetch: command });
    return { type: 'settings.state', requestId: randomUUID(), values: { theme: 'dark' } };
  };
  client.terminalControl = (command) => calls.push(command);
  const request = client.request;
  const adapter = createRemoteClientAdapter(
    client,
    (event) => {
      const copy = structuredClone(event);
      messages.push(copy);
      deliver(copy);
    },
    () => localTerminal,
    10000,
  );
  const invoke = (method, args = [], viewId = 'one', wire = false) =>
    adapter.invoke({
      id: randomUUID(),
      method,
      viewId,
      args:
        wire || ['client:info', 'client:state', 'client:detach'].includes(method)
          ? args
          : [client.state.connectionId, ...args],
    });
  const terminal = (message) => {
    for (const listener of client.terminalListeners) listener(message);
  };
  t.after(() => {
    // Connection shutdown retires terminal cleanup listeners without creating any new requests.
    adapter.dispose();
    client.update({ status: 'disconnected', connectionId: null });
  });
  return {
    client,
    sessionId,
    calls,
    messages,
    adapter,
    invoke,
    terminal,
    finish: (outcome, index = 0) => late.splice(index, 1)[0].onFinal?.(outcome),
    request,
    handle: (next) => (handle = next),
    local: (next) => (localTerminal = next),
    deliver: (next) => (deliver = next),
  };
}
async function enabled(f, views = ['one']) {
  f.adapter.setEnabled(true);
  for (const view of views) await f.invoke('client:state', [], view);
}

test('Web disabled leaves the desktop client and connection untouched', async (t) => {
  const f = fixture(t);
  assert.equal(f.client.listeners.size, 0);
  assert.equal(f.client.terminalListeners.size, 0);
  assert.equal(f.client.request, f.request);
  assert.deepEqual(await f.invoke('client:info'), { connected: true });
  await assert.rejects(f.invoke('client:state'), /已关闭/);
  await enabled(f);
  f.adapter.setEnabled(false);
  assert.equal(f.client.listeners.size, 0);
  assert.equal(f.client.terminalListeners.size, 0);
  assert.equal(f.client.request, f.request);
  assert.equal(f.client.state.status, 'connected');
  assert.deepEqual(f.calls, []);
});

test('state snapshots include clock readings; updates are coalesced and revisioned', async (t) => {
  const f = fixture(t);
  await enabled(f, ['one', 'two']);
  assert.equal(f.messages[0].message.full, true);
  assert.deepEqual(f.messages[0].message.clock, {
    now: 123456,
    activity: { [f.sessionId]: 123000 },
  });
  f.messages.length = 0;
  f.client.update({ error: 'first' });
  f.client.update({ error: 'last', model: 'model' });
  assert.equal(f.messages.length, 0);
  f.adapter.flush();
  assert.equal(f.messages.length, 2);
  assert.equal(f.messages[0].message.revision, 1);
  assert.deepEqual(f.messages[0].message.state, { error: 'last', model: 'model' });
  assert.equal(f.messages[1].viewId, 'two');
});

test('event patches send added/replaced events and evictions rather than all history', async (t) => {
  const f = fixture(t);
  const first = { sequence: 1, payload: { text: 'one' } };
  const second = { sequence: 2, payload: { text: 'two' } };
  f.client.update({ events: { [f.sessionId]: [first, second] } });
  await enabled(f);
  const third = { sequence: 3, payload: { text: 'three' } };
  f.client.update({ events: { [f.sessionId]: [second, third] } });
  f.adapter.flush();
  assert.deepEqual(f.messages.at(-1).message.events[f.sessionId], { upsert: [third], remove: [1] });
  f.client.update({ events: {} });
  f.adapter.flush();
  assert.equal(f.messages.at(-1).message.events[f.sessionId], null);
});

test('request and fetch use desktop methods and publish changed state before their result', async (t) => {
  const f = fixture(t);
  await enabled(f);
  f.handle(async () => f.client.update({ model: 'changed' }));
  await f.invoke('client:request', [{ type: 'account.status' }]);
  assert.equal(f.messages.at(-1).message.state.model, 'changed');
  const data = await f.invoke('client:fetch', [{ type: 'settings.get' }]);
  assert.equal(data.type, 'settings.state');
  assert.deepEqual(f.calls.at(-1), { fetch: { type: 'settings.get' } });
  await assert.rejects(f.invoke('client:fetch', [{ type: 'account.status' }]), /不返回数据/);
});

test('selections operate the original client and broadcast its authoritative selection', async (t) => {
  const f = fixture(t);
  const other = randomUUID();
  f.client.update({ sessions: [...f.client.state.sessions, { id: other, title: 'other' }] });
  await enabled(f, ['one', 'two']);
  await f.invoke('client:select', [other], 'two');
  assert.equal(f.client.state.selectedId, other);
  assert.equal(f.calls.at(-1).type, 'session.subscribe');
  assert.equal(f.messages.at(-1).message.state.selectedId, other);
  await assert.rejects(f.invoke('client:select', [randomUUID()]), /不存在/);
});

test('creation selects the shared desktop subscription even after its browser disconnects', async (t) => {
  const f = fixture(t);
  let finish;
  const created = randomUUID();
  f.handle((command) => {
    if (command.type === 'session.create') return new Promise((resolve) => (finish = resolve));
  });
  await enabled(f);
  const pending = f.invoke('client:request', [
    { type: 'session.create', title: 'new', projectPath: '/work' },
  ]);
  await f.invoke('client:detach');
  f.client.update({ sessions: [...f.client.state.sessions, { id: created, title: 'new' }] });
  finish({ type: 'response', ok: true, requestId: randomUUID(), sessionId: created });
  await pending;
  assert.equal(f.client.state.selectedId, created);
  assert.deepEqual(f.calls.at(-1), {
    type: 'session.subscribe',
    sessionId: created,
    afterSequence: 0,
  });
});

test('a failed Web event publisher cannot break desktop state or terminal listeners', async (t) => {
  const f = fixture(t);
  const adapter = createRemoteClientAdapter(f.client, () => {
    throw new Error('IPC gone');
  });
  t.after(() => adapter.dispose());
  adapter.setEnabled(true);
  await adapter.invoke({ id: randomUUID(), viewId: 'one', method: 'client:state', args: [] });
  assert.doesNotThrow(() => f.client.update({ model: 'new' }));
  assert.doesNotThrow(() => adapter.flush());
  const terminalId = randomUUID();
  f.handle(async (command) => {
    if (command.type === 'terminal.open')
      f.terminal({ type: 'terminal.opened', sessionId: f.sessionId, terminalId });
  });
  await adapter.invoke({
    id: randomUUID(),
    viewId: 'one',
    method: 'client:request',
    args: [
      f.client.state.connectionId,
      { type: 'terminal.open', sessionId: f.sessionId, cols: 80, rows: 24 },
    ],
  });
  assert.equal(f.client.state.status, 'connected');
});

test('remote operations validate commands exactly and require an attached view', async (t) => {
  const f = fixture(t);
  await enabled(f);
  await assert.rejects(f.invoke('client:request', [{ type: 'leave' }]), /Invalid/);
  await assert.rejects(
    f.invoke('client:request', [{ type: 'account.status', extra: true }]),
    /Unrecognized/,
  );
  await assert.rejects(
    f.invoke('client:request', [{ type: 'account.status', requestId: randomUUID() }]),
    /格式/,
  );
  await assert.rejects(f.invoke('client:request', [{ type: 'account.status' }], 'unknown'), /同步/);
  await assert.rejects(f.invoke('client:no-such-method'), /不存在/);
  assert.equal(f.calls.length, 0);
});

test('a desktop terminal already open or opening is never adopted or closed by Web', async (t) => {
  const f = fixture(t);
  await enabled(f);
  f.local(f.sessionId);
  await assert.rejects(
    f.invoke('client:request', [
      { type: 'terminal.open', sessionId: f.sessionId, cols: 80, rows: 24 },
    ]),
    /另一页面/,
  );
  f.terminal({ type: 'terminal.opened', sessionId: f.sessionId, terminalId: randomUUID() });
  await f.invoke('client:detach');
  assert.equal(f.calls.length, 0);
  assert.equal(
    f.messages.some(({ message }) => message.type === 'client:terminal'),
    false,
  );
});

test('Web terminal ownership isolates input and cleanup without touching other views', async (t) => {
  const f = fixture(t);
  const terminalId = randomUUID();
  f.handle(async (command) => {
    if (command.type === 'terminal.open')
      f.terminal({ type: 'terminal.opened', sessionId: f.sessionId, terminalId });
    if (command.type === 'terminal.close')
      f.terminal({ type: 'terminal.closed', sessionId: f.sessionId, terminalId, exitCode: 0 });
  });
  await enabled(f, ['one', 'two']);
  await f.invoke('client:request', [
    { type: 'terminal.open', sessionId: f.sessionId, cols: 80, rows: 24 },
  ]);
  assert.equal(f.adapter.terminalBusy(f.sessionId), true);
  assert.equal(
    f.messages.filter(({ message }) => message.type === 'client:terminal').at(-1).viewId,
    'one',
  );
  const input = { type: 'terminal.input', sessionId: f.sessionId, terminalId, data: 'hello' };
  await assert.rejects(f.invoke('client:terminal', [input], 'two'), /另一页面/);
  await f.invoke('client:terminal', [input]);
  assert.deepEqual(f.calls.at(-1), input);
  await f.invoke('client:detach', [], 'two');
  assert.equal(
    f.calls.some(({ type }) => type === 'terminal.close'),
    false,
  );
  await f.invoke('client:detach');
  await turn();
  assert.equal(f.calls.filter(({ type }) => type === 'terminal.close').length, 1);
  assert.equal(f.adapter.terminalBusy(f.sessionId), false);
  assert.equal(f.client.state.status, 'connected');
});

test('an unsuccessful Web open never adopts a late opened frame from a closing desktop panel', async (t) => {
  const f = fixture(t);
  const desktopTerminalId = randomUUID();
  f.handle(async (command) => {
    if (command.type !== 'terminal.open') return;
    f.terminal({ type: 'terminal.opened', sessionId: f.sessionId, terminalId: desktopTerminalId });
    await f.invoke('client:detach');
    throw new Error('请先结束这个会话的运行，再打开终端。');
  });
  await enabled(f);
  await assert.rejects(
    f.invoke('client:request', [
      { type: 'terminal.open', sessionId: f.sessionId, cols: 80, rows: 24 },
    ]),
    /结束/,
  );
  assert.equal(
    f.calls.some(({ type }) => type === 'terminal.close'),
    false,
  );
  assert.equal(
    f.messages.some(({ message }) => message.type === 'client:terminal'),
    false,
  );
  assert.equal(f.adapter.terminalBusy(f.sessionId), false);
});

test('closing Web during an open reserves its late terminal until cleanup completes', async (t) => {
  const f = fixture(t);
  let finish;
  f.handle((command) =>
    command.type === 'terminal.open' ? new Promise((resolve) => (finish = resolve)) : undefined,
  );
  await enabled(f);
  const pending = f.invoke('client:request', [
    { type: 'terminal.open', sessionId: f.sessionId, cols: 80, rows: 24 },
  ]);
  f.adapter.setEnabled(false);
  assert.equal(f.adapter.terminalBusy(f.sessionId), true);
  const terminalId = randomUUID();
  f.terminal({ type: 'terminal.opened', sessionId: f.sessionId, terminalId });
  finish();
  await pending;
  await turn();
  assert.equal(f.calls.at(-1).type, 'terminal.close');
  assert.equal(f.calls.at(-1).terminalId, terminalId);
  assert.equal(f.client.state.status, 'connected');
  assert.equal(f.adapter.terminalBusy(f.sessionId), false);
  assert.equal(f.client.terminalListeners.size, 0);
});

test('timed-out terminal opens wait for their final success before closing late opened frames', async (t) => {
  const f = fixture(t);
  f.handle((command) => {
    if (command.type === 'terminal.open') throw new Error('请求超时；未自动重发。');
  });
  await enabled(f);
  await assert.rejects(
    f.invoke('client:request', [
      { type: 'terminal.open', sessionId: f.sessionId, cols: 80, rows: 24 },
    ]),
    /超时/,
  );
  assert.equal(f.adapter.terminalBusy(f.sessionId), true);
  f.terminal({ type: 'terminal.opened', sessionId: f.sessionId, terminalId: randomUUID() });
  assert.equal(f.calls.length, 1);
  f.finish({ type: 'response', ok: true, requestId: randomUUID(), sessionId: f.sessionId });
  await turn();
  assert.equal(f.calls.at(-1).type, 'terminal.close');
  assert.equal(f.adapter.terminalBusy(f.sessionId), false);
});

for (const disable of [false, true]) {
  test(`a late failed terminal open releases the desktop reservation with Web ${disable ? 'disabled' : 'enabled'}`, async (t) => {
    const f = fixture(t);
    f.handle((command) => {
      if (command.type === 'terminal.open') throw new Error('请求超时；未自动重发。');
    });
    await enabled(f);
    await assert.rejects(
      f.invoke('client:request', [
        { type: 'terminal.open', sessionId: f.sessionId, cols: 80, rows: 24 },
      ]),
      /结果尚未确认/,
    );
    if (disable) f.adapter.setEnabled(false);
    assert.equal(f.adapter.terminalBusy(f.sessionId), true);
    // An older desktop panel's frame must not become owned just because our request timed out.
    f.terminal({ type: 'terminal.opened', sessionId: f.sessionId, terminalId: randomUUID() });
    f.finish({ type: 'response', ok: false, requestId: randomUUID(), code: 'terminal_failed' });
    await turn();
    assert.equal(f.adapter.terminalBusy(f.sessionId), false);
    assert.equal(f.adapter.terminalProblem(f.sessionId), null);
    assert.equal(f.calls.length, 1);
    assert.equal(f.client.state.status, 'connected');
    if (disable) {
      assert.equal(f.client.listeners.size, 0);
      assert.equal(f.client.terminalListeners.size, 0);
    }
  });
}

test('a timed-out Web open closes only its own confirmed terminal after Web is disabled', async (t) => {
  const f = fixture(t);
  f.handle((command) => {
    if (command.type === 'terminal.open') throw new Error('请求超时；未自动重发。');
  });
  await enabled(f);
  await assert.rejects(
    f.invoke('client:request', [
      { type: 'terminal.open', sessionId: f.sessionId, cols: 80, rows: 24 },
    ]),
    /超时/,
  );
  f.adapter.setEnabled(false);
  const oldId = randomUUID();
  const ownId = randomUUID();
  f.terminal({ type: 'terminal.opened', sessionId: f.sessionId, terminalId: oldId });
  f.terminal({ type: 'terminal.closed', sessionId: f.sessionId, terminalId: oldId, exitCode: 0 });
  f.terminal({ type: 'terminal.opened', sessionId: f.sessionId, terminalId: ownId });
  assert.equal(f.calls.length, 1);
  f.finish({ type: 'response', ok: true, requestId: randomUUID(), sessionId: f.sessionId });
  await turn();
  assert.deepEqual(
    f.calls.filter(({ type }) => type === 'terminal.close'),
    [{ type: 'terminal.close', sessionId: f.sessionId, terminalId: ownId }],
  );
  assert.equal(f.adapter.terminalBusy(f.sessionId), false);
  assert.equal(f.client.listeners.size, 0);
  assert.equal(f.client.terminalListeners.size, 0);
});

test('an unconfirmed terminal explains recovery without replay or a silent desktop reconnect', async (t) => {
  const f = fixture(t);
  f.handle((command) => {
    if (command.type === 'terminal.open') throw new Error('请求超时；未自动重发。');
  });
  await enabled(f);
  await assert.rejects(
    f.invoke('client:request', [
      { type: 'terminal.open', sessionId: f.sessionId, cols: 80, rows: 24 },
    ]),
    /断开后重新连接/,
  );
  f.adapter.setEnabled(false);
  assert.match(f.adapter.terminalProblem(f.sessionId), /结果尚未确认.*断开后重新连接/);
  assert.equal(f.calls.length, 1);
  assert.equal(f.client.state.status, 'connected');
  f.client.update({ connectionId: randomUUID() });
  assert.equal(f.adapter.terminalBusy(f.sessionId), false);
  assert.equal(f.client.listeners.size, 0);
  assert.equal(f.client.terminalListeners.size, 0);
  f.finish({ type: 'response', ok: true, requestId: randomUUID() });
  assert.equal(f.calls.length, 1);
});

test('a timed-out cleanup waits for its final response without sending duplicate closes', async (t) => {
  const f = fixture(t);
  const terminalId = randomUUID();
  f.handle((command) => {
    if (command.type === 'terminal.open')
      f.terminal({ type: 'terminal.opened', sessionId: f.sessionId, terminalId });
    if (command.type === 'terminal.close') throw new Error('请求超时；未自动重发。');
  });
  await enabled(f);
  await f.invoke('client:request', [
    { type: 'terminal.open', sessionId: f.sessionId, cols: 80, rows: 24 },
  ]);
  f.adapter.setEnabled(false);
  await turn();
  f.terminal({ type: 'terminal.data', sessionId: f.sessionId, terminalId, data: 'late', bytes: 4 });
  assert.equal(f.calls.filter(({ type }) => type === 'terminal.close').length, 1);
  f.finish({ type: 'response', ok: false, requestId: randomUUID(), code: 'terminal_inactive' });
  assert.equal(f.adapter.terminalBusy(f.sessionId), false);
  assert.equal(f.client.terminalListeners.size, 0);
});

test('a real desktop request timeout followed by failure releases the Web reservation and listeners', async (t) => {
  const Original = globalThis.WebSocket;
  class Socket {
    static OPEN = 1;
    readyState = 1;
    sent = [];
    send(text) {
      this.sent.push(JSON.parse(text));
    }
    close() {
      this.readyState = 3;
      this.onclose?.();
    }
    message(value) {
      this.onmessage({ data: JSON.stringify(value) });
    }
  }
  globalThis.WebSocket = Socket;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const client = new ProxyClient();
  const adapter = createRemoteClientAdapter(client, () => {});
  t.after(() => {
    adapter.dispose();
    client.disconnect();
    globalThis.WebSocket = Original;
  });
  client.connect('ws://127.0.0.1:1/ws', 'test-token-with-enough-characters', undefined, false);
  const socket = client.socket;
  const sessionId = randomUUID();
  socket.message({
    type: 'ready',
    protocolVersion: PROTOCOL_VERSION,
    version: '0.0.1',
    connectionId: randomUUID(),
    adapter: 'simulation',
    sessions: [],
  });
  adapter.setEnabled(true);
  await adapter.invoke({ id: 'state', viewId: 'one', method: 'client:state', args: [] });
  const pending = adapter.invoke({
    id: 'open',
    viewId: 'one',
    method: 'client:request',
    args: [client.state.connectionId, { type: 'terminal.open', sessionId, cols: 80, rows: 24 }],
  });
  const rejected = assert.rejects(pending, /结果尚未确认/);
  t.mock.timers.tick(10000);
  await rejected;
  assert.equal(client.pending.size, 0);
  adapter.setEnabled(false);
  assert.equal(adapter.terminalBusy(sessionId), true);
  socket.message({
    type: 'response',
    requestId: socket.sent[0].requestId,
    ok: false,
    code: 'terminal_failed',
    message: '原生终端启动失败。',
  });
  assert.equal(adapter.terminalBusy(sessionId), false);
  assert.equal(client.listeners.size, 0);
  assert.equal(client.terminalListeners.size, 0);
  assert.equal(client.state.status, 'connected');
  assert.equal(socket.sent.length, 1);
});

for (const timeout of [false, true]) {
  test(`an explicit browser close is shared with cleanup while ${timeout ? 'timed out' : 'pending'}`, async (t) => {
    const f = fixture(t);
    const terminalId = randomUUID();
    let finish;
    f.handle((command) => {
      if (command.type === 'terminal.open')
        f.terminal({ type: 'terminal.opened', sessionId: f.sessionId, terminalId });
      if (command.type === 'terminal.close') {
        if (timeout) throw new Error('请求超时；未自动重发。');
        return new Promise((resolve) => (finish = resolve));
      }
    });
    await enabled(f);
    await f.invoke('client:request', [
      { type: 'terminal.open', sessionId: f.sessionId, cols: 80, rows: 24 },
    ]);
    const pending = f.invoke('client:request', [
      { type: 'terminal.close', sessionId: f.sessionId, terminalId },
    ]);
    if (timeout) await assert.rejects(pending, /超时/);
    await f.invoke('client:detach');
    f.adapter.setEnabled(false);
    await turn();
    assert.equal(f.calls.filter(({ type }) => type === 'terminal.close').length, 1);
    if (timeout) f.finish({ type: 'response', ok: true, requestId: randomUUID() });
    else {
      finish();
      await pending;
    }
    assert.equal(f.adapter.terminalBusy(f.sessionId), false);
    assert.equal(f.client.listeners.size, 0);
    assert.equal(f.client.terminalListeners.size, 0);
    assert.equal(f.client.state.status, 'connected');
  });
}

async function browser(t, f, count = 1) {
  const Original = globalThis.WebSocket;
  const sockets = [];
  class Socket {
    static OPEN = 1;
    readyState = 0;
    sent = [];
    delayTerminal = false;
    responses = [];
    constructor(url) {
      this.viewId = new URL(url).searchParams.get('view');
      sockets.push(this);
    }
    open() {
      this.readyState = 1;
      this.onopen?.();
    }
    send(text) {
      const value = JSON.parse(text);
      this.sent.push(value);
      void f.invoke(value.method, value.args, this.viewId, true).then(
        (result) => {
          const respond = () => this.message({ type: 'response', id: value.id, ok: true, result });
          if (this.delayTerminal && value.method === 'client:terminal')
            this.responses.push(respond);
          else respond();
        },
        (error) =>
          this.message({ type: 'response', id: value.id, ok: false, error: error.message }),
      );
    }
    message(value) {
      if (this.readyState === 1) this.onmessage?.({ data: JSON.stringify(value) });
    }
    close() {
      this.readyState = 3;
      this.onclose?.();
      void f.invoke('client:detach', [], this.viewId);
    }
  }
  globalThis.WebSocket = Socket;
  const clients = Array.from({ length: count }, () => new RemoteClient());
  f.deliver(({ viewId, message }) => {
    sockets.findLast((socket) => socket.viewId === viewId)?.message(message);
  });
  f.adapter.setEnabled(true);
  for (const [index, client] of clients.entries())
    client.connect(
      'ws://127.0.0.1:1',
      '',
      {},
      true,
      async () => `ws://127.0.0.1:2/api/control?view=browser-${index}`,
    );
  await turn();
  for (const socket of sockets) socket.open();
  await turn();
  t.after(() => {
    for (const client of clients) client.disconnect();
    globalThis.WebSocket = Original;
  });
  return { client: clients[0], clients, sockets };
}

for (const type of ['session.stats', 'instructions.get', 'instructions.update']) {
  test(`browser ${type} forwards data and failures through the desktop fetch`, async (t) => {
    const f = fixture(t);
    const b = await browser(t, f);
    const command =
      type === 'session.stats'
        ? { type, sessionId: f.sessionId }
        : type === 'instructions.update'
          ? { type, text: '回复用中文。', version: 'original-version' }
          : { type };
    const data =
      type === 'session.stats'
        ? { type, requestId: randomUUID(), sessionId: f.sessionId, turns: 2, requests: 4 }
        : {
            type: 'instructions.state',
            requestId: randomUUID(),
            text: '回复用中文。',
            version: 'next-version',
          };
    const forwarded = [];
    f.client.fetch = async (value) => {
      forwarded.push(value);
      return data;
    };
    assert.deepEqual(await b.client.fetch(command), data);
    assert.deepEqual(forwarded, [command]);
    f.client.fetch = async (value) => {
      forwarded.push(value);
      throw new Error('原版本已变化，请重新载入。');
    };
    await assert.rejects(b.client.fetch(command), /原版本已变化，请重新载入。/);
    assert.deepEqual(forwarded, [command, command]);
    assert.equal(f.client.state.status, 'connected');
  });
}

test('two browsers share device readiness and clear unavailable transport state until resynced', async (t) => {
  const f = fixture(t);
  const device = { id: randomUUID(), name: '另一台电脑', platform: 'linux', ready: true };
  f.client.update({ devices: [device] });
  const b = await browser(t, f, 2);
  for (const client of b.clients) assert.deepEqual(client.state.devices, [device]);
  f.client.update({ devices: [{ ...device, ready: false }] });
  f.adapter.flush();
  for (const client of b.clients)
    assert.deepEqual(client.state.devices, [{ ...device, ready: false }]);
  b.sockets[0].close();
  assert.equal(b.client.state.status, 'reconnecting');
  assert.deepEqual(b.client.state.devices, []);
  assert.deepEqual(b.clients[1].state.devices, [{ ...device, ready: false }]);
  assert.deepEqual(f.client.state.devices, [{ ...device, ready: false }]);
  f.client.update({ devices: [device] });
  f.adapter.flush();
  assert.deepEqual(b.clients[1].state.devices, [device]);
  b.client.retryNow();
  await turn();
  b.sockets[2].open();
  await turn();
  assert.deepEqual(b.client.state.devices, [device]);
  f.client.update({ status: 'reconnecting', connectionId: null, devices: [] });
  f.adapter.flush();
  for (const client of b.clients) {
    assert.equal(client.state.status, 'reconnecting');
    assert.deepEqual(client.state.devices, []);
  }
  f.client.update({ status: 'connected', connectionId: randomUUID(), devices: [device] });
  f.adapter.flush();
  b.client.disconnect();
  assert.deepEqual(b.client.state.devices, []);
  assert.deepEqual(b.clients[1].state.devices, [device]);
  assert.equal(f.client.state.status, 'connected');
});

test('other-device messages, approvals and stop requests keep their session and run identities', async (t) => {
  const f = fixture(t);
  const device = { id: randomUUID(), name: '另一台电脑', platform: 'linux', ready: true };
  const sessionId = randomUUID();
  const runId = randomUUID();
  f.client.update({
    devices: [device],
    sessions: [...f.client.state.sessions, { id: sessionId, title: 'elsewhere', device }],
  });
  const b = await browser(t, f, 2);
  const commands = [
    { type: 'message.send', sessionId, text: '/status', scenario: 'chat' },
    { type: 'approval.reply', sessionId, runId, approvalId: randomUUID(), allowed: true },
    { type: 'run.cancel', sessionId, runId },
  ];
  for (const [index, command] of commands.entries()) await b.clients[index % 2].request(command);
  assert.deepEqual(f.calls, commands);
  assert.equal(f.client.state.selectedId, f.sessionId);
  assert.equal(f.client.state.status, 'connected');
});

test('browser fetch returns data; state changes are visible when request resolves', async (t) => {
  const f = fixture(t);
  const b = await browser(t, f);
  assert.equal(b.client.state.status, 'connected');
  assert.equal(b.sockets[0].sent[0].method, 'client:state');
  assert.equal(
    b.sockets[0].sent.some((frame) => ['auth', 'device'].includes(frame.type)),
    false,
  );
  f.handle(async () => f.client.update({ model: 'new-model' }));
  await b.client.request({ type: 'account.status' });
  assert.equal(b.client.state.model, 'new-model');
  const data = await b.client.fetch({ type: 'settings.get' });
  assert.equal(data.values.theme, 'dark');
  assert.equal(b.client.results.size, 0);
  assert.equal(b.client.activityAt(f.sessionId), 123000);
  assert.ok(Math.abs(b.client.serviceNow() - 123456) < 1000);
});

test('large snapshots are chunked and event deltas reconstruct the shared history', async (t) => {
  const f = fixture(t);
  const first = { sequence: 1, payload: { text: 'x'.repeat(70000) } };
  f.client.update({ events: { [f.sessionId]: [first] } });
  const b = await browser(t, f);
  const chunks = f.messages.filter(({ message }) => message.type === 'client:chunk');
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every(({ message }) => Buffer.byteLength(JSON.stringify(message)) < 64 * 1024));
  assert.equal(b.client.state.events[f.sessionId][0].payload.text.length, 70000);
  const next = { sequence: 2, payload: { text: 'next' } };
  f.client.update({ events: { [f.sessionId]: [first, next] } });
  f.adapter.flush();
  assert.deepEqual(b.client.state.events[f.sessionId], [first, next]);
  f.client.update({ events: {} });
  f.adapter.flush();
  assert.deepEqual(b.client.state.events, {});
});

test('browser selection marks cached history loading before asynchronous desktop selection', async (t) => {
  const f = fixture(t);
  const other = randomUUID();
  f.client.update({
    sessions: [...f.client.state.sessions, { id: other, title: 'other' }],
    history: {
      [other]: {
        firstSequence: 1,
        lastSequence: 2,
        hasEarlier: false,
        loading: false,
        loadingEarlier: false,
      },
    },
  });
  const b = await browser(t, f);
  b.client.select(other);
  assert.equal(b.client.state.history[other].loading, true);
  await turn();
  assert.equal(f.client.state.selectedId, other);
  assert.equal(b.client.state.selectedId, other);
});

test('browser disconnect rejects uncertain writes and reconnect never replays them', async (t) => {
  const f = fixture(t);
  const b = await browser(t, f);
  let finish;
  f.handle(() => new Promise((resolve) => (finish = resolve)));
  const pending = b.client.request({ type: 'account.logout' });
  b.sockets[0].close();
  await assert.rejects(pending, RequestInterruptedError);
  assert.equal(f.client.state.status, 'connected');
  b.client.retryNow();
  await turn();
  b.sockets[1].open();
  await turn();
  assert.deepEqual(
    b.sockets[1].sent.map(({ method }) => method),
    ['client:state'],
  );
  assert.equal(f.calls.length, 1);
  finish();
  await turn();
  b.client.disconnect();
  assert.equal(f.client.state.status, 'connected');
});

test('a missing state revision closes only the browser transport', async (t) => {
  const f = fixture(t);
  const b = await browser(t, f);
  b.sockets[0].message({
    type: 'client:state',
    full: false,
    revision: 100,
    state: {},
    events: {},
    clock: { now: 0, activity: {} },
  });
  assert.equal(b.sockets[0].readyState, 3);
  assert.equal(f.client.state.status, 'connected');
  assert.equal(b.client.state.status, 'reconnecting');
});

test('operations are bound to their issuing service connection, with state and detach exempt', async (t) => {
  const f = fixture(t);
  const b = await browser(t, f);
  const old = b.client.state.connectionId;
  f.client.update({ connectionId: randomUUID() });
  for (const [method, args] of [
    ['client:request', [{ type: 'account.logout' }]],
    ['client:fetch', [{ type: 'settings.update', values: {} }]],
    ['client:select', [f.sessionId]],
    ['client:load-earlier', [f.sessionId]],
    [
      'client:terminal',
      [{ type: 'terminal.input', sessionId: f.sessionId, terminalId: randomUUID(), data: 'x' }],
    ],
    ['client:clear-error', []],
  ])
    await assert.rejects(f.invoke(method, [old, ...args], 'browser-0', true), /连接已变化/);
  assert.equal(f.calls.length, 0);
  await f.invoke('client:state', [], 'browser-0', true);
  await b.client.request({ type: 'account.logout' });
  assert.equal(f.calls.at(-1).type, 'account.logout');
  await f.invoke('client:detach', [], 'browser-0', true);
});

async function queuedTerminal(t) {
  const f = fixture(t);
  const b = await browser(t, f);
  const terminalId = randomUUID();
  f.handle((command) => {
    if (command.type === 'terminal.open')
      f.terminal({ type: 'terminal.opened', sessionId: f.sessionId, terminalId });
  });
  await b.client.request({ type: 'terminal.open', sessionId: f.sessionId, cols: 80, rows: 24 });
  const socket = b.sockets[0];
  socket.delayTerminal = true;
  const input = (data) =>
    b.client.terminalControl({ type: 'terminal.input', sessionId: f.sessionId, terminalId, data });
  const ack = (bytes) =>
    b.client.terminalControl({ type: 'terminal.ack', sessionId: f.sessionId, terminalId, bytes });
  const resize = (cols) =>
    b.client.terminalControl({
      type: 'terminal.resize',
      sessionId: f.sessionId,
      terminalId,
      cols,
      rows: 24,
    });
  return { f, b, socket, terminalId, input, ack, resize };
}

test('terminal input has ordered backpressure while acknowledgements and latest resize keep moving', async (t) => {
  const { f, b, socket, input, ack, resize } = await queuedTerminal(t);
  for (let n = 0; n < 80; n++) input(String(n));
  for (let n = 0; n < 20; n++) ack(16 * 1024);
  for (let n = 80; n < 100; n++) resize(n);
  await turn();
  assert.equal(f.calls.filter((x) => x.type === 'terminal.input').length, 1);
  assert.equal(f.calls.filter((x) => x.type === 'terminal.ack').length, 1);
  assert.equal(f.calls.filter((x) => x.type === 'terminal.resize').length, 1);
  for (let n = 0; n < 100 && (socket.responses.length || b.client.terminalBytes); n++) {
    assert.ok(b.client.requests.size <= 3);
    for (const respond of socket.responses.splice(0)) respond();
    await turn();
  }
  assert.deepEqual(
    f.calls.filter((x) => x.type === 'terminal.input').map((x) => x.data),
    Array.from({ length: 80 }, (_, n) => String(n)),
  );
  const acks = f.calls.filter((x) => x.type === 'terminal.ack');
  assert.equal(
    acks.reduce((sum, x) => sum + x.bytes, 0),
    20 * 16 * 1024,
  );
  assert.ok(acks.every((x) => x.bytes <= 256 * 1024));
  assert.equal(f.calls.filter((x) => x.type === 'terminal.resize').at(-1).cols, 99);
  assert.equal(b.client.terminalBytes, 0);
});

for (const reason of ['disconnect', 'connection replacement', 'explicit close', 'terminal exit']) {
  test(`queued terminal input is discarded without replay after ${reason}`, async (t) => {
    const { f, b, socket, terminalId, input } = await queuedTerminal(t);
    for (let n = 0; n < 20; n++) input(String(n));
    await turn();
    if (reason === 'disconnect') {
      socket.close();
      b.client.retryNow();
      await turn();
      b.sockets.at(-1).open();
    } else if (reason === 'connection replacement') {
      f.client.update({ connectionId: randomUUID() });
      f.adapter.flush();
    } else if (reason === 'explicit close') {
      await b.client.request({ type: 'terminal.close', sessionId: f.sessionId, terminalId });
    } else f.terminal({ type: 'terminal.closed', sessionId: f.sessionId, terminalId, exitCode: 0 });
    for (const respond of socket.responses.splice(0)) respond();
    await turn();
    assert.equal(f.calls.filter((x) => x.type === 'terminal.input').length, 1);
    assert.equal(b.client.terminalBytes, 0);
  });
}

test('oversized paste bounds memory, discards the suffix and preserves output flow control', async (t) => {
  const { f, b, socket, input, ack, resize } = await queuedTerminal(t);
  for (let n = 0; n < 300; n++) input('x'.repeat(4096));
  assert.equal(b.client.terminalBytes, 0);
  assert.match(b.client.state.error, /粘贴过大/);
  ack(16384);
  resize(100);
  await turn();
  for (const respond of socket.responses.splice(0)) respond();
  await turn();
  input('must-not-send-a-tail');
  assert.equal(f.calls.filter((x) => x.type === 'terminal.input').length, 1);
  assert.equal(f.calls.filter((x) => x.type === 'terminal.ack').length, 1);
  assert.equal(f.calls.filter((x) => x.type === 'terminal.resize').at(-1).cols, 100);
});
