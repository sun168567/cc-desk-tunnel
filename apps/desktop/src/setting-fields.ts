import type { DeviceShell, NativeSettings } from '@cc-desk-tunnel/protocol';

// Settings described once for every client that shows them: the desktop and browser pages, and ccdt in a terminal.
// Nothing here draws; each client shows the same choices with the same words in its own way.

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
  enabled: { title: '自动压缩', detail: '只对写入了 1 小时缓存的会话生效，订阅账号默认如此' },
  afterMinutes: {
    title: '空闲多久后压缩',
    detail: '从最后一轮结束算起；关闭自动压缩时，到这个时间起提醒',
    options: [30, 40, 45, 50, 55],
  },
  minTokens: {
    title: '上下文至少',
    detail: '小于这个大小的会话不压缩，也不提醒',
    options: [50_000, 100_000, 150_000, 200_000, 300_000],
  },
};

// The shell Claude is told the user prefers for scripts on a Windows computer. The choice is kept by the service for
// this computer alone; Git Bash is offered once the computer has it.
export const shellField = {
  title: '偏好的 Shell',
  detail: '不指定时由 Claude 按任务选择；选了也只是优先，任务更适合另一种时 Claude 仍会换用',
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
export type CliField = { key: CliKey; title: string; detail: string } & (
  | { kind: 'toggle' }
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
        detail: '上下文接近窗口上限时自动摘要并继续',
      },
      {
        key: 'autoCompactWindow',
        kind: 'choice',
        title: '自动压缩窗口',
        detail: '上下文达到这个大小前后触发自动压缩；不超过模型自身的窗口',
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
        detail: '在需要之前于后台算好摘要，压缩时少等；仅在自动压缩开启时有效',
      },
      {
        key: 'autoMemoryEnabled',
        kind: 'toggle',
        title: '自动记忆',
        detail: '允许读写自动记忆目录',
      },
      {
        key: 'autoDreamEnabled',
        kind: 'toggle',
        title: '后台整理记忆',
        detail: '空闲时在后台归并、整理已有的记忆',
      },
      {
        key: 'fileCheckpointingEnabled',
        kind: 'toggle',
        title: '文件检查点',
        detail: '编辑前保存快照，供 /rewind 恢复',
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
        detail: '关闭后模型不再进行扩展思考',
      },
      {
        key: 'showThinkingSummaries',
        kind: 'toggle',
        title: '显示思考过程',
        detail:
          '向 Claude 索取思考的摘要并显示在对话里，默认开启；关闭后不再索取，模型照常思考。第三方模型自己输出的思考不受这一项影响',
      },
      {
        key: 'fastMode',
        kind: 'toggle',
        title: '快速模式',
        detail: '官方 fast mode：输出更快，计费与额度消耗按官方规则',
      },
      {
        key: 'fallbackModel',
        kind: 'text',
        title: '备用模型',
        detail: '主模型过载或不可用时依次改用；填模型名或别名，逗号分隔，最多 5 个',
        placeholder: '例如 sonnet, haiku',
        write: (value) => (Array.isArray(value) ? value.join(', ') : ''),
        read: (text) => {
          const names = text.split(/[,，\s]+/).filter(Boolean);
          return names.length ? names.slice(0, 5) : null;
        },
      },
      {
        key: 'autoContinueAtUsageLimit',
        kind: 'toggle',
        title: '额度用尽后自动继续',
        detail: '订阅额度触顶时等待重置并自动接着做，适合长任务',
      },
      {
        key: 'switchModelsOnFlag',
        kind: 'toggle',
        title: '触发安全拦截时换模型',
        detail: '消息被拦截时自动改用其他模型继续，关闭则暂停',
      },
      {
        key: 'promptCacheTtl',
        kind: 'choice',
        title: '提示缓存时长',
        detail: '主对话的提示缓存保留时间',
        unset: '默认（自动）',
        options: ttl,
        read: (text) => text as CliValue,
      },
      {
        key: 'subagentPromptCacheTtl',
        kind: 'choice',
        title: '子任务的提示缓存时长',
        detail: '主对话之外的请求：子代理、后台与辅助请求',
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
        detail: 'Claude 的提问等多久后带着已选的答案自行继续；无人值守的任务不至于一直停着',
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
        detail:
          '一条命令的输出直接交给 Claude 的字符数，超出的部分存成文件只给预览；Windows 上的操作都经命令执行',
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
        detail:
          '工具的说明不再随每次请求全部发出，Claude 用到时再查找，工具多（例如接了 MCP）时能明显减少上下文占用。默认：官方账号开启，第三方接口关闭；第三方接口要能转发 tool_reference 才能开启',
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
        detail:
          '要你批准的工具调用不再等你，立即拒绝并告诉 Claude，这一轮接着做；适合无人值守的定时任务。开启后所有会话（包括 ccdt）都不会再弹出审批，允许规则和自动模式照常先判断',
      },
      {
        key: 'blockWritesOutsideWorkingDirectories',
        kind: 'toggle',
        title: '禁止在工作目录外写文件',
        detail:
          '写文件、编辑工具不能改工作目录以外的文件，也不能改 Claude Code 的设置文件；不限制命令，Claude 自己的记忆和计划文件不受影响。这些工具只作用于服务器上的文件',
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
        detail: 'Claude Code 默认在提交信息和 PR 描述里加上自己的署名',
        unset: '默认（加署名）',
        options: [['false', '不加署名']],
        read: () => false,
      },
      {
        key: 'includeGitInstructions',
        kind: 'toggle',
        title: '内置的提交与 PR 流程说明',
        detail: '系统提示词里附带的提交、开 PR 的做法；按自己的流程来时可以关闭',
      },
    ],
  },
];
