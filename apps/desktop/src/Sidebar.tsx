import { useMemo, useState } from 'react';
import {
  ChevronDown,
  Ellipsis,
  Folder,
  MessageSquare,
  Plus,
  Search,
  SquareTerminal,
  UserRound,
  X,
} from 'lucide-react';
import type { Session } from '@cc-desk-tunnel/protocol';
import { folderName, isInside, pathKey } from './paths.ts';
import { IconButton } from './ui.tsx';

type MenuPosition = { x: number; y: number; above?: boolean };

function activity(session: Session) {
  if (!session.activeRun) return new Date(session.updatedAt).toLocaleDateString('zh-CN');
  if (session.activeRun.surface === 'terminal') return '原生终端';
  return session.activeRun.status === 'awaiting_approval' ? '等待审批' : '运行中';
}

export default function Sidebar({
  sessions,
  selectedId,
  projects,
  workspaceRoot,
  connected,
  busy,
  refreshing,
  terminalOpen,
  terminalActive,
  adapterName,
  accountName,
  accountDetail,
  select,
  newSession,
  addProject,
  createInProject,
  openAccount,
  sessionMenu,
  connectionMenu,
  close,
}: {
  sessions: Session[];
  selectedId: string | undefined;
  projects: string[];
  // Sessions whose directory lies under this root belong to no project and are listed on their own.
  workspaceRoot: string;
  connected: boolean;
  busy: boolean;
  refreshing: boolean;
  // `terminalOpen` is this window's terminal; `terminalActive` also covers one held by another connection.
  terminalOpen: boolean;
  terminalActive: boolean;
  adapterName: string;
  accountName: string;
  accountDetail: string;
  select: (sessionId: string) => void;
  newSession: () => void;
  addProject: () => void;
  createInProject: (path: string) => void;
  openAccount: () => void;
  sessionMenu: (session: Session, position: MenuPosition) => void;
  connectionMenu: (position: MenuPosition) => void;
  close: () => void;
}) {
  const [search, setSearch] = useState('');
  const { plain, groups } = useMemo(() => {
    const grouped = new Map<string, Session[]>();
    const plain: Session[] = [];
    const term = search.trim().toLowerCase();
    for (const path of projects) grouped.set(pathKey(path), []);
    for (const session of sessions) {
      if (isInside(session.projectPath, workspaceRoot)) {
        if (session.title.toLowerCase().includes(term)) plain.push(session);
        continue;
      }
      if (!`${session.title} ${session.projectPath}`.toLowerCase().includes(term)) continue;
      const key = pathKey(session.projectPath);
      const members = grouped.get(key) ?? [];
      members.push(session);
      grouped.set(key, members);
    }
    return {
      plain,
      groups: [...grouped.entries()]
        .map(([key, members]) => ({
          path: members[0]?.projectPath ?? projects.find((path) => pathKey(path) === key)!,
          sessions: members,
        }))
        .filter(
          (group) =>
            group.sessions.length ||
            !search ||
            group.path.toLowerCase().includes(search.toLowerCase()),
        ),
    };
  }, [sessions, search, projects, workspaceRoot]);

  function renderSession(session: Session) {
    return (
      <div
        className={`session-row ${selectedId === session.id ? 'selected' : ''}`}
        key={session.id}
        onContextMenu={(event) => {
          event.preventDefault();
          sessionMenu(session, { x: event.clientX, y: event.clientY });
        }}
      >
        <button
          type="button"
          className="session-select"
          disabled={terminalOpen || terminalActive}
          onClick={() => select(session.id)}
        >
          <MessageSquare />
          <span>
            <strong>{session.title}</strong>
            <small>{activity(session)}</small>
          </span>
          {session.activeRun && <span className="running-dot" />}
        </button>
        <IconButton
          title="会话操作"
          className="session-more"
          onClick={(event) => {
            const box = event.currentTarget.getBoundingClientRect();
            sessionMenu(session, { x: box.left, y: box.bottom + 4 });
          }}
        >
          <Ellipsis />
        </IconButton>
      </div>
    );
  }
  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <div className="brand">
          <SquareTerminal />
          <span>CC Desk Tunnel</span>
        </div>
        <IconButton className="mobile-only" title="收起会话列表" onClick={close}>
          <X />
        </IconButton>
      </div>
      <button
        type="button"
        className="button new-session"
        disabled={!connected || busy || refreshing || terminalOpen || terminalActive}
        onClick={newSession}
      >
        <Plus />
        新建会话
      </button>
      <label className="session-search">
        <Search />
        <input
          aria-label="搜索会话"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="搜索会话或项目"
        />
      </label>
      <nav className="session-list" aria-label="会话列表">
        {plain.map(renderSession)}
        <div className="list-heading">
          项目
          <IconButton
            title="添加项目"
            disabled={!connected || busy || terminalActive}
            onClick={addProject}
          >
            <Plus />
          </IconButton>
        </div>
        {groups.map(({ path, sessions: members }) => (
          <section className="project-group" key={pathKey(path)}>
            <h2 title={path}>
              <Folder />
              <span>{folderName(path)}</span>
              <IconButton
                title={`新建会话 · ${path}`}
                disabled={!connected || busy || refreshing || terminalActive}
                onClick={() => createInProject(path)}
              >
                <Plus />
              </IconButton>
            </h2>
            {members.map(renderSession)}
            {!members.length && <p className="project-empty">暂无会话</p>}
          </section>
        ))}
        {groups.length === 0 && plain.length === 0 && (
          <p className="list-empty">{search ? '没有匹配会话' : '暂无会话'}</p>
        )}
      </nav>
      <button className="account-entry" type="button" onClick={openAccount}>
        <UserRound />
        <span>
          <strong>{accountName}</strong>
          <small>{accountDetail}</small>
        </span>
        <ChevronDown />
      </button>
      <button
        className="sidebar-footer"
        type="button"
        aria-haspopup="menu"
        title="连接"
        onClick={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          connectionMenu({ x: box.left + 12, y: box.top + 2, above: true });
        }}
      >
        <span className={`connection-dot ${connected ? 'online' : ''}`} />
        <span>{connected ? '已连接' : '重连中'}</span>
        <span className="adapter-label">{adapterName}</span>
      </button>
    </aside>
  );
}
