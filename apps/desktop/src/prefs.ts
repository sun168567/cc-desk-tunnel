import { useSyncExternalStore } from 'react';

// Choices that belong to this computer's window and never reach the service: what is pinned, what a project is
// called here, and which events raise a notification.
export type NotifyKind = 'done' | 'failed' | 'approval' | 'question' | 'schedule' | 'connection';
export type Prefs = {
  pinnedSessions: string[];
  // Projects are named by pathKey().
  pinnedProjects: string[];
  projectNames: Record<string, string>;
  notify: { enabled: boolean; sound: boolean } & Record<NotifyKind, boolean>;
};

const storageKey = 'proxy-prefs';
const defaults: Prefs = {
  pinnedSessions: [],
  pinnedProjects: [],
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
};

function read(): Prefs {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? '{}');
    const strings = (value: unknown) =>
      Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
    return {
      pinnedSessions: strings(saved.pinnedSessions),
      pinnedProjects: strings(saved.pinnedProjects),
      projectNames:
        saved.projectNames && typeof saved.projectNames === 'object' ? saved.projectNames : {},
      notify: { ...defaults.notify, ...(typeof saved.notify === 'object' ? saved.notify : {}) },
    };
  } catch {
    return defaults;
  }
}

let current = read();
const listeners = new Set<() => void>();
export const getPrefs = () => current;
export function setPrefs(change: (prefs: Prefs) => Prefs) {
  current = change(current);
  localStorage.setItem(storageKey, JSON.stringify(current));
  for (const listener of listeners) listener();
}
export const usePrefs = () =>
  useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, getPrefs);

export const toggled = (list: string[], value: string) =>
  list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
