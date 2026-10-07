import { useCallback, useEffect, useRef, useState } from 'react';

// Unsent text is the user's work: it is kept per session and written to disk shortly after every edit,
// so switching sessions, closing the window or a crash does not lose it.
export type Drafts = Record<string, string>;
const storageKey = 'proxy-drafts';
const delay = 300;

function clean(value: unknown): Drafts {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => {
      return typeof entry[1] === 'string' && entry[1] !== '';
    }),
  );
}
async function load(): Promise<Drafts> {
  try {
    if (window.desktop) return clean(await window.desktop.loadDrafts());
    return clean(JSON.parse(localStorage.getItem(storageKey) ?? '{}'));
  } catch {
    return {};
  }
}
function store(drafts: Drafts) {
  if (window.desktop) void window.desktop.saveDrafts(drafts).catch(() => {});
  else localStorage.setItem(storageKey, JSON.stringify(drafts));
}

export function useDrafts() {
  const [drafts, setDrafts] = useState<Drafts>({});
  const latest = useRef(drafts);
  const loaded = useRef(false);
  const pending = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const flush = useCallback(() => {
    if (pending.current === undefined) return;
    clearTimeout(pending.current);
    pending.current = undefined;
    store(latest.current);
  }, []);
  const change = useCallback(
    (update: (drafts: Drafts) => Drafts) => {
      setDrafts((current) => {
        const next = clean(update(current));
        latest.current = next;
        return next;
      });
      // Nothing is written before the saved drafts are read, or they would be replaced by a partial set.
      if (!loaded.current) return;
      clearTimeout(pending.current);
      pending.current = setTimeout(flush, delay);
    },
    [flush],
  );
  useEffect(() => {
    void load().then((saved) => {
      loaded.current = true;
      // Text typed while the saved drafts were being read wins over what was saved.
      change((current) => ({ ...saved, ...current }));
    });
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, [change, flush]);
  const setDraft = useCallback(
    (sessionId: string, text: string) => change((current) => ({ ...current, [sessionId]: text })),
    [change],
  );
  return [drafts, setDraft] as const;
}
