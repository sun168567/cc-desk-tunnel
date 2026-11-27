import type { T } from '@cc-desk-tunnel/i18n';
import type { DeviceShell, NativeSettings } from '@cc-desk-tunnel/protocol';

// Settings described once for every client that shows them: the desktop and browser pages, and ccdt in a terminal.
// Nothing here draws; each client shows the same choices with the same words in its own way, in its language: what
// says them takes the client's `t` (catalog namespace `settings`). A detail is one short
// line; what takes more words, and how settings work together, is in the help, at the place `help` names
// (an article of help-content.ts, or `article#heading`).

// How many seconds each step of connecting may take. The defaults suit most computers; a domain account whose
// domain controller is out of reach, or slow security software, can need more.
export type ConnectionWaits = { connect: number; ssh: number; ready: number };
export const connectionWaits: ConnectionWaits = { connect: 15, ssh: 10, ready: 45 };
export const waitRange = { min: 5, max: 600 };
export const waitFields = (
  t: T,
): { step: keyof ConnectionWaits; title: string; detail: string }[] => [
  {
    step: 'connect',
    title: t('settings:wait.connect.title'),
    detail: t('settings:wait.connect.detail'),
  },
  {
    step: 'ssh',
    title: t('settings:wait.ssh.title'),
    detail: t('settings:wait.ssh.detail'),
  },
  {
    step: 'ready',
    title: t('settings:wait.ready.title'),
    detail: t('settings:wait.ready.detail'),
  },
];

// The service's idle compaction: what each value means and the choices offered for it.
export const idleCompactionFields = (t: T) => ({
  enabled: {
    title: t('settings:idle.enabled.title'),
    detail: t('settings:idle.enabled.detail'),
  },
  afterMinutes: {
    title: t('settings:idle.after.title'),
    detail: t('settings:idle.after.detail'),
    options: [30, 40, 45, 50, 55],
  },
  minTokens: {
    title: t('settings:idle.minTokens.title'),
    detail: t('settings:idle.minTokens.detail'),
    options: [50_000, 100_000, 150_000, 200_000, 300_000],
  },
});

// The shell Claude is told the user prefers for scripts on a Windows computer. The choice is kept by the service for
// this computer alone; Git Bash is offered once the computer has it.
export const shellField = (t: T) => ({
  title: t('settings:shell.title'),
  detail: t('settings:shell.detail'),
  help: 'execution#shell',
  unset: t('settings:shell.unset'),
  missing: t('settings:shell.missing'),
  options: [
    ['pwsh', 'PowerShell 7'],
    ['bash', 'Git Bash'],
  ] as [DeviceShell, string][],
});

export type CliKey = keyof NativeSettings;
export type CliValue = NativeSettings[CliKey];
// A setting is a switch (default / on / off), one of a few choices, or a line of text. Choices and text say
// how their value is written in the box and read back; an empty box is "unset".
export type CliField = { key: CliKey; title: string; detail: string; help?: string } & (
  | { kind: 'toggle'; unset: string }
  | { kind: 'choice'; unset: string; options: [string, string][]; read: (text: string) => CliValue }
  | {
      kind: 'text';
      placeholder: string;
      write: (value: CliValue) => string;
      read: (text: string) => CliValue;
    }
);
const sizes = (values: number[], current: unknown, name: (value: number) => string) =>
  [...new Set([...values, ...(typeof current === 'number' ? [current] : [])])]
    .sort((a, b) => a - b)
    .map((value): [string, string] => [String(value), name(value)]);
const tokens = (value: number) =>
  `${value >= 1_000_000 ? `${value / 1_000_000}M` : `${value / 1000}K`} tokens`;
const ttl = (t: T): [string, string][] => [
  ['5m', t('settings:cli.ttl.5m')],
  ['1h', t('settings:cli.ttl.1h')],
];

// The official CLI's settings in the order they are shown, under the heading they belong to.
export const cliSettingGroups = (
  t: T,
  values: NativeSettings,
): { name: string; fields: CliField[] }[] => [
  {
    name: t('settings:cli.group.context'),
    fields: [
      {
        key: 'autoCompactEnabled',
        kind: 'toggle',
        title: t('settings:cli.autoCompactEnabled.title'),
        detail: t('settings:cli.autoCompactEnabled.detail'),
        unset: t('settings:default.on'),
      },
      {
        key: 'autoCompactWindow',
        kind: 'choice',
        title: t('settings:cli.autoCompactWindow.title'),
        detail: t('settings:cli.autoCompactWindow.detail'),
        help: 'context#window',
        unset: t('settings:default.auto'),
        options: sizes(
          [100_000, 200_000, 300_000, 400_000, 500_000, 750_000, 1_000_000],
          values.autoCompactWindow,
          tokens,
        ),
        read: Number,
      },
      {
        key: 'precomputeCompactionEnabled',
        kind: 'toggle',
        title: t('settings:cli.precomputeCompactionEnabled.title'),
        detail: t('settings:cli.precomputeCompactionEnabled.detail'),
        unset: t('settings:default.auto'),
      },
      {
        key: 'autoMemoryEnabled',
        kind: 'toggle',
        title: t('settings:cli.autoMemoryEnabled.title'),
        detail: t('settings:cli.autoMemoryEnabled.detail'),
        help: 'memory#auto',
        unset: t('settings:default.on'),
      },
      {
        key: 'autoDreamEnabled',
        kind: 'toggle',
        title: t('settings:cli.autoDreamEnabled.title'),
        detail: t('settings:cli.autoDreamEnabled.detail'),
        unset: t('settings:default.auto'),
      },
      {
        key: 'fileCheckpointingEnabled',
        kind: 'toggle',
        title: t('settings:cli.fileCheckpointingEnabled.title'),
        detail: t('settings:cli.fileCheckpointingEnabled.detail'),
        help: 'permissions#checkpoints',
        unset: t('settings:default.on'),
      },
    ],
  },
  {
    name: t('settings:cli.group.model'),
    fields: [
      {
        key: 'alwaysThinkingEnabled',
        kind: 'toggle',
        title: t('settings:cli.alwaysThinkingEnabled.title'),
        detail: t('settings:cli.alwaysThinkingEnabled.detail'),
        help: 'model-settings#thinking',
        unset: t('settings:default.on'),
      },
      {
        key: 'showThinkingSummaries',
        kind: 'toggle',
        title: t('settings:cli.showThinkingSummaries.title'),
        detail: t('settings:cli.showThinkingSummaries.detail'),
        help: 'model-settings#thinking',
        unset: t('settings:default.off'),
      },
      {
        key: 'fastMode',
        kind: 'toggle',
        title: t('settings:cli.fastMode.title'),
        detail: t('settings:cli.fastMode.detail'),
        help: 'model-settings#fast',
        unset: t('settings:default.off'),
      },
      {
        key: 'fallbackModel',
        kind: 'text',
        title: t('settings:cli.fallbackModel.title'),
        detail: t('settings:cli.fallbackModel.detail'),
        help: 'model-settings#fallback',
        placeholder: t('settings:cli.fallbackModel.placeholder'),
        write: (value) => (Array.isArray(value) ? value.join(', ') : ''),
        read: (text) => {
          const names = text.split(/[,，\s]+/).filter(Boolean);
          return names.length ? names.slice(0, 3) : null;
        },
      },
      {
        key: 'autoContinueAtUsageLimit',
        kind: 'toggle',
        title: t('settings:cli.autoContinueAtUsageLimit.title'),
        detail: t('settings:cli.autoContinueAtUsageLimit.detail'),
        help: 'unattended#limit',
        unset: t('settings:default.on'),
      },
      {
        key: 'switchModelsOnFlag',
        kind: 'toggle',
        title: t('settings:cli.switchModelsOnFlag.title'),
        detail: t('settings:cli.switchModelsOnFlag.detail'),
        help: 'model-settings#fallback',
        unset: t('settings:default.on'),
      },
      {
        key: 'promptCacheTtl',
        kind: 'choice',
        title: t('settings:cli.promptCacheTtl.title'),
        detail: t('settings:cli.promptCacheTtl.detail'),
        help: 'context#ttl',
        unset: t('settings:default.auto'),
        options: ttl(t),
        read: (text) => text as CliValue,
      },
      {
        key: 'subagentPromptCacheTtl',
        kind: 'choice',
        title: t('settings:cli.subagentPromptCacheTtl.title'),
        detail: t('settings:cli.subagentPromptCacheTtl.detail'),
        unset: t('settings:default.auto'),
        options: ttl(t),
        read: (text) => text as CliValue,
      },
    ],
  },
  {
    name: t('settings:cli.group.behavior'),
    fields: [
      {
        key: 'language',
        kind: 'text',
        title: t('settings:cli.language.title'),
        detail: t('settings:cli.language.detail'),
        placeholder: '',
        write: (value) => (typeof value === 'string' ? value : ''),
        read: (text) => text || null,
      },
      {
        key: 'askUserQuestionTimeout',
        kind: 'choice',
        title: t('settings:cli.askUserQuestionTimeout.title'),
        detail: t('settings:cli.askUserQuestionTimeout.detail'),
        help: 'unattended#question',
        unset: t('settings:default.wait'),
        options: [
          ['60s', t('settings:cli.askUserQuestionTimeout.60s')],
          ['5m', t('settings:cli.askUserQuestionTimeout.5m')],
          ['10m', t('settings:cli.askUserQuestionTimeout.10m')],
          ['never', t('settings:cli.askUserQuestionTimeout.never')],
        ],
        read: (text) => text as CliValue,
      },
      {
        key: 'bashOutputMaxChars',
        kind: 'choice',
        title: t('settings:cli.bashOutputMaxChars.title'),
        detail: t('settings:cli.bashOutputMaxChars.detail'),
        help: 'execution#output',
        unset: t('settings:default.chars'),
        options: sizes(
          [10_000, 30_000, 60_000, 100_000, 128_000],
          values.bashOutputMaxChars,
          (value) => t('settings:cli.bashOutputMaxChars.chars', { n: value / 1000 }),
        ),
        read: Number,
      },
      {
        key: 'toolSearch',
        kind: 'toggle',
        title: t('settings:cli.toolSearch.title'),
        detail: t('settings:cli.toolSearch.detail'),
        help: 'execution#tools',
        unset: t('settings:default.auto'),
      },
      {
        key: 'todoTools',
        kind: 'toggle',
        title: t('settings:cli.todoTools.title'),
        detail: t('settings:cli.todoTools.detail'),
        help: 'conversation#tasks',
        unset: t('settings:default.on'),
      },
      {
        key: 'enableArtifact',
        kind: 'toggle',
        title: t('settings:cli.enableArtifact.title'),
        detail: t('settings:cli.enableArtifact.detail'),
        unset: t('settings:default.auto'),
      },
    ],
  },
  {
    name: t('settings:cli.group.permissions'),
    fields: [
      {
        key: 'denyInsteadOfPrompting',
        kind: 'toggle',
        title: t('settings:cli.denyInsteadOfPrompting.title'),
        detail: t('settings:cli.denyInsteadOfPrompting.detail'),
        help: 'unattended#deny',
        unset: t('settings:default.off'),
      },
      {
        key: 'blockWritesOutsideWorkingDirectories',
        kind: 'toggle',
        title: t('settings:cli.blockWritesOutsideWorkingDirectories.title'),
        detail: t('settings:cli.blockWritesOutsideWorkingDirectories.detail'),
        help: 'permissions#writes',
        unset: t('settings:default.off'),
      },
    ],
  },
  {
    name: 'Git',
    fields: [
      {
        key: 'attribution',
        kind: 'choice',
        title: t('settings:cli.attribution.title'),
        detail: t('settings:cli.attribution.detail'),
        unset: t('settings:default.attribution'),
        options: [['false', t('settings:cli.attribution.false')]],
        read: () => false,
      },
      {
        key: 'includeGitInstructions',
        kind: 'toggle',
        title: t('settings:cli.includeGitInstructions.title'),
        detail: t('settings:cli.includeGitInstructions.detail'),
        unset: t('settings:default.on'),
      },
    ],
  },
];
