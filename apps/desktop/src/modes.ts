import type { PermissionMode } from '@cc-desk-tunnel/protocol';
import type { T } from './i18n.ts';

// The names of Claude Code's modes as the mode menu shows them, and what each asks the user for.
export const modeName = (t: T, mode: PermissionMode) => t(`session:mode.${mode}.name`);
export const modeDetail = (t: T, mode: PermissionMode) => t(`session:mode.${mode}.detail`);
// The modes the shortcut goes through in turn. Asking about nothing is chosen only from the menu, after a warning.
const cycled: PermissionMode[] = ['auto', 'default', 'acceptEdits', 'plan'];
export const nextMode = (mode: PermissionMode) =>
  cycled[(cycled.indexOf(mode) + 1) % cycled.length];
