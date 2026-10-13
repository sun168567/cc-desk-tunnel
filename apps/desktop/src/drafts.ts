import { useCallback, useEffect, useRef, useState } from 'react';
import type { Attachment } from './attachments.ts';

// Unsent text is the user's work: it is kept per session and written to disk shortly after every edit,
// so switching sessions, closing the window or a crash does not lose it.
export type Draft = { text: string; attachments: Attachment[] };
export type Drafts = Record<string, Draft>;
const storageKey = 'proxy-drafts';
const delay = 300;

function clean(value: unknown): Drafts {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([id, raw]) => {
      const draft = typeof raw === 'string' ? { text: raw, attachments: [] } : raw;
      if (!draft || typeof draft !== 'object' || typeof draft.text !== 'string') return [];
      const attachments = Array.isArray(draft.attachments) ? draft.attachments.filter((item: Attachment) => item && typeof item.path === 'string').slice(0, 40).map((item: Attachment) => ({ path: item.path })) : [];
      return draft.text || attachments.length ? [[id, { text: draft.text, attachments }]] : [];
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
    (sessionId: string, value: string | Draft | ((previous: Draft) => Draft)) => change((current) => ({ ...current, [sessionId]: typeof value === 'function' ? value(current[sessionId] ?? { text: '', attachments: [] }) : typeof value === 'string' ? { text: value, attachments: current[sessionId]?.attachments ?? [] } : value })),
    [change],
  );
  return [drafts, setDraft] as const;
}
