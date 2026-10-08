import { PROTOCOL_VERSION, serverMessageSchema } from '@cc-desk-tunnel/protocol';
import type {
  AccountState,
  Command,
  NativeCapabilities,
  NativeMetrics,
  ServerMessage,
  ServiceUpdate,
  Session,
  SessionEvent,
  TerminalControl,
} from '@cc-desk-tunnel/protocol';

type Response = Extract<ServerMessage, { type: 'response' }>;
type DataMessage = Extract<
  ServerMessage,
  { type: 'usage.summary' | 'usage.page' | 'settings.state' }
>;
// Commands answered with a data frame, and the frame each one gets.
type Replies = {
  'usage.summary': 'usage.summary';
  'usage.query': 'usage.page';
  'settings.get': 'settings.state';
  'settings.update': 'settings.state';
};
type TerminalMessage = Extract<
  ServerMessage,
  { type: 'terminal.opened' | 'terminal.data' | 'terminal.closed' }
>;
type NewCommand = Command extends infer C
  ? C extends Command
    ? Omit<C, 'requestId'>
    : never
  : never;
export type HistoryState = {
  firstSequence: number;
  lastSequence: number;
  hasEarlier: boolean;
  loading: boolean;
  loadingEarlier: boolean;
};
export type ClientState = {
  status: 'disconnected' | 'connecting' | 'connected' | 'reconnecting';
  // The local bridge is taking the service connection back after a network drop. The connection, its runs and
  // terminal stay; what is sent meanwhile goes out once it is back.
  resuming: boolean;
  connectionId: string | null;
  sessions: Session[];
  events: Record<string, SessionEvent[]>;
  history: Record<string, HistoryState>;
  selectedId: string | null;
  error: string | null;
  adapter: 'simulation' | 'claude-code';
  // The Windows installer version the service offers, if any.
  release: string | null;
  // The service's version and where it stands against the published releases, if it follows them.
  service: string | null;
  update: ServiceUpdate | null;
  // The service refused this client for its version; it may still hand out an installer.
  mismatch: boolean;
  model: string | null;
  // The latest native readings from any session, for views that are not tied to the selected one.
  capabilities: NativeCapabilities | null;
  metrics: NativeMetrics | null;
  account: AccountState | null;
};

// The renderer's single connection and its state store: components read `state` through subscribe / getSnapshot
// and send commands with request(). Nothing is resent automatically after a disconnect.
export class ProxyClient {
  state: ClientState = {
    status: 'disconnected',
    resuming: false,
    connectionId: null,
    sessions: [],
    events: {},
    history: {},
    selectedId: null,
    error: null,
    adapter: 'simulation',
    release: null,
    service: null,
    update: null,
    mismatch: false,
    model: null,
    capabilities: null,
    metrics: null,
    account: null,
  };
  results = new Map<string, DataMessage>();
  listeners = new Set<() => void>();
  terminalListeners = new Set<(message: TerminalMessage) => void>();
  socket: WebSocket | null = null;
  credentials: { url: string; token: string; reconnect: boolean } | null = null;
  retryTimer: ReturnType<typeof setTimeout> | undefined;
  retryAttempt = 0;
  // Streamed events are merged in batches so a fast reply does not re-render per fragment.
  streamTimer: ReturnType<typeof setTimeout> | undefined;
  streamEvents: SessionEvent[] = [];
  // Event history is kept for the most recently viewed sessions only.
  cacheOrder: string[] = [];
  pending = new Map<
    string,
    {
      resolve: (response: Response) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  update(values: Partial<ClientState>) {
    this.state = { ...this.state, ...values };
    for (const listener of this.listeners) listener();
  }
  connect(url: string, token: string, reconnect = true) {
    const address = new URL(url);
    if (
      !['ws:', 'wss:'].includes(address.protocol) ||
      address.username ||
      address.password ||
      address.search ||
      address.hash
    )
      throw new Error('请输入不含凭据的 WebSocket 服务地址。');
    if (
      !['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname) ||
      address.protocol !== 'ws:'
    )
      throw new Error('当前离线原型仅连接本机环回服务。');
    if (token.trim().length < 24) throw new Error('服务凭据至少 24 个字符。');
    this.disconnect();
    this.credentials = { url: address.toString(), token: token.trim(), reconnect };
    this.cacheOrder = [];
    this.update({
      status: 'connecting',
      resuming: false,
      error: null,
      release: null,
      service: null,
      update: null,
      mismatch: false,
      sessions: [],
      events: {},
      history: {},
      selectedId: null,
      capabilities: null,
      metrics: null,
      account: null,
    });
    this.open();
  }
  private open() {
    if (!this.credentials) return;
    const credentials = this.credentials;
    const socket = new WebSocket(credentials.url);
    this.socket = socket;
    const timeout = setTimeout(() => socket.close(), 50000);
    socket.onopen = () =>
      socket.send(
        JSON.stringify({
          type: 'auth',
          protocolVersion: PROTOCOL_VERSION,
          token: credentials.token,
          deviceName: 'Windows desktop',
        }),
      );
    socket.onmessage = ({ data }) => {
      if (this.socket !== socket) return;
      let message: ServerMessage;
      try {
        message = serverMessageSchema.parse(JSON.parse(data));
      } catch {
        this.update({ error: '服务消息格式不兼容，已断开连接。' });
        this.credentials = null;
        socket.close();
        return;
      }
      if (message.type === 'ready') {
        if (message.adapter === 'claude-code') credentials.reconnect = false;
        clearTimeout(timeout);
        this.retryAttempt = 0;
        const selectedId = message.sessions.some((session) => session.id === this.state.selectedId)
          ? this.state.selectedId
          : null;
        this.update({
          status: 'connected',
          connectionId: message.connectionId,
          sessions: message.sessions,
          selectedId,
          error: null,
          adapter: message.adapter,
          release: message.client?.version ?? null,
          service: message.version,
          update: message.update ?? null,
          model: message.model ?? null,
        });
        if (selectedId) this.load(selectedId);
      } else if (message.type === 'connection.state') {
        this.update({ resuming: message.state === 'reconnecting' });
      } else if (message.type === 'response') {
        const request = this.pending.get(message.requestId);
        if (!request) return;
        clearTimeout(request.timer);
        this.pending.delete(message.requestId);
        if (message.ok) request.resolve(message);
        else request.reject(new Error(message.message ?? '请求失败。'));
      } else if (message.type === 'connection.error') {
        this.update({ error: message.message });
        if (message.code === 'version_mismatch')
          this.update({
            mismatch: true,
            service: message.service ?? null,
            release: message.client?.version ?? null,
          });
        if (
          [
            'unauthorized',
            'version_mismatch',
            'tunnel_failed',
            'device_busy',
            'ssh_failed',
          ].includes(message.code)
        ) {
          this.credentials = null;
          socket.close();
        }
      } else if (
        message.type === 'usage.summary' ||
        message.type === 'usage.page' ||
        message.type === 'settings.state'
      ) {
        if (this.pending.has(message.requestId)) this.results.set(message.requestId, message);
      } else if (message.type === 'service.update') {
        const { type: _type, ...update } = message;
        this.update(
          update.state === 'restarting'
            ? { update, error: `服务端已升级到 ${update.latest}，正在重启；请稍候重新连接。` }
            : { update },
        );
      } else if (message.type === 'account.state') {
        const { type: _type, ...account } = message;
        // A signed-out account must not keep showing the previous one's identity and quota.
        this.update(
          account.loggedIn ? { account } : { account, capabilities: null, metrics: null },
        );
      } else if (message.type === 'session.updated') {
        this.upsert(message.session);
      } else if (
        message.type === 'terminal.opened' ||
        message.type === 'terminal.data' ||
        message.type === 'terminal.closed'
      ) {
        for (const listener of this.terminalListeners) listener(message);
      } else if (message.type === 'session.deleted') {
        const events = { ...this.state.events };
        const history = { ...this.state.history };
        delete events[message.sessionId];
        delete history[message.sessionId];
        this.streamEvents = this.streamEvents.filter(
          (event) => event.sessionId !== message.sessionId,
        );
        this.cacheOrder = this.cacheOrder.filter((id) => id !== message.sessionId);
        const sessions = this.state.sessions.filter((session) => session.id !== message.sessionId);
        const selectedId =
          this.state.selectedId === message.sessionId ? null : this.state.selectedId;
        this.update({ sessions, events, history, selectedId });
      } else if (message.type === 'session.snapshot') {
        this.flushStream();
        if (
          !this.pending.has(message.requestId) ||
          !this.cacheOrder.includes(message.session.id) ||
          !this.state.sessions.some((session) => session.id === message.session.id)
        )
          return;
        this.upsert(message.session);
        const id = message.session.id;
        const previous = this.state.history[id];
        const history = {
          firstSequence:
            message.mode === 'append'
              ? (previous?.firstSequence ?? message.firstSequence)
              : message.firstSequence,
          lastSequence:
            message.mode === 'prepend'
              ? (previous?.lastSequence ?? message.lastSequence)
              : message.lastSequence,
          hasEarlier:
            message.mode === 'append' ? (previous?.hasEarlier ?? false) : message.hasEarlier,
          loading: false,
          loadingEarlier: false,
        };
        this.merge(id, message.events, history, message.mode === 'replace');
      } else if (message.type === 'session.event') {
        const payload = message.event.payload;
        if (payload.type === 'native.capabilities') this.update({ capabilities: payload });
        if (payload.type === 'native.metrics') this.update({ metrics: payload });
        if (!this.cacheOrder.includes(message.event.sessionId)) return;
        this.streamEvents.push(message.event);
        this.streamTimer ??= setTimeout(() => this.flushStream(), 32);
      }
    };
    socket.onclose = () => {
      clearTimeout(timeout);
      if (this.socket !== socket) return;
      this.socket = null;
      this.flushStream();
      this.rejectPending();
      if (!this.credentials || !this.credentials.reconnect) {
        const nativeClosed = !!this.credentials;
        this.credentials = null;
        this.update({
          status: 'disconnected',
          resuming: false,
          connectionId: null,
          error: this.state.error ?? (nativeClosed ? '原生连接已结束，请重新连接。' : null),
        });
        return;
      }
      this.update({ status: 'reconnecting', connectionId: null });
      this.retryTimer = setTimeout(
        () => this.open(),
        Math.min(1000 * 2 ** this.retryAttempt++, 5000),
      );
    };
    socket.onerror = () => {
      /* onclose owns reconnect and pending request cleanup. */
    };
  }
  disconnect() {
    this.flushStream();
    this.credentials = null;
    clearTimeout(this.retryTimer);
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    this.rejectPending();
    this.retryAttempt = 0;
    this.update({ status: 'disconnected', resuming: false, connectionId: null });
  }
  private rejectPending() {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error('连接中断；请以恢复后的历史确认提交结果，不会自动重发。'));
    }
    this.pending.clear();
  }
  private upsert(session: Session) {
    this.update({
      sessions: [...this.state.sessions.filter((item) => item.id !== session.id), session].sort(
        (a, b) => b.updatedAt.localeCompare(a.updatedAt),
      ),
    });
  }
  private flushStream() {
    clearTimeout(this.streamTimer);
    this.streamTimer = undefined;
    const grouped = new Map<string, SessionEvent[]>();
    for (const event of this.streamEvents) {
      const events = grouped.get(event.sessionId) ?? [];
      events.push(event);
      grouped.set(event.sessionId, events);
    }
    this.streamEvents = [];
    for (const [id, events] of grouped) this.merge(id, events);
  }
  private merge(
    sessionId: string,
    events: SessionEvent[],
    history?: HistoryState,
    replace = false,
  ) {
    const bySequence = new Map(
      (replace ? [] : (this.state.events[sessionId] ?? [])).map((event) => [event.sequence, event]),
    );
    for (const event of events) bySequence.set(event.sequence, event);
    const combined = [...bySequence.values()].sort((a, b) => a.sequence - b.sequence);
    const previous = history ??
      this.state.history[sessionId] ?? {
        firstSequence: combined[0]?.sequence ?? 0,
        lastSequence: 0,
        hasEarlier: false,
        loading: false,
        loadingEarlier: false,
      };
    this.update({
      events: {
        ...this.state.events,
        [sessionId]: combined,
      },
      history: {
        ...this.state.history,
        [sessionId]: {
          ...previous,
          lastSequence: Math.max(previous.lastSequence, combined.at(-1)?.sequence ?? 0),
        },
      },
    });
  }
  private load(sessionId: string) {
    const previous = this.state.history[sessionId];
    const afterSequence = previous?.lastSequence ?? 0;
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
    void this.request({ type: 'session.subscribe', sessionId, afterSequence }).catch(
      (error: Error) => {
        const history = this.state.history[sessionId];
        if (history)
          this.update({
            error: error.message,
            history: { ...this.state.history, [sessionId]: { ...history, loading: false } },
          });
      },
    );
  }
  async loadEarlier(sessionId: string) {
    const history = this.state.history[sessionId];
    if (!history?.hasEarlier || history.loadingEarlier || history.loading) return;
    this.update({
      history: { ...this.state.history, [sessionId]: { ...history, loadingEarlier: true } },
    });
    try {
      await this.request({
        type: 'session.history',
        sessionId,
        beforeSequence: history.firstSequence,
      });
    } catch (error) {
      const current = this.state.history[sessionId];
      if (current)
        this.update({
          history: { ...this.state.history, [sessionId]: { ...current, loadingEarlier: false } },
        });
      throw error;
    }
  }
  select(sessionId: string) {
    this.flushStream();
    this.cacheOrder = [...this.cacheOrder.filter((id) => id !== sessionId), sessionId];
    const events = { ...this.state.events };
    const history = { ...this.state.history };
    while (this.cacheOrder.length > 4) {
      const evicted = this.cacheOrder.shift()!;
      delete events[evicted];
      delete history[evicted];
    }
    this.update({ selectedId: sessionId, events, history });
    if (this.state.status === 'connected') this.load(sessionId);
  }
  // Terminal output bypasses the state store; xterm consumes it directly.
  onTerminal = (listener: (message: TerminalMessage) => void) => {
    this.terminalListeners.add(listener);
    return () => {
      this.terminalListeners.delete(listener);
    };
  };
  terminalControl(command: TerminalControl) {
    if (this.state.status === 'connected' && this.socket?.readyState === WebSocket.OPEN)
      this.socket.send(JSON.stringify(command));
  }
  // Data replies arrive just before their response frame.
  async fetch<T extends keyof Replies>(command: Extract<NewCommand, { type: T }>) {
    const response = await this.request(command);
    const result = this.results.get(response.requestId);
    this.results.delete(response.requestId);
    if (!result) throw new Error('服务没有返回数据。');
    return result as Extract<ServerMessage, { type: Replies[T] }>;
  }
  async request(command: NewCommand): Promise<Response> {
    if (this.state.status !== 'connected' || this.socket?.readyState !== WebSocket.OPEN)
      throw new Error('服务未连接。');
    const requestId = crypto.randomUUID();
    return new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.pending.delete(requestId);
          reject(new Error('请求超时；请查看历史确认结果，未自动重发。'));
        },
        command.type === 'session.status' ||
          command.type.startsWith('account.') ||
          command.type.startsWith('service.')
          ? 30000
          : 10000,
      );
      this.pending.set(requestId, { resolve, reject, timer });
      this.socket!.send(JSON.stringify({ ...command, requestId }));
    });
  }
}
