import { useSyncExternalStore } from 'react';
import { isLanguageChoice } from '@cc-desk-tunnel/i18n';
import type { LanguageChoice } from '@cc-desk-tunnel/i18n';
import { onSharedChange, saveShared, shareOnce, shared } from './shared.ts';
import { defaultView, viewModes } from './transcriptView.ts';
import type { TranscriptView } from './transcriptView.ts';

// Choices that belong to this computer and never reach the service: what is pinned and folded, which events raise
// a notification, and the keyboard shortcuts. The windows of the computer's
// connections share them (see shared.ts).
export type NotifyKind = 'done' | 'failed' | 'approval' | 'question' | 'schedule' | 'connection';
import { connectionWaits, waitRange } from './setting-fields.ts';
import type { ConnectionWaits } from './setting-fields.ts';
export { connectionWaits, waitRange };
export type { ConnectionWaits };
// The colours: the system's light or dark, or always one of them. The page shows the choice as `data-theme` on
// its root (see main.tsx and the top of style.css), and the desktop window's own parts follow it (main.cjs).
export const themes = ['system', 'light', 'dark'] as const;
export type Theme = (typeof themes)[number];
export type Prefs = {
  pinnedSessions: string[];
  // Projects are named by pathKey().
  pinnedProjects: string[];
  // Projects whose sessions are folded away in the sidebar.
  collapsedProjects: string[];
  // Whether the sessions on the user's other computers are listed in the sidebar.
  elsewhereOpen: boolean;
  // Which of the other computers, and which folders on them, are folded away: a computer by its id, a folder by
  // the computer's id, a line break and the folder's pathKey(), and the sessions with no project by the
  // computer's id and a line break.
  collapsedElsewhere: string[];
  notify: { enabled: boolean; sound: boolean } & Record<NotifyKind, boolean>;
  // `keys` holds only what the user changed, by action; an empty combination means none.
  shortcuts: { enabled: boolean; keys: Record<string, string> };
  connection: ConnectionWaits;
  // Whether the approval modes include the one that asks about nothing.
  bypassPermissions: boolean;
  // The line under each reply. `summary` holds only the figures the user switched on or off, by key, so a figure
  // added later follows its own default.
  stats: { enabled: boolean; summary: Record<string, boolean> };
  // Whether the quota used is shown beside the message box.
  quota: boolean;
  // Whether the service is to keep the plan quota current while runs go on, reading it once a minute; off, the
  // quota shown is what the replies carry (see `quota.watch`).
  quotaReads: boolean;
  // How much of the work behind a reply is shown.
  view: TranscriptView;
  // The strip under the input box with the whole session's figures; chosen the same way.
  sessionBar: { enabled: boolean; summary: Record<string, boolean> };
  theme: Theme;
  // The language of the window, its menus and dialogs: the system's, or one chosen here (see i18n.ts).
  language: LanguageChoice;
  // The file panel beside the conversation: whether it is open, and how wide the user made it.
  filePanel: { open: boolean; width: number };
};

const storageKey = 'proxy-prefs';
const defaults: Prefs = {
  pinnedSessions: [],
  pinnedProjects: [],
  collapsedProjects: [],
  elsewhereOpen: false,
  collapsedElsewhere: [],
  notify: {
    enabled: true,
    sound: true,
    done: true,
    failed: true,
    approval: true,
    question: true,
    schedule: true,
    connection: true,
  },
  shortcuts: { enabled: true, keys: {} },
  connection: connectionWaits,
  bypassPermissions: false,
  stats: { enabled: false, summary: {} },
  quota: false,
  quotaReads: true,
  view: defaultView,
  sessionBar: { enabled: false, summary: {} },
  theme: 'system',
  language: 'system',
  filePanel: { open: false, width: 420 },
};

function stored(): unknown {
  try {
    return JSON.parse(localStorage.getItem(storageKey) ?? '{}');
  } catch {
    return {};
  }
}
function read(saved: any = shared('prefs') ?? stored()): Prefs {
  try {
    if (!saved || typeof saved !== 'object') return defaults;
    const strings = (value: unknown) =>
      Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
    return {
      pinnedSessions: strings(saved.pinnedSessions),
      pinnedProjects: strings(saved.pinnedProjects),
      collapsedProjects: strings(saved.collapsedProjects),
      elsewhereOpen: saved.elsewhereOpen === true,
      collapsedElsewhere: strings(saved.collapsedElsewhere),
      notify: { ...defaults.notify, ...(typeof saved.notify === 'object' ? saved.notify : {}) },
      shortcuts: {
        enabled: saved.shortcuts?.enabled !== false,
        keys: Object.fromEntries(
          Object.entries(saved.shortcuts?.keys ?? {}).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string',
          ),
        ),
      },
      connection: Object.fromEntries(
        Object.entries(connectionWaits).map(([step, seconds]) => {
          const value = saved.connection?.[step];
          return [
            step,
            Number.isInteger(value) && value >= waitRange.min && value <= waitRange.max
              ? value
              : seconds,
          ];
        }),
      ) as ConnectionWaits,
      bypassPermissions: saved.bypassPermissions === true,
      quota: saved.quota === true,
      quotaReads: saved.quotaReads !== false,
      view: {
        mode: viewModes.find((mode) => mode === saved.view?.mode) ?? defaultView.mode,
      },
      stats: {
        enabled: saved.stats?.enabled === true,
        summary: Object.fromEntries(
          Object.entries(saved.stats?.summary ?? {}).filter(
            (entry): entry is [string, boolean] => typeof entry[1] === 'boolean',
          ),
        ),
      },
      sessionBar: {
        enabled: saved.sessionBar?.enabled === true,
        summary: Object.fromEntries(
          Object.entries(saved.sessionBar?.summary ?? {}).filter(
            (entry): entry is [string, boolean] => typeof entry[1] === 'boolean',
          ),
        ),
      },
      theme: themes.find((theme) => theme === saved.theme) ?? defaults.theme,
      language: isLanguageChoice(saved.language) ? saved.language : defaults.language,
      filePanel: {
        open: saved.filePanel?.open === true,
        width:
          Number.isFinite(saved.filePanel?.width) && saved.filePanel.width >= 280
            ? Math.min(saved.filePanel.width, 3000)
            : defaults.filePanel.width,
      },
    };
  } catch {
    return defaults;
  }
}

let current = read();
shareOnce('prefs', current);
const listeners = new Set<() => void>();
export const getPrefs = () => current;
function keep(next: Prefs) {
  current = next;
  localStorage.setItem(storageKey, JSON.stringify(current));
  for (const listener of listeners) listener();
}
export function setPrefs(change: (prefs: Prefs) => Prefs) {
  keep(change(current));
  saveShared('prefs', current);
}
onSharedChange('prefs', (value) => keep(read(value)));
export function onPrefs(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export const usePrefs = () => useSyncExternalStore(onPrefs, getPrefs);

export const toggled = (list: string[], value: string) =>
  list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
