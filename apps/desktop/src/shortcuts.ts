import type { T } from './i18n.ts';
import { isMac } from './platform.ts';
import type { Prefs } from './prefs.ts';

// The window's keyboard shortcuts. They act only on key presses that reach this window while it is in front —
// nothing is registered with the system — and the user can change each one or turn them all off.
export type Action =
  | 'back'
  | 'forward'
  | 'toggleSide'
  | 'newSession'
  | 'settings'
  | 'find'
  | 'cycleMode'
  | 'toggleFiles'
  | 'zoomIn'
  | 'zoomOut'
  | 'zoomReset';
// `desktop` marks what only the desktop window does; a browser has its own zoom. Each is named by
// settings:shortcut.action.<id> (actionName).
export const actions: { id: Action; desktop?: boolean }[] = [
  { id: 'back' },
  { id: 'forward' },
  { id: 'toggleSide' },
  { id: 'newSession' },
  { id: 'settings' },
  { id: 'find' },
  { id: 'cycleMode' },
  { id: 'toggleFiles', desktop: true },
  { id: 'zoomIn', desktop: true },
  { id: 'zoomOut', desktop: true },
  { id: 'zoomReset', desktop: true },
];
export const actionName = (t: T, action: Action) => t(`settings:shortcut.action.${action}`);
// On macOS the key of commands is Command, which a key press names `Win` here as on any keyboard. Option with an
// arrow moves through text there, so going back and forward take the brackets, as in its browsers. Each default is
// written in the order comboOf records a key press in, or a press of it would not match.
const command = isMac ? 'Win' : 'Ctrl';
const defaults: Record<Action, string> = {
  back: isMac ? 'Win+BracketLeft' : 'Alt+ArrowLeft',
  forward: isMac ? 'Win+BracketRight' : 'Alt+ArrowRight',
  toggleSide: `${command}+KeyB`,
  newSession: `${command}+KeyN`,
  settings: `${command}+Comma`,
  find: `${command}+KeyF`,
  cycleMode: 'Alt+Shift+KeyM',
  toggleFiles: isMac ? 'Shift+Win+KeyE' : 'Ctrl+Shift+KeyE',
  zoomIn: `${command}+Equal`,
  zoomOut: `${command}+Minus`,
  zoomReset: `${command}+Digit0`,
};
// The combination an action answers to: the user's own, or the default; empty when the user removed it.
export const keyFor = (prefs: Prefs, action: Action) =>
  prefs.shortcuts.keys[action] ?? defaults[action];

const numpad: Record<string, string> = {
  NumpadAdd: 'Equal',
  NumpadSubtract: 'Minus',
  Numpad0: 'Digit0',
};
// A key press as a combination, named by the physical key so that an input method or a keyboard layout does
// not change it. Null while only modifier keys are down.
export function comboOf(event: KeyboardEvent | React.KeyboardEvent) {
  if (/^(Control|Shift|Alt|Meta|OS)/.test(event.code) || !event.code) return null;
  return [
    event.ctrlKey && 'Ctrl',
    event.altKey && 'Alt',
    event.shiftKey && 'Shift',
    event.metaKey && 'Win',
    numpad[event.code] ?? event.code,
  ]
    .filter(Boolean)
    .join('+');
}
// A combination that would get in the way of typing is not accepted: it needs Ctrl, Alt or a function key.
export const usable = (combo: string) => /(^|\+)(Ctrl|Alt|Win|F\d{1,2})(\+|$)/.test(combo);

const names: Record<string, string> = {
  ...(isMac ? { Win: '⌘', Alt: '⌥' } : {}),
  Equal: '=',
  Minus: '-',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Backquote: '`',
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
};
// A combination as it is written for the user; the space bar is named in the window's language.
export const show = (t: T, combo: string) =>
  combo
    .split('+')
    .map((part) =>
      part === 'Space'
        ? t('settings:shortcut.space')
        : (names[part] ?? part.replace(/^(Key|Digit)/, '')),
    )
    .join('+');
