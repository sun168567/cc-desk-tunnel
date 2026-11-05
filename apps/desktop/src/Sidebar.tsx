import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Ellipsis,
  Folder,
  FolderOpen,
  Laptop,
  Pin,
  Plus,
  Search,
  SquarePen,
  X,
} from 'lucide-react';
import type { Session } from '@cc-desk-tunnel/protocol';
import type { ConnectedDevice } from './client.ts';
import NoticeBell from './NoticeBell.tsx';
import type { Notifications } from './notifications.ts';
import { ago, folderName, isInside, pathKey } from './paths.ts';
import { setPrefs, toggled, usePrefs } from './prefs.ts';
import { useConnectionName } from './shared.ts';
import { IconButton } from './ui.tsx';
import { terminalState } from './RunStatus.tsx';
import type { MenuPosition } from './ui.tsx';

function activity(session: Session) {
  if (!session.activeRun) return ago(Date.parse(session.updatedAt));
  if (session.activeRun.surface === 'terminal') return terminalState(session.activeRun.activity);
  if (session.activeRun.waiting === 'background') return '后台任务';
  if (session.activeRun.status !== 'awaiting_approval') return '运行中';
  return session.activeRun.waiting === 'question' ? '等待回答' : '等待审批';
}

const breathing = (run: NonNullable<Session['activeRun']>) =>
  run.activity ? run.activity === 'working' : run.status !== 'awaiting_approval';

// A list of sessions shows its latest few until it is listed in full.
const PAGE = 5;

// Another computer's sessions: by project folder, and those without a project.
type Elsewhere = {
  name: string;
  // Connected, and its commands reach it: its sessions can be worked on from here.
  online: boolean;
  projects: Map<string, { path: string; sessions: Session[] }>;
  plain: Session[];
};

export default function Sidebar({
  localProjects = true,
  sessions,
  elsewhere,
  devices,
  selectedId,
  projects,
  workspaceRoots,
  connected,
  busy,
  refreshing,
  notifications,
  select,
  newSession,
  addProject,
  createInProject,
  sessionMenu,
  projectMenu,
}: {
  localProjects?: boolean;
  sessions: Session[];
  // Sessions on the user's other computers: listed apart, by computer and under it by project folder, and not
  // part of any project here.
  elsewhere: Session[];
  devices: ConnectedDevice[];
  selectedId: string | undefined;
  projects: string[];
  // Sessions whose directory lies under one of these belong to no project and are listed on their own.
  workspaceRoots: string[];
  connected: boolean;
  busy: boolean;
  refreshing: boolean;

  notifications: Notifications;
  select: (sessionId: string) => void;
  newSession: () => void;
  addProject: () => void;
  createInProject: (path: string) => void;
  sessionMenu: (session: Session, position: MenuPosition) => void;
  projectMenu: (path: string, position: MenuPosition) => void;
}) {
  const prefs = usePrefs();
  const connectionName = useConnectionName();
  const [search, setSearch] = useState('');
  const [searching, setSearching] = useState(false);
  // The lists listed in full rather than their latest few, for this window only.
  const [listed, setListed] = useState<string[]>([]);
  const { pinned, plain, groups } = useMemo(() => {
    const grouped = new Map<string, Session[]>();
    const plain: Session[] = [];
    const pinned: Session[] = [];
    const term = search.trim().toLowerCase();
    for (const path of projects) grouped.set(pathKey(path), []);
    for (const session of sessions) {
      const loose = isInside(session.projectPath, workspaceRoots);
      const text = loose ? session.title : `${session.title} ${session.projectPath}`;
      if (!text.toLowerCase().includes(term)) continue;
      if (prefs.pinnedSessions.includes(session.id)) {
        pinned.push(session);
        if (loose) continue;
      } else if (loose) {
        plain.push(session);
        continue;
      }
      const key = pathKey(session.projectPath);
      const members = grouped.get(key) ?? [];
      if (!prefs.pinnedSessions.includes(session.id)) members.push(session);
      grouped.set(key, members);
    }
    const first = (key: string) => (prefs.pinnedProjects.includes(key) ? 0 : 1);
    return {
      pinned,
      plain,
      groups: [...grouped.entries()]
        .map(([key, members]) => ({
          key,
          path:
            projects.find((path) => pathKey(path) === key) ??
            sessions.find((session) => pathKey(session.projectPath) === key)!.projectPath,
          sessions: members,
        }))
        .filter(
          (group) => group.sessions.length || !term || group.path.toLowerCase().includes(term),
        )
        // Array.sort is stable: pinned projects come first, the rest keep their order.
        .sort((a, b) => first(a.key) - first(b.key)),
    };
  }, [sessions, search, projects, workspaceRoots, prefs.pinnedSessions, prefs.pinnedProjects]);

  const others = useMemo(() => {
    const term = search.trim().toLowerCase();
    const groups = new Map<string, Elsewhere>();
    for (const session of elsewhere) {
      if (!`${session.title} ${session.projectPath}`.toLowerCase().includes(term)) continue;
      // A session from before computers were told apart, whose folder is not on this one.
      const device = session.device ?? { id: '', name: '未知设备' };
      const entry: Elsewhere = groups.get(device.id) ?? {
        name: device.name,
        online: devices.some((item) => item.id === device.id && item.ready),
        projects: new Map(),
        plain: [],
      };
      groups.set(device.id, entry);
      // The server currently creates only sessions without a project; its workspace paths are internal.
      // Which folders hold another computer's sessions without a project is not known here; the ones this
      // program makes are told by their shape, a day and under it a time.
      if (
        devices.some((item) => item.id === device.id && item.server) ||
        /[\\/]\d{4}-\d{2}-\d{2}[\\/]\d{6}(-\d+)?[\\/]?$/.test(session.projectPath)
      ) {
        entry.plain.push(session);
        continue;
      }
      const key = pathKey(session.projectPath);
      const project = entry.projects.get(key) ?? { path: session.projectPath, sessions: [] };
      project.sessions.push(session);
      entry.projects.set(key, project);
    }
    return [...groups.entries()];
  }, [elsewhere, devices, search]);
  const othersCount = others.reduce(
    (count, [, device]) =>
      count +
      device.plain.length +
      [...device.projects.values()].reduce((sum, project) => sum + project.sessions.length, 0),
    0,
  );
  // A search shows what it found, folded or not.
  const othersOpen = prefs.elsewhereOpen || !!search.trim();

  // A card beside the row tells what the short line cannot: the whole title, the project and the time.
  const [card, setCard] = useState<{ session: Session; top: number; left: number } | null>(null);
  const hover = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const aside = useRef<HTMLElement>(null);
  const leave = () => {
    clearTimeout(hover.current);
    setCard(null);
  };
  useEffect(() => leave, []);

  // Folds a list away and opens it again; folded, it tells how many sessions the list holds and whether one runs.
  function foldToggle({
    open,
    label,
    icon,
    name,
    members,
    toggle,
  }: {
    open: boolean;
    label: string;
    icon: ReactNode;
    name: string;
    members: Session[];
    toggle: () => void;
  }) {
    return (
      <button
        type="button"
        className="project-toggle"
        aria-expanded={open}
        aria-label={`${open ? '收起' : '展开'}${label}`}
        onClick={toggle}
      >
        {icon}
        <span>{name}</span>
        {!open && members.some((session) => session.activeRun) && <i className="running-dot" />}
        {!open && members.length > 0 && <small>{members.length}</small>}
      </button>
    );
  }
  const foldElsewhere = (key: string) => () =>
    setPrefs((value) => ({ ...value, collapsedElsewhere: toggled(value.collapsedElsewhere, key) }));

  // A list shows its latest few sessions, and also the open one and those at work wherever they are, until it is
  // listed in full. A search lists all it found.
  function renderSessions(key: string, members: Session[]) {
    const kept = members.filter(
      (session, index) => index < PAGE || session.id === selectedId || session.activeRun,
    );
    if (search.trim() || kept.length === members.length) return members.map(renderSession);
    const full = listed.includes(key);
    return (
      <>
        {(full ? members : kept).map(renderSession)}
        <button
          type="button"
          className="project-more"
          onClick={() => setListed((value) => toggled(value, key))}
        >
          {full ? '收起' : `展开显示（还有 ${members.length - kept.length} 个）`}
        </button>
      </>
    );
  }

  function renderSession(session: Session) {
    const isPinned = prefs.pinnedSessions.includes(session.id);
    return (
      <div
        className={`session-row ${selectedId === session.id ? 'selected' : ''}`}
        key={session.id}
        onContextMenu={(event) => {
          event.preventDefault();
          leave();
          sessionMenu(session, { x: event.clientX, y: event.clientY });
        }}
        onMouseEnter={(event) => {
          const row = event.currentTarget.getBoundingClientRect();
          clearTimeout(hover.current);
          hover.current = setTimeout(
            () =>
              setCard({
                session,
                top: row.top,
                left: aside.current!.getBoundingClientRect().right + 8,
              }),
            600,
          );
        }}
        onMouseLeave={leave}
      >
        <button type="button" className="session-select" onClick={() => select(session.id)}>
          <strong>{session.title}</strong>
          {session.activeRun && (
            <span className={`running-dot${breathing(session.activeRun) ? ' breathing' : ''}`} />
          )}
          <small>{activity(session)}</small>
        </button>
        <IconButton
          title={isPinned ? '取消置顶' : '置顶'}
          className="row-action"
          onClick={() =>
            setPrefs((value) => ({
              ...value,
              pinnedSessions: toggled(value.pinnedSessions, session.id),
            }))
          }
        >
          <Pin />
        </IconButton>
        <IconButton
          title="会话操作"
          className="row-action session-more"
          onClick={(event) => {
            const box = event.currentTarget.getBoundingClientRect();
            leave();
            sessionMenu(session, { x: box.left, y: box.bottom + 4 });
          }}
        >
          <Ellipsis />
        </IconButton>
      </div>
    );
  }
  return (
    <aside className="sidebar" ref={aside}>
      <div className="sidebar-brand">
        <span className="brand">
          CC Desk Tunnel
          {connectionName && <span className="brand-connection">{connectionName}</span>}
        </span>
        <NoticeBell notifications={notifications} open={select} />
        <IconButton
          title={searching ? '关闭搜索' : '搜索'}
          onClick={() => {
            setSearching((value) => !value);
            setSearch('');
          }}
        >
          {searching ? <X /> : <Search />}
        </IconButton>
      </div>
      {searching && (
        <label className="session-search">
          <Search />
          <input
            autoFocus
            aria-label="搜索会话"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setSearching(false);
                setSearch('');
              }
            }}
            placeholder="搜索会话或项目"
          />
        </label>
      )}
      <button
        type="button"
        className="side-action new-session"
        disabled={!connected || busy || refreshing}
        onClick={newSession}
      >
        <SquarePen />
        新建会话
      </button>
      <nav className="session-list" aria-label="会话列表">
        {pinned.length > 0 && <div className="list-heading">置顶</div>}
        {pinned.map(renderSession)}
        {localProjects && (
          <div className="list-heading">
            项目
            <IconButton title="添加项目" disabled={!connected || busy} onClick={addProject}>
              <Plus />
            </IconButton>
          </div>
        )}
        {groups.map(({ key, path, sessions: members }) => {
          // A search shows what it found, folded or not.
          const collapsed = !search.trim() && prefs.collapsedProjects.includes(key);
          const name = prefs.projectNames[key] || folderName(path);
          return (
            <section className="project-group" key={key}>
              <h2
                title={path}
                onContextMenu={(event) => {
                  event.preventDefault();
                  projectMenu(path, { x: event.clientX, y: event.clientY });
                }}
              >
                {foldToggle({
                  open: !collapsed,
                  label: `项目 · ${name}`,
                  icon: collapsed ? <Folder /> : <FolderOpen />,
                  name,
                  members,
                  toggle: () =>
                    setPrefs((value) => ({
                      ...value,
                      collapsedProjects: toggled(value.collapsedProjects, key),
                    })),
                })}
                {prefs.pinnedProjects.includes(key) && <Pin className="pin-mark" />}
                <IconButton
                  title={`项目操作 · ${path}`}
                  className="row-action"
                  onClick={(event) => {
                    const box = event.currentTarget.getBoundingClientRect();
                    projectMenu(path, { x: box.left, y: box.bottom + 4 });
                  }}
                >
                  <Ellipsis />
                </IconButton>
                <IconButton
                  title={`新建会话 · ${path}`}
                  className="row-action"
                  disabled={!connected || busy || refreshing}
                  onClick={() => createInProject(path)}
                >
                  <Plus />
                </IconButton>
              </h2>
              {!collapsed && renderSessions(key, members)}
              {!collapsed && !members.length && <p className="project-empty">暂无会话</p>}
            </section>
          );
        })}
        {localProjects && groups.length === 0 && (
          <p className="project-empty">{search ? '没有匹配的项目' : '还没有项目'}</p>
        )}
        {plain.length > 0 && <div className="list-heading">最近</div>}
        {plain.map(renderSession)}
        {othersCount > 0 && (
          <section className="project-group">
            <h2 title="这些会话的项目目录在你的其他电脑上；那台电脑在线时可以直接在这里操作，也可以接到这台电脑上继续">
              {foldToggle({
                open: othersOpen,
                label: '其他设备的会话',
                icon: <Laptop />,
                name: '其他设备',
                members: elsewhere,
                toggle: () =>
                  setPrefs((value) => ({ ...value, elsewhereOpen: !value.elsewhereOpen })),
              })}
            </h2>
            {othersOpen &&
              others.map(([id, device]) => {
                // Each computer, and each folder on it, folds the same way a project does; a search opens them.
                const open = (key: string) =>
                  !!search.trim() || !prefs.collapsedElsewhere.includes(key);
                const projects = [...device.projects.entries()];
                const plainKey = `${id}\n`;
                return (
                  <Fragment key={id}>
                    <div className="list-heading">
                      {foldToggle({
                        open: open(id),
                        label: `设备 · ${device.name}`,
                        icon: open(id) ? <ChevronDown /> : <ChevronRight />,
                        name: device.name,
                        members: [
                          ...projects.flatMap(([, project]) => project.sessions),
                          ...device.plain,
                        ],
                        toggle: foldElsewhere(id),
                      })}
                      <span className={`device-state${device.online ? ' online' : ''}`}>
                        {device.online ? '在线' : '离线'}
                      </span>
                    </div>
                    {open(id) &&
                      projects.map(([path, project]) => {
                        const key = `${id}\n${path}`;
                        const name = folderName(project.path);
                        return (
                          <Fragment key={path}>
                            <div className="elsewhere-project" title={project.path}>
                              {foldToggle({
                                open: open(key),
                                label: `项目 · ${device.name} · ${name}`,
                                icon: open(key) ? <FolderOpen /> : <Folder />,
                                name,
                                members: project.sessions,
                                toggle: foldElsewhere(key),
                              })}
                            </div>
                            {open(key) && renderSessions(key, project.sessions)}
                          </Fragment>
                        );
                      })}
                    {open(id) && device.plain.length > 0 && projects.length > 0 && (
                      <div className="elsewhere-project">
                        {foldToggle({
                          open: open(plainKey),
                          label: `普通会话 · ${device.name}`,
                          icon: open(plainKey) ? <FolderOpen /> : <Folder />,
                          name: '普通会话',
                          members: device.plain,
                          toggle: foldElsewhere(plainKey),
                        })}
                      </div>
                    )}
                    {open(id) &&
                      (open(plainKey) || !projects.length) &&
                      renderSessions(plainKey, device.plain)}
                  </Fragment>
                );
              })}
          </section>
        )}
        {search &&
          groups.length === 0 &&
          plain.length === 0 &&
          pinned.length === 0 &&
          othersCount === 0 && <p className="list-empty">没有匹配会话</p>}
      </nav>
      {card && (
        <div className="session-card" role="tooltip" style={{ top: card.top, left: card.left }}>
          <strong>{card.session.title}</strong>
          <span>
            <Folder />
            {isInside(card.session.projectPath, workspaceRoots)
              ? '普通会话'
              : card.session.projectPath}
          </span>
          <small>
            {activity(card.session)} · {new Date(card.session.updatedAt).toLocaleString('zh-CN')}
          </small>
        </div>
      )}
    </aside>
  );
}
