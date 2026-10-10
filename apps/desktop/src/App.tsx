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
  CircleHelp,
  Download,
  FileDown,
  FolderInput,
  FolderOpen,
  GitFork,
  LogOut,
  Pencil,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  Settings,
  SquareTerminal,
  Trash2,
  Unplug,
  UserRound,
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
import { exportSession } from './exportSession.ts';
import { useNotifications } from './notifications.ts';
import { folderName, isInside, isNewer, pathKey, withProject } from './paths.ts';
import { getPrefs, setPrefs, toggled, usePrefs } from './prefs.ts';
import { actions, comboOf, keyFor, show as comboText } from './shortcuts.ts';
import type { Action } from './shortcuts.ts';
import Rail from './Rail.tsx';
import type { Page } from './Rail.tsx';
import {
  AddProjectDialog,
  DeleteSessionDialog,
  RenameProjectDialog,
  RenameSessionDialog,
} from './SessionDialogs.tsx';
import SettingsPage from './SettingsPage.tsx';
import type { Section } from './SettingsPage.tsx';
import Sidebar from './Sidebar.tsx';
import TitleBar from './TitleBar.tsx';
import type { BarMenu } from './TitleBar.tsx';
import { IconButton, Menu } from './ui.tsx';
import type { MenuItem, MenuPosition } from './ui.tsx';

const NativeTerminal = lazy(() => import('./NativeTerminal.tsx'));

// The newest event of a kind is the session's current native state.
function latest<T extends EventPayload['type']>(events: SessionEvent[], type: T) {
  return (events.findLast((event) => event.payload.type === type)?.payload ?? null) as Extract<
    EventPayload,
    { type: T }
  > | null;
}
// Where the window is: a page, the settings section when that page is open, and the session being read.
type Place = { page: Page; section: Section; sessionId: string | null };
// Which menu is open. Its items are built while rendering, so they follow the state as it changes.
type OpenMenu = MenuPosition &
  (
    | { kind: 'session'; sessionId: string }
    | { kind: 'project'; path: string }
    | { kind: 'move'; sessionId: string }
    | { kind: 'settings' }
    | { kind: 'update' }
    | { kind: 'bar'; label: string }
  );
const narrow = () => matchMedia('(max-width: 700px)').matches;
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
  const [findRequest, setFindRequest] = useState(0);
  // Which of this computer's settings is open on the login page.
  const [localSettings, setLocalSettings] = useState<Section | null>(null);
  useEffect(() => {
    if (state.status !== 'disconnected' && state.status !== 'connecting') setLocalSettings(null);
  }, [state.status]);
  const refreshed = useRef(new Set<string>());
  const [projects, setProjects] = useState(savedProjects);
  // The folders that hold sessions without a project; new ones are made in the first.
  const [workspaceRoots, setWorkspaceRoots] = useState<string[]>([]);
  const [drafts, setDraft] = useDrafts();
  const [scenario, setScenario] = useState<Scenario>('chat');
  const [slashOpen, setSlashOpen] = useState(false);
  // The side column is shown beside the page on a wide window and laid over it on a narrow one.
  const [sideOpen, setSideOpen] = useState(() => !narrow());
  const closeSide = useCallback(() => {
    if (narrow()) setSideOpen(false);
  }, []);
  // Crossing between the two layouts starts from each one's usual state.
  useEffect(() => {
    const query = matchMedia('(max-width: 700px)');
    const follow = () => setSideOpen(!query.matches);
    query.addEventListener('change', follow);
    return () => query.removeEventListener('change', follow);
  }, []);
  const [place, setPlace] = useState<Place>({ page: 'chat', section: 'account', sessionId: null });
  // Places visited, for the title bar's way back and forward.
  const trail = useRef<{ places: Place[]; at: number }>({ places: [place], at: 0 });
  const [, setTrailAt] = useState(0);
  const accountOpen = place.page === 'settings' && place.section === 'account';
  const prefs = usePrefs();
  const [version, setVersion] = useState('');
  useEffect(() => {
    void window.desktop?.version().then(setVersion);
  }, []);
  const [terminalSessionId, setTerminalSessionId] = useState<string | null>(null);
  const closeTerminal = useCallback(() => setTerminalSessionId(null), []);
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteSession, setDeleteSession] = useState<Session | null>(null);
  const [renameSession, setRenameSession] = useState<Session | null>(null);
  const [renameProject, setRenameProject] = useState<string | null>(null);
  const [repointProject, setRepointProject] = useState<string | null>(null);

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
      // The installed client has no simulation mode, whatever an earlier version saved.
      const restored = window.desktop!.dev ? saved : { ...saved, mode: 'remote' as const };
      setForm(restored);
      if (restored.autoLogin) void login(restored);
    });
  }, []);
  useEffect(() => {
    if (connected) void window.desktop?.saveLogin(form);
  }, [connected, form.remember, form.autoLogin]);
  useEffect(() => {
    const close = () => client.disconnect();
    const unsubscribe = window.desktop?.onProxyClosed(() => {
      client.disconnect();
      setForm((current) => (current.remember ? current : { ...current, token: '' }));
      setError((value) => value ?? client.state.error ?? '远程连接已关闭，请重新登录。');
      notifications.push({
        kind: 'connection',
        title: '连接中断',
        body: client.state.error?.split('\n')[0] ?? '远程连接已关闭，请重新登录。',
      });
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
    if (connected) void window.desktop?.workspaceRoots().then(setWorkspaceRoots);
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
          waits: getPrefs().connection,
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
  function stopRun() {
    if (!selected?.activeRun) return;
    const { id: sessionId, activeRun } = selected;
    void act(async () => {
      await client.request({ type: 'run.cancel', sessionId, runId: activeRun.id });
    });
  }
  function disconnect() {
    client.disconnect();
    setForm((current) => (current.remember ? current : { ...current, token: '' }));
    void window.desktop?.disconnectProxy();
  }
  // Moves the window to a place and remembers it; going back or forward revisits without adding to the trail.
  function visit(next: Place, record = true) {
    if (next.sessionId && next.sessionId !== client.state.selectedId) client.select(next.sessionId);
    setPlace(next);
    closeSide();
    if (!record) return;
    const { places, at } = trail.current;
    const last = places[at];
    if (
      last.page === next.page &&
      last.section === next.section &&
      last.sessionId === next.sessionId
    )
      return;
    trail.current = { places: [...places.slice(0, at + 1), next].slice(-50), at: 0 };
    trail.current.at = trail.current.places.length - 1;
    setTrailAt(trail.current.at);
  }
  function step(by: number) {
    const { places } = trail.current;
    // Sessions deleted since are passed over.
    for (let at = trail.current.at + by; at >= 0 && at < places.length; at += by) {
      const target = places[at];
      if (target.sessionId && !state.sessions.some((item) => item.id === target.sessionId))
        continue;
      trail.current.at = at;
      setTrailAt(at);
      visit(target, false);
      return;
    }
  }
  const stepAvailable = (by: number) => {
    const { places } = trail.current;
    for (let at = trail.current.at + by; at >= 0 && at < places.length; at += by)
      if (!places[at].sessionId || state.sessions.some((item) => item.id === places[at].sessionId))
        return true;
    return false;
  };
  const show = (sessionId: string) => visit({ ...place, page: 'chat', sessionId });
  const open = (page: Page, section: Section = place.section) =>
    visit({ page, section, sessionId: client.state.selectedId });
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
    if (response.sessionId) show(response.sessionId);
  }
  async function createInProject(path: string) {
    await act(() => createSession(path));
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
      });
      return;
    }
    const path = selected?.projectPath ?? projects[0] ?? state.sessions[0]?.projectPath;
    if (path) await createInProject(path);
    else await addProject();
  }
  // A due task is an ordinary message: to its session once that is idle, or to a session made for it. It is
  // never queued into a run, and waits while the native terminal holds the CLI.
  const notifications = useNotifications(client, () =>
    place.page === 'chat' ? client.state.selectedId : null,
  );
  useEffect(() => window.desktop?.onNotifyClicked((sessionId) => sessionId && show(sessionId)));
  const schedules = useSchedules(
    async (task, due) => {
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
    },
    (task, outcome) =>
      notifications.push({
        kind: 'schedule',
        title: '定时任务未发出',
        body: `${task.name}：${outcome.text}`,
      }),
  );
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
    const pinned = prefs.pinnedSessions.includes(session.id);
    return [
      {
        label: pinned ? '取消置顶' : '置顶',
        icon: pinned ? <PinOff /> : <Pin />,
        run: () =>
          setPrefs((value) => ({
            ...value,
            pinnedSessions: toggled(value.pinnedSessions, session.id),
          })),
      },
      {
        label: '重命名',
        icon: <Pencil />,
        disabled: !idle || !!session.activeRun,
        run: () => {
          setError(null);
          closeSide();
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
      {
        label: '导出为 Markdown',
        icon: <FileDown />,
        disabled: !connected || !!terminalSessionId || terminalActive,
        run: () => {
          void act(async () => {
            await exportSession(client, session);
          });
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
        separated: true,
        disabled: !connected || !!session.activeRun || !!terminalSessionId || terminalActive,
        run: () => {
          setError(null);
          closeSide();
          setDeleteSession(session);
        },
      },
    ];
  }
  function projectMenu(path: string): MenuItem[] {
    const key = pathKey(path);
    const pinned = prefs.pinnedProjects.includes(key);
    return [
      {
        label: '新建会话',
        icon: <Plus />,
        disabled: !connected || busy || refreshing || terminalActive,
        run: () => {
          void createInProject(path);
        },
      },
      {
        label: pinned ? '取消置顶' : '置顶',
        icon: pinned ? <PinOff /> : <Pin />,
        run: () =>
          setPrefs((value) => ({ ...value, pinnedProjects: toggled(value.pinnedProjects, key) })),
      },
      { label: '修改显示名称', icon: <Pencil />, run: () => setRenameProject(path) },
      {
        label: '更改文件夹…',
        icon: <FolderInput />,
        disabled: !connected || busy || !!terminalSessionId || terminalActive,
        run: () => {
          if (!window.desktop) return setRepointProject(path);
          void act(async () => {
            const chosen = await window.desktop!.chooseProject();
            if (chosen) await repoint(path, chosen);
          });
        },
      },
      ...(window.desktop
        ? [
            {
              label: '在资源管理器中打开',
              icon: <FolderOpen />,
              separated: true,
              run: () => {
                void act(() => window.desktop!.openFolder(path));
              },
            },
          ]
        : []),
    ];
  }
  const projectLabel = (path: string) => prefs.projectNames[pathKey(path)] || folderName(path);
  // Every project the session could belong to, the one it is in marked.
  function moveMenu(session: Session): MenuItem[] {
    const paths = [...projects];
    for (const item of state.sessions)
      if (
        !isInside(item.projectPath, workspaceRoots) &&
        !paths.some((path) => pathKey(path) === pathKey(item.projectPath))
      )
        paths.push(item.projectPath);
    return paths.map((path) => ({
      label: projectLabel(path),
      detail: path,
      checked: pathKey(path) === pathKey(session.projectPath),
      run: () => {
        if (pathKey(path) !== pathKey(session.projectPath))
          void act(async () => {
            await client.request({
              type: 'session.move',
              sessionId: session.id,
              projectPath: path,
            });
          });
      },
    }));
  }
  // Points a project at another folder: its sessions move there, and what this computer keeps about the
  // project (its place in the list, its name, its pin) follows.
  async function repoint(from: string, to: string) {
    const key = pathKey(from);
    const next = pathKey(to);
    if (key === next) return;
    const members = state.sessions.filter((item) => pathKey(item.projectPath) === key);
    if (members.some((item) => item.activeRun))
      throw new Error('这个项目里有会话正在运行，结束后再更改文件夹。');
    for (const item of members)
      await client.request({ type: 'session.move', sessionId: item.id, projectPath: to });
    setProjects((value) => [
      ...new Map(
        value
          .map((path) => (pathKey(path) === key ? to : path))
          .map((path) => [pathKey(path), path]),
      ).values(),
    ]);
    setPrefs((value) => {
      const projectNames = { ...value.projectNames };
      if (projectNames[key] && !projectNames[next]) projectNames[next] = projectNames[key];
      delete projectNames[key];
      return {
        ...value,
        projectNames,
        pinnedProjects: [
          ...new Set(value.pinnedProjects.map((item) => (item === key ? next : item))),
        ],
      };
    });
  }
  const adapterName = nativeMode ? 'Claude Code' : 'Simulation';
  const accountName = signedOut
    ? '未登录'
    : (state.account?.email ?? capabilities?.account.email ?? (nativeMode ? '账号' : '离线模拟'));
  const upgradeItem: MenuItem | null = upgrade
    ? {
        label: `升级客户端到 ${upgrade}`,
        icon: <Download />,
        disabled: busy || state.sessions.some((item) => !!item.activeRun),
        run: () => {
          void act(() => window.desktop!.installUpdate());
        },
      }
    : null;
  const updates = [
    ...(upgradeItem ? [upgradeItem] : []),
    ...(serviceUpdate ? [serviceUpdate] : []),
  ];
  // The rail shows its button only for an update that exists, not for the standing offer to look for one.
  const pendingUpdate = upgrade
    ? `客户端可升级到 ${upgrade}`
    : update && ['available', 'manual', 'installing', 'restarting'].includes(update.state)
      ? (serviceUpdate?.label ?? null)
      : null;
  // What a menu shows beside an item that has a shortcut.
  const hint = (action: Action) =>
    (prefs.shortcuts.enabled && comboText(keyFor(prefs, action))) || undefined;
  const settingsMenu: MenuItem[] = [
    {
      label: `账号 · ${accountName}`,
      icon: <UserRound />,
      detail: signedOut
        ? '点击登录 Claude 账号'
        : (state.account?.subscriptionType ??
          capabilities?.account.subscriptionType ??
          '账号与额度'),
      run: () => open('settings', 'account'),
    },
    {
      label: '设置',
      icon: <Settings />,
      hint: hint('settings'),
      separated: true,
      run: () => open('settings', nativeMode ? 'claude' : 'general'),
    },
    { label: '帮助', icon: <CircleHelp />, run: () => open('settings', 'help') },
    { label: '断开连接', icon: <LogOut />, separated: true, run: disconnect },
  ];
  const toggleSide = () => setSideOpen((value) => !value);
  const canCreate = connected && !busy && !refreshing && !terminalSessionId && !terminalActive;
  const barMenus: BarMenu[] = [
    {
      label: '文件',
      items: [
        {
          label: '新建会话',
          hint: hint('newSession'),
          disabled: !canCreate,
          run: () => {
            void newSession();
          },
        },
        {
          label: '添加项目…',
          disabled: !connected || busy || terminalActive,
          run: () => {
            void addProject();
          },
        },
        {
          label: '导出当前会话…',
          disabled: !selected || !connected || !!terminalSessionId || terminalActive,
          separated: true,
          run: () => {
            void act(async () => {
              await exportSession(client, selected!);
            });
          },
        },
        { label: '断开连接', separated: true, run: disconnect },
        ...(window.desktop ? [{ label: '退出', run: () => void window.desktop!.quit() }] : []),
      ],
    },
    {
      label: '视图',
      items: [
        {
          label: '查找对话内容',
          hint: hint('find'),
          disabled: !selected || place.page !== 'chat' || !!terminalSessionId,
          run: () => setFindRequest((value) => value + 1),
        },
        { label: sideOpen ? '收起侧栏' : '展开侧栏', hint: hint('toggleSide'), run: toggleSide },
        { label: '会话', separated: true, checked: place.page === 'chat', run: () => open('chat') },
        {
          label: '定时任务',
          checked: place.page === 'schedules',
          run: () => open('schedules'),
        },
        {
          label: '设置',
          hint: hint('settings'),
          checked: place.page === 'settings',
          run: () => open('settings'),
        },
        ...(window.desktop
          ? [
              {
                label: '放大',
                hint: hint('zoomIn'),
                separated: true,
                run: () => window.desktop!.zoom(1),
              },
              { label: '缩小', hint: hint('zoomOut'), run: () => window.desktop!.zoom(-1) },
              { label: '实际大小', hint: hint('zoomReset'), run: () => window.desktop!.zoom(0) },
            ]
          : []),
      ],
    },
    {
      label: '帮助',
      items: [
        { label: '使用说明', run: () => open('settings', 'help') },
        {
          label: '快捷键',
          run: () => open('settings', 'shortcuts'),
        },
        ...(project.url ? [{ label: '项目主页', separated: true, run: openProject }] : []),
        { label: '检查更新与版本信息', run: () => open('settings', 'about') },
      ],
    },
  ];
  // The shortcuts, as the user set them. A key press that something else already took, or that belongs to the
  // native terminal or an open dialog, is left alone.
  const keys = useRef<(event: KeyboardEvent) => void>(() => {});
  keys.current = (event) => {
    if (event.defaultPrevented || !prefs.shortcuts.enabled) return;
    if (!connected && state.status !== 'reconnecting') return;
    if (
      (event.target as Element | null)?.closest?.('.native-terminal') ||
      document.querySelector('dialog[open]')
    )
      return;
    const combo = comboOf(event);
    const action = combo && actions.find((item) => keyFor(prefs, item.id) === combo)?.id;
    if (!action) return;
    const run: Record<Action, (() => void) | false | undefined> = {
      back: !terminalSessionId && (() => step(-1)),
      forward: !terminalSessionId && (() => step(1)),
      toggleSide,
      newSession: canCreate && (() => void newSession()),
      settings: () => open('settings'),
      find:
        !!selected &&
        place.page === 'chat' &&
        !terminalSessionId &&
        (() => setFindRequest((value) => value + 1)),
      zoomIn: window.desktop && (() => window.desktop!.zoom(1)),
      zoomOut: window.desktop && (() => window.desktop!.zoom(-1)),
      zoomReset: window.desktop && (() => window.desktop!.zoom(0)),
    };
    const act = run[action];
    if (!act) return;
    event.preventDefault();
    act();
  };
  useEffect(() => {
    const listener = (event: KeyboardEvent) => keys.current(event);
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);

  if (state.status === 'disconnected' || state.status === 'connecting')
    return localSettings ? (
      <div className="settings-only">
        <div className="window-drag" />
        <SettingsPage
          client={client}
          section={localSettings}
          go={setLocalSettings}
          back={() => setLocalSettings(null)}
          native={false}
          account={null}
          form={form}
          changeForm={changeForm}
          workspaceRoot={workspaceRoots[0] ?? ''}
          chooseWorkspace={(reset) => {
            void act(async () => {
              setWorkspaceRoots(await window.desktop!.chooseWorkspace(reset));
            });
          }}
          version={version}
          service={null}
          adapterName=""
          updates={[]}
        />
      </div>
    ) : (
      <LoginPage
        openSettings={() => setLocalSettings('general')}
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
  const menuSession =
    menu?.kind === 'session' ? state.sessions.find((item) => item.id === menu.sessionId) : null;
  const openMenu =
    !menu || (menu.kind === 'session' && !menuSession)
      ? null
      : menu.kind === 'session'
        ? { label: `会话操作 · ${menuSession!.title}`, items: sessionMenu(menuSession!) }
        : menu.kind === 'project'
          ? { label: `项目操作 · ${menu.path}`, items: projectMenu(menu.path) }
          : menu.kind === 'move'
            ? {
                label: '会话所在的项目',
                heading: '把会话移到另一个项目；下一条消息会告诉 Claude 项目已变更',
                items: state.sessions.some((item) => item.id === menu.sessionId)
                  ? moveMenu(state.sessions.find((item) => item.id === menu.sessionId)!)
                  : [],
              }
            : menu.kind === 'settings'
              ? { label: '设置与账号', items: settingsMenu }
              : menu.kind === 'update'
                ? { label: '更新', items: updates }
                : {
                    label: menu.label,
                    items: barMenus.find((item) => item.label === menu.label)?.items ?? [],
                  };
  const sectionNames: Record<Section, string> = {
    account: '账号与额度',
    claude: 'Claude Code 设置',
    general: '常规设置',
    notifications: '通知设置',
    shortcuts: '快捷键',
    help: '帮助',
    about: '关于与更新',
  };
  return (
    <div className={`shell ${sideOpen ? '' : 'side-closed'}`}>
      <TitleBar
        title={
          place.page === 'chat'
            ? (selected?.title ?? 'CC Desk Tunnel')
            : place.page === 'schedules'
              ? '定时任务'
              : sectionNames[place.section]
        }
        back={!terminalSessionId && stepAvailable(-1) ? () => step(-1) : undefined}
        forward={!terminalSessionId && stepAvailable(1) ? () => step(1) : undefined}
        sideOpen={sideOpen}
        toggleSide={toggleSide}
        menus={barMenus}
        openMenu={(item, position) => setMenu({ kind: 'bar', label: item.label, ...position })}
        connected={connected}
        adapterName={adapterName}
      />
      <Rail
        page={place.page}
        go={(page) => open(page)}
        update={pendingUpdate}
        openUpdate={(position) => setMenu({ kind: 'update', ...position })}
        openSettings={(position) => setMenu({ kind: 'settings', ...position })}
      />
      {sideOpen && (
        <button
          className="sidebar-shade"
          aria-label="收起侧栏"
          onClick={() => setSideOpen(false)}
        />
      )}
      {place.page === 'settings' ? (
        <SettingsPage
          client={client}
          section={place.section}
          go={(section) => open('settings', section)}
          native={nativeMode}
          form={form}
          changeForm={changeForm}
          workspaceRoot={workspaceRoots[0] ?? ''}
          chooseWorkspace={(reset) => {
            void act(async () => {
              setWorkspaceRoots(await window.desktop!.chooseWorkspace(reset));
            });
          }}
          version={version}
          service={state.service}
          adapterName={adapterName}
          updates={updates}
          account={
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
            />
          }
        />
      ) : place.page === 'schedules' ? (
        <SchedulePanel
          schedules={schedules}
          sessions={state.sessions}
          projects={projects}
          capabilities={capabilities}
        />
      ) : (
        <>
          <Sidebar
            sessions={state.sessions}
            selectedId={selected?.id}
            projects={projects}
            workspaceRoots={workspaceRoots}
            connected={connected}
            busy={busy}
            refreshing={refreshing}
            terminalOpen={!!terminalSessionId}
            terminalActive={terminalActive}
            notifications={notifications}
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
            sessionMenu={(session, position) =>
              setMenu({ kind: 'session', sessionId: session.id, ...position })
            }
            projectMenu={(path, position) => setMenu({ kind: 'project', path, ...position })}
          />
          <main className="workspace">
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
            <Conversation
              findRequest={findRequest}
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
              loadEarlier={() => client.loadEarlier(selected!.id)}
              edit={
                controlsDisabled
                  ? undefined
                  : (id, text) => {
                      void fork(selected!, { id, text });
                    }
              }
              stopTask={(taskId) => {
                void act(async () => {
                  await client.request({
                    type: 'run.task.stop',
                    sessionId: selected!.id,
                    runId: selected!.activeRun!.id,
                    taskId,
                  });
                });
              }}
              stop={stopRun}
              replyApproval={(runId, approvalId, allowed, answers) => {
                void act(async () => {
                  await client.request({
                    type: 'approval.reply',
                    sessionId: selected!.id,
                    runId,
                    approvalId,
                    allowed,
                    ...(answers ? { answers } : {}),
                  });
                });
              }}
            />
            {selected && !terminalSessionId && (
              <Composer
                session={selected}
                projectName={
                  isInside(selected.projectPath, workspaceRoots)
                    ? null
                    : projectLabel(selected.projectPath)
                }
                chooseProject={
                  controlsDisabled
                    ? undefined
                    : (position) => setMenu({ kind: 'move', sessionId: selected.id, ...position })
                }
                draft={draft}
                setDraft={(text) => setDraft(selected.id, text)}
                native={nativeMode}
                connected={connected}
                busy={busy}
                refreshing={refreshing}
                canRefreshModels={!state.sessions.some((session) => session.activeRun)}
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
                stop={stopRun}
              />
            )}
          </main>
        </>
      )}
      {menu && openMenu && (
        <Menu
          label={openMenu.label}
          heading={'heading' in openMenu ? openMenu.heading : undefined}
          x={menu.x}
          y={menu.y}
          above={menu.above}
          onClose={closeMenu}
          items={openMenu.items}
        />
      )}
      {repointProject && (
        <AddProjectDialog
          title="更改项目文件夹"
          action="更改"
          busy={busy}
          connected={connected}
          error={error}
          close={() => setRepointProject(null)}
          add={(path) => {
            void act(async () => {
              if (!path) return;
              await repoint(repointProject, path);
              setRepointProject(null);
            });
          }}
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
              if (isInside(deleteSession.projectPath, workspaceRoots))
                void window.desktop?.removeWorkspace(deleteSession.projectPath);
              setDeleteSession(null);
            });
          }}
        />
      )}
      {renameProject && (
        <RenameProjectDialog
          path={renameProject}
          name={prefs.projectNames[pathKey(renameProject)] ?? ''}
          close={() => setRenameProject(null)}
          rename={(name) => {
            setPrefs((value) => {
              const projectNames = { ...value.projectNames };
              if (name) projectNames[pathKey(renameProject)] = name;
              else delete projectNames[pathKey(renameProject)];
              return { ...value, projectNames };
            });
            setRenameProject(null);
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
