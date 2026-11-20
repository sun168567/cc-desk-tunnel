import type { PermissionMode } from '@cc-desk-tunnel/protocol';

// The names of Claude Code's modes, as the mode menu shows them.
export const modeNames: Record<PermissionMode, string> = {
  auto: '自动审批',
  default: '手动审批',
  acceptEdits: '接受编辑',
  plan: '计划模式',
  bypassPermissions: '绕过权限',
};
// The modes the shortcut goes through in turn. Asking about nothing is chosen only from the menu, after a warning.
const cycled: PermissionMode[] = ['auto', 'default', 'acceptEdits', 'plan'];
export const nextMode = (mode: PermissionMode) =>
  cycled[(cycled.indexOf(mode) + 1) % cycled.length];
