import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import type { IncomingMessage, RequestListener } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { WebSocket, WebSocketServer } from 'ws';
import {
  deleteSession,
  forkSession,
  getSessionMessages,
  listSessions,
  renameSession,
} from '@anthropic-ai/claude-agent-sdk';
import {
  authSchema,
  commandSchema,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  ResumeLog,
  resumeAckSchema,
  tunnelAttachSchema,
  tunnelCredentialsSchema,
  terminalControlSchema,
  terminalStatusSchema,
} from '@cc-desk-tunnel/protocol';
import type {
  AccountState,
  Command,
  EventPayload,
  ServerMessage,
  Session,
  TerminalControl,
  TerminalStatus,
  TunnelAttach,
  TunnelCredentials,
} from '@cc-desk-tunnel/protocol';
import {
  hookEnvironment,
  runClaude,
  nativeDirectory,
  prepareNativeDirectory,
  readNativeStatus,
} from './claude.ts';
import type { ClaudeOptions } from './claude.ts';
import { ClientReleases } from './client-release.ts';
import { DomainError } from './errors.ts';
import type { NativeLogin } from './native-account.ts';
import { NativeInput } from './native-input.ts';
import { RelayTunnel } from './relay.ts';
import { completeOnboarding } from './native-onboarding.ts';
import { readNativeSettings, updateNativeSettings } from './native-settings.ts';
import type { NativeTerminal } from './native-terminal.ts';
import { simulate } from './simulation.ts';
import { SessionStore } from './store.ts';
import { Throttle } from './throttle.ts';
import { WindowsTunnel } from './tunnel.ts';
import type { TunnelOptions } from './tunnel.ts';
import { ServiceUpdates, serviceVersion } from './updates.ts';
import type { UpdateOptions } from './updates.ts';
import { UsageLog, createUsageReceiver, telemetryEnvironment } from './usage.ts';

type Peer = {
  socket: WebSocket;
  id: string;
  address: string;
  authenticated: boolean;
  // A relay connection of the tunnel owner: it carries SSH bytes, not protocol frames.
  relay?: boolean;
  tunnel?: WindowsTunnel;
  registering: boolean;
  subscriptions: Set<string>;
  responses: Map<string, { command: string; response: Promise<ServerMessage> }>;
  // A connection whose client reconnects by itself outlives a network drop for a grace period: its frames are
  // numbered and held until acknowledged, and its runs, terminal and tunnel wait for it (`detached`).
  resume?: { key: string; log: ResumeLog };
  detached?: ReturnType<typeof setTimeout>;
};
export type Run = {
  id: string;
  sessionId: string;
  owner: Peer;
  controller: AbortController;
  // Simulation keeps its single tool and approval here; native runs use `approvals` and `input`.
  toolId?: string;
  toolFinished: boolean;
  approvalId?: string;
  decide?: (allowed: boolean) => void;
  approvals: Map<string, (allowed: boolean) => void>;
  cancelReason?: string;
  input?: NativeInput;
  controls: { refresh?: () => Promise<void> };
};
// A native terminal keeps running while no client shows it; `reattach` marks one that was shown when its
// connection dropped, to be shown again when it resumes.
type Terminal = {
  id: string;
  sessionId: string;
  owner: Peer;
  process?: NativeTerminal;
  status: TerminalStatus;
  since: string;
  reattach?: boolean;
};
// Each terminal is a CLI process with its own memory; this bounds what one device can start.
const MAX_TERMINALS = 8;
type Login = { process: NativeLogin; owner: Peer; url?: string };
type CommandOf<T extends Command['type']> = Extract<Command, { type: T }>;
export type ServerOptions = {
  token: string;
  dataDir: string;
  stepMs?: number;
  allowedOrigins?: string[];
  claude?: ClaudeOptions;
  tunnel?: TunnelOptions;
  tls?: { cert: Buffer; key: Buffer };
  reverseProxy?: boolean;
  host?: string;
  // Where an administrator puts the Windows installer offered to clients; defaults to <dataDir>/client.
  clientDir?: string;
  // Following the published releases; absent, the service neither looks for nor installs newer versions.
  updates?: Omit<UpdateOptions, 'clientDir'>;
  // How long a dropped resumable connection is kept for its client to come back.
  resumeGraceMs?: number;
};

export function createProxyServer(options: ServerOptions) {
  if (options.token.length < 24)
    throw new Error('PROXY_TOKEN must contain at least 24 characters.');
  if (options.claude && (!options.tunnel || (!options.tls && !options.reverseProxy)))
    throw new Error(
      'Native mode requires TLS or explicit reverse proxy mode, and frps configuration.',
    );
  const store = new SessionStore(options.dataDir);
  const usage = new UsageLog(store.database);
  const usageReceiver = options.claude ? createUsageReceiver(usage) : undefined;
  const peers = new Set<Peer>();
  // One run or terminal per session. Account changes and status reads wait until no run or terminal is active.
  const runs = new Map<string, Run>();
  const mutations = new Set<string>();
  const terminals = new Map<string, Terminal>();
  const terminalOf = (sessionId: string) =>
    [...terminals.values()].find((candidate) => candidate.sessionId === sessionId);
  function publishTerminals(peer: Peer) {
    send(peer, {
      type: 'terminals.state',
      terminals: [...terminals.values()]
        .filter((current) => current.owner === peer)
        .map((current) => ({
          terminalId: current.id,
          sessionId: current.sessionId,
          status: current.status,
          attached: !!current.process?.attached,
          since: current.since,
        })),
    });
  }
  function setStatus(current: Terminal, status: TerminalStatus) {
    if (current.status === status) return;
    current.status = status;
    current.since = new Date().toISOString();
    publishTerminals(current.owner);
  }
  // Native terminals report their state here through the hooks of their directory (see `withStatusHooks`).
  const hookSecret = randomBytes(24).toString('base64url');
  let hookAddress = '';
  const hookServer = options.claude
    ? createServer((request, response) => {
        request.resume();
        const [, terminalId, secret, status] =
          /^\/terminal\/([^/]+)\/([^/]+)\/([a-z]+)$/.exec(request.url ?? '') ?? [];
        const current = terminalId ? terminals.get(terminalId) : undefined;
        const parsed = terminalStatusSchema.safeParse(status);
        if (request.method !== 'POST' || !current || secret !== hookSecret || !parsed.success)
          response.writeHead(404).end();
        else {
          setStatus(current, parsed.data);
          response.writeHead(204).end();
        }
      })
    : undefined;
  let login: Login | undefined;
  let tunnelOwner: Peer | undefined;
  // Background work that close() waits for.
  const tasks = new Set<Promise<unknown>>();
  const tunnelTasks = new Set<Promise<unknown>>();
  let closing = false;
  const adapter = options.claude ? 'claude-code' : 'simulation';
  const origins = options.allowedOrigins ?? [
    'http://127.0.0.1:5173',
    'http://localhost:5173',
    'file://',
    'null',
  ];
  const expectedToken = createHash('sha256').update(options.token).digest();
  const authorized = (token: string) =>
    timingSafeEqual(expectedToken, createHash('sha256').update(token).digest());
  const clientDir = options.clientDir ?? join(options.dataDir, 'client');
  const releases = new ClientReleases(clientDir);
  const version = serviceVersion();
  const updates = options.updates
    ? new ServiceUpdates({ ...options.updates, clientDir }, (state) =>
        broadcast({ type: 'service.update', ...state }),
      )
    : undefined;
  const throttle = new Throttle();
  const graceMs = options.resumeGraceMs ?? 180000;
  // Behind the reverse proxy every socket comes from the proxy itself; it passes the client on in X-Real-IP.
  const addressOf = (request: IncomingMessage) =>
    (options.reverseProxy && [request.headers['x-real-ip']].flat()[0]) ||
    request.socket.remoteAddress ||
    'unknown';
  function refuse(address: string) {
    const count = throttle.fail(address);
    const wait = throttle.blocked(address);
    console.log(
      `Sign-in refused from ${address}: wrong service token, ${count} in a row${wait ? `; blocked for ${wait}s` : ''}`,
    );
  }

  const handler: RequestListener = (request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ status: 'ok', protocolVersion: PROTOCOL_VERSION, adapter }));
    } else if (request.method === 'GET' && request.url === '/client/installer') {
      // The same secret as the WebSocket: only a signed-in client can fetch the installer.
      const release = releases.current;
      const address = addressOf(request);
      if (throttle.blocked(address)) {
        response.writeHead(429, { 'Retry-After': throttle.blocked(address) }).end();
      } else if (!authorized(request.headers.authorization?.replace(/^Bearer /, '') ?? '')) {
        refuse(address);
        response.writeHead(401).end();
      } else if (!release) {
        response.writeHead(404).end();
      } else {
        response.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': release.size,
          'Cache-Control': 'no-store',
        });
        createReadStream(release.path)
          .on('error', () => response.destroy())
          .pipe(response);
      }
    } else {
      response.writeHead(404);
      response.end();
    }
  };
  const server = options.tls ? createHttpsServer(options.tls, handler) : createServer(handler);
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  server.on('upgrade', (request, socket, head) => {
    if (
      closing ||
      request.url !== '/ws' ||
      (request.headers.origin && !origins.includes(request.headers.origin))
    ) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    const address = addressOf(request);
    if (throttle.blocked(address) || !throttle.enter(address)) {
      socket.end(
        `HTTP/1.1 429 Too Many Requests\r\nRetry-After: ${throttle.blocked(address) || 5}\r\nConnection: close\r\n\r\n`,
      );
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, address));
  });

  function send(peer: Peer, message: ServerMessage) {
    const frame = JSON.stringify(message);
    // A dropped connection collects what it misses, up to a limit; past it, it is given up.
    if (peer.resume && !peer.resume.log.record(frame) && peer.detached) {
      expire(peer, 'too much output waiting for it');
      return;
    }
    if (peer.socket.readyState === WebSocket.OPEN) peer.socket.send(frame);
  }
  function detach(peer: Peer) {
    console.log(
      `Connection ${peer.id.slice(0, 8)} dropped; kept ${graceMs / 1000}s for its client to reconnect`,
    );
    peer.detached = setTimeout(() => expire(peer, `not back within ${graceMs / 1000}s`), graceMs);
    // Its terminals run on unwatched, and are drawn afresh when it is back.
    for (const current of terminals.values())
      if (current.owner === peer && current.process?.attached) {
        current.reattach = true;
        current.process.detach();
      }
    if (peer.tunnel instanceof RelayTunnel) peer.tunnel.recheck();
  }
  function expire(peer: Peer, why: string) {
    if (!peer.detached) return;
    clearTimeout(peer.detached);
    peer.detached = undefined;
    peer.resume = undefined;
    const owned = [...runs.values()].filter((run) => run.owner === peer).length;
    console.log(`Connection ${peer.id.slice(0, 8)} given up: ${why}; runs ended with it: ${owned}`);
    release(peer);
  }
  // Hands a dropped connection, with its runs, terminal and tunnel, to the new socket, then replays what the client
  // missed. The client replays its own side after `resumed`.
  function resume(
    peer: Peer,
    { connectionId, key, received }: { connectionId: string; key: string; received: number },
  ) {
    const target = [...peers].find(
      (candidate) => candidate.id === connectionId && candidate.resume,
    );
    const held = target?.resume;
    const matches =
      !!held &&
      timingSafeEqual(
        createHash('sha256').update(held.key).digest(),
        createHash('sha256').update(key).digest(),
      );
    const frames = matches ? held.log.since(received) : null;
    if (!target || !held || !frames) {
      if (matches) expire(target!, 'its client lost track of the frames');
      send(peer, {
        type: 'connection.error',
        code: 'resume_failed',
        message: '网络中断太久或服务已重启，原来的运行已结束，请重新连接。',
      });
      peer.socket.close(4004, 'Resume failed');
      return false;
    }
    clearTimeout(target.detached);
    target.detached = undefined;
    const previous = target.socket;
    target.socket = peer.socket;
    target.address = peer.address;
    peers.delete(peer);
    // Its close handler sees that it no longer belongs to the connection.
    previous.terminate();
    held.log.confirm(received);
    peer.socket.send(
      JSON.stringify({ type: 'resumed', connectionId, received: held.log.received }),
    );
    for (const frame of frames) peer.socket.send(frame);
    for (const current of terminals.values())
      if (current.owner === target && current.reattach) {
        current.reattach = false;
        const process = current.process;
        if (process) track(process.attach(process.cols, process.rows));
      }
    if (target.tunnel instanceof RelayTunnel) target.tunnel.recheck();
    console.log(`Connection ${connectionId.slice(0, 8)} resumed; ${frames.length} frames replayed`);
    return target;
  }
  function broadcast(message: ServerMessage, sessionId?: string) {
    for (const peer of peers) {
      if (peer.authenticated && (!sessionId || peer.subscriptions.has(sessionId)))
        send(peer, message);
    }
  }
  function track(task: Promise<unknown>, group = tasks) {
    group.add(task);
    void task.finally(() => group.delete(task));
  }
  function updated(sessionId: string) {
    broadcast({ type: 'session.updated', session: store.get(sessionId).session });
  }

  // Stores an event and sends it to the session's subscribers; quota readings also drive the usage periods.
  function record(sessionId: string, runId: string, payload: EventPayload) {
    if (payload.type === 'native.metrics' && payload.rateLimits?.available)
      usage.observe(payload.rateLimits);
    const event = store.append(sessionId, runId, payload);
    broadcast({ type: 'session.event', event }, sessionId);
    return event;
  }
  function emit(run: Run, payload: EventPayload) {
    record(run.sessionId, run.id, payload);
    if (payload.type === 'native.title' && store.get(run.sessionId).session.autoTitle)
      broadcast({
        type: 'session.updated',
        session: store.renameNative(run.sessionId, payload.title),
      });
    if (payload.type === 'run.status') updated(run.sessionId);
  }
  function finish(run: Run, status: 'completed' | 'cancelled' | 'failed', reason?: string) {
    if (runs.get(run.sessionId) !== run) return;
    run.input?.close();
    if (run.toolId && !run.toolFinished) {
      emit(run, {
        type: 'tool.result',
        toolId: run.toolId,
        status: 'cancelled',
        output: '模拟工具未执行。',
        exitCode: null,
      });
    }
    emit(run, { type: 'run.status', status, reason, connectionId: run.owner.id });
    runs.delete(run.sessionId);
    run.controller.abort();
    run.decide?.(false);
    for (const decide of run.approvals.values()) decide(false);
    run.approvals.clear();
  }
  // A native run ends through its own adapter, which reports what is known about in-flight tools first.
  function cancel(run: Run, reason: string) {
    if (!options.claude) {
      finish(run, 'cancelled', reason);
      return;
    }
    run.cancelReason = reason;
    run.input?.close();
    run.controller.abort();
    for (const decide of run.approvals.values()) decide(false);
    run.approvals.clear();
  }
  function nativeRoot(sessionId: string) {
    return store.get(sessionId).session.nativeRoot ?? sessionId;
  }
  async function native(run: Run) {
    try {
      const { session } = store.get(run.sessionId);
      const status = await runClaude(options.claude!, {
        sessionId: run.sessionId,
        nativeRoot: session.nativeRoot ?? session.id,
        projectPath: session.projectPath,
        permissionMode: session.permissionMode,
        model: session.model,
        effort: session.effort,
        input: run.input!,
        controls: run.controls,
        dataDir: store.directory,
        resume: store.hasNativeContext(run.sessionId),
        signal: run.controller.signal,
        ssh: run.owner.tunnel!.ssh!,
        emit: (event) => emit(run, event),
        approve: (toolId) => {
          if (run.controller.signal.aborted) return Promise.resolve(false);
          const approvalId = randomUUID();
          return new Promise<boolean>((resolve) => {
            run.approvals.set(approvalId, (allowed) => {
              emit(run, { type: 'approval.resolved', approvalId, allowed });
              resolve(allowed);
            });
            emit(run, { type: 'approval.requested', approvalId, toolId });
            emit(run, {
              type: 'run.status',
              status: 'awaiting_approval',
              connectionId: run.owner.id,
            });
          });
        },
      });
      finish(run, status, run.cancelReason);
    } catch {
      emit(run, {
        type: 'run.error',
        code: 'native_adapter_failed',
        message: '原生进程适配失败；请检查服务配置和 CLI 版本。',
      });
      finish(run, run.controller.signal.aborted ? 'cancelled' : 'failed', run.cancelReason);
    }
  }

  async function publishAccount(target?: Peer, notice?: string) {
    const { accountStatus } = await import('./native-account.ts');
    const state: AccountState = {
      ...(await accountStatus(options.claude!.executable)),
      login: login?.url ? { url: login.url } : null,
      notice,
    };
    if (target) send(target, { type: 'account.state', ...state });
    else broadcast({ type: 'account.state', ...state });
  }
  async function account(peer: Peer, command: CommandOf<`account.${string}` & Command['type']>) {
    if (!options.claude) throw new DomainError('native_unavailable', '离线模拟没有原生账号。');
    if (command.type === 'account.status') {
      await publishAccount(peer);
      return;
    }
    if (command.type === 'account.code') {
      if (!login?.url) throw new DomainError('login_inactive', '登录流程已结束，请重新获取链接。');
      login.process.submit(command.code);
      return;
    }
    if (command.type === 'account.cancel') {
      login?.process.cancel();
      return;
    }
    if (terminals.size || runs.size || mutations.size)
      throw new DomainError('native_busy', '请先结束原生运行或终端，再管理账号。');
    const { NativeLogin, accountLogout } = await import('./native-account.ts');
    if (command.type === 'account.logout') {
      login?.process.cancel();
      try {
        await accountLogout(options.claude.executable);
      } catch {
        throw new DomainError('logout_failed', '退出登录失败，请在原生终端执行 /logout 确认。');
      }
      await publishAccount();
      return;
    }
    if (!login) {
      const current: Login = {
        owner: peer,
        process: new NativeLogin(
          options.claude.executable,
          (succeeded) => {
            if (login === current) login = undefined;
            if (closing) return;
            if (succeeded) completeOnboarding();
            track(
              publishAccount(
                undefined,
                succeeded || current.process.cancelled
                  ? undefined
                  : '登录未完成；请重新获取链接后再试。',
              ).catch(() => {}),
            );
          },
          (text) => {
            if (closing || login !== current) return;
            track(publishAccount(undefined, text).catch(() => {}));
          },
        ),
      };
      login = current;
      try {
        current.url = await current.process.url;
      } catch {
        throw new DomainError('login_failed', '官方登录命令没有给出授权链接，请检查 CLI 与网络。');
      }
    }
    await publishAccount();
  }

  // Starts the CLI without a prompt to read its account, model and quota state.
  async function readStatus(peer: Peer, command: CommandOf<'session.status'>) {
    if (!options.claude) throw new DomainError('native_unavailable', '离线模拟没有原生账号状态。');
    // During a run its own CLI answers, so quota can be reread without waiting for the turn to end.
    const active =
      runs.get(command.sessionId) ?? [...runs.values()].find((run) => run.controls.refresh);
    if (active?.controls.refresh && !terminals.size && !mutations.size) {
      await active.controls.refresh();
      return;
    }
    if (terminals.size || runs.size || mutations.size)
      throw new DomainError('native_busy', '运行结束后再刷新原生状态。');
    mutations.add(command.sessionId);
    const controller = new AbortController();
    const closed = () => controller.abort();
    peer.socket.once('close', closed);
    try {
      const events = await readNativeStatus(
        options.claude,
        store.directory,
        nativeRoot(command.sessionId),
        command.sessionId,
        controller.signal,
      );
      for (const payload of events) {
        const event = record(command.sessionId, command.requestId, payload);
        if (!peer.subscriptions.has(command.sessionId))
          send(peer, { type: 'session.event', event });
      }
      updated(command.sessionId);
    } finally {
      peer.socket.removeListener('close', closed);
      mutations.delete(command.sessionId);
    }
  }
  function ownTerminal(
    peer: Peer,
    command: CommandOf<'terminal.close' | 'terminal.detach'>,
  ): Terminal {
    const current = terminals.get(command.terminalId);
    if (!current || current.sessionId !== command.sessionId)
      throw new DomainError('terminal_inactive', '原生终端已结束。');
    if (current.owner !== peer) throw new DomainError('not_owner', '原生终端属于另一连接。');
    return current;
  }
  // A terminal occupies its session like a run does, so other connections see it as busy. A session has at most
  // one; opening the session again shows the running one.
  async function openTerminal(peer: Peer, command: CommandOf<'terminal.open'>, session: Session) {
    if (!options.claude) throw new DomainError('native_unavailable', '离线模拟不启动原生终端。');
    const existing = terminalOf(command.sessionId);
    if (existing) {
      if (existing.owner !== peer) throw new DomainError('not_owner', '原生终端属于另一连接。');
      send(peer, {
        type: 'terminal.opened',
        sessionId: command.sessionId,
        terminalId: existing.id,
      });
      await existing.process?.attach(command.cols, command.rows);
      publishTerminals(peer);
      return;
    }
    if (runs.has(command.sessionId))
      throw new DomainError('native_busy', '这个会话正在图形界面里运行，请先结束运行。');
    if (terminals.size >= MAX_TERMINALS)
      throw new DomainError(
        'native_busy',
        `最多同时运行 ${MAX_TERMINALS} 个原生终端，请先结束一个。`,
      );
    if (!peer.tunnel?.ssh) throw new DomainError('execution_offline', '本机 SSH 尚未就绪。');
    const current: Terminal = {
      id: randomUUID(),
      sessionId: command.sessionId,
      owner: peer,
      status: 'starting',
      since: new Date().toISOString(),
    };
    terminals.set(current.id, current);
    try {
      const { NativeTerminal, terminalArguments, terminalEnvironment } =
        await import('./native-terminal.ts');
      if (closing || peer.socket.readyState !== WebSocket.OPEN)
        throw new Error('Connection closed');
      completeOnboarding();
      const cwd = prepareNativeDirectory(options.claude, store.directory, nativeRoot(session.id));
      // Runs and terminals of a session share this directory, so the latest conversation may be either. Without one,
      // `--continue` would end the CLI at once.
      const continued =
        !!command.continue &&
        (await listSessions({ dir: cwd, limit: 1 }).then(
          (found) => found.length > 0,
          () => false,
        ));
      if (closing || peer.socket.readyState !== WebSocket.OPEN)
        throw new Error('Connection closed');
      current.process = new NativeTerminal(
        options.claude.executable,
        terminalArguments(options.claude, session, peer.tunnel.ssh, continued),
        {
          cwd,
          cols: command.cols,
          rows: command.rows,
          env: {
            ...terminalEnvironment(options.claude),
            ...hookEnvironment(`${hookAddress}/${current.id}/${hookSecret}`),
          },
        },
        (data, bytes) =>
          send(peer, {
            type: 'terminal.data',
            sessionId: current.sessionId,
            terminalId: current.id,
            data,
            bytes,
          }),
        (exitCode) => {
          if (terminals.get(current.id) !== current) return;
          terminals.delete(current.id);
          store.append(current.sessionId, current.id, {
            type: 'run.status',
            status: 'completed',
            surface: 'terminal',
            connectionId: peer.id,
          });
          updated(current.sessionId);
          send(peer, {
            type: 'terminal.closed',
            sessionId: current.sessionId,
            terminalId: current.id,
            exitCode,
          });
          publishTerminals(peer);
        },
      );
      store.append(command.sessionId, current.id, {
        type: 'run.status',
        status: 'running',
        surface: 'terminal',
        connectionId: peer.id,
      });
      updated(command.sessionId);
      send(peer, { type: 'terminal.opened', sessionId: command.sessionId, terminalId: current.id });
      publishTerminals(peer);
    } catch {
      await current.process?.close();
      if (terminals.get(current.id) === current) terminals.delete(current.id);
      throw new DomainError('terminal_failed', '原生终端启动失败，请检查 Linux PTY 组件与 CLI。');
    }
  }
  // Rename and delete change the native session first; the proxy record follows only when that succeeded.
  async function manageSession(
    command: CommandOf<'session.delete' | 'session.rename'>,
    session: Session,
  ) {
    if (session.activeRun) throw new DomainError('run_active', '请先结束当前运行再管理会话。');
    mutations.add(command.sessionId);
    try {
      if (options.claude && store.hasNativeContext(command.sessionId)) {
        const nativeOptions = {
          dir: nativeDirectory(store.directory, nativeRoot(command.sessionId)),
        };
        if (command.type === 'session.delete')
          await deleteSession(command.sessionId, nativeOptions);
        else await renameSession(command.sessionId, command.title, nativeOptions);
      }
      if (command.type === 'session.delete') {
        store.delete(command.sessionId);
        broadcast({ type: 'session.deleted', sessionId: command.sessionId });
        for (const other of peers) other.subscriptions.delete(command.sessionId);
      } else {
        broadcast({
          type: 'session.updated',
          session: store.rename(command.sessionId, command.title),
        });
      }
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError(
        'native_mutation_failed',
        '原生会话更新失败，代理记录保留。请检查原生存储与权限。',
      );
    } finally {
      mutations.delete(command.sessionId);
    }
  }
  // A fork is the native session copied under a new ID, together with the proxy's record of it. The SDK cuts
  // a copy after a message and only knows the source's message IDs, so stopping before a message takes two
  // copies: one through that message, then one of it up to the entry before its last.
  async function fork(command: CommandOf<'session.fork'>, session: Session) {
    if (session.activeRun) throw new DomainError('run_active', '请先结束当前运行再分叉会话。');
    const existing = store.created(command.requestId);
    if (existing) return existing.id;
    const before = command.beforeMessageId
      ? store.forkPoint(command.sessionId, command.beforeMessageId)
      : undefined;
    const title = `${session.title.slice(0, 116)}（分叉）`;
    let id: string = randomUUID();
    let resumable = false;
    mutations.add(command.sessionId);
    try {
      if (options.claude && store.hasNativeContext(command.sessionId)) {
        const dir = nativeDirectory(store.directory, nativeRoot(command.sessionId));
        if (!command.beforeMessageId) {
          id = (await forkSession(command.sessionId, { dir, title })).sessionId;
          resumable = true;
        } else {
          const through = await forkSession(command.sessionId, {
            dir,
            upToMessageId: command.beforeMessageId,
          });
          try {
            const kept = (await getSessionMessages(through.sessionId, { dir })).at(-2);
            // Nothing before the message: the fork starts a native session of its own.
            if (kept) {
              id = (await forkSession(through.sessionId, { dir, upToMessageId: kept.uuid, title }))
                .sessionId;
              resumable = true;
            }
          } finally {
            await deleteSession(through.sessionId, { dir });
          }
        }
      }
      const created = store.fork(
        command.requestId,
        command.sessionId,
        id,
        title,
        resumable,
        before,
      );
      broadcast({ type: 'session.updated', session: created });
      return created.id;
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError(
        'native_mutation_failed',
        '原生会话分叉失败，未创建新会话。该位置可能不在原生记录中。',
      );
    } finally {
      mutations.delete(command.sessionId);
    }
  }
  // A message starts a run, or joins the native run this connection already owns. Compacting is the native
  // /compact command sent as a message.
  function submit(
    peer: Peer,
    command: CommandOf<'message.send' | 'session.compact'>,
    session: Session,
  ) {
    if (command.type === 'session.compact' && !options.claude)
      throw new DomainError('native_unavailable', '离线模拟不提供原生上下文压缩。');
    if (command.type === 'session.compact' && !store.hasNativeContext(command.sessionId))
      throw new DomainError('native_context_missing', '先建立原生会话再压缩上下文。');
    const text = command.type === 'session.compact' ? '/compact' : command.text;
    const scenario = command.type === 'message.send' ? command.scenario : 'chat';
    // A repeated request ID is the same message arriving again, not a second message.
    const existing = store.userMessage(command.sessionId, command.requestId);
    if (existing?.payload.type === 'message.user') {
      if (existing.payload.text !== text || existing.payload.scenario !== scenario)
        throw new DomainError('request_conflict', '请求 ID 已被其他内容使用。');
      return;
    }
    if (session.activeRun) {
      const active = runs.get(command.sessionId);
      if (!options.claude || command.type !== 'message.send' || !active?.input)
        throw new DomainError('run_active', '当前会话正在运行。');
      if (active.owner !== peer) throw new DomainError('not_owner', '该运行属于另一连接。');
      if (active.controller.signal.aborted)
        throw new DomainError('run_finishing', '原生运行正在停止，请稍后发送。');
      active.input.assertWritable();
      peer.subscriptions.add(command.sessionId);
      emit(active, { type: 'message.user', messageId: command.requestId, text, scenario });
      active.input.submit(command.requestId, text);
      return;
    }
    if (options.claude && mutations.size)
      throw new DomainError('native_busy', '原生状态正在读取，请稍后发送。');
    if (options.claude && !peer.tunnel?.ssh)
      throw new DomainError(
        'execution_offline',
        '本机 SSH 尚未就绪，请通过桌面客户端重新建立连接。',
      );
    peer.subscriptions.add(command.sessionId);
    const run: Run = {
      id: randomUUID(),
      sessionId: command.sessionId,
      owner: peer,
      controller: new AbortController(),
      toolFinished: false,
      approvals: new Map(),
      controls: {},
    };
    runs.set(command.sessionId, run);
    if (options.claude) run.input = new NativeInput(run.sessionId, (event) => emit(run, event));
    emit(run, {
      type: 'message.user',
      messageId: command.requestId,
      text,
      scenario,
    });
    emit(run, { type: 'run.status', status: 'running', connectionId: run.owner.id });
    run.input?.submit(command.requestId, text);
    track(
      options.claude
        ? native(run)
        : simulate(run, command as CommandOf<'message.send'>, {
            stepMs: options.stepMs ?? 110,
            projectPath: () => store.get(run.sessionId).session.projectPath,
            emit: (payload) => emit(run, payload),
            finish: (status, reason) => finish(run, status, reason),
          }),
    );
  }
  function controlRun(peer: Peer, command: CommandOf<'run.cancel' | 'approval.reply'>) {
    const run = runs.get(command.sessionId);
    if (!run || run.id !== command.runId)
      throw new DomainError('run_inactive', '运行已结束，操作未生效。');
    if (run.owner !== peer) throw new DomainError('not_owner', '该运行属于另一连接。');
    if (command.type === 'run.cancel') {
      cancel(
        run,
        options.claude
          ? '用户停止；已发出的 本机 SSH 命令可能继续执行，副作用未撤销，不能自动重试。'
          : '用户停止',
      );
      return;
    }
    if (options.claude) {
      const decide = run.approvals.get(command.approvalId);
      if (!decide) throw new DomainError('approval_inactive', '审批已失效。');
      run.approvals.delete(command.approvalId);
      decide(command.allowed);
      if (!run.approvals.size)
        emit(run, { type: 'run.status', status: 'running', connectionId: peer.id });
      return;
    }
    if (!run.decide || run.approvalId !== command.approvalId)
      throw new DomainError('approval_inactive', '审批已失效。');
    const decide = run.decide;
    run.decide = undefined;
    decide(command.allowed);
  }

  // Resolves to the session ID carried in the response frame; account and usage commands have none.
  async function execute(peer: Peer, command: Command): Promise<string | undefined> {
    switch (command.type) {
      case 'account.status':
      case 'account.login':
      case 'account.code':
      case 'account.cancel':
      case 'account.logout':
        await account(peer, command);
        return undefined;
      case 'settings.get':
      case 'settings.update': {
        if (!options.claude) throw new DomainError('native_unavailable', '离线模拟没有原生设置。');
        try {
          const values =
            command.type === 'settings.get'
              ? readNativeSettings()
              : updateNativeSettings(command.values);
          send(peer, { type: 'settings.state', requestId: command.requestId, values });
        } catch {
          throw new DomainError(
            'settings_failed',
            '原生设置文件无法读取或写入；请在原生终端用 /config 检查。',
          );
        }
        return undefined;
      }
      case 'usage.summary':
        send(peer, { type: 'usage.summary', requestId: command.requestId, ...usage.summary() });
        return undefined;
      case 'service.update.check':
        if (!updates) throw new DomainError('updates_unavailable', '此服务未启用版本跟踪。');
        await updates.check();
        return undefined;
      case 'service.update.install':
        if (!updates) throw new DomainError('updates_unavailable', '此服务未启用版本跟踪。');
        // The restart at the end would cut these off.
        if (terminals.size || runs.size || mutations.size || login)
          throw new DomainError('native_busy', '请先结束运行、终端或登录流程，再升级服务端。');
        try {
          updates.install(command.version);
        } catch (error) {
          throw new DomainError('update_unavailable', (error as Error).message);
        }
        return undefined;
      case 'usage.query': {
        const titles = new Map(store.list().map((session) => [session.id, session.title]));
        send(peer, {
          type: 'usage.page',
          requestId: command.requestId,
          ...usage.query(command, (sessionId) => titles.get(sessionId) ?? null),
        });
        return undefined;
      }
      case 'terminal.list':
        publishTerminals(peer);
        return undefined;
      case 'session.create': {
        const session = store.create(command.requestId, command.title, command.projectPath);
        peer.subscriptions.clear();
        peer.subscriptions.add(session.id);
        broadcast({ type: 'session.updated', session });
        return session.id;
      }
    }
    const { session } = store.get(command.sessionId);
    if (mutations.has(command.sessionId))
      throw new DomainError('session_busy', '会话正在更新，请稍后重试。');
    switch (command.type) {
      case 'session.status':
        await readStatus(peer, command);
        return command.sessionId;
      case 'terminal.close':
        await ownTerminal(peer, command).process?.close();
        return command.sessionId;
      case 'terminal.detach':
        ownTerminal(peer, command).process?.detach();
        publishTerminals(peer);
        return command.sessionId;
      case 'terminal.open':
        await openTerminal(peer, command, session);
        return command.sessionId;
      case 'session.subscribe':
        peer.subscriptions.clear();
        peer.subscriptions.add(command.sessionId);
        send(peer, {
          type: 'session.snapshot',
          ...store.history(command.sessionId, command.requestId, command.afterSequence),
        });
        return command.sessionId;
      case 'session.history':
        send(peer, {
          type: 'session.snapshot',
          ...store.history(command.sessionId, command.requestId, 0, command.beforeSequence),
        });
        return command.sessionId;
      case 'run.cancel':
      case 'approval.reply':
        controlRun(peer, command);
        return command.sessionId;
    }
    if (terminalOf(command.sessionId))
      throw new DomainError(
        'native_busy',
        '这个会话的原生终端正在运行，请先结束终端再操作图形会话。',
      );
    if (
      updates?.installing &&
      (command.type === 'message.send' || command.type === 'session.compact')
    )
      throw new DomainError('service_upgrading', '服务端正在升级，重启完成后再发送。');
    switch (command.type) {
      case 'session.configure':
        broadcast({
          type: 'session.updated',
          session: store.configure(
            command.sessionId,
            command.permissionMode,
            command.model,
            command.effort,
          ),
        });
        break;
      case 'session.delete':
      case 'session.rename':
        await manageSession(command, session);
        break;
      case 'session.fork':
        return fork(command, session);
      case 'message.send':
      case 'session.compact':
        submit(peer, command, session);
        break;
    }
    return command.sessionId;
  }

  const installer = () =>
    releases.current
      ? (({ version, size, sha256 }) => ({ version, size, sha256 }))(releases.current)
      : undefined;
  // The first frame must authenticate; a desktop client also asks for its Windows tunnel here. Returns the
  // connection the socket now serves, which is another one when it resumed.
  function authenticate(peer: Peer, value: unknown): Peer | false {
    const auth = authSchema.safeParse(value);
    // Only a wrong token counts against the address: an outdated client holding the right one is not guessing.
    const token = (value as { token?: unknown } | null)?.token;
    if (typeof token !== 'string' || !authorized(token)) refuse(peer.address);
    else throttle.succeed(peer.address);
    if (!auth.success || !authorized(auth.data.token)) {
      send(peer, { type: 'connection.error', code: 'unauthorized', message: '认证失败。' });
      peer.socket.close(4001, 'Unauthorized');
      return false;
    }
    // A client of another version is told which version runs here and, if held, the installer to fetch.
    if (auth.data.protocolVersion !== PROTOCOL_VERSION) {
      send(peer, {
        type: 'connection.error',
        code: 'version_mismatch',
        message: `客户端与服务端（${version}）的版本不一致，需要升级其中一方。`,
        service: version,
        client: installer(),
      });
      peer.socket.close(4002, 'Version mismatch');
      return false;
    }
    if (auth.data.resume) return resume(peer, auth.data.resume);
    peer.authenticated = true;
    // Only the relay can wait for its desktop: an frp tunnel ends with its frpc connection.
    const key =
      auth.data.resumable &&
      auth.data.tunnel &&
      auth.data.tunnelTransport === 'relay' &&
      options.tunnel
        ? randomBytes(32).toString('base64url')
        : undefined;
    send(peer, {
      type: 'ready',
      protocolVersion: PROTOCOL_VERSION,
      connectionId: peer.id,
      adapter,
      model: options.claude?.model,
      version,
      update: updates?.state,
      client: installer(),
      sessions: store.list(),
      ...(key && { resume: { key, graceMs } }),
    });
    if (key)
      peer.resume = {
        key,
        log: new ResumeLog((received) => {
          if (peer.socket.readyState === WebSocket.OPEN)
            peer.socket.send(JSON.stringify({ type: 'resume.ack', received }));
        }),
      };
    if (auth.data.tunnel && options.tunnel) {
      // A device that dropped and is waiting to come back gives way to a new sign-in, which is most likely the same
      // desktop started again. Its relay tunnel shares nothing with the new one, so neither waits for the other.
      const stale = tunnelOwner?.detached ? tunnelOwner : undefined;
      if (stale) expire(stale, 'a new connection took the device');
      if (tunnelOwner && tunnelOwner !== stale) {
        send(peer, {
          type: 'connection.error',
          code: 'device_busy',
          message: '已有桌面设备连接或正在清理，请稍后重试。',
        });
        peer.socket.close(4003, 'Device busy');
        return peer;
      }
      tunnelOwner = peer;
      const relay = auth.data.tunnelTransport === 'relay';
      peer.tunnel = new (relay ? RelayTunnel : WindowsTunnel)(
        options.tunnel,
        store.directory,
        peer.id,
        () => {
          peer.socket.close(4003, 'Tunnel process closed');
        },
      );
      track(
        peer.tunnel
          .start()
          .then((config) => send(peer, config))
          .catch(() => {
            send(peer, {
              type: 'connection.error',
              code: 'tunnel_failed',
              message: relay
                ? '执行通道启动失败，请检查服务配置。'
                : 'frps 启动失败，请检查服务配置与端口。',
            });
            peer.socket.close(4003, 'Tunnel failed');
          }),
        tunnelTasks,
      );
    }
    return peer;
  }
  // A relay connection signs in with the secret its desktop received over the control connection. A wrong secret
  // counts against the address like a wrong token.
  function attachRelay(peer: Peer, attach: TunnelAttach) {
    const owner = tunnelOwner;
    if (
      !owner ||
      owner.id !== attach.connectionId ||
      !(owner.tunnel instanceof RelayTunnel) ||
      !owner.tunnel.matches(attach.secret)
    ) {
      refuse(peer.address);
      peer.socket.close(4001, 'Unauthorized');
      return false;
    }
    throttle.succeed(peer.address);
    peer.relay = true;
    if (!owner.tunnel.attach(peer.socket)) peer.socket.close(4008, 'Relay full');
    return true;
  }
  function registerTunnel(peer: Peer, credentials: TunnelCredentials) {
    if (!peer.tunnel || peer.registering || credentials.connectionId !== peer.id) {
      peer.socket.close(4002, 'Inactive tunnel registration');
      return;
    }
    peer.registering = true;
    track(
      peer.tunnel
        .accept(credentials)
        .then(() => {
          send(peer, { type: 'tunnel.ready', connectionId: peer.id });
        })
        .catch(() => {
          send(peer, {
            type: 'connection.error',
            code: 'ssh_failed',
            message: '本机 SSH / Shell 就绪探测失败。',
          });
          peer.socket.close(4003, 'SSH probe failed');
        }),
      tunnelTasks,
    );
  }
  // Keystrokes, resizes and flow-control acknowledgments carry no request ID and get no response.
  function controlTerminal(peer: Peer, control: TerminalControl) {
    const current = terminals.get(control.terminalId);
    if (!current || current.owner !== peer || current.sessionId !== control.sessionId) {
      send(peer, {
        type: 'connection.error',
        code: 'terminal_inactive',
        message: '原生终端已结束或属于另一连接。',
      });
      return;
    }
    try {
      if (control.type === 'terminal.input') {
        current.process?.write(control.data);
        // Answering a prompt sets the CLI working again; no hook reports that moment.
        if (current.status === 'waiting') setStatus(current, 'busy');
      } else if (control.type === 'terminal.resize')
        current.process?.resize(control.cols, control.rows);
      else current.process?.acknowledge(control.bytes);
    } catch {
      const task = current.process?.close();
      if (task) track(task);
    }
  }
  // A request ID is answered once: a resend gets the same response, never a second execution.
  function dispatch(peer: Peer, command: Command) {
    const serialized = JSON.stringify(command);
    const previous = peer.responses.get(command.requestId);
    if (previous) {
      if (previous.command === serialized)
        void previous.response.then((response) => send(peer, response));
      else
        send(peer, {
          type: 'response',
          requestId: command.requestId,
          ok: false,
          code: 'request_conflict',
          message: '请求 ID 已被其他内容使用。',
        });
      return;
    }
    const response = execute(peer, command).then(
      (sessionId): ServerMessage => ({
        type: 'response',
        requestId: command.requestId,
        ok: true,
        sessionId,
      }),
      (error): ServerMessage => ({
        type: 'response',
        requestId: command.requestId,
        ok: false,
        code: error instanceof DomainError ? error.code : 'internal_error',
        message: error instanceof DomainError ? error.message : '服务处理失败。',
      }),
    );
    peer.responses.set(command.requestId, { command: serialized, response });
    track(response.then((value) => send(peer, value)));
  }
  // Whatever the connection owned ends with it; nothing is replayed for a later connection.
  function release(peer: Peer) {
    peers.delete(peer);
    peer.resume?.log.stop();
    if (login?.owner === peer) login.process.cancel();
    for (const current of terminals.values()) {
      const task = current.owner === peer ? current.process?.close() : undefined;
      if (task) track(task);
    }
    for (const run of runs.values())
      if (run.owner === peer)
        cancel(
          run,
          options.claude
            ? '连接断开，运行未重放；在途命令结果可能未知。'
            : '连接断开，运行未重放。',
        );
    if (peer.tunnel)
      track(
        peer.tunnel.close().finally(() => {
          if (tunnelOwner === peer) tunnelOwner = undefined;
        }),
        tunnelTasks,
      );
  }

  wss.on('connection', (socket: WebSocket, address: string) => {
    void releases.refresh();
    // Becomes the dropped connection when this socket resumes one.
    let peer: Peer = {
      socket,
      id: randomUUID(),
      address,
      authenticated: false,
      registering: false,
      subscriptions: new Set(),
      responses: new Map(),
    };
    peers.add(peer);
    const authTimer = setTimeout(() => socket.close(4001, 'Authentication timeout'), 5000);
    // A long unattended run should survive a brief network stall: only two pings in a row without an answer,
    // about 45 seconds of silence, end the connection.
    let missed = 0;
    let timedOut = false;
    socket.on('pong', () => {
      missed = 0;
    });
    const heartbeat = setInterval(() => {
      if (missed >= 2) {
        timedOut = true;
        socket.terminate();
        return;
      }
      missed++;
      socket.ping();
    }, 15000);
    socket.on('error', () => socket.terminate());
    socket.on('message', (data, isBinary) => {
      // A socket whose connection was resumed elsewhere may still hold frames; the new socket replays them.
      if (peer.relay || peer.socket !== socket) return;
      let value: unknown;
      try {
        if (isBinary) throw new Error('Binary frame');
        value = JSON.parse(data.toString('utf8'));
      } catch {
        send(peer, {
          type: 'connection.error',
          code: 'invalid_json',
          message: '消息必须是 JSON 文本。',
        });
        socket.close(4002, 'Invalid frame');
        return;
      }
      if (!peer.authenticated) {
        const attach = tunnelAttachSchema.safeParse(value);
        const next = attach.success
          ? attachRelay(peer, attach.data) && peer
          : authenticate(peer, value);
        if (next) {
          peer = next;
          clearTimeout(authTimer);
          throttle.leave(address);
        }
        return;
      }
      if (peer.resume) {
        const ack = resumeAckSchema.safeParse(value);
        if (ack.success) {
          peer.resume.log.confirm(ack.data.received);
          return;
        }
        peer.resume.log.receive();
      }
      const credentials = tunnelCredentialsSchema.safeParse(value);
      if (credentials.success) {
        registerTunnel(peer, credentials.data);
        return;
      }
      const control = terminalControlSchema.safeParse(value);
      if (control.success) {
        controlTerminal(peer, control.data);
        return;
      }
      const command = commandSchema.safeParse(value);
      if (!command.success) {
        send(peer, {
          type: 'connection.error',
          code: 'invalid_command',
          message: '请求格式无效。',
        });
        return;
      }
      dispatch(peer, command.data);
    });
    socket.on('close', (code) => {
      clearTimeout(authTimer);
      clearInterval(heartbeat);
      if (!peer.authenticated && !peer.relay) throttle.leave(address);
      // A resumed connection moved on to another socket.
      if (peer.socket !== socket) return;
      // Anything but a deliberate close from a client that can come back leaves the connection waiting for it.
      if (peer.resume && !peer.detached && !closing && code !== 1000) {
        detach(peer);
        return;
      }
      // Why a connection ended is the first thing needed when a run was cut short.
      const owned = [...runs.values()].filter((run) => run.owner === peer).length;
      if (peer.authenticated && !closing)
        console.log(
          `Connection ${peer.id.slice(0, 8)} closed: ${timedOut ? 'no heartbeat answer for 45s' : `code ${code}`}; runs ended with it: ${owned}`,
        );
      release(peer);
    });
  });
  return {
    store,
    async listen(port = 8787): Promise<string> {
      await releases.refresh();
      updates?.start();
      if (usageReceiver)
        options.claude!.environment = telemetryEnvironment(await usageReceiver.listen());
      if (hookServer) {
        await new Promise<void>((resolve) => hookServer.listen(0, '127.0.0.1', resolve));
        hookAddress = `http://127.0.0.1:${(hookServer.address() as { port: number }).port}/terminal`;
      }
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, options.host ?? '127.0.0.1', () => {
          server.off('error', reject);
          resolve();
        });
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No listening address');
      return `${options.tls ? 'https' : 'http'}://${options.host ?? '127.0.0.1'}:${address.port}`;
    },
    async close() {
      closing = true;
      updates?.stop();
      login?.process.cancel();
      const terminalCleanup = Promise.all(
        [...terminals.values()].map((current) => current.process?.close()),
      );
      for (const run of runs.values()) cancel(run, '服务停止，运行未重放。');
      for (const peer of peers) clearTimeout(peer.detached);
      const cleanup = [...peers].map((peer) => peer.tunnel?.close());
      for (const peer of peers) peer.socket.terminate();
      await Promise.all([...tasks]);
      await terminalCleanup;
      await Promise.all([...tunnelTasks]);
      await Promise.all(cleanup);
      await usageReceiver?.close();
      hookServer?.close();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      store.close();
    },
  };
}
