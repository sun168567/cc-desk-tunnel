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
  'run.task.background',
  'approval.reply',
  'usage.summary',
  'usage.query',
  'quota.watch',
  'account.status',
  'compaction.get',
  // Push channels as the desktop sets them: what one sends with is read back by no window, and whoever holds a
  // browser's login can run commands on the user's computers already.
  'push.get',
  'push.update',
  'push.channel.add',
  'push.channel.update',
  'push.channel.enable',
  'push.channel.delete',
  'push.test',
  'session.push',
  'web.settings.get',
  'web.settings.update',
  'web.sessions.revoke',
  'web.totp.setup',
  'web.totp.enable',
  'web.totp.disable',
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
  'run.task.background',
  'approval.reply',
  'push.update',
  'push.channel.add',
  'push.channel.update',
  'push.channel.enable',
  'push.channel.delete',
  'push.test',
  'session.push',
  'web.settings.update',
  'web.sessions.revoke',
  'web.totp.setup',
  'web.totp.enable',
  'web.totp.disable',
]);

// Web settings, browser logins and the domain certificate are answered by WebAccess.
export const isWebCommand = (
  command: Command,
): command is Extract<Command, { type: `web.${string}` }> => command.type.startsWith('web.');
