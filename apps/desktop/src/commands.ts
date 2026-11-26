import type { NativeCapabilities } from '@cc-desk-tunnel/protocol';
import type { T } from './i18n.ts';

// A Claude Code command offered after "/" in the message box. It is sent as the message itself, as the CLI takes it.
export type SlashCommand = { name: string; description: string; argumentHint: string };

// Commands this window does with its own controls (compacting, the model and effort, approvals, the account, the
// title, settings), those that would put the CLI in another session than this one, and Claude Code's own for
// sessions its servers launch. They are for Claude Code's own terminal; the CLI also names the commands bound to
// its terminal, which the service leaves out already. Names starting with "__" are the CLI's internal ones.
const hidden = new Set([
  'compact',
  'model',
  'effort',
  'fast',
  'permissions',
  'login',
  'logout',
  'config',
  'autocompact',
  'rename',
  'clear',
  'resume',
  'exit',
  'quit',
  'workflow-launch-exec',
]);
// The everyday ones come first and are said in the window's words (session:command.*); the rest keep Claude Code's
// own.
const everyday = ['review', 'security-review', 'context', 'usage', 'init'] as const;
const isEveryday = (name: string): name is (typeof everyday)[number] =>
  (everyday as readonly string[]).includes(name);

// The commands whose name, or one of whose other names, starts with what follows the slash; then those that only
// contain it.
export function slashCommands(
  t: T,
  capabilities: NativeCapabilities | null,
  typed: string,
): SlashCommand[] {
  const query = typed.toLowerCase();
  const details =
    capabilities?.commandDetails ??
    (capabilities?.commands ?? []).map((name) => ({
      name,
      description: '',
      argumentHint: '',
      aliases: undefined,
    }));
  const rank = (name: string) => (isEveryday(name) ? everyday.indexOf(name) : everyday.length);
  const found = details
    .filter((command) => !hidden.has(command.name) && !command.name.startsWith('__'))
    .map((command) => {
      const names = [command.name, ...(command.aliases ?? [])].map((name) => name.toLowerCase());
      const fit = names.some((name) => name.startsWith(query))
        ? 0
        : names.some((name) => name.includes(query))
          ? 1
          : -1;
      return { command, fit };
    })
    .filter(({ fit }) => fit >= 0);
  return found
    .sort(
      (a, b) =>
        a.fit - b.fit ||
        rank(a.command.name) - rank(b.command.name) ||
        a.command.name.localeCompare(b.command.name),
    )
    .map(({ command }) => ({
      name: command.name,
      description: isEveryday(command.name)
        ? t(`session:command.${command.name}`)
        : command.description,
      argumentHint: command.argumentHint,
    }));
}
