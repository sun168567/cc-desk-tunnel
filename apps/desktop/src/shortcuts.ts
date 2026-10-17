import { isMac as desktopIsMac } from './platform.ts';
import type { Prefs } from './prefs.ts';

// Browser shortcuts follow the keyboard in front of the user, not the remote execution host.
const isMac =
  typeof window !== 'undefined' && (!window.desktop || window.desktop.remote)
    ? typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform)
    : desktopIsMac;

// The window's keyboard shortcuts. They act only on key presses that reach this window while it is in front —
// nothing is registered with the system — and the user can change each one or turn them all off.
export type Action =
  | 'back'
  | 'forward'
  | 'toggleSide'
  | 'newSession'
  | 'settings'
  | 'find'
  | 'zoomIn'
  | 'zoomOut'
  | 'zoomReset';
// `desktop` marks what only the desktop window does; a browser has its own zoom.
export const actions: { id: Action; name: string; desktop?: boolean }[] = [
  { id: 'back', name: '后退' },
  { id: 'forward', name: '前进' },
  { id: 'toggleSide', name: '收起或展开侧栏' },
  { id: 'newSession', name: '新建会话' },
  { id: 'settings', name: '打开设置' },
  { id: 'find', name: '查找对话内容' },
  { id: 'zoomIn', name: '放大界面', desktop: true },
  { id: 'zoomOut', name: '缩小界面', desktop: true },
  { id: 'zoomReset', name: '恢复界面大小', desktop: true },
];
const defaults: Record<Action, string> = {
  back: 'Alt+ArrowLeft',
  forward: 'Alt+ArrowRight',
  toggleSide: 'Ctrl+KeyB',
  newSession: 'Ctrl+KeyN',
  settings: 'Ctrl+Comma',
  find: 'Ctrl+KeyF',
  zoomIn: 'Ctrl+Equal',
  zoomOut: 'Ctrl+Minus',
  zoomReset: 'Ctrl+Digit0',
};
// On macOS the key of commands is Command, which a key press names `Win` here as on any keyboard. Option
// with an arrow moves through text there, so going back and forward take the brackets, as in its browsers.
const macDefaults = {
  ...(Object.fromEntries(
    Object.entries(defaults).map(([action, combo]) => [action, combo.replace('Ctrl+', 'Win+')]),
  ) as Record<Action, string>),
  back: 'Win+BracketLeft',
  forward: 'Win+BracketRight',
};
// The combination an action answers to: the user's own, or the default; empty when the user removed it.
export const keyFor = (prefs: Prefs, action: Action) =>
  prefs.shortcuts.keys[action] ?? (isMac ? macDefaults : defaults)[action];

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
  Space: '空格',
};
export const show = (combo: string) =>
  combo
    .split('+')
    .map((part) => names[part] ?? part.replace(/^(Key|Digit)/, ''))
    .join('+');
