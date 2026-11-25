import { ArrowLeft, ArrowRight, PanelLeft, PanelRight } from 'lucide-react';
import { useT } from './i18n.ts';
import { useConnectionName } from './shared.ts';
import { IconButton } from './ui.tsx';
import type { MenuItem, MenuPosition } from './ui.tsx';

export type BarMenu = { label: string; items: MenuItem[] };

// The window's own top edge: it is the drag handle of the frameless desktop window, and carries the way back,
// the side column's switch, the menus and the state of the connection, named once there are several.
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
  files,
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
  // The file panel's switch, where the window has one.
  files?: { open: boolean; toggle: () => void; hint?: string };
}) {
  const t = useT();
  const connectionName = useConnectionName();
  return (
    <header className="titlebar">
      <IconButton className="history-back" title={t('nav:back')} disabled={!back} onClick={back}>
        <ArrowLeft />
      </IconButton>
      <IconButton
        className="history-button"
        title={t('nav:forward')}
        disabled={!forward}
        onClick={forward}
      >
        <ArrowRight />
      </IconButton>
      <IconButton
        className="sidebar-toggle"
        title={sideOpen ? t('nav:collapseSidebar') : t('nav:expandSidebar')}
        onClick={toggleSide}
      >
        <PanelLeft />
      </IconButton>
      <nav className="titlebar-menus" aria-label={t('nav:menu')}>
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
      {files && (
        <IconButton
          className={`files-toggle ${files.open ? 'active' : ''}`}
          title={
            files.hint
              ? t(files.open ? 'nav:files.closeWith' : 'nav:files.openWith', { hint: files.hint })
              : t(files.open ? 'nav:files.close' : 'nav:files.open')
          }
          aria-pressed={files.open}
          onClick={files.toggle}
        >
          <PanelRight />
        </IconButton>
      )}
      <span
        className="connection-status"
        title={connectionName ? `${connectionName} · ${adapterName}` : adapterName}
      >
        <span className={`connection-dot ${connected ? 'online' : ''}`} />
        {connectionName && <span className="connection-name">{connectionName}</span>}
        <span>{connected ? t('nav:connected') : t('nav:reconnecting')}</span>
        {!connectionName && <small>{adapterName}</small>}
      </span>
    </header>
  );
}
