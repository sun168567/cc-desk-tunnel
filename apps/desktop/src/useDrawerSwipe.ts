import { useRef } from 'react';
import type { MouseEvent, PointerEvent } from 'react';

export function useDrawerSwipe(enabled: boolean, open: boolean, change: (open: boolean) => void) {
  const swipe = useRef<{
    id: number;
    x: number;
    y: number;
    width: number;
    at: number;
    open: boolean;
    dragging: boolean;
  } | null>(null);
  const suppressClick = useRef(false);
  function finish(event: PointerEvent<HTMLDivElement>, cancelled = false) {
    const start = swipe.current;
    if (!start || start.id !== event.pointerId) return;
    swipe.current = null;
    if (!start.dragging) return;
    const dx = event.clientX - start.x;
    const moved =
      Math.abs(dx) > start.width * 0.3 || (Math.abs(dx) > 40 && event.timeStamp - start.at < 300);
    suppressClick.current = true;
    change(!cancelled && moved ? dx > 0 : start.open);
    delete event.currentTarget.dataset.drawerDrag;
    event.currentTarget.style.removeProperty('--drawer-x');
    event.currentTarget.style.removeProperty('--drawer-progress');
  }
  return {
    onPointerDown(event: PointerEvent<HTMLDivElement>) {
      suppressClick.current = false;
      if (!enabled || !event.isPrimary || event.button !== 0) return;
      if (
        !(event.target instanceof Element) ||
        !event.target.closest(open ? '.rail, .sidebar, .sidebar-shade' : '.workspace, .titlebar') ||
        event.target.closest('input, textarea, [contenteditable], pre, table, .katex-display')
      )
        return;
      const width = event.currentTarget.querySelector('.rail')!.getBoundingClientRect().width;
      swipe.current = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        width,
        at: event.timeStamp,
        open,
        dragging: false,
      };
    },
    onPointerMove(event: PointerEvent<HTMLDivElement>) {
      const start = swipe.current;
      if (!start || start.id !== event.pointerId) return;
      const dx = event.clientX - start.x;
      const dy = event.clientY - start.y;
      if (!start.dragging) {
        if ((!start.open && dx < -8) || (Math.abs(dy) > 8 && Math.abs(dy) > Math.abs(dx))) {
          swipe.current = null;
          return;
        }
        if (Math.abs(dx) < 8 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
        start.dragging = true;
        event.currentTarget.setPointerCapture(event.pointerId);
        event.currentTarget.dataset.drawerDrag = '';
      }
      event.preventDefault();
      const x = Math.max(-start.width, Math.min(0, (start.open ? 0 : -start.width) + dx));
      event.currentTarget.style.setProperty('--drawer-x', `${x}px`);
      event.currentTarget.style.setProperty('--drawer-progress', String(1 + x / start.width));
    },
    onPointerUp: finish,
    onPointerCancel: (event: PointerEvent<HTMLDivElement>) => finish(event, true),
    onLostPointerCapture(event: PointerEvent<HTMLDivElement>) {
      if (event.target === event.currentTarget) finish(event, true);
    },
    onClickCapture(event: MouseEvent<HTMLDivElement>) {
      if (!suppressClick.current) return;
      event.preventDefault();
      event.stopPropagation();
      suppressClick.current = false;
    },
  };
}
