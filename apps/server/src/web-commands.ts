import type { Command } from '@cc-desk-tunnel/protocol';

// New protocol commands stay desktop-only until explicitly admitted here.
export const browserCommands = new Set<Command['type']>([
  'server.session.create',
  'session.subscribe',
  'session.history',
  'session.status',
  'session.stats',
  'session.rename',
  'session.delete',
  'session.configure',
  'session.compact',
  'message.send',
  'run.cancel',
  'run.continue',
  'run.task.stop',
  'approval.reply',
  'terminal.open',
  'terminal.close',
  'usage.summary',
  'usage.query',
  'account.status',
  'web.settings.get',
  'web.settings.update',
  'web.sessions.revoke',
  'web.totp.setup',
  'web.totp.enable',
  'web.totp.disable',
  'web.passkeys.start',
  'web.passkeys.status',
  'web.passkeys.cancel',
  'web.passkeys.rename',
  'web.passkeys.remove',
]);

// What a browser changes is its user's doing; reading is told apart by the page with \web.activity\.
export const browserActivity = new Set<Command['type']>([
  'server.session.create',
  'session.rename',
  'session.delete',
  'session.configure',
  'session.compact',
  'message.send',
  'run.cancel',
  'run.continue',
  'run.task.stop',
  'approval.reply',
  'terminal.open',
  'terminal.close',
  'web.settings.update',
  'web.sessions.revoke',
  'web.totp.setup',
  'web.totp.enable',
  'web.totp.disable',
  'web.passkeys.start',
  'web.passkeys.rename',
  'web.passkeys.remove',
]);

// Web settings, browser logins and the domain certificate are answered by WebAccess.
export const isWebCommand = (
  command: Command,
): command is Extract<Command, { type: `web.${string}` }> => command.type.startsWith('web.');
