import type { DeviceShell, NativeSettings } from '@cc-desk-tunnel/protocol';

// Settings described once for every client that shows them: the desktop and browser pages, and ccdt in a terminal.
// Nothing here draws; each client shows the same choices with the same words in its own way. A detail is one short
// line; what takes more words, and how settings work together, is in the help, at the place `help` names
// (an article of help-content.ts, or `article#heading`).

// How many seconds each step of connecting may take. The defaults suit most computers; a domain account whose
// domain controller is out of reach, or slow security software, can need more.
export type ConnectionWaits = { connect: number; ssh: number; ready: number };
export const connectionWaits: ConnectionWaits = { connect: 15, ssh: 10, ready: 45 };
export const waitRange = { min: 5, max: 600 };
export const waitFields: { step: keyof ConnectionWaits; title: string; detail: string }[] = [
  { step: 'connect', title: '连接服务器', detail: '与服务端建立网络连接' },
  {
    step: 'ssh',
    title: '本机 SSH 服务启动',
    detail: '域账号连不上域控制器、或安全软件扫描较慢时，启动会久一些',
  },
  {
    step: 'ready',
    title: '执行通道就绪',
    detail: '从连上服务端到隧道接通的总时间；至少比上一项多 35 秒',
  },
];

// The service's idle compaction: what each value means and the choices offered for it.
export const idleCompactionFields = {
  enabled: {
    title: '自动压缩',
    detail: '只对 1 小时缓存的会话生效，订阅账号默认如此',
  },
  afterMinutes: {
    title: '空闲多久后压缩',
    detail: '从最后一轮结束算起；关闭自动压缩时，到点提醒',
    options: [30, 40, 45, 50, 55],
  },
  minTokens: {
    title: '上下文至少',
    detail: '更小的会话不压缩，也不提醒',
    options: [50_000, 100_000, 150_000, 200_000, 300_000],
  },
};

// The shell Claude is told the user prefers for scripts on a Windows computer. The choice is kept by the service for
// this computer alone; Git Bash is offered once the computer has it.
export const shellField = {
  title: '偏好的 Shell',
  detail: '不指定时由 Claude 按任务选；选了也只是优先',
  help: 'execution#shell',
  unset: '不指定',
  missing:
    '没有检测到 Git Bash：安装 Git for Windows（https://git-scm.com/download/win）后重新连接，就可以选择它。',
  options: [
    ['pwsh', 'PowerShell 7'],
    ['bash', 'Git Bash'],
  ] as [DeviceShell, string][],
};

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
const ttl: [string, string][] = [
  ['5m', '5 分钟'],
  ['1h', '1 小时'],
];

// The official CLI's settings in the order they are shown, under the heading they belong to.
export const cliSettingGroups = (
  values: NativeSettings,
): { name: string; fields: CliField[] }[] => [
  {
    name: '上下文与记忆',
    fields: [
      {
        key: 'autoCompactEnabled',
        kind: 'toggle',
        title: '自动压缩上下文',
        detail: '上下文快满时自动摘要并接着做',
        unset: '默认（开启）',
      },
      {
        key: 'autoCompactWindow',
        kind: 'choice',
        title: '自动压缩窗口',
        detail: '上下文到这么大就压缩，不超过模型自身的窗口',
        help: 'context#window',
        unset: '默认（自动）',
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
        title: '提前准备压缩摘要',
        detail: '后台先算好摘要，压缩时少等；需开启自动压缩',
        unset: '默认（自动）',
      },
      {
        key: 'autoMemoryEnabled',
        kind: 'toggle',
        title: '自动记忆',
        detail: 'Claude 自己记笔记，下次会话还记得',
        help: 'memory#auto',
        unset: '默认（开启）',
      },
      {
        key: 'autoDreamEnabled',
        kind: 'toggle',
        title: '后台整理记忆',
        detail: '空闲时归并、整理已有的记忆',
        unset: '默认（自动）',
      },
      {
        key: 'fileCheckpointingEnabled',
        kind: 'toggle',
        title: '文件检查点',
        detail: '编辑前留快照，供 /rewind 撤回；只在 ccdt 里有用',
        help: 'permissions#checkpoints',
        unset: '默认（开启）',
      },
    ],
  },
  {
    name: '模型与额度',
    fields: [
      {
        key: 'alwaysThinkingEnabled',
        kind: 'toggle',
        title: '思考',
        detail: '只对老一些的模型有用，新模型总会思考',
        help: 'model-settings#thinking',
        unset: '默认（开启）',
      },
      {
        key: 'showThinkingSummaries',
        kind: 'toggle',
        title: '显示思考过程',
        detail: '对话里显示思考的摘要，不改变思考多少',
        help: 'model-settings#thinking',
        unset: '默认（关闭）',
      },
      {
        key: 'fastMode',
        kind: 'toggle',
        title: '快速模式',
        detail: '输出更快、更贵；订阅账号从额外用量扣费',
        help: 'model-settings#fast',
        unset: '默认（关闭）',
      },
      {
        key: 'fallbackModel',
        kind: 'text',
        title: '备用模型',
        detail: '主模型过载或不可用时依次换用；逗号分隔，最多 3 个',
        help: 'model-settings#fallback',
        placeholder: '例如 sonnet, haiku',
        write: (value) => (Array.isArray(value) ? value.join(', ') : ''),
        read: (text) => {
          const names = text.split(/[,，\s]+/).filter(Boolean);
          return names.length ? names.slice(0, 3) : null;
        },
      },
      {
        key: 'autoContinueAtUsageLimit',
        kind: 'toggle',
        title: '额度用尽后自动继续',
        detail: '等额度重置后接着做；只在 ccdt 里有用',
        help: 'unattended#limit',
        unset: '默认（开启）',
      },
      {
        key: 'switchModelsOnFlag',
        kind: 'toggle',
        title: '触发安全拦截时换模型',
        detail: '请求被拦下时换模型继续；关闭则这一轮出错结束',
        help: 'model-settings#fallback',
        unset: '默认（开启）',
      },
      {
        key: 'promptCacheTtl',
        kind: 'choice',
        title: '提示缓存时长',
        detail: '主对话的缓存保留多久',
        help: 'context#ttl',
        unset: '默认（自动）',
        options: ttl,
        read: (text) => text as CliValue,
      },
      {
        key: 'subagentPromptCacheTtl',
        kind: 'choice',
        title: '子任务的提示缓存时长',
        detail: '子代理、压缩等主对话之外的请求',
        unset: '默认（自动）',
        options: ttl,
        read: (text) => text as CliValue,
      },
    ],
  },
  {
    name: '行为',
    fields: [
      {
        key: 'language',
        kind: 'text',
        title: '回复语言',
        detail: '例如 chinese、japanese；留空由 CLI 决定',
        placeholder: '',
        write: (value) => (typeof value === 'string' ? value : ''),
        read: (text) => text || null,
      },
      {
        key: 'askUserQuestionTimeout',
        kind: 'choice',
        title: '提问无人回答时',
        detail: '提问等多久后自己继续；只在 ccdt 里有用',
        help: 'unattended#question',
        unset: '默认（一直等）',
        options: [
          ['60s', '60 秒后继续'],
          ['5m', '5 分钟后继续'],
          ['10m', '10 分钟后继续'],
          ['never', '一直等'],
        ],
        read: (text) => text as CliValue,
      },
      {
        key: 'bashOutputMaxChars',
        kind: 'choice',
        title: '命令输出上限',
        detail: '超出的部分存成文件，Claude 只看到开头',
        help: 'execution#output',
        unset: '默认（30K）',
        options: sizes(
          [10_000, 30_000, 60_000, 100_000, 128_000],
          values.bashOutputMaxChars,
          (value) => `${value / 1000}K 字符`,
        ),
        read: Number,
      },
      {
        key: 'toolSearch',
        kind: 'toggle',
        title: '工具搜索',
        detail: '工具说明用到时再查，接了 MCP 时省上下文',
        help: 'execution#tools',
        unset: '默认（自动）',
      },
      {
        key: 'enableArtifact',
        kind: 'toggle',
        title: 'Artifact 网页',
        detail: 'Claude 可以把文档、图表发布成 claude.ai 上的网页',
        unset: '默认（自动）',
      },
    ],
  },
  {
    name: '权限',
    fields: [
      {
        key: 'denyInsteadOfPrompting',
        kind: 'toggle',
        title: '不等审批，直接拒绝',
        detail: '要你批准的调用直接拒绝，所有会话都不再弹审批',
        help: 'unattended#deny',
        unset: '默认（关闭）',
      },
      {
        key: 'blockWritesOutsideWorkingDirectories',
        kind: 'toggle',
        title: '禁止在工作目录外写文件',
        detail: '只管服务器上的写文件工具，挡不住对你电脑的修改',
        help: 'permissions#writes',
        unset: '默认（关闭）',
      },
    ],
  },
  {
    name: 'Git',
    fields: [
      {
        key: 'attribution',
        kind: 'choice',
        title: '提交与 PR 的署名',
        detail: '默认在提交信息和 PR 描述里加上 Claude 的署名',
        unset: '默认（加署名）',
        options: [['false', '不加署名']],
        read: () => false,
      },
      {
        key: 'includeGitInstructions',
        kind: 'toggle',
        title: '内置的提交与 PR 流程说明',
        detail: '官方的提交、开 PR 做法；按自己的流程时关掉',
        unset: '默认（开启）',
      },
    ],
  },
];
