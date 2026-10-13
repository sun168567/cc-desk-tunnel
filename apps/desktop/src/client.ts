import {
  continues,
  isFragment,
  PROTOCOL_VERSION,
  serverMessageSchema,
} from '@cc-desk-tunnel/protocol';
import type {
  AccountState,
  Command,
  Device,
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
// Losing a reply says nothing about whether the operation reached the service. Keep that uncertainty
// separate from the current connection state, which can recover while the warning is still displayed.
export class RequestInterruptedError extends Error {
  readonly readOnly: boolean;
  constructor(type: Command['type']) {
    const readOnly = [
      'session.subscribe',
      'session.history',
      'session.status',
      'account.status',
      'usage.summary',
      'usage.query',
      'settings.get',
      'service.update.check',
    ].includes(type);
    super(
      readOnly
        ? '连接中断，上次读取未完成；连接恢复后可重试。'
        : '连接中断；上次请求的确认未收到。任务可能仍在运行，请查看会话历史确认结果；不会自动重发。',
    );
    this.name = 'RequestInterruptedError';
    this.readOnly = readOnly;
  }
  describe(connected: boolean) {
    if (!connected) return this.message;
    return this.readOnly
      ? '连接已恢复；上次读取未完成，请重试。'
      : '连接已恢复；上次请求的确认因断线未收到。任务可能仍在运行，请查看会话历史确认结果；不会自动重发。';
  }
}

export type HistoryState = {
  firstSequence: number;
  lastSequence: number;
  hasEarlier: boolean;
  loading: boolean;
  loadingEarlier: boolean;
};
export type ClientState = {
  status: 'disconnected' | 'connecting' | 'connected' | 'reconnecting';
  connectionId: string | null;
  // The computer this client signed in as; a session is worked on from the one it is on.
  device: Device | null;
  sessions: Session[];
  events: Record<string, SessionEvent[]>;
  // Output a run is in the middle of, as far as it has arrived. It has no place in the history yet: the
  // event that records it takes its place.
  live: Record<string, SessionEvent>;
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
  // How much of the installer of its own version the service has fetched so far, from 0 to 1, while it is
  // still fetching it.
  preparing: number | null;
  model: string | null;
  // The latest native readings from any session, for views that are not tied to the selected one.
  capabilities: NativeCapabilities | null;
  metrics: NativeMetrics | null;
  account: AccountState | null;
};

// The renderer's single connection and its state store: components read `state` through subscribe / getSnapshot
// and send commands with request(). A connection that breaks is made again, for as long as it takes, and what
// was missed is read from the service's record; nothing is resent automatically.
export class ProxyClient {
  state: ClientState = {
    status: 'disconnected',
    connectionId: null,
    device: null,
    sessions: [],
    events: {},
    live: {},
    history: {},
    selectedId: null,
    error: null,
    adapter: 'simulation',
    release: null,
    service: null,
    update: null,
    mismatch: false,
    preparing: null,
    model: null,
    capabilities: null,
    metrics: null,
    account: null,
  };
  results = new Map<string, DataMessage>();
  listeners = new Set<() => void>();
  terminalListeners = new Set<(message: TerminalMessage) => void>();
  socket: WebSocket | null = null;
  credentials: {
    url: string;
    token: string;
    device: Device;
    reconnect: boolean;
    // Remote mode: opens the bridge in the main process and resolves to its address. A bridge serves one
    // connection, so every attempt asks for a new one.
    bridge?: () => Promise<string>;
  } | null = null;
  retryTimer: ReturnType<typeof setTimeout> | undefined;
  retryAttempt = 0;
  // Whether this sign-in has stood once. Until then a failure is the user's to look at; after it, a fault on
  // the way is tried again.
  private established = false;
  // Tells the answer of the bridge asked for last from those of earlier attempts.
  private turn = 0;
  // Streamed events and fragments are taken in batches, in the order they came, so a fast reply does not
  // re-render per fragment.
  streamTimer: ReturnType<typeof setTimeout> | undefined;
  streamEvents: (SessionEvent | Extract<ServerMessage, { type: 'session.fragment' }>)[] = [];
  // Event history is kept for the most recently viewed sessions only.
  cacheOrder: string[] = [];
  pending = new Map<
    string,
    {
      resolve: (response: Response) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
      type: Command['type'];
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
  connect(
    url: string,
    token: string,
    device: Device,
    reconnect = true,
    bridge?: () => Promise<string>,
  ) {
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
    this.credentials = { url: address.toString(), token: token.trim(), device, reconnect, bridge };
    this.established = false;
    this.cacheOrder = [];
    this.update({
      status: 'connecting',
      device,
      error: null,
      release: null,
      service: null,
      update: null,
      mismatch: false,
      preparing: null,
      sessions: [],
      events: {},
      live: {},
      history: {},
      selectedId: null,
      capabilities: null,
      metrics: null,
      account: null,
    });
    this.open();
  }
  private open() {
    const credentials = this.credentials;
    if (!credentials) return;
    if (!credentials.bridge) {
      this.attach(credentials);
      return;
    }
    const turn = ++this.turn;
    const current = () => this.credentials === credentials && this.turn === turn;
    credentials.bridge().then(
      (url) => {
        if (!current()) return;
        credentials.url = url;
        this.attach(credentials);
      },
      // The bridge could not even be set up on this computer: nothing a later attempt would change.
      (error) => {
        if (!current()) return;
        this.credentials = null;
        this.update({
          status: 'disconnected',
          connectionId: null,
          error: error instanceof Error ? error.message : '本机连接准备失败。',
        });
      },
    );
  }
  private attach(credentials: NonNullable<ProxyClient['credentials']>) {
    const socket = new WebSocket(credentials.url);
    this.socket = socket;
    const timeout = setTimeout(() => socket.close(), 50000);
    socket.onopen = () => {
      socket.send(
        JSON.stringify({
          type: 'auth',
          protocolVersion: PROTOCOL_VERSION,
          token: credentials.token,
          deviceName: credentials.device.name,
        }),
      );
      socket.send(JSON.stringify({ type: 'device', id: credentials.device.id }));
    };
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
        if (message.adapter === 'claude-code' && !credentials.bridge) credentials.reconnect = false;
        this.established = true;
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
            preparing: message.preparing
              ? message.preparing.size
                ? message.preparing.received / message.preparing.size
                : 0
              : null,
          });
        if (
          [
            'unauthorized',
            'version_mismatch',
            'tunnel_failed',
            'ssh_failed',
            'connection_lost',
            'client_failed',
          ].includes(message.code)
        ) {
          // The way to the service broke, or the service could not reach back: the next attempt may do.
          const passing =
            this.established &&
            credentials.reconnect &&
            ['tunnel_failed', 'ssh_failed', 'connection_lost'].includes(message.code);
          if (!passing) this.credentials = null;
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
        const live = { ...this.state.live };
        const history = { ...this.state.history };
        delete events[message.sessionId];
        delete live[message.sessionId];
        delete history[message.sessionId];
        this.streamEvents = this.streamEvents.filter(
          (event) => event.sessionId !== message.sessionId,
        );
        this.cacheOrder = this.cacheOrder.filter((id) => id !== message.sessionId);
        const sessions = this.state.sessions.filter((session) => session.id !== message.sessionId);
        const selectedId =
          this.state.selectedId === message.sessionId ? null : this.state.selectedId;
        this.update({ sessions, events, live, history, selectedId });
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
        // History up to now ends where unfinished output begins; the service sends that again, whole.
        if (message.mode !== 'prepend' && this.state.live[id]) {
          const { [id]: _stale, ...live } = this.state.live;
          this.update({ live });
        }
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
      } else if (message.type === 'session.fragment') {
        if (!this.cacheOrder.includes(message.sessionId)) return;
        this.streamEvents.push(message);
        this.streamTimer ??= setTimeout(() => this.flushStream(), 32);
      }
    };
    socket.onclose = () => {
      clearTimeout(timeout);
      if (this.socket !== socket) return;
      this.socket = null;
      this.flushStream();
      this.rejectPending();
      if (
        !this.credentials ||
        !this.credentials.reconnect ||
        (this.credentials.bridge && !this.established)
      ) {
        const nativeClosed = !!this.credentials;
        this.credentials = null;
        this.update({
          status: 'disconnected',
          connectionId: null,
          error: this.state.error ?? (nativeClosed ? '原生连接已结束，请重新连接。' : null),
        });
        return;
      }
      this.update({ status: 'reconnecting', connectionId: null });
      this.retryTimer = setTimeout(
        () => {
          this.retryTimer = undefined;
          this.open();
        },
        Math.min(1000 * 2 ** this.retryAttempt++, credentials.bridge ? 10000 : 5000),
      );
    };
    socket.onerror = () => {
      /* onclose owns reconnect and pending request cleanup. */
    };
  }
  // Makes the attempt that is waiting for its turn now: the network just came back.
  retryNow() {
    if (this.state.status !== 'reconnecting' || this.retryTimer === undefined) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.open();
  }
  disconnect() {
    this.flushStream();
    this.credentials = null;
    this.turn++;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    const socket = this.socket;
    this.socket = null;
    // Said before closing, so that the service does not keep this computer's runs for it to come back to.
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'leave' }));
    socket?.close();
    this.rejectPending();
    this.retryAttempt = 0;
    this.update({ status: 'disconnected', connectionId: null });
  }
  private rejectPending() {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new RequestInterruptedError(request.type));
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
    const live = { ...this.state.live };
    let moved = false;
    for (const item of this.streamEvents) {
      const open = live[item.sessionId];
      if ('type' in item) {
        const { sessionId, runId, payload } = item;
        if (!isFragment(payload)) continue;
        const last = open?.runId === runId ? open.payload : undefined;
        live[sessionId] =
          open && last && isFragment(last) && continues(last, payload)
            ? { ...open, payload: { ...payload, text: last.text + payload.text } }
            : { sessionId, runId, sequence: 0, createdAt: new Date().toISOString(), payload };
        moved = true;
        continue;
      }
      // Whatever the run records next comes after its unfinished output, which is recorded first.
      if (open?.runId === item.runId) {
        delete live[item.sessionId];
        moved = true;
      }
      const events = grouped.get(item.sessionId) ?? [];
      events.push(item);
      grouped.set(item.sessionId, events);
    }
    this.streamEvents = [];
    if (moved) this.update({ live });
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
  // A session's events as they are shown: what is recorded, then the output still arriving, where the event
  // that records it will be.
  shown(sessionId: string): SessionEvent[] {
    const recorded = this.state.events[sessionId] ?? [];
    const unfinished = this.state.live[sessionId];
    return unfinished
      ? [...recorded, { ...unfinished, sequence: (recorded.at(-1)?.sequence ?? 0) + 1 }]
      : recorded;
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
    const live = { ...this.state.live };
    const history = { ...this.state.history };
    while (this.cacheOrder.length > 4) {
      const evicted = this.cacheOrder.shift()!;
      delete events[evicted];
      delete live[evicted];
      delete history[evicted];
    }
    this.update({ selectedId: sessionId, events, live, history });
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
  async request(command: NewCommand, requestId = crypto.randomUUID()): Promise<Response> {
    if (this.state.status !== 'connected' || this.socket?.readyState !== WebSocket.OPEN)
      throw new Error('服务未连接。');
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
      this.pending.set(requestId, { resolve, reject, timer, type: command.type });
      this.socket!.send(JSON.stringify({ ...command, requestId }));
    });
  }
}
