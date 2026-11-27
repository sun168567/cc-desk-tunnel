import {
  BellRing,
  Bot,
  Brain,
  CalendarClock,
  CircleHelp,
  Compass,
  Download,
  FolderTree,
  Gauge,
  Hourglass,
  Laptop,
  Lock,
  MessagesSquare,
  MonitorSmartphone,
  Moon,
  Network,
  NotebookPen,
  Plug,
  Rocket,
  Server,
  Settings,
  ShieldAlert,
  ShieldCheck,
  SquareTerminal,
  UserRound,
  Wifi,
} from 'lucide-react';
import type { T } from '@cc-desk-tunnel/i18n';
import type { Section } from './SettingsPage.tsx';

// The help's articles. What does not change with the language is written once here: the articles' ids, groups and
// icons, what is new, the order of their blocks, the pictures, where steps and actions lead. The text is in each
// language's catalog, at `help:articles.<id>`: its `title`, `lead`, the `words` the search finds it by, and each
// block's text at `blocks.<key>` (a heading's at its `id`, the name a link goes to it by) in the form its kind has
// (see `fill`). `helpArticles` puts the two together for HelpCenter to lay out: short paragraphs, steps, prompts to
// try, pictures of the real controls, and links between them.
//
// In text: `code`, **bold**, [[action]] for the key of a shortcut (an action of shortcuts.ts), and [words](target)
// for a link: `#article` or `#article#heading`, `settings:<section>`, `do:<action>` (something the window does) or a
// web address. `{device}` is the name of another of the user's computers that is online, or a stand-in; `{here}` is
// this one. Every language keeps the same links, actions and names (apps/desktop/test-main/help-links.test.mjs).
//
// What is new: `since` on an article that a version brought, or on a block that a version added to an older
// article, with `news` when the page of what is new names the change (in the words at `news.<key>`). It is marked
// while the program is of that version and goes by itself with the next; the page of what is new is made of these
// marks. When a release brings a feature, write how to use it here and mark it (scripts/release.mjs reminds of this).
//
// `Sources` above an article names the pages of https://code.claude.com/docs/en/ its facts come from. Those facts
// change with Claude Code, not with this program: check them again when its behaviour changes.

export type Doing =
  | 'addProject'
  | 'newSession'
  | 'schedules'
  | 'files'
  | 'chat'
  | 'syncInstructions'
  | 'exportSession';
export type Target = { article: string } | { settings: Section } | { doing: Doing };
export type Prompt = { text: string; note?: string };
type Fresh = { since?: string; news?: string };
export type Block = Fresh &
  (
    | { kind: 'p'; text: string }
    | { kind: 'heading'; text: string; id: string }
    | { kind: 'list'; items: string[] }
    | {
        kind: 'steps';
        items: { title: string; text: string; action?: { label: string; target: Target } }[];
      }
    | { kind: 'prompts'; title?: string; items: Prompt[] }
    | { kind: 'callout'; tone: Tone; title: string; text: string }
    | { kind: 'figure'; name: Figure; caption?: string }
    | { kind: 'code'; label?: string; text: string }
    | { kind: 'table'; head: [string, string]; rows: [string, string][] }
    | { kind: 'faq'; items: { q: string; a: string[] }[] }
    | { kind: 'keys' }
    | { kind: 'actions'; items: { label: string; target: Target }[] }
  );
type Tone = 'tip' | 'note' | 'warn';
export type Figure =
  | 'map'
  | 'approval'
  | 'remote-approval'
  | 'modes'
  | 'terminal'
  | 'agents'
  | 'cache'
  | 'quota'
  | 'devices'
  | 'sync'
  | 'export'
  | 'folders';
export type Article = {
  id: string;
  group: GroupId;
  title: string;
  icon: typeof Bot;
  lead: string;
  // The version that brought the whole article.
  since?: string;
  // What a browser cannot do: such an article is not offered there.
  desktop?: boolean;
  blocks: Block[];
  related?: string[];
  // More words the search finds it by.
  words: string;
};

// A block as written here, its text left to the catalogs: `key` names it there. Steps and actions say where each of
// their items leads, by its place; a step that leads nowhere has none.
type Keyed<Kind> = { kind: Kind; key: string };
type Shape = { since?: string; news?: true } & (
  | Keyed<'p' | 'list' | 'prompts' | 'code' | 'table' | 'faq'>
  | { kind: 'heading'; id: string }
  | (Keyed<'steps'> & { targets: (Target | null)[] })
  | (Keyed<'callout'> & { tone: Tone })
  | { kind: 'figure'; name: Figure; key?: string }
  | { kind: 'keys' }
  | (Keyed<'actions'> & { targets: Target[] })
);
type ArticleShape = Pick<Article, 'id' | 'group' | 'icon' | 'since' | 'desktop' | 'related'> & {
  blocks: Shape[];
};

export const groups = [
  { id: 'start', icon: Rocket },
  { id: 'daily', icon: MessagesSquare },
  { id: 'devices', icon: Laptop },
  { id: 'agents', icon: SquareTerminal },
  { id: 'account', icon: Gauge },
  { id: 'settings', icon: Settings },
  { id: 'care', icon: ShieldCheck },
  { id: 'faq', icon: CircleHelp },
] as const;
export type GroupId = (typeof groups)[number]['id'];
export const groupName = (t: T, id: GroupId) => t(`help:groups.${id}`);

const shapes: ArticleShape[] = [
  // Getting started
  {
    id: 'how-it-works',
    group: 'start',
    icon: Compass,
    blocks: [
      {
        kind: 'figure',
        name: 'map',
      },
      {
        kind: 'list',
        key: 'list1',
      },
      {
        kind: 'callout',
        key: 'tip1',
        tone: 'tip',
      },
      {
        kind: 'callout',
        key: 'note1',
        tone: 'note',
      },
      {
        kind: 'callout',
        key: 'tip2',
        tone: 'tip',
      },
    ],
    related: ['first-steps', 'remote-ops', 'safety'],
  },
  {
    id: 'first-steps',
    group: 'start',
    icon: Rocket,
    blocks: [
      {
        kind: 'steps',
        key: 'steps1',
        targets: [
          {
            settings: 'account',
          },
          {
            doing: 'addProject',
          },
          {
            doing: 'newSession',
          },
          null,
        ],
      },
      {
        kind: 'prompts',
        key: 'prompts1',
      },
      {
        kind: 'callout',
        key: 'tip1',
        tone: 'tip',
      },
    ],
    related: ['how-it-works', 'approval', 'settings'],
  },
  // Everyday use
  {
    id: 'sessions',
    group: 'daily',
    icon: FolderTree,
    blocks: [
      {
        kind: 'list',
        key: 'list1',
      },
      {
        kind: 'list',
        key: 'list2',
        since: '0.3.19',
        news: true,
      },
      {
        kind: 'list',
        key: 'list3',
      },
      {
        kind: 'callout',
        key: 'tip1',
        tone: 'tip',
      },
      {
        kind: 'heading',
        id: 'export',
        since: '0.3.22',
      },
      {
        kind: 'p',
        key: 'p1',
        since: '0.3.22',
        news: true,
      },
      {
        kind: 'figure',
        name: 'export',
        since: '0.3.22',
      },
      {
        kind: 'actions',
        key: 'actions1',
        since: '0.3.22',
        targets: [
          {
            doing: 'exportSession',
          },
        ],
      },
    ],
    related: ['devices', 'conversation', 'ccdt'],
  },
  {
    id: 'conversation',
    group: 'daily',
    icon: MessagesSquare,
    blocks: [
      {
        kind: 'list',
        key: 'list1',
        since: '0.3.21',
        news: true,
      },
      {
        kind: 'callout',
        key: 'note1',
        tone: 'note',
      },
      {
        kind: 'heading',
        id: 'keys',
      },
      {
        kind: 'keys',
      },
    ],
    related: ['approval', 'files', 'context'],
  },
  {
    id: 'approval',
    group: 'daily',
    icon: ShieldCheck,
    blocks: [
      {
        kind: 'figure',
        name: 'modes',
      },
      {
        kind: 'list',
        key: 'list1',
      },
      {
        kind: 'figure',
        name: 'approval',
        key: 'approval',
      },
      {
        kind: 'callout',
        key: 'note1',
        tone: 'note',
      },
      {
        kind: 'callout',
        key: 'warn1',
        tone: 'warn',
      },
    ],
    related: ['conversation', 'unattended', 'permissions'],
  },
  {
    id: 'files',
    group: 'daily',
    icon: FolderTree,
    desktop: true,
    blocks: [
      {
        kind: 'steps',
        key: 'steps1',
        targets: [
          {
            doing: 'files',
          },
          null,
          null,
        ],
      },
      {
        kind: 'list',
        key: 'list1',
      },
      {
        kind: 'list',
        key: 'list2',
        since: '0.3.22',
        news: true,
      },
      {
        kind: 'figure',
        name: 'folders',
        since: '0.3.22',
      },
      {
        kind: 'prompts',
        key: 'prompts1',
      },
    ],
    related: ['remote-ops', 'conversation'],
  },
  {
    id: 'schedules',
    group: 'daily',
    icon: CalendarClock,
    desktop: true,
    blocks: [
      {
        kind: 'prompts',
        key: 'prompts1',
      },
      {
        kind: 'steps',
        key: 'steps1',
        targets: [
          {
            doing: 'schedules',
          },
          null,
          null,
        ],
      },
      {
        kind: 'list',
        key: 'list1',
      },
    ],
    related: ['unattended', 'approval', 'background'],
  },
  // Several computers
  {
    id: 'devices',
    group: 'devices',
    icon: Laptop,
    blocks: [
      {
        kind: 'figure',
        name: 'devices',
      },
      {
        kind: 'list',
        key: 'list1',
      },
      {
        kind: 'list',
        key: 'list2',
        since: '0.3.19',
        news: true,
      },
      {
        kind: 'heading',
        id: 'no-project',
      },
      {
        kind: 'p',
        key: 'p1',
      },
      {
        kind: 'list',
        key: 'list3',
      },
      {
        kind: 'prompts',
        key: 'prompts1',
        since: '0.3.19',
      },
    ],
    related: ['remote-ops', 'always-online', 'browser'],
  },
  {
    id: 'remote-ops',
    group: 'devices',
    icon: Network,
    since: '0.3.19',
    blocks: [
      {
        kind: 'prompts',
        key: 'prompts1',
      },
      {
        kind: 'figure',
        name: 'remote-approval',
        key: 'remote-approval',
      },
      {
        kind: 'list',
        key: 'list1',
      },
    ],
    related: ['devices', 'always-online', 'approval'],
  },
  {
    id: 'always-online',
    group: 'devices',
    icon: Wifi,
    since: '0.3.19',
    blocks: [
      {
        kind: 'steps',
        key: 'steps1',
        targets: [null, null, null],
      },
      {
        kind: 'code',
        key: 'code1',
      },
      {
        kind: 'code',
        key: 'code2',
      },
      {
        kind: 'p',
        key: 'p1',
      },
      {
        kind: 'prompts',
        key: 'prompts1',
      },
      {
        kind: 'callout',
        key: 'note1',
        tone: 'note',
      },
    ],
    related: ['remote-ops', 'ccdt'],
  },
  {
    id: 'browser',
    group: 'devices',
    icon: MonitorSmartphone,
    blocks: [
      {
        kind: 'steps',
        key: 'steps1',
        targets: [
          {
            settings: 'web',
          },
          null,
          null,
        ],
      },
      {
        kind: 'list',
        key: 'list1',
      },
    ],
    related: ['approval', 'devices', 'safety'],
  },
  // Terminal and agents
  {
    id: 'ccdt',
    group: 'agents',
    icon: SquareTerminal,
    blocks: [
      {
        kind: 'figure',
        name: 'terminal',
      },
      {
        kind: 'heading',
        id: 'workflow',
      },
      {
        kind: 'steps',
        key: 'steps1',
        targets: [
          {
            doing: 'addProject',
          },
          null,
          null,
        ],
      },
      {
        kind: 'callout',
        key: 'note1',
        tone: 'note',
      },
      {
        kind: 'heading',
        id: 'commands',
      },
      {
        kind: 'table',
        key: 'table1',
      },
      {
        kind: 'list',
        key: 'list1',
        since: '0.3.19',
        news: true,
      },
    ],
    related: ['quota', 'agents', 'always-online'],
  },
  {
    id: 'agents',
    group: 'agents',
    icon: Bot,
    since: '0.3.19',
    blocks: [
      {
        kind: 'figure',
        name: 'agents',
      },
      {
        kind: 'heading',
        id: 'call-others',
      },
      {
        kind: 'prompts',
        key: 'prompts1',
      },
      {
        kind: 'heading',
        id: 'called-by-others',
      },
      {
        kind: 'p',
        key: 'p1',
      },
      {
        kind: 'code',
        key: 'code1',
      },
      {
        kind: 'table',
        key: 'table1',
      },
      {
        kind: 'callout',
        key: 'tip1',
        tone: 'tip',
      },
    ],
    related: ['acp', 'ccdt'],
  },
  {
    id: 'acp',
    group: 'agents',
    icon: Plug,
    since: '0.3.19',
    blocks: [
      {
        kind: 'code',
        key: 'code1',
      },
      {
        kind: 'code',
        key: 'code2',
      },
      {
        kind: 'list',
        key: 'list1',
      },
      {
        kind: 'callout',
        key: 'note1',
        tone: 'note',
      },
    ],
    related: ['agents', 'ccdt'],
  },
  // Quota and account
  {
    id: 'quota',
    group: 'account',
    icon: Gauge,
    blocks: [
      {
        kind: 'figure',
        name: 'quota',
      },
      {
        kind: 'list',
        key: 'list1',
      },
      {
        kind: 'actions',
        key: 'actions1',
        targets: [
          {
            settings: 'account',
          },
        ],
      },
    ],
    related: ['ccdt', 'context', 'model-settings'],
  },
  {
    id: 'account',
    group: 'account',
    icon: UserRound,
    blocks: [
      {
        kind: 'list',
        key: 'list1',
      },
      {
        kind: 'callout',
        key: 'warn1',
        tone: 'warn',
      },
      {
        kind: 'actions',
        key: 'actions1',
        targets: [
          {
            settings: 'account',
          },
        ],
      },
    ],
    related: ['quota', 'safety'],
  },
  // Settings
  // Sources: settings-reference (how each setting behaves outside an interactive terminal)
  {
    id: 'settings',
    group: 'settings',
    icon: Settings,
    since: '0.3.19',
    blocks: [
      {
        kind: 'table',
        key: 'table1',
      },
      {
        kind: 'callout',
        key: 'tip1',
        tone: 'tip',
      },
      {
        kind: 'callout',
        key: 'tip2',
        tone: 'tip',
        since: '0.3.21',
        news: true,
      },
      {
        kind: 'heading',
        id: 'scopes',
      },
      {
        kind: 'table',
        key: 'table2',
      },
      {
        kind: 'heading',
        id: 'cli',
      },
      {
        kind: 'p',
        key: 'p1',
      },
      {
        kind: 'table',
        key: 'table3',
      },
      {
        kind: 'actions',
        key: 'actions1',
        targets: [
          {
            settings: 'claude',
          },
        ],
      },
    ],
    related: ['context', 'unattended', 'model-settings'],
  },
  // Sources: prompt-caching, settings-reference#idlecompaction, settings-reference#autocompactwindow
  {
    id: 'context',
    group: 'settings',
    icon: Hourglass,
    blocks: [
      {
        kind: 'figure',
        name: 'cache',
      },
      {
        kind: 'heading',
        id: 'how',
      },
      {
        kind: 'p',
        key: 'p1',
      },
      {
        kind: 'list',
        key: 'list1',
      },
      {
        kind: 'heading',
        id: 'ttl',
      },
      {
        kind: 'p',
        key: 'p2',
      },
      {
        kind: 'table',
        key: 'table1',
      },
      {
        kind: 'callout',
        key: 'note1',
        tone: 'note',
      },
      {
        kind: 'p',
        key: 'p3',
      },
      {
        kind: 'heading',
        id: 'idle',
      },
      {
        kind: 'p',
        key: 'p4',
      },
      {
        kind: 'list',
        key: 'list2',
      },
      {
        kind: 'heading',
        id: 'window',
      },
      {
        kind: 'p',
        key: 'p5',
      },
      {
        kind: 'list',
        key: 'list3',
      },
      {
        kind: 'callout',
        key: 'tip1',
        tone: 'tip',
      },
      {
        kind: 'heading',
        id: 'numbers',
      },
      {
        kind: 'p',
        key: 'p6',
      },
      {
        kind: 'list',
        key: 'list4',
      },
      {
        kind: 'actions',
        key: 'actions1',
        targets: [
          {
            settings: 'context',
          },
          {
            settings: 'claude',
          },
        ],
      },
    ],
    related: ['quota', 'model-settings', 'conversation'],
  },
  // Sources: settings-reference#askuserquestiontimeout, interactive-mode (continuing on its own once the quota is back)
  {
    id: 'unattended',
    group: 'settings',
    icon: Moon,
    blocks: [
      {
        kind: 'heading',
        id: 'stops',
      },
      {
        kind: 'table',
        key: 'table1',
      },
      {
        kind: 'heading',
        id: 'deny',
      },
      {
        kind: 'list',
        key: 'list1',
      },
      {
        kind: 'heading',
        id: 'question',
      },
      {
        kind: 'p',
        key: 'p1',
      },
      {
        kind: 'prompts',
        key: 'prompts1',
      },
      {
        kind: 'p',
        key: 'p2',
      },
      {
        kind: 'heading',
        id: 'limit',
      },
      {
        kind: 'p',
        key: 'p3',
      },
      {
        kind: 'prompts',
        key: 'prompts2',
      },
      {
        kind: 'p',
        key: 'p4',
      },
      {
        kind: 'heading',
        id: 'recipe',
      },
      {
        kind: 'steps',
        key: 'steps1',
        targets: [
          null,
          {
            settings: 'claude',
          },
          null,
          {
            settings: 'notifications',
          },
        ],
      },
    ],
    related: ['schedules', 'approval', 'background'],
  },
  // Sources: settings-reference#alwaysthinkingenabled, fast-mode, settings-reference#fallbackmodel,
  // settings-reference#switchmodelsonflag
  {
    id: 'model-settings',
    group: 'settings',
    icon: Brain,
    blocks: [
      {
        kind: 'heading',
        id: 'thinking',
      },
      {
        kind: 'list',
        key: 'list1',
      },
      {
        kind: 'heading',
        id: 'fast',
      },
      {
        kind: 'list',
        key: 'list2',
      },
      {
        kind: 'heading',
        id: 'fallback',
      },
      {
        kind: 'list',
        key: 'list3',
      },
      {
        kind: 'actions',
        key: 'actions1',
        targets: [
          {
            settings: 'claude',
          },
        ],
      },
    ],
    related: ['context', 'quota'],
  },
  // Sources: memory, settings-reference#includegitinstructions, settings-reference#language
  {
    id: 'memory',
    group: 'settings',
    icon: NotebookPen,
    blocks: [
      {
        kind: 'table',
        key: 'table1',
      },
      {
        kind: 'heading',
        id: 'project',
      },
      {
        kind: 'p',
        key: 'p0',
        since: '0.3.22',
        news: true,
      },
      {
        kind: 'figure',
        name: 'sync',
        since: '0.3.22',
      },
      {
        kind: 'list',
        key: 'list0',
      },
      {
        kind: 'actions',
        key: 'actions0',
        since: '0.3.22',
        targets: [
          {
            doing: 'syncInstructions',
          },
        ],
      },
      {
        kind: 'p',
        key: 'p1',
      },
      {
        kind: 'code',
        key: 'code1',
      },
      {
        kind: 'heading',
        id: 'auto',
      },
      {
        kind: 'list',
        key: 'list1',
      },
      {
        kind: 'callout',
        key: 'note1',
        tone: 'note',
      },
      {
        kind: 'heading',
        id: 'habits',
      },
      {
        kind: 'list',
        key: 'list2',
      },
      {
        kind: 'actions',
        key: 'actions1',
        targets: [
          {
            settings: 'instructions',
          },
          {
            settings: 'claude',
          },
        ],
      },
    ],
    related: ['conversation', 'sessions'],
  },
  // Sources: settings-reference#bashoutputmaxchars, mcp (tool search)
  {
    id: 'execution',
    group: 'settings',
    icon: SquareTerminal,
    blocks: [
      {
        kind: 'heading',
        id: 'shell',
      },
      {
        kind: 'list',
        key: 'list1',
      },
      {
        kind: 'actions',
        key: 'actions1',
        targets: [
          {
            settings: 'shell',
          },
        ],
      },
      {
        kind: 'heading',
        id: 'output',
      },
      {
        kind: 'list',
        key: 'list2',
      },
      {
        kind: 'heading',
        id: 'tools',
      },
      {
        kind: 'list',
        key: 'list3',
      },
      {
        kind: 'heading',
        id: 'waits',
      },
      {
        kind: 'list',
        key: 'list4',
      },
      {
        kind: 'actions',
        key: 'actions2',
        targets: [
          {
            settings: 'connection',
          },
        ],
      },
    ],
    related: ['remote-ops', 'devices', 'troubleshoot'],
  },
  // Sources: settings-reference#filecheckpointingenabled, settings-reference (permissions)
  {
    id: 'permissions',
    group: 'settings',
    icon: Lock,
    blocks: [
      {
        kind: 'heading',
        id: 'bypass',
      },
      {
        kind: 'p',
        key: 'p1',
      },
      {
        kind: 'heading',
        id: 'writes',
      },
      {
        kind: 'list',
        key: 'list1',
      },
      {
        kind: 'heading',
        id: 'checkpoints',
      },
      {
        kind: 'p',
        key: 'p2',
      },
      {
        kind: 'callout',
        key: 'note1',
        tone: 'note',
      },
      {
        kind: 'actions',
        key: 'actions1',
        targets: [
          {
            settings: 'claude',
          },
        ],
      },
    ],
    related: ['approval', 'safety'],
  },
  // Upkeep and safety
  // Plugins
  {
    id: 'plugins',
    group: 'settings',
    icon: Plug,
    since: '0.3.21',
    blocks: [
      { kind: 'p', key: 'p1' },
      { kind: 'prompts', key: 'prompts1' },
      { kind: 'steps', key: 'steps1', targets: [null, { settings: 'plugins' }, null] },
      { kind: 'heading', id: 'events' },
      { kind: 'table', key: 'table1' },
      { kind: 'callout', key: 'warn1', tone: 'warn' },
    ],
    related: ['plugin-dev', 'unattended', 'safety'],
  },
  {
    id: 'plugin-dev',
    group: 'settings',
    icon: SquareTerminal,
    since: '0.3.21',
    blocks: [
      { kind: 'p', key: 'p1' },
      { kind: 'code', key: 'code1' },
      { kind: 'heading', id: 'hooks' },
      { kind: 'code', key: 'code2' },
      { kind: 'list', key: 'list1' },
      { kind: 'heading', id: 'settings' },
      { kind: 'code', key: 'code3' },
      { kind: 'list', key: 'list2' },
      { kind: 'heading', id: 'fields' },
      { kind: 'table', key: 'table1' },
      { kind: 'list', key: 'list3' },
    ],
    related: ['plugins'],
  },
  {
    id: 'background',
    group: 'care',
    icon: BellRing,
    blocks: [
      {
        kind: 'list',
        key: 'list1',
      },
      {
        kind: 'actions',
        key: 'actions1',
        targets: [
          {
            settings: 'notifications',
          },
        ],
      },
    ],
    related: ['schedules', 'upgrade'],
  },
  {
    id: 'upgrade',
    group: 'care',
    icon: Download,
    blocks: [
      {
        kind: 'steps',
        key: 'steps1',
        targets: [
          {
            settings: 'about',
          },
          null,
          null,
        ],
      },
      {
        kind: 'list',
        key: 'list1',
      },
    ],
    related: ['background', 'troubleshoot'],
  },
  {
    id: 'safety',
    group: 'care',
    icon: ShieldAlert,
    blocks: [
      {
        kind: 'list',
        key: 'list1',
      },
      {
        kind: 'p',
        key: 'p1',
      },
    ],
    related: ['account', 'browser'],
  },
  // Troubleshooting
  {
    id: 'troubleshoot',
    group: 'faq',
    icon: Server,
    blocks: [
      {
        kind: 'table',
        key: 'table1',
      },
      {
        kind: 'p',
        key: 'p1',
      },
    ],
    related: ['faq', 'upgrade'],
  },
  {
    id: 'faq',
    group: 'faq',
    icon: CircleHelp,
    blocks: [
      {
        kind: 'faq',
        key: 'faq1',
      },
    ],
    related: ['troubleshoot', 'how-it-works'],
  },
];

// A message of the catalogs as it is: text, or the list or the fields a block's text is made of.
const read = (t: T, key: string) => t(key as never, { returnObjects: true } as never) as unknown;

function fill(t: T, { blocks, ...article }: ArticleShape): Article {
  const text = <V>(key: string) => read(t, `help:articles.${article.id}.${key}`) as V;
  return {
    ...article,
    title: text<string>('title'),
    lead: text<string>('lead'),
    words: text<string>('words'),
    blocks: blocks.map((block): Block => {
      const fresh: Fresh = { since: block.since };
      // The page of what is new names the change in the words kept by the block's name.
      const name = 'id' in block ? block.id : 'key' in block ? block.key : undefined;
      if (block.news && name) fresh.news = text<string>(`news.${name}`);
      const own = <V>(key: string) => text<V>(`blocks.${key}`);
      switch (block.kind) {
        case 'p':
          return { ...fresh, kind: 'p', text: own<string>(block.key) };
        case 'heading':
          return { ...fresh, kind: 'heading', id: block.id, text: own<string>(block.id) };
        case 'list':
          return { ...fresh, kind: 'list', items: own<string[]>(block.key) };
        case 'steps':
          return {
            ...fresh,
            kind: 'steps',
            items: own<{ title: string; text: string; action?: string }[]>(block.key).map(
              ({ action, ...step }, index) => {
                const target = block.targets[index];
                return action && target ? { ...step, action: { label: action, target } } : step;
              },
            ),
          };
        case 'prompts':
          return {
            ...fresh,
            kind: 'prompts',
            ...own<{ title?: string; items: Prompt[] }>(block.key),
          };
        case 'callout':
          return {
            ...fresh,
            kind: 'callout',
            tone: block.tone,
            ...own<{ title: string; text: string }>(block.key),
          };
        case 'figure':
          return {
            ...fresh,
            kind: 'figure',
            name: block.name,
            caption: block.key && own<string>(block.key),
          };
        case 'code':
          return { ...fresh, kind: 'code', ...own<{ label?: string; text: string }>(block.key) };
        case 'table':
          return {
            ...fresh,
            kind: 'table',
            ...own<{ head: [string, string]; rows: [string, string][] }>(block.key),
          };
        case 'faq':
          return { ...fresh, kind: 'faq', items: own<{ q: string; a: string[] }[]>(block.key) };
        case 'keys':
          return { ...fresh, kind: 'keys' };
        case 'actions':
          return {
            ...fresh,
            kind: 'actions',
            items: own<string[]>(block.key).map((label, index) => ({
              label,
              target: block.targets[index],
            })),
          };
      }
    }),
  };
}

// Every article in the language of `t`.
export const helpArticles = (t: T): Article[] => shapes.map((shape) => fill(t, shape));
// The articles' structure, for the tests: each block's key in the catalogs and where it leads.
export const helpShapes: readonly ArticleShape[] = shapes;

// The page of what is new in a version is made of the articles and blocks marked with it.
export type News = { title: string; text: string; article: string; icon: typeof Bot };
export function newsOf(t: T, version: string, list: Article[]): News[] {
  const found: News[] = [];
  for (const article of list) {
    if (article.since === version)
      found.push({
        title: article.title,
        text: article.lead,
        article: article.id,
        icon: article.icon,
      });
    else
      for (const block of article.blocks)
        if (block.since === version && block.news)
          found.push({
            title: block.news,
            text: t('help:seeArticle', { title: article.title }),
            article: article.id,
            icon: article.icon,
          });
  }
  return found;
}
export const hasNews = (version: string) =>
  shapes.some(
    (article) =>
      article.since === version ||
      article.blocks.some((block) => block.since === version && block.news),
  );
// How new an article is in a version: brought by it, or changed by it.
export const freshness = (article: Article, version: string) =>
  article.since === version
    ? 'new'
    : article.blocks.some((block) => block.since === version)
      ? 'changed'
      : null;

// The prompts the front page offers, most telling first. Those naming another computer are offered only when one is
// online.
const starterShapes = [
  { key: 'disks', device: true, article: 'remote-ops' },
  { key: 'explain', article: 'first-steps' },
  { key: 'transfer', device: true, article: 'remote-ops' },
  { key: 'run', article: 'first-steps' },
  { key: 'report', article: 'schedules' },
  { key: 'review', article: 'agents' },
] as const;
export const starters = (t: T): (Prompt & { device?: boolean; article: string })[] =>
  starterShapes.map(({ key, ...starter }) => ({ ...starter, text: t(`help:starters.${key}`) }));

// What an empty session offers to say first: about its project, or about the computer for a session of none, and
// one that reaches another computer when one is online.
export function suggestions(
  t: T,
  {
    project,
    other,
    schedules,
  }: {
    project: boolean;
    other?: string;
    schedules: boolean;
  },
) {
  if (project)
    return [
      t('help:suggestions.explain'),
      t('help:suggestions.run'),
      other ? t('help:suggestions.otherTests', { other }) : t('help:suggestions.commits'),
    ];
  return [
    t('help:suggestions.disks'),
    other ? t('help:suggestions.otherVersions', { other }) : t('help:suggestions.tools'),
    ...(schedules ? [t('help:suggestions.report')] : []),
  ];
}
