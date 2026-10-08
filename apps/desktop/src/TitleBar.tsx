import { ArrowLeft, ArrowRight, PanelLeft } from 'lucide-react';
import { IconButton } from './ui.tsx';
import type { MenuItem, MenuPosition } from './ui.tsx';

export type BarMenu = { label: string; items: MenuItem[] };

// The window's own top edge: it is the drag handle of the frameless desktop window, and carries the way back,
// the side column's switch, the menus and the state of the connection.
export default function TitleBar({
  title,
  back,
  forward,
  sideOpen,
  toggleSide,
  menus,
  openMenu,
  connected,
  adapterName,
}: {
  title: string;
  // Absent while there is nowhere to go.
  back?: () => void;
  forward?: () => void;
  sideOpen: boolean;
  toggleSide: () => void;
  menus: BarMenu[];
  openMenu: (menu: BarMenu, position: MenuPosition) => void;
  connected: boolean;
  adapterName: string;
}) {
  return (
    <header className="titlebar">
      <IconButton title="后退" disabled={!back} onClick={back}>
        <ArrowLeft />
      </IconButton>
      <IconButton title="前进" disabled={!forward} onClick={forward}>
        <ArrowRight />
      </IconButton>
      <IconButton title={sideOpen ? '收起侧栏' : '展开会话列表'} onClick={toggleSide}>
        <PanelLeft />
      </IconButton>
      <nav className="titlebar-menus" aria-label="菜单">
        {menus.map((menu) => (
          <button
            type="button"
            key={menu.label}
            aria-haspopup="menu"
            onClick={(event) => {
              const box = event.currentTarget.getBoundingClientRect();
              openMenu(menu, { x: box.left, y: box.bottom + 4 });
            }}
          >
            {menu.label}
          </button>
        ))}
      </nav>
      <h1>{title}</h1>
      <span className="connection-status" title={adapterName}>
        <span className={`connection-dot ${connected ? 'online' : ''}`} />
        <span>{connected ? '已连接' : '重连中'}</span>
        <small>{adapterName}</small>
      </span>
    </header>
  );
}
