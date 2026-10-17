import { MAX_FRAME_BYTES, commandSchema, terminalControlSchema } from '@cc-desk-tunnel/protocol';
import type { ServerMessage, SessionEvent, TerminalControl } from '@cc-desk-tunnel/protocol';
import { ProxyClient, RequestInterruptedError } from './client.ts';
import type { ClientState } from './client.ts';

type Command = Parameters<ProxyClient['request']>[0];
type FetchCommand = Parameters<ProxyClient['fetch']>[0];
type Replies = {
  'usage.summary': 'usage.summary';
  'usage.query': 'usage.page';
  'session.stats': 'session.stats';
  'settings.get': 'settings.state';
  'settings.update': 'settings.state';
  'instructions.get': 'instructions.state';
  'instructions.update': 'instructions.state';
};
type TerminalMessage = Parameters<Parameters<ProxyClient['onTerminal']>[0]>[0];
type TerminalQueue = {
  connectionId: string | null;
  input: Extract<TerminalControl, { type: 'terminal.input' }>[];
  bytes: number;
  ack: number;
  resize?: Extract<TerminalControl, { type: 'terminal.resize' }>;
  inputPending: boolean;
  inputBlocked: boolean;
  ackPending: boolean;
  resizePending: boolean;
  closed: boolean;
};
type Clock = { now: number; activity: Record<string, number> };
type EventChange = { replace?: SessionEvent[]; upsert?: SessionEvent[]; remove?: number[] };
type StateMessage = {
  type: 'client:state';
  revision: number;
  full: boolean;
  state: Partial<ClientState>;
  events: Record<string, EventChange | null>;
  clock: Clock;
};
type RemoteRequest = { id: string; viewId?: string; method: string; args: unknown[] };
export type RemoteClientHost = {
  onRemoteEnabledChanged: (listener: (enabled: boolean) => void) => () => void;
  onRemoteRequest: (
    methods: string[],
    listener: (request: RemoteRequest) => unknown | Promise<unknown>,
  ) => () => void;
  publishRemoteEvent: (event: { viewId?: string; message: unknown }) => void;
};
export const remoteClientMethods = [
  'client:info',
  'client:state',
  'client:request',
  'client:fetch',
  'client:select',
  'client:load-earlier',
  'client:terminal',
  'client:clear-error',
  'client:detach',
];
const fetches = new Set([
  'usage.summary',
  'usage.query',
  'session.stats',
  'settings.get',
  'settings.update',
  'instructions.get',
  'instructions.update',
]);
// JSON inside the chunk envelope escapes some bytes a second time. These character-sized chunks
// remain below 64 KiB on the wire, including non-ASCII text; the complete message is capped in bytes.
const chunkSize = 16 * 1024;
const maxMessage = 64 * 1024 * 1024;
const maxViews = 16;
const uuid = (value: unknown): value is string =>
  typeof value === 'string' && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value);

// The desktop remains the only ProxyClient. This adapter exports its state and invokes its existing
// public operations; it owns neither the service connection nor the desktop's reconnect/leave lifecycle.
export function createRemoteClientAdapter(
  client: ProxyClient,
  publish: RemoteClientHost['publishRemoteEvent'],
  getLocalTerminal: () => string | null = () => null,
  interval = 100,
) {
  const views = new Set<string>();
  const terminals = new Map<
    string,
    {
      viewId: string;
      id: string | null;
      retired: boolean;
      closing: boolean;
      closeRequest: ReturnType<ProxyClient['request']> | null;
      confirmed: boolean;
      buffered: TerminalMessage[];
      bufferedBytes: number;
    }
  >();
  let enabled = false;
  let disposed = false;
  let previous = client.state;
  let revision = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe: (() => void) | undefined;
  let terminalUnsubscribe: (() => void) | undefined;
  let connectionId = client.state.connectionId;

  function publishMessage(event: { viewId?: string; message: unknown }) {
    // A disappearing browser or IPC listener is a Web failure, never a desktop client failure.
    try {
      publish(event);
    } catch {}
  }

  function send(message: unknown, viewId?: string) {
    const text = JSON.stringify(message);
    if (text.length > maxMessage || new TextEncoder().encode(text).byteLength > maxMessage)
      throw new Error('工作台数据超过浏览器同步容量，请减少已加载的历史。');
    if (text.length <= chunkSize) return publishMessage({ viewId, message });
    const id = crypto.randomUUID();
    const total = Math.ceil(text.length / chunkSize);
    for (let index = 0; index < total; index++)
      publishMessage({
        viewId,
        message: {
          type: 'client:chunk',
          id,
          index,
          total,
          text: text.slice(index * chunkSize, (index + 1) * chunkSize),
        },
      });
  }
  function clock(): Clock {
    return {
      now: client.serviceNow(),
      activity: Object.fromEntries(
        client.state.sessions.map(({ id }) => [id, client.activityAt(id)]),
      ),
    };
  }
  function stateMessage(full: boolean): StateMessage {
    const current = client.state;
    const state: Partial<ClientState> = {};
    for (const key of Object.keys(current) as (keyof ClientState)[]) {
      if (key !== 'events' && (full || current[key] !== previous[key]))
        Object.assign(state, { [key]: current[key] });
    }
    const events: StateMessage['events'] = {};
    for (const id of new Set([...Object.keys(previous.events), ...Object.keys(current.events)])) {
      const next = current.events[id];
      const old = previous.events[id];
      if (!full && next === old) continue;
      if (!next) events[id] = null;
      else if (full || !old) events[id] = { replace: next };
      else {
        const before = new Map(old.map((event) => [event.sequence, event]));
        const after = new Set(next.map((event) => event.sequence));
        events[id] = {
          upsert: next.filter((event) => before.get(event.sequence) !== event),
          remove: old.filter((event) => !after.has(event.sequence)).map((event) => event.sequence),
        };
      }
    }
    return { type: 'client:state', revision, full, state, events, clock: clock() };
  }
  function flush() {
    clearTimeout(timer);
    timer = undefined;
    if (!enabled || !views.size || previous === client.state) return;
    revision++;
    const message = stateMessage(false);
    for (const viewId of views) send(message, viewId);
    previous = client.state;
  }
  function stopListeningWhenIdle() {
    if (enabled || terminals.size) return;
    unsubscribe?.();
    unsubscribe = undefined;
    terminalUnsubscribe?.();
    terminalUnsubscribe = undefined;
  }
  function closeTerminal(sessionId: string) {
    const terminal = terminals.get(sessionId);
    if (!terminal || !terminal.id) return null;
    if (terminal.closing) return terminal.closeRequest;
    terminal.closing = true;
    const pending = client.request(
      { type: 'terminal.close', sessionId, terminalId: terminal.id },
      (outcome) => {
        if (terminals.get(sessionId) !== terminal) return;
        if (
          outcome instanceof RequestInterruptedError ||
          (!(outcome instanceof Error) && (outcome.ok || outcome.code === 'terminal_inactive'))
        )
          terminals.delete(sessionId);
        else {
          terminal.closing = false;
          terminal.closeRequest = null;
        }
        stopListeningWhenIdle();
      },
    );
    terminal.closeRequest = pending;
    void pending
      .catch((error) => {
        // A timeout is still awaiting the original response. Do not send duplicate closes.
        if (!/请求超时/.test(String(error))) {
          terminal.closing = false;
          terminal.closeRequest = null;
        }
      })
      .finally(stopListeningWhenIdle);
    return pending;
  }
  function detach(viewId: string) {
    views.delete(viewId);
    for (const [sessionId, terminal] of terminals) {
      if (terminal.viewId !== viewId) continue;
      terminal.retired = true;
      closeTerminal(sessionId);
    }
    stopListeningWhenIdle();
  }
  function listen() {
    unsubscribe ??= client.subscribe(() => {
      if (connectionId !== client.state.connectionId) {
        connectionId = client.state.connectionId;
        terminals.clear();
        stopListeningWhenIdle();
      }
      if (enabled && views.size && !timer)
        timer = setTimeout(() => {
          try {
            flush();
          } catch (error) {
            for (const viewId of [...views]) {
              publishMessage({
                viewId,
                message: { type: 'client:error', message: (error as Error).message },
              });
              detach(viewId);
            }
          }
        }, interval);
    });
    terminalUnsubscribe ??= client.onTerminal(terminalMessage);
  }
  function terminalMessage(message: TerminalMessage) {
    const terminal = terminals.get(message.sessionId);
    if (!terminal || (terminal.id && terminal.id !== message.terminalId)) return;
    // opened has no request ID. Until our open succeeds, it could belong to a desktop panel whose
    // close is still in flight. A rejected Web open must never adopt or close that terminal.
    if (!terminal.confirmed) {
      const bytes = JSON.stringify(message).length;
      if (message.type !== 'terminal.data' || terminal.bufferedBytes + bytes <= 1024 * 1024) {
        terminal.buffered.push(message);
        terminal.bufferedBytes += bytes;
      } else terminal.retired = true;
      return;
    }
    if (message.type === 'terminal.opened') terminal.id = message.terminalId;
    // Unidentified data cannot claim a desktop terminal whose open was already in flight.
    if (!terminal.id) return;
    if (!terminal.retired && views.has(terminal.viewId)) {
      try {
        send({ type: 'client:terminal', message }, terminal.viewId);
      } catch {
        detach(terminal.viewId);
      }
    }
    if (message.type === 'terminal.closed') {
      terminals.delete(message.sessionId);
      stopListeningWhenIdle();
    } else if (terminal.retired) closeTerminal(message.sessionId);
  }
  function releaseTerminalMessages(sessionId: string) {
    const terminal = terminals.get(sessionId);
    if (!terminal) return;
    const messages = terminal.buffered;
    terminal.buffered = [];
    terminal.bufferedBytes = 0;
    for (const message of messages) terminalMessage(message);
  }
  function setEnabled(value: boolean) {
    if (disposed && value) return;
    if (enabled === value) return;
    enabled = value;
    clearTimeout(timer);
    timer = undefined;
    if (enabled) {
      previous = client.state;
      connectionId = client.state.connectionId;
      listen();
    } else {
      for (const viewId of [...views]) detach(viewId);
      stopListeningWhenIdle();
    }
  }
  function command(value: unknown): Command {
    if (!value || typeof value !== 'object' || 'requestId' in value)
      throw new Error('请求格式无效。');
    const parsed = commandSchema.parse({ ...value, requestId: crypto.randomUUID() });
    const { requestId: _requestId, ...result } = parsed;
    return result;
  }
  function terminalProblem(sessionId: string) {
    const terminal = terminals.get(sessionId);
    if (!terminal) return null;
    if (terminal.retired && !terminal.confirmed)
      return '浏览器终端的启动结果尚未确认；请稍候，或在桌面断开后重新连接。';
    if (terminal.closing)
      return '浏览器终端正在结束；请稍候，若服务一直未响应，可在桌面断开后重新连接。';
    return '这个会话的原生终端已经在另一页面打开。';
  }
  async function request(viewId: string, value: Command) {
    if (value.type === 'terminal.open') {
      const problem = terminalProblem(value.sessionId);
      if (problem) throw new Error(problem);
      if (
        getLocalTerminal() === value.sessionId ||
        client.state.sessions.some(
          (session) => session.id === value.sessionId && session.activeRun?.surface === 'terminal',
        )
      )
        throw new Error('这个会话的原生终端已经在另一页面打开。');
      if (terminals.size >= maxViews) throw new Error('仍有终端正在结束，请稍后再试。');
      const terminal = {
        viewId,
        id: null as string | null,
        retired: false,
        closing: false,
        closeRequest: null as ReturnType<ProxyClient['request']> | null,
        confirmed: false,
        buffered: [] as TerminalMessage[],
        bufferedBytes: 0,
      };
      terminals.set(value.sessionId, terminal);
      try {
        return await client.request(value, (outcome) => {
          if (terminals.get(value.sessionId) !== terminal) return;
          if (outcome instanceof Error || !outcome.ok) {
            terminals.delete(value.sessionId);
            stopListeningWhenIdle();
            return;
          }
          terminal.confirmed = true;
          // The service sends opened before its successful response. Older frames from a desktop
          // panel closing in the meantime are not this open's terminal.
          terminal.id =
            terminal.buffered.findLast((message) => message.type === 'terminal.opened')
              ?.terminalId ?? null;
          releaseTerminalMessages(value.sessionId);
          if (terminal.retired) closeTerminal(value.sessionId);
        });
      } catch (error) {
        terminal.retired = true;
        // Only the original request's final response can establish ownership. Keep buffering late
        // frames after a timeout; a failed open must never adopt a closing desktop panel's terminal.
        if (/请求超时/.test(String(error))) {
          closeTerminal(value.sessionId);
          throw new Error('终端启动请求超时，结果尚未确认；请稍候，或在桌面断开后重新连接。');
        } else if (terminals.get(value.sessionId) === terminal) terminals.delete(value.sessionId);
        throw error;
      } finally {
        stopListeningWhenIdle();
      }
    }
    if (value.type === 'terminal.close') {
      const terminal = terminals.get(value.sessionId);
      if (!terminal || terminal.viewId !== viewId || terminal.id !== value.terminalId)
        throw new Error('原生终端属于另一页面或已经结束。');
      return closeTerminal(value.sessionId);
    }
    const response = await client.request(value);
    // The service's create operation selects its new subscription. Select in the desktop before
    // replying, even when the initiating browser went away between creation and its UI navigation.
    if (value.type === 'session.create' && response.sessionId) client.select(response.sessionId);
    return response;
  }
  async function invoke({ viewId, method, args }: RemoteRequest) {
    if (method === 'client:info') {
      if (!Array.isArray(args) || args.length) throw new Error('请求格式无效。');
      return { connected: client.state.status === 'connected' };
    }
    if (!viewId || !Array.isArray(args)) throw new Error('缺少已授权的浏览器页面。');
    if (method === 'client:detach') {
      detach(viewId);
      return null;
    }
    if (!enabled || disposed) throw new Error('Web 工作台已关闭。');
    if (method === 'client:state') {
      if (args.length) throw new Error('请求格式无效。');
      if (!views.has(viewId) && views.size >= maxViews) throw new Error('浏览器页面过多。');
      flush();
      views.add(viewId);
      send(stateMessage(true), viewId);
      return { revision };
    }
    if (!views.has(viewId)) throw new Error('请先同步工作台。');
    // A browser frame may arrive after the desktop has connected to a different service.
    // Bind every operation to the connection it was issued for, not whichever one is current.
    const [expectedConnection, ...operationArgs] = args;
    if (expectedConnection !== client.state.connectionId)
      throw new Error('桌面服务连接已变化，请确认当前工作台后重试；操作未发送。');
    args = operationArgs;
    let result: unknown;
    try {
      switch (method) {
        case 'client:request':
          if (args.length !== 1) throw new Error('请求格式无效。');
          result = await request(viewId, command(args[0]));
          break;
        case 'client:fetch': {
          if (args.length !== 1) throw new Error('请求格式无效。');
          const value = command(args[0]);
          if (!fetches.has(value.type)) throw new Error('此请求不返回数据。');
          result = await client.fetch(value as FetchCommand);
          break;
        }
        case 'client:select':
        case 'client:load-earlier': {
          if (args.length !== 1 || !uuid(args[0])) throw new Error('会话标识无效。');
          if (!client.state.sessions.some(({ id }) => id === args[0]))
            throw new Error('会话已经不存在。');
          result =
            method === 'client:select' ? client.select(args[0]) : await client.loadEarlier(args[0]);
          break;
        }
        case 'client:terminal': {
          if (args.length !== 1) throw new Error('请求格式无效。');
          const control = terminalControlSchema.parse(args[0]);
          const terminal = terminals.get(control.sessionId);
          if (
            !terminal ||
            terminal.retired ||
            terminal.viewId !== viewId ||
            terminal.id !== control.terminalId
          )
            throw new Error('原生终端属于另一页面或已经结束。');
          client.terminalControl(control);
          break;
        }
        case 'client:clear-error':
          if (args.length) throw new Error('请求格式无效。');
          client.update({ error: null });
          break;
        default:
          throw new Error('工作台操作不存在。');
      }
      return result ?? null;
    } finally {
      // Callers inspect state immediately after await request/fetch/loadEarlier. Commit it first.
      flush();
    }
  }
  return {
    invoke,
    setEnabled,
    flush,
    terminalBusy: (sessionId: string) => terminals.has(sessionId),
    terminalProblem,
    dispose() {
      disposed = true;
      setEnabled(false);
    },
  };
}

// The browser renders the same components but never opens a service connection. Loss of its Web socket
// rejects in-flight requests without replaying them; reconnect only asks for a fresh desktop snapshot.
export class RemoteClient extends ProxyClient {
  private webSocket: WebSocket | null = null;
  private address: (() => Promise<string>) | null = null;
  private epoch = 0;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private readyTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnecting = false;
  private requests = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (reason: Error) => void;
      timer: ReturnType<typeof setTimeout>;
      command?: Command['type'];
    }
  >();
  private terminalQueues = new Map<string, TerminalQueue>();
  private terminalBytes = 0;
  private revision = -1;
  private clockOffset = 0;
  private remoteActivity: Record<string, number> = {};
  private chunks:
    | { id: string; total: number; next: number; text: string[]; size: number; began: number }
    | undefined;
  serviceNow = () => Date.now() - this.clockOffset;
  activityAt = (sessionId: string) => this.remoteActivity[sessionId] ?? 0;

  connect(...args: Parameters<ProxyClient['connect']>) {
    this.disconnect();
    this.address = args[4] ?? (() => Promise.resolve(args[0]));
    this.reconnecting = true;
    this.update({ status: 'connecting', error: null });
    void this.openWeb();
  }
  private async openWeb() {
    const epoch = ++this.epoch;
    try {
      const url = await this.address?.();
      if (!url || epoch !== this.epoch || !this.reconnecting) return;
      const socket = new WebSocket(url);
      this.webSocket = socket;
      this.revision = -1;
      this.chunks = undefined;
      clearTimeout(this.readyTimer);
      this.readyTimer = setTimeout(() => {
        if (epoch === this.epoch) socket.close();
      }, 50000);
      socket.onopen = () => {
        if (epoch !== this.epoch) return;
        void this.call('client:state', []).catch((error: Error) => {
          this.update({ error: error.message });
          socket.close();
        });
      };
      socket.onmessage = ({ data }) => {
        if (epoch !== this.epoch) return;
        try {
          this.message(JSON.parse(String(data)));
        } catch {
          this.update({ error: '工作台同步数据无效，请重新连接。' });
          socket.close();
        }
      };
      socket.onerror = () => {};
      socket.onclose = () => {
        if (epoch !== this.epoch) return;
        clearTimeout(this.readyTimer);
        this.webSocket = null;
        this.chunks = undefined;
        this.rejectRequests();
        this.scheduleReconnect();
      };
    } catch (error) {
      if (epoch !== this.epoch) return;
      this.update({ error: (error as Error).message });
      this.scheduleReconnect();
    }
  }
  private scheduleReconnect() {
    if (!this.reconnecting) return;
    this.update({ status: 'reconnecting', devices: [] });
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(
      () => {
        this.reconnectTimer = undefined;
        void this.openWeb();
      },
      Math.min(1000 * 2 ** this.attempt++, 5000),
    );
  }
  retryNow() {
    if (!this.reconnecting || !this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    clearTimeout(this.readyTimer);
    this.readyTimer = undefined;
    void this.openWeb();
  }
  disconnect() {
    this.reconnecting = false;
    this.address = null;
    this.epoch++;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    clearTimeout(this.readyTimer);
    this.readyTimer = undefined;
    this.webSocket?.close();
    this.webSocket = null;
    this.chunks = undefined;
    this.rejectRequests();
    this.attempt = 0;
    this.update({ status: 'disconnected', connectionId: null, devices: [] });
  }
  private rejectRequests() {
    this.dropTerminals();
    for (const request of this.requests.values()) {
      clearTimeout(request.timer);
      request.reject(
        request.command
          ? new RequestInterruptedError(request.command)
          : new Error('工作台连接中断。'),
      );
    }
    this.requests.clear();
  }
  private call(
    method: string,
    args: unknown[],
    command?: Command['type'],
    connectionId = this.state.connectionId,
  ): Promise<unknown> {
    const socket = this.webSocket;
    if (!socket || socket.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error('工作台未连接。'));
    if (this.requests.size >= 128) return Promise.reject(new Error('等待处理的请求过多。'));
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.requests.delete(id);
        reject(new Error('请求超时；请查看历史确认结果，未自动重发。'));
      }, 45000);
      this.requests.set(id, { resolve, reject, timer, command });
      try {
        socket.send(
          JSON.stringify({
            id,
            method,
            args: method === 'client:state' ? args : [connectionId, ...args],
          }),
        );
      } catch (error) {
        clearTimeout(timer);
        this.requests.delete(id);
        reject(error);
      }
    });
  }
  private message(value: any) {
    if (!value || typeof value !== 'object') throw new Error('Invalid message');
    if (value.type === 'client:chunk') {
      if (
        !uuid(value.id) ||
        !Number.isInteger(value.total) ||
        value.total < 1 ||
        value.total > maxMessage / chunkSize ||
        !Number.isInteger(value.index) ||
        typeof value.text !== 'string' ||
        value.text.length > chunkSize
      )
        throw new Error('Invalid chunk');
      if (value.index === 0)
        this.chunks = {
          id: value.id,
          total: value.total,
          next: 0,
          text: [],
          size: 0,
          began: Date.now(),
        };
      const current = this.chunks;
      if (
        !current ||
        current.id !== value.id ||
        current.total !== value.total ||
        current.next !== value.index ||
        Date.now() - current.began > 30000
      )
        throw new Error('Out of order chunk');
      current.next++;
      current.size += new TextEncoder().encode(value.text).byteLength;
      if (current.size > maxMessage) throw new Error('Oversized snapshot');
      current.text.push(value.text);
      if (current.next === current.total) {
        this.chunks = undefined;
        this.message(JSON.parse(current.text.join('')));
      }
      return;
    }
    if (value.type === 'response') {
      const request = this.requests.get(value.id);
      if (!request) return;
      clearTimeout(request.timer);
      this.requests.delete(value.id);
      if (value.ok) request.resolve(value.result);
      else
        request.reject(
          new Error(typeof value.error === 'string' ? value.error : '工作台操作失败。'),
        );
      return;
    }
    if (value.type === 'client:error') {
      this.update({ error: String(value.message) });
      this.webSocket?.close();
      return;
    }
    if (value.type === 'client:terminal') {
      const message = value.message as TerminalMessage;
      if (
        !message ||
        !['terminal.opened', 'terminal.data', 'terminal.closed'].includes(message.type)
      )
        throw new Error('Invalid terminal message');
      if (message.type === 'terminal.closed')
        this.dropTerminals(message.sessionId, message.terminalId);
      for (const listener of this.terminalListeners) listener(message);
      return;
    }
    if (
      value.type !== 'client:state' ||
      !Number.isSafeInteger(value.revision) ||
      typeof value.full !== 'boolean' ||
      !value.state ||
      !value.events ||
      !value.clock
    )
      throw new Error('Invalid state');
    const message = value as StateMessage;
    if (!message.full && message.revision !== this.revision + 1)
      throw new Error('State revision gap');
    if (message.full && message.revision < this.revision) return;
    const events: ClientState['events'] = message.full ? {} : { ...this.state.events };
    for (const [id, change] of Object.entries(message.events)) {
      if (change === null) delete events[id];
      else if (change.replace) events[id] = change.replace;
      else {
        const bySequence = new Map((events[id] ?? []).map((event) => [event.sequence, event]));
        for (const sequence of change.remove ?? []) bySequence.delete(sequence);
        for (const event of change.upsert ?? []) bySequence.set(event.sequence, event);
        events[id] = [...bySequence.values()].sort((a, b) => a.sequence - b.sequence);
      }
    }
    this.revision = message.revision;
    clearTimeout(this.readyTimer);
    this.readyTimer = undefined;
    this.clockOffset = Date.now() - message.clock.now;
    this.remoteActivity = message.clock.activity;
    this.attempt = 0;
    this.update({ ...message.state, events });
  }
  request(command: Command): ReturnType<ProxyClient['request']> {
    if (command.type === 'terminal.close') {
      const queue = this.terminalQueue(command);
      if (queue) {
        this.terminalBytes -= queue.bytes;
        queue.input = [];
        queue.bytes = queue.ack = 0;
        queue.resize = undefined;
        queue.closed = true;
      }
    }
    return this.call('client:request', [command], command.type) as ReturnType<
      ProxyClient['request']
    >;
  }
  fetch<T extends keyof Replies>(command: Extract<Command, { type: T }>) {
    return this.call('client:fetch', [command], (command as FetchCommand).type) as Promise<
      Extract<ServerMessage, { type: Replies[T] }>
    >;
  }
  select(sessionId: string) {
    // exportSession waits on history.loading immediately after select(). Preserve that contract while
    // the authoritative desktop selection travels back, without claiming a second local selection.
    const previous = this.state.history[sessionId];
    this.update({
      history: {
        ...this.state.history,
        [sessionId]: {
          ...(previous ?? {
            firstSequence: 0,
            lastSequence: 0,
            hasEarlier: false,
            loadingEarlier: false,
          }),
          loading: true,
        },
      },
    });
    void this.call('client:select', [sessionId]).catch((error: Error) =>
      this.update({
        error: error.message,
        history: {
          ...this.state.history,
          [sessionId]: { ...this.state.history[sessionId]!, loading: false },
        },
      }),
    );
  }
  async loadEarlier(sessionId: string) {
    await this.call('client:load-earlier', [sessionId], 'session.history');
  }
  private dropTerminals(sessionId?: string, terminalId?: string) {
    for (const [key, queue] of this.terminalQueues) {
      if (sessionId && key !== `${sessionId}:${terminalId}`) continue;
      this.terminalBytes -= queue.bytes;
      this.terminalQueues.delete(key);
    }
  }
  private terminalQueue(command: { sessionId: string; terminalId: string }) {
    const key = `${command.sessionId}:${command.terminalId}`;
    let queue = this.terminalQueues.get(key);
    if (!queue && this.terminalQueues.size < maxViews) {
      queue = {
        connectionId: this.state.connectionId,
        input: [],
        bytes: 0,
        ack: 0,
        inputPending: false,
        inputBlocked: false,
        ackPending: false,
        resizePending: false,
        closed: false,
      };
      this.terminalQueues.set(key, queue);
    }
    return queue;
  }
  private pumpTerminal(sessionId: string, terminalId: string, queue: TerminalQueue) {
    const key = `${sessionId}:${terminalId}`;
    if (this.terminalQueues.get(key) !== queue || queue.closed) return;
    const send = (
      command: TerminalControl,
      pending: 'inputPending' | 'ackPending' | 'resizePending',
    ) => {
      queue[pending] = true;
      void this.call('client:terminal', [command], undefined, queue.connectionId)
        .catch((error: Error) => {
          if (this.terminalQueues.get(key) !== queue) return;
          // An uncertain input is never replayed; discard the remainder rather than sending a suffix.
          this.terminalBytes -= queue.bytes;
          queue.input = [];
          queue.bytes = queue.ack = 0;
          queue.resize = undefined;
          queue.closed = true;
          this.update({ error: error.message });
        })
        .finally(() => {
          queue[pending] = false;
          this.pumpTerminal(sessionId, terminalId, queue);
        });
    };
    // Each stream has its own slot: a long paste cannot delay output acknowledgements or resizes.
    if (!queue.ackPending && queue.ack) {
      const bytes = Math.min(queue.ack, MAX_FRAME_BYTES);
      queue.ack -= bytes;
      send({ type: 'terminal.ack', sessionId, terminalId, bytes }, 'ackPending');
    }
    if (!queue.resizePending && queue.resize) {
      const size = queue.resize;
      queue.resize = undefined;
      send(size, 'resizePending');
    }
    if (!queue.inputPending && queue.input.length) {
      const input = queue.input.shift()!;
      const bytes = new TextEncoder().encode(input.data).byteLength;
      queue.bytes -= bytes;
      this.terminalBytes -= bytes;
      send(input, 'inputPending');
    }
  }
  terminalControl(command: TerminalControl) {
    if (this.state.status !== 'connected') return;
    const queue = this.terminalQueue(command);
    if (!queue || queue.closed) return;
    if (command.type === 'terminal.input') {
      if (queue.inputBlocked) return;
      const bytes = new TextEncoder().encode(command.data).byteLength;
      if (this.terminalBytes + bytes > 1024 * 1024 || queue.input.length >= 256) {
        this.terminalBytes -= queue.bytes;
        queue.input = [];
        queue.bytes = 0;
        queue.inputBlocked = true;
        this.update({
          error: '终端粘贴过大，未发送的输入已丢弃；请关闭后重新打开终端并分段粘贴。',
        });
        return;
      }
      queue.input.push(command);
      queue.bytes += bytes;
      this.terminalBytes += bytes;
    } else if (command.type === 'terminal.ack') queue.ack += command.bytes;
    else queue.resize = command;
    this.pumpTerminal(command.sessionId, command.terminalId, queue);
  }
  clearRemoteError() {
    void this.call('client:clear-error', []).catch((error: Error) =>
      this.update({ error: error.message }),
    );
  }
  update(values: Partial<ClientState>) {
    if (
      ('connectionId' in values && values.connectionId !== this.state.connectionId) ||
      (values.status && values.status !== 'connected')
    )
      this.dropTerminals();
    super.update(values);
    if (
      Object.keys(values).length === 1 &&
      values.error === null &&
      this.webSocket?.readyState === WebSocket.OPEN
    )
      this.clearRemoteError();
  }
}
