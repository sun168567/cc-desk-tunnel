import { useEffect, useRef } from 'react';
import type { Page } from './Rail.tsx';
import type { Section } from './SettingsPage.tsx';

export type Place = {
  page: Page;
  section: Section;
  sessionId: string | null;
  settingsIndex?: boolean;
};
type Entry = { place: Place; index: number; drawer?: boolean; furthest?: number };
const same = (a: Place, b: Place) =>
  a.page === b.page &&
  a.section === b.section &&
  a.sessionId === b.sessionId &&
  !!a.settingsIndex === !!b.settingsIndex;

// Only navigation metadata goes in history; content and credentials stay out of it.
export function useWebNavigation(
  enabled: boolean,
  initial: Place,
  apply: (place: Place, drawer: boolean, direction?: number) => void,
) {
  const current = useRef<Entry>({ place: initial, index: 0 });
  const furthest = useRef(0);
  const pending = useRef(false);
  const queued = useRef<(() => void) | null>(null);
  const restore = useRef(apply);
  restore.current = apply;
  useEffect(() => {
    if (!enabled) return;
    const saved: Entry | undefined = window.history.state?.ccDesk;
    if (saved) {
      current.current = saved;
      furthest.current = saved.furthest ?? saved.index;
      restore.current(saved.place, !!saved.drawer);
    } else {
      window.history.replaceState({ ...window.history.state, ccDesk: current.current }, '');
    }
    const pop = (event: PopStateEvent) => {
      pending.current = false;
      const entry: Entry | undefined = event.state?.ccDesk;
      if (entry) {
        furthest.current = Math.max(furthest.current, entry.index);
        write(entry, true, Math.sign(entry.index - current.current.index));
      }
      const next = queued.current;
      queued.current = null;
      next?.();
    };
    window.addEventListener('popstate', pop);
    return () => window.removeEventListener('popstate', pop);
  }, [enabled]);

  function write(entry: Entry, replace = false, direction = 0) {
    if (!replace) furthest.current = entry.index;
    entry = { ...entry, furthest: furthest.current };
    window.history[replace ? 'replaceState' : 'pushState'](
      { ...window.history.state, ccDesk: entry },
      '',
    );
    current.current = entry;
    restore.current(entry.place, !!entry.drawer, direction);
  }
  function step(by: number) {
    if (pending.current || !canStep(by)) return;
    pending.current = true;
    window.history.go(by);
  }
  function drawer(open: boolean) {
    if (pending.current) {
      queued.current = () => drawer(open);
      return;
    }
    const entry = current.current;
    if (!!entry.drawer === open) return;
    if (open) write({ ...entry, index: entry.index + 1, drawer: true });
    else step(-1);
  }
  function visit(place: Place) {
    if (pending.current) {
      queued.current = () => visit(place);
      return;
    }
    const entry = current.current;
    if (same(entry.place, place)) {
      drawer(false);
      return;
    }
    write({ place, index: entry.index + (entry.drawer ? 0 : 1) }, !!entry.drawer);
  }
  function canStep(by: number) {
    return by < 0 ? current.current.index > 0 : current.current.index < furthest.current;
  }
  return { visit, drawer, step, canStep };
}
