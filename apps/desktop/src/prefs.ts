import { useSyncExternalStore } from 'react';
import { defaultQuotaLimits, readQuotaLimits } from './quota.ts';
import type { QuotaLimits } from './quota.ts';
import { onSharedChange, saveShared, shareOnce, shared } from './shared.ts';

// Choices that belong to this computer and never reach the service: what is pinned, what a project is called
// here, which events raise a notification, and the keyboard shortcuts. The windows of the computer's
// connections share them (see shared.ts).
export type NotifyKind = 'done' | 'failed' | 'approval' | 'question' | 'schedule' | 'connection';
export type ThemeMode = 'system' | 'dark' | 'light';
export type InterfaceFont = 'system' | 'serif';
export type TextSize = 'small' | 'medium' | 'large';
export type TranscriptWidth = 'narrow' | 'medium' | 'wide';
// How many seconds each step of connecting may take. The defaults suit most computers; a domain account whose
// domain controller is out of reach, or slow security software, can need more.
export type ConnectionWaits = { connect: number; ssh: number; ready: number };
export const connectionWaits: ConnectionWaits = { connect: 15, ssh: 10, ready: 45 };
export const waitRange = { min: 5, max: 600 };
export type Prefs = {
  pinnedSessions: string[];
  // Projects are named by pathKey().
  pinnedProjects: string[];
  // Projects whose sessions are folded away in the sidebar.
  collapsedProjects: string[];
  // Whether the sessions on the user's other computers are listed in the sidebar.
  elsewhereOpen: boolean;
  projectNames: Record<string, string>;
  notify: { enabled: boolean; sound: boolean } & Record<NotifyKind, boolean>;
  // `keys` holds only what the user changed, by action; an empty combination means none.
  shortcuts: { enabled: boolean; keys: Record<string, string> };
  connection: ConnectionWaits;
  // Whether the approval modes include the one that asks about nothing.
  bypassPermissions: boolean;
  // Theme appearance: follow operating system, or force dark or light.
  theme: ThemeMode;
  interfaceFont: InterfaceFont;
  codeFont: string;
  textSize: TextSize;
  transcriptWidth: TranscriptWidth;
  // The line under each reply. `summary` holds only the figures the user switched on or off, by key, so a figure
  // added later follows its own default.
  stats: { enabled: boolean; summary: Record<string, boolean> };
  // Whether the quota used is shown beside the message box.
  quota: boolean;
  // Percents of the official 5-hour and weekly windows. This computer stops sending; it does not ask the service.
  quotaLimits: QuotaLimits;
};

const storageKey = 'proxy-prefs';
const defaults: Prefs = {
  pinnedSessions: [],
  pinnedProjects: [],
  collapsedProjects: [],
  elsewhereOpen: false,
  projectNames: {},
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
  theme: 'system',
  interfaceFont: 'system',
  codeFont: '',
  textSize: 'medium',
  transcriptWidth: 'medium',
  stats: { enabled: false, summary: {} },
  quota: false,
  quotaLimits: defaultQuotaLimits,
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
      projectNames:
        saved.projectNames && typeof saved.projectNames === 'object' ? saved.projectNames : {},
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
      theme: saved.theme === 'dark' || saved.theme === 'light' ? saved.theme : 'system',
      interfaceFont: saved.interfaceFont === 'serif' ? 'serif' : 'system',
      codeFont: typeof saved.codeFont === 'string' ? saved.codeFont : '',
      textSize:
        saved.textSize === 'small' || saved.textSize === 'large' ? saved.textSize : 'medium',
      transcriptWidth:
        saved.transcriptWidth === 'narrow' || saved.transcriptWidth === 'wide'
          ? saved.transcriptWidth
          : 'medium',
      quota: saved.quota === true,
      quotaLimits: readQuotaLimits(
        saved.quotaLimits ??
          (saved.quota && typeof saved.quota === 'object' ? saved.quota : undefined),
      ),
      stats: {
        enabled: saved.stats?.enabled === true,
        summary: Object.fromEntries(
          Object.entries(saved.stats?.summary ?? {}).filter(
            (entry): entry is [string, boolean] => typeof entry[1] === 'boolean',
          ),
        ),
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
export const usePrefs = () =>
  useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, getPrefs);

export const toggled = (list: string[], value: string) =>
  list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
