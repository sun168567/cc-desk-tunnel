import { useSyncExternalStore } from 'react';

// What all of this computer's connections have in common. Each connection is a window of its own with its own
// profile (see electron/connections.cjs); these values live outside the profiles, and a change made in one
// window reaches the others within seconds. A browser has one window and shares nothing.
// `label`: the name the user gave, or else the service's address; empty for a window that has not signed in yet.
export type Connection = { id: string; name: string; label: string };
// A connection that has signed in somewhere: `saved` when its token is remembered, `open` when its window runs.
// `url` is empty for a connection an earlier version made that kept no address.
export type Account = Connection & {
  url: string;
  fingerprint: string;
  mode: 'local' | 'remote';
  saved: boolean;
  autoLogin: boolean;
  usedAt: number;
  current: boolean;
  open: boolean;
};
// A running session of a connection and the folder on this computer it works in.
export type Run = { id: string; folder: string };
export type Shared = {
  prefs?: unknown;
  projects?: unknown;
  connections: Connection[];
  // What the other connections have running now, by their names.
  busy: { name: string; runs: Run[] }[];
};

const boot = window.desktop?.boot;
const values: Shared = { connections: [], busy: [], ...boot?.shared };
const listeners = new Set<() => void>();
window.desktop?.onSharedChanged((key, value) => {
  values[key] = value as never;
  for (const listener of listeners) listener();
});
function onShared(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
// Tells of a value another window changed, not of this window's own changes.
export function onSharedChange<K extends keyof Shared>(key: K, take: (value: Shared[K]) => void) {
  return window.desktop?.onSharedChanged((changed, value) => {
    if (changed === key) take(value as Shared[K]);
  });
}
export const shared = <K extends keyof Shared>(key: K) => values[key];
export const useShared = <K extends keyof Shared>(key: K) =>
  useSyncExternalStore(onShared, () => values[key]);
export function saveShared(key: 'prefs' | 'projects', value: unknown) {
  values[key] = value;
  void window.desktop?.saveShared(key, value).catch(() => {});
}
// The first connection had these values to itself before they were shared, and brings them along.
export function shareOnce(key: 'prefs' | 'projects', value: unknown) {
  if (boot?.connection === '' && values[key] === undefined) saveShared(key, value);
}
// Two addresses are one service when they name the same place; see `serviceKey` in electron/connections.cjs.
export function serviceKey(url: string) {
  const text = url.trim();
  try {
    return new URL(text).href;
  } catch {
    return text;
  }
}
// The connection's name or service, once there are several to tell apart.
export function useConnectionName() {
  const connections = useShared('connections');
  return connections.filter((entry) => entry.label).length > 1
    ? (connections.find((entry) => entry.id === boot?.connection)?.label ?? '')
    : '';
}
