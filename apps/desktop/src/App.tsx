import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  CalendarClock,
  Download,
  GitFork,
  LogOut,
  Settings2,
  PanelLeft,
  Pencil,
  RefreshCw,
  SquareTerminal,
  Trash2,
  Unplug,
  X,
} from 'lucide-react';
import { GithubMark, openProject, project } from './project.tsx';
import type {
  Effort,
  EventPayload,
  PermissionMode,
  Session,
  SessionEvent,
} from '@cc-desk-tunnel/protocol';
import AccountPanel from './AccountPanel.tsx';
import { ProxyClient } from './client.ts';
import Composer from './Composer.tsx';
import { useDrafts } from './drafts.ts';
import SchedulePanel from './SchedulePanel.tsx';
import { taskMessage, useSchedules } from './schedules.ts';
import type { Scenario } from './Composer.tsx';
import Conversation from './Conversation.tsx';
import LoginPage from './LoginPage.tsx';
import type { ConnectionForm } from './LoginPage.tsx';
import { isInside, isNewer, withProject } from './paths.ts';
import { AddProjectDialog, DeleteSessionDialog, RenameSessionDialog } from './SessionDialogs.tsx';
import SettingsPanel from './SettingsPanel.tsx';
import Sidebar from './Sidebar.tsx';
import { IconButton, Menu } from './ui.tsx';
import type { MenuItem } from './ui.tsx';

const NativeTerminal = lazy(() => import('./NativeTerminal.tsx'));

// The newest event of a kind is the session's current native state.
function latest<T extends EventPayload['type']>(events: SessionEvent[], type: T) {
  return (events.findLast((event) => event.payload.type === type)?.payload ?? null) as Extract<
    EventPayload,
    { type: T }
  > | null;
}
function savedProjects(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem('proxy-projects') ?? '[]');
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

// Owns the connection, the selection and every request; the components below render and report user intent.
export function App() {
  const [client] = useState(() => new ProxyClient());
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const [form, setForm] = useState<ConnectionForm>(() => ({
    url: localStorage.getItem('proxy-url') ?? 'ws://127.0.0.1:8787/ws',
    token: '',
    fingerprint: '',
    mode: window.desktop ? 'remote' : 'local',
    remember: false,
    autoLogin: false,
  }));
  const changeForm = useCallback(
    (values: Partial<ConnectionForm>) => setForm((current) => ({ ...current, ...values })),
    [],
  );
  const [proxyConnecting, setProxyConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One request at a time from this window; `refreshing` is the slower native status read.
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const refreshed = useRef(new Set<string>());
  const [projects, setProjects] = useState(savedProjects);
  const [workspaceRoot, setWorkspaceRoot] = useState('');
  const [drafts, setDraft] = useDrafts();
  const [scenario, setScenario] = useState<Scenario>('chat');
  const [slashOpen, setSlashOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // The page shown in place of the conversation, if any.
  const [panel, setPanel] = useState<'account' | 'settings' | 'schedules' | null>(null);
  const accountOpen = panel === 'account';
  const [version, setVersion] = useState('');
  useEffect(() => {
    void window.desktop?.version().then(setVersion);
  }, []);
  const [terminalSessionId, setTerminalSessionId] = useState<string | null>(null);
  const closeTerminal = useCallback(() => setTerminalSessionId(null), []);
  const [menu, setMenu] = useState<{
    sessionId?: string;
    x: number;
    y: number;
    above?: boolean;
  } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteSession, setDeleteSession] = useState<Session | null>(null);
  const [renameSession, setRenameSession] = useState<Session | null>(null);

  const nativeMode = state.adapter === 'claude-code';
  const connected = state.status === 'connected';
  const selected = state.sessions.find((session) => session.id === state.selectedId);
  const events = selected ? (state.events[selected.id] ?? []) : [];
  const history = selected ? state.history[selected.id] : undefined;
  const nativeSession = latest(events, 'native.session');
  const capabilities = latest(events, 'native.capabilities') ?? state.capabilities;
  const metrics = latest(events, 'native.metrics');
  // Quota belongs to the account, so the newest reading from any session wins over the selected session's.
  const quota = [metrics, state.metrics]
    .filter((item) => !!item?.rateLimits)
    .sort((a, b) =>
      (b!.rateLimits!.measuredAt ?? '').localeCompare(a!.rateLimits!.measuredAt ?? ''),
    )[0];
  const accountMetrics =
    (metrics ?? state.metrics) && quota
      ? { ...(metrics ?? state.metrics)!, rateLimits: quota.rateLimits }
      : (metrics ?? state.metrics);
  const canCompact = !!latest(events, 'native.context')?.persisted;
  // The native terminal takes over the CLI state, whichever connection opened it.
  const terminalActive = state.sessions.some(
    (session) => session.activeRun?.surface === 'terminal',
  );
  const controlsDisabled =
    !connected ||
    busy ||
    refreshing ||
    !!selected?.activeRun ||
    !!history?.loading ||
    terminalActive ||
    !!terminalSessionId;
  const ownsRun = !!selected?.activeRun && selected.activeRun.connectionId === state.connectionId;
  // A native run accepts follow-up messages from the connection that owns it.
  const inputDisabled =
    !connected ||
    busy ||
    !!history?.loading ||
    terminalActive ||
    (!!selected?.activeRun && (!nativeMode || !ownsRun)) ||
    refreshing;
  const draft = selected ? (drafts[selected.id] ?? '') : '';
  const signedOut = state.account?.loggedIn === false;
  const currentError = error ?? state.error;
  // Offered when the service holds a newer installer than the running client.
  const upgrade =
    version && state.release && isNewer(state.release, version) ? state.release : null;

  // A check or an upgrade of the service that failed says why.
  const update = state.update;
  useEffect(() => {
    if (update?.state === 'failed' && update.detail) setError(update.detail);
  }, [update]);
  const serviceUpdate = !nativeMode
    ? null
    : update?.state === 'available'
      ? {
          label: `升级服务端到 ${update.latest}`,
          icon: <Download />,
          disabled: busy || state.sessions.some((item) => !!item.activeRun),
          run: () => {
            if (
              window.confirm(
                `服务端将升级到 ${update.latest} 并重启，需要几分钟，期间不能发送消息；重启后需重新连接。继续？`,
              )
            )
              void act(async () => {
                await client.request({ type: 'service.update.install', version: update.latest! });
              });
          },
        }
      : update?.state === 'manual'
        ? {
            label: `服务端 ${update.latest} 需在服务器上升级`,
            icon: <Download />,
            disabled: true,
            run: () => undefined,
          }
        : update?.state === 'installing' || update?.state === 'restarting'
          ? {
              label: `服务端升级中：${update.detail ?? '重启'}`,
              icon: <RefreshCw />,
              disabled: true,
              run: () => undefined,
            }
          : {
              label:
                update?.state === 'checking'
                  ? '正在检查更新…'
                  : update?.state === 'idle' && update.checkedAt
                    ? `已是最新 ${state.service} · 再次检查`
                    : '检查更新',
              icon: <RefreshCw />,
              disabled: busy || update?.state === 'checking',
              run: () => {
                void act(async () => {
                  await client.request({ type: 'service.update.check' });
                });
              },
            };

  // A saved sign-in fills the form once per launch and, when asked, connects without a click.
  const loaded = useRef(false);
  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    void window.desktop?.loadLogin().then((saved) => {
      if (!saved) return;
      setForm(saved);
      if (saved.autoLogin) void login(saved);
    });
  }, []);
  useEffect(() => {
    if (connected)
      void window.desktop?.saveLogin(form).catch((error) => {
        setError(error instanceof Error ? error.message : '无法保存登录凭据。');
      });
  }, [connected]);
  useEffect(() => {
    const close = () => client.disconnect();
    const unsubscribe = window.desktop?.onProxyClosed(() => {
      client.disconnect();
      setForm((current) => (current.remember ? current : { ...current, token: '' }));
      setError((value) => value ?? client.state.error ?? '远程连接已关闭，请重新登录。');
    });
    window.addEventListener('beforeunload', close);
    return () => {
      window.removeEventListener('beforeunload', close);
      client.disconnect();
      unsubscribe?.();
    };
  }, [client, changeForm]);
  useEffect(() => {
    if (!connected) {
      setTerminalSessionId(null);
      setMenu(null);
    }
  }, [connected]);
  useEffect(() => {
    if (connected) void window.desktop?.workspaceRoot().then(setWorkspaceRoot);
  }, [connected]);
  useEffect(() => {
    localStorage.setItem('proxy-projects', JSON.stringify(projects));
  }, [projects]);
  // Each session's native state is read once when it is first shown idle.
  useEffect(() => {
    if (
      !nativeMode ||
      !selected ||
      !connected ||
      history?.loading ||
      selected.activeRun ||
      terminalActive ||
      refreshed.current.has(selected.id)
    )
      return;
    refreshed.current.add(selected.id);
    void refreshStatus(selected.id);
  }, [nativeMode, selected?.id, connected, history?.loading, selected?.activeRun, terminalActive]);
  useEffect(() => {
    if (nativeMode && connected) void client.request({ type: 'account.status' }).catch(() => {});
  }, [nativeMode, connected, accountOpen]);
  useEffect(() => {
    if (
      !accountOpen ||
      !nativeMode ||
      !connected ||
      state.capabilities ||
      state.account?.loggedIn !== true ||
      refreshing ||
      state.sessions.some((session) => session.activeRun)
    )
      return;
    void refreshStatus();
  }, [accountOpen, nativeMode, connected, state.capabilities, state.account?.loggedIn]);

  async function act(action: () => Promise<void>) {
    setError(null);
    setBusy(true);
    try {
      await action();
    } catch (error) {
      setError(error instanceof Error ? error.message : '操作失败。');
    } finally {
      setBusy(false);
    }
  }
  // Remote mode connects through the main process, which opens the tunnel and returns a loopback address.
  async function login(form: ConnectionForm) {
    setError(null);
    try {
      if (form.mode === 'remote') {
        setProxyConnecting(true);
        const connection = await window.desktop!.connectProxy({
          url: form.url,
          fingerprint: form.fingerprint,
        });
        client.connect(connection.url, form.token, false);
      } else {
        client.connect(form.url, form.token);
      }
      localStorage.setItem('proxy-url', form.url);
    } catch (error) {
      if (form.mode === 'remote') await window.desktop?.disconnectProxy();
      setError(error instanceof Error ? error.message : '连接失败。');
    } finally {
      setProxyConnecting(false);
    }
  }
  function disconnect() {
    client.disconnect();
    setForm((current) => (current.remember ? current : { ...current, token: '' }));
    void window.desktop?.disconnectProxy();
  }
  function show(sessionId: string) {
    client.select(sessionId);
    setPanel(null);
    setSidebarOpen(false);
  }
  async function refreshStatus(sessionId = selected?.id ?? state.sessions[0]?.id) {
    if (!sessionId || refreshing) return;
    setRefreshing(true);
    try {
      await client.request({ type: 'session.status', sessionId });
    } catch (error) {
      setError(error instanceof Error ? error.message : '原生状态读取失败');
    } finally {
      setRefreshing(false);
    }
  }
  async function createSession(projectPath: string) {
    const response = await client.request({ type: 'session.create', title: '新会话', projectPath });
    if (response.sessionId) client.select(response.sessionId);
  }
  async function createInProject(path: string) {
    await act(async () => {
      await createSession(path);
      setPanel(null);
      setSidebarOpen(false);
    });
  }
  async function addProject() {
    if (!window.desktop?.chooseProject) {
      setCreateOpen(true);
      return;
    }
    await act(async () => {
      const path = await window.desktop!.chooseProject();
      if (path) setProjects((value) => withProject(value, path));
    });
  }
  // The desktop gives a session without a project its own directory; a browser has none to offer and reuses a project.
  async function newSession() {
    if (window.desktop) {
      await act(async () => {
        const directory = await window.desktop!.createWorkspace();
        try {
          await createSession(directory);
        } catch (error) {
          await window.desktop!.removeWorkspace(directory);
          throw error;
        }
        setPanel(null);
        setSidebarOpen(false);
      });
      return;
    }
    const path = selected?.projectPath ?? projects[0] ?? state.sessions[0]?.projectPath;
    if (path) await createInProject(path);
    else await addProject();
  }
  // A due task is an ordinary message: to its session once that is idle, or to a session made for it. It is
  // never queued into a run, and waits while the native terminal holds the CLI.
  const schedules = useSchedules(async (task, due) => {
    const { status, sessions, selectedId } = client.state;
    if (status !== 'connected' || sessions.some((item) => item.activeRun?.surface === 'terminal'))
      return false;
    let session: Session | undefined;
    if (task.target.type === 'session') {
      const { sessionId } = task.target;
      session = sessions.find((item) => item.id === sessionId);
      if (!session) throw new Error('目标会话已不存在');
      if (session.activeRun) return false;
    } else {
      const created = await client.request({
        type: 'session.create',
        title: task.name,
        projectPath: task.target.projectPath,
      });
      session = client.state.sessions.find((item) => item.id === created.sessionId);
      if (!session) throw new Error('新会话创建失败');
      // Creating a session moved the live stream to it; the session being read takes it back.
      if (selectedId) client.select(selectedId);
    }
    if (
      (task.model && task.model !== session.model) ||
      (task.effort && task.effort !== session.effort)
    )
      await client.request({
        type: 'session.configure',
        sessionId: session.id,
        permissionMode: session.permissionMode,
        model: task.model ?? session.model,
        effort: task.effort ?? session.effort,
      });
    await client.request({
      type: 'message.send',
      sessionId: session.id,
      text: taskMessage(task, due),
      scenario: 'chat',
    });
    return true;
  });
  // A fork continues from the same context in a session of its own. Forking before a message brings that
  // message back as a draft, which is how an earlier message is edited and sent again.
  async function fork(session: Session, before?: { id: string; text: string }) {
    await act(async () => {
      const response = await client.request({
        type: 'session.fork',
        sessionId: session.id,
        ...(before ? { beforeMessageId: before.id } : {}),
      });
      if (!response.sessionId) return;
      if (before) setDraft(response.sessionId, before.text);
      show(response.sessionId);
    });
  }
  async function send() {
    if (!selected || !draft.trim() || inputDisabled) return;
    const sessionId = selected.id;
    setSlashOpen(false);
    await act(async () => {
      await client.request({ type: 'message.send', sessionId, text: draft, scenario });
      setDraft(sessionId, '');
    });
  }
  async function compact() {
    if (!selected || controlsDisabled || !canCompact) return;
    setSlashOpen(false);
    setDraft(selected.id, '');
    await act(async () => {
      await client.request({ type: 'session.compact', sessionId: selected.id });
    });
  }
  async function configure(values: {
    model?: string | null;
    effort?: Effort | null;
    permissionMode?: PermissionMode;
  }) {
    if (!selected) return;
    await act(async () => {
      await client.request({
        type: 'session.configure',
        sessionId: selected.id,
        permissionMode: selected.permissionMode,
        ...values,
      });
    });
  }
  function sessionMenu(session: Session): MenuItem[] {
    const idle = connected && !busy && !terminalSessionId && !terminalActive;
    const anyRun = state.sessions.some((item) => !!item.activeRun);
    return [
      {
        label: '重命名',
        icon: <Pencil />,
        disabled: !idle || !!session.activeRun,
        run: () => {
          setError(null);
          setSidebarOpen(false);
          setRenameSession(session);
        },
      },
      {
        label: '分叉会话',
        icon: <GitFork />,
        disabled: !idle || !!session.activeRun,
        run: () => {
          void fork(session);
        },
      },
      ...(nativeMode
        ? [
            {
              label: '原生终端',
              icon: <SquareTerminal />,
              disabled: !idle || anyRun,
              run: () => {
                show(session.id);
                setTerminalSessionId(session.id);
              },
            },
            {
              label: '刷新状态',
              icon: <RefreshCw />,
              disabled: !idle || anyRun || refreshing || !!history?.loading,
              run: () => {
                void refreshStatus(session.id);
              },
            },
          ]
        : []),
      {
        label: '删除',
        icon: <Trash2 />,
        danger: true,
        disabled: !connected || !!session.activeRun || !!terminalSessionId || terminalActive,
        run: () => {
          setError(null);
          setSidebarOpen(false);
          setDeleteSession(session);
        },
      },
    ];
  }

  if (state.status === 'disconnected' || state.status === 'connecting')
    return (
      <LoginPage
        form={form}
        change={changeForm}
        error={
          currentError && state.mismatch && !upgrade && state.service && version
            ? `${currentError}${isNewer(version, state.service) ? '此客户端较新，请先升级服务端。' : '服务端还没有备好对应的客户端安装包，请稍后重试或手动安装。'}`
            : currentError
        }
        upgrade={state.mismatch && window.desktop ? upgrade : null}
        install={() => {
          void act(() => window.desktop!.installUpdate());
        }}
        connecting={state.status === 'connecting' || proxyConnecting || busy}
        submit={() => {
          void login(form);
        }}
      />
    );
  const menuSession = menu && state.sessions.find((item) => item.id === menu.sessionId);
  return (
    <div className={`shell ${sidebarOpen ? 'sidebar-open' : ''}`}>
      {sidebarOpen && (
        <button
          className="sidebar-shade"
          aria-label="收起会话列表"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <Sidebar
        sessions={state.sessions}
        selectedId={selected?.id}
        projects={projects}
        workspaceRoot={workspaceRoot}
        connected={connected}
        busy={busy}
        refreshing={refreshing}
        terminalOpen={!!terminalSessionId}
        terminalActive={terminalActive}
        adapterName={nativeMode ? 'Claude Code' : 'Simulation'}
        accountName={
          signedOut ? '未登录' : (state.account?.email ?? capabilities?.account.email ?? '账号')
        }
        accountDetail={
          signedOut
            ? '点击登录 Claude 账号'
            : (state.account?.subscriptionType ??
              capabilities?.account.subscriptionType ??
              (nativeMode ? 'Claude Code' : '离线模拟'))
        }
        select={show}
        newSession={() => {
          void newSession();
        }}
        addProject={() => {
          void addProject();
        }}
        createInProject={(path) => {
          void createInProject(path);
        }}
        openAccount={() => {
          setPanel('account');
          setSidebarOpen(false);
        }}
        sessionMenu={(session, position) => setMenu({ sessionId: session.id, ...position })}
        connectionMenu={setMenu}
        close={() => setSidebarOpen(false)}
      />
      <main className="workspace">
        {panel === 'settings' ? (
          <SettingsPanel client={client} close={() => setPanel(null)} />
        ) : panel === 'schedules' ? (
          <SchedulePanel
            schedules={schedules}
            sessions={state.sessions}
            projects={projects}
            capabilities={capabilities}
            close={() => setPanel(null)}
          />
        ) : accountOpen ? (
          <AccountPanel
            client={client}
            account={nativeMode ? state.account : null}
            capabilities={signedOut ? null : capabilities}
            metrics={signedOut ? null : accountMetrics}
            refreshing={refreshing}
            disabled={!state.sessions.length || !connected || refreshing || terminalActive}
            error={currentError}
            refresh={() => {
              void refreshStatus();
            }}
            close={() => setPanel(null)}
          />
        ) : (
          <>
            <header className="workspace-bar">
              <IconButton title="展开会话列表" onClick={() => setSidebarOpen(true)}>
                <PanelLeft />
              </IconButton>
              <h1>{selected?.title ?? '会话'}</h1>
            </header>
            {terminalSessionId && connected && (
              <Suspense
                fallback={
                  <div className="history-status" role="status">
                    加载原生终端
                  </div>
                }
              >
                <NativeTerminal
                  client={client}
                  sessionId={terminalSessionId}
                  onClose={closeTerminal}
                />
              </Suspense>
            )}
            {currentError && (
              <div className="error-banner" role="alert">
                <span>{currentError}</span>
                <IconButton
                  title="关闭错误提示"
                  onClick={() => {
                    setError(null);
                    client.update({ error: null });
                  }}
                >
                  <X />
                </IconButton>
              </div>
            )}
            {!connected && (
              <div className="connection-banner" role="status">
                <Unplug />
                连接中断，等待恢复
              </div>
            )}
            {connected && state.resuming && (
              <div className="connection-banner" role="status">
                <Unplug />
                网络中断，正在重连；运行和终端在服务端继续
              </div>
            )}
            <Conversation
              session={selected}
              events={events}
              history={history}
              connected={connected}
              native={nativeMode}
              ownsRun={ownsRun}
              busy={busy}
              newSession={() => {
                void newSession();
              }}
              loadEarlier={() => {
                void act(() => client.loadEarlier(selected!.id));
              }}
              edit={
                controlsDisabled
                  ? undefined
                  : (id, text) => {
                      void fork(selected!, { id, text });
                    }
              }
              replyApproval={(runId, approvalId, allowed) => {
                void act(async () => {
                  await client.request({
                    type: 'approval.reply',
                    sessionId: selected!.id,
                    runId,
                    approvalId,
                    allowed,
                  });
                });
              }}
            />
            {selected && !terminalSessionId && (
              <Composer
                session={selected}
                draft={draft}
                setDraft={(text) => setDraft(selected.id, text)}
                native={nativeMode}
                connected={connected}
                busy={busy}
                refreshing={refreshing}
                ownsRun={ownsRun}
                inputDisabled={inputDisabled}
                controlsDisabled={controlsDisabled}
                slashOpen={slashOpen}
                setSlashOpen={setSlashOpen}
                canCompact={canCompact}
                scenario={scenario}
                setScenario={setScenario}
                capabilities={capabilities}
                nativeSession={nativeSession}
                metrics={metrics}
                send={() => {
                  void send();
                }}
                compact={() => {
                  void compact();
                }}
                refresh={() => {
                  void refreshStatus();
                }}
                configure={configure}
                stop={() => {
                  void act(async () => {
                    await client.request({
                      type: 'run.cancel',
                      sessionId: selected.id,
                      runId: selected.activeRun!.id,
                    });
                  });
                }}
              />
            )}
          </>
        )}
      </main>
      {menu && (!menu.sessionId || menuSession) && (
        <Menu
          label={menuSession ? `会话操作 · ${menuSession.title}` : '连接'}
          x={menu.x}
          y={menu.y}
          above={menu.above}
          onClose={closeMenu}
          items={
            menuSession
              ? sessionMenu(menuSession)
              : [
                  ...(nativeMode
                    ? [
                        {
                          label: 'Claude Code 设置',
                          icon: <Settings2 />,
                          run: () => {
                            setPanel('settings');
                            setSidebarOpen(false);
                          },
                        },
                      ]
                    : []),
                  {
                    label: '定时任务',
                    icon: <CalendarClock />,
                    run: () => {
                      setPanel('schedules');
                      setSidebarOpen(false);
                    },
                  },
                  ...(upgrade
                    ? [
                        {
                          label: `升级到 ${upgrade}`,
                          icon: <Download />,
                          disabled: busy || state.sessions.some((item) => !!item.activeRun),
                          run: () => {
                            void act(() => window.desktop!.installUpdate());
                          },
                        },
                      ]
                    : []),
                  ...(serviceUpdate ? [serviceUpdate] : []),
                  ...(project.url
                    ? [{ label: project.name, icon: <GithubMark />, run: openProject }]
                    : []),
                  { label: '断开连接', icon: <LogOut />, run: disconnect },
                ]
          }
        />
      )}
      {createOpen && (
        <AddProjectDialog
          busy={busy}
          connected={connected}
          error={error}
          close={() => setCreateOpen(false)}
          add={(path) => {
            void act(async () => {
              if (!path) return;
              setProjects((value) => withProject(value, path));
              setCreateOpen(false);
            });
          }}
        />
      )}
      {deleteSession && (
        <DeleteSessionDialog
          session={deleteSession}
          native={nativeMode}
          busy={busy}
          connected={connected}
          error={error}
          close={() => setDeleteSession(null)}
          confirm={() => {
            void act(async () => {
              await client.request({ type: 'session.delete', sessionId: deleteSession.id });
              setDraft(deleteSession.id, '');
              // A plain session's directory goes with it when the session left nothing there.
              if (isInside(deleteSession.projectPath, workspaceRoot))
                void window.desktop?.removeWorkspace(deleteSession.projectPath);
              setDeleteSession(null);
            });
          }}
        />
      )}
      {renameSession && (
        <RenameSessionDialog
          session={renameSession}
          busy={busy}
          connected={connected}
          error={error}
          close={() => setRenameSession(null)}
          rename={(title) => {
            void act(async () => {
              await client.request({ type: 'session.rename', sessionId: renameSession.id, title });
              setRenameSession(null);
            });
          }}
        />
      )}
    </div>
  );
}
