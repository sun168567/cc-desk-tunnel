import { CalendarClock, CircleHelp, Download, MessagesSquare, Settings } from 'lucide-react';
import { useT } from './i18n.ts';
import type { MenuPosition } from './ui.tsx';

export type Page = 'chat' | 'schedules' | 'settings' | 'help';

// The narrow column of pages at the window's left edge. The update button is there only when there is
// something to install.
export default function Rail({
  page,
  schedules = true,
  go,
  update,
  openUpdate,
  openSettings,
}: {
  page: Page;
  schedules?: boolean;
  go: (page: Page) => void;
  update: string | null;
  openUpdate: (position: MenuPosition) => void;
  openSettings: (position: MenuPosition) => void;
}) {
  const t = useT();
  const beside = (element: HTMLElement): MenuPosition => {
    const box = element.getBoundingClientRect();
    return { x: box.right + 6, y: box.bottom, above: true };
  };
  return (
    <nav className="rail" aria-label={t('nav:pages')}>
      <button
        type="button"
        title={t('nav:page.sessions')}
        aria-label={t('nav:page.sessions')}
        aria-current={page === 'chat' ? 'page' : undefined}
        onClick={() => go('chat')}
      >
        <MessagesSquare />
      </button>
      {schedules && (
        <button
          type="button"
          title={t('nav:page.schedules')}
          aria-label={t('nav:page.schedules')}
          aria-current={page === 'schedules' ? 'page' : undefined}
          onClick={() => go('schedules')}
        >
          <CalendarClock />
        </button>
      )}
      <span className="rail-space" />
      {update && (
        <button
          type="button"
          className="rail-update"
          title={update}
          aria-label={t('nav:page.update')}
          aria-haspopup="menu"
          onClick={(event) => openUpdate(beside(event.currentTarget))}
        >
          <Download />
        </button>
      )}
      <button
        type="button"
        title={t('nav:page.help')}
        aria-label={t('nav:page.help')}
        aria-current={page === 'help' ? 'page' : undefined}
        onClick={() => go('help')}
      >
        <CircleHelp />
      </button>
      <button
        type="button"
        title={t('nav:page.settings')}
        aria-label={t('nav:page.settings')}
        aria-haspopup="menu"
        aria-current={page === 'settings' ? 'page' : undefined}
        onClick={(event) => openSettings(beside(event.currentTarget))}
      >
        <Settings />
      </button>
    </nav>
  );
}
