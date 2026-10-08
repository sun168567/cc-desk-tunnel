import { CalendarClock, Download, MessagesSquare, Settings } from 'lucide-react';
import type { MenuPosition } from './ui.tsx';

export type Page = 'chat' | 'schedules' | 'settings';

// The narrow column of pages at the window's left edge. The update button is there only when there is
// something to install.
export default function Rail({
  page,
  go,
  update,
  openUpdate,
  openSettings,
}: {
  page: Page;
  go: (page: Page) => void;
  update: string | null;
  openUpdate: (position: MenuPosition) => void;
  openSettings: (position: MenuPosition) => void;
}) {
  const beside = (element: HTMLElement): MenuPosition => {
    const box = element.getBoundingClientRect();
    return { x: box.right + 6, y: box.bottom, above: true };
  };
  return (
    <nav className="rail" aria-label="页面">
      <button
        type="button"
        title="会话"
        aria-label="会话"
        aria-current={page === 'chat' ? 'page' : undefined}
        onClick={() => go('chat')}
      >
        <MessagesSquare />
      </button>
      <button
        type="button"
        title="定时任务"
        aria-label="定时任务"
        aria-current={page === 'schedules' ? 'page' : undefined}
        onClick={() => go('schedules')}
      >
        <CalendarClock />
      </button>
      <span className="rail-space" />
      {update && (
        <button
          type="button"
          className="rail-update"
          title={update}
          aria-label="更新"
          aria-haspopup="menu"
          onClick={(event) => openUpdate(beside(event.currentTarget))}
        >
          <Download />
        </button>
      )}
      <button
        type="button"
        title="设置与账号"
        aria-label="设置与账号"
        aria-haspopup="menu"
        aria-current={page === 'settings' ? 'page' : undefined}
        onClick={(event) => openSettings(beside(event.currentTarget))}
      >
        <Settings />
      </button>
    </nav>
  );
}
