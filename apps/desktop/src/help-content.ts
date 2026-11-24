import {
  Bot,
  CalendarClock,
  CircleHelp,
  Compass,
  Download,
  FolderTree,
  Gauge,
  Hourglass,
  Laptop,
  MessagesSquare,
  MonitorSmartphone,
  Network,
  Plug,
  Rocket,
  Server,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  SquareTerminal,
  UserRound,
  Wifi,
  BellRing,
} from 'lucide-react';
import type { Section } from './SettingsPage.tsx';

// The help's articles. Text is written once here and laid out by HelpCenter: short paragraphs, steps, prompts to try,
// pictures of the real controls, and links between them.
//
// In text: `code`, **bold**, [[action]] for the key of a shortcut (an action of shortcuts.ts), and [words](target)
// for a link: `#article`, `settings:<section>`, `do:<action>` (something the window does) or a web address.
// `{device}` is the name of another of the user's computers that is online, or a stand-in; `{here}` is this one.

export type Doing = 'addProject' | 'newSession' | 'schedules' | 'files' | 'chat';
export type Target = { article: string } | { settings: Section } | { doing: Doing };
export type Prompt = { text: string; note?: string };
export type Block =
  | { kind: 'p'; text: string }
  | { kind: 'heading'; text: string }
  | { kind: 'list'; items: string[] }
  | {
      kind: 'steps';
      items: { title: string; text: string; action?: { label: string; target: Target } }[];
    }
  | { kind: 'prompts'; title?: string; items: Prompt[] }
  | { kind: 'callout'; tone: 'tip' | 'note' | 'warn'; title: string; text: string }
  | { kind: 'figure'; name: Figure; caption?: string }
  | { kind: 'code'; label?: string; text: string }
  | { kind: 'table'; head: [string, string]; rows: [string, string][] }
  | { kind: 'faq'; items: { q: string; a: string[] }[] }
  | { kind: 'news'; items: { title: string; text: string; article: string }[] }
  | { kind: 'keys' }
  | { kind: 'actions'; items: { label: string; target: Target }[] };
export type Figure =
  | 'map'
  | 'approval'
  | 'remote-approval'
  | 'modes'
  | 'terminal'
  | 'agents'
  | 'cache'
  | 'quota'
  | 'devices';
export type Article = {
  id: string;
  group: string;
  title: string;
  icon: typeof Bot;
  lead: string;
  // The version that brought it, marked as new while that is the program's version.
  since?: string;
  // What a browser cannot do: such an article is not offered there.
  desktop?: boolean;
  blocks: Block[];
  related?: string[];
  // More words the search finds it by.
  words?: string;
};

export const groups = [
  { id: 'start', name: '开始使用', icon: Rocket },
  { id: 'daily', name: '日常使用', icon: MessagesSquare },
  { id: 'devices', name: '多台电脑', icon: Laptop },
  { id: 'agents', name: '终端与 agent', icon: SquareTerminal },
  { id: 'account', name: '额度与账号', icon: Gauge },
  { id: 'care', name: '维护与安全', icon: ShieldCheck },
  { id: 'faq', name: '遇到问题', icon: CircleHelp },
] as const;

// The release the "new" marks and the page of what is new belong to.
export const release = '0.3.18';

export const articles: Article[] = [
  // 开始使用
  {
    id: 'how-it-works',
    group: 'start',
    title: '它是怎么工作的',
    icon: Compass,
    lead: 'Claude Code 住在你的服务器上，你的每台电脑都是它的手。',
    blocks: [
      { kind: 'figure', name: 'map' },
      {
        kind: 'list',
        items: [
          '**会话和记忆在服务端**：关掉客户端、换一台电脑、拿起手机，接着的都是同一个会话。',
          '**文件和命令在你的电脑上**：Claude 经一条加密通道，在你的电脑上读写文件、运行命令。项目不用搬到服务器，也不会被上传。',
          '**电脑主动连出**：不需要公网 IP，不开入站端口；断开后，这次连接的通道和临时密钥随即作废。',
        ],
      },
      {
        kind: 'callout',
        tone: 'tip',
        title: '步骤里出现 ssh device-… 是正常的',
        text: '这就是 Claude 在操作你的电脑：`device` 指会话所在的那台，`device-<名字>` 是你其他在线的电脑。',
      },
      {
        kind: 'callout',
        tone: 'note',
        title: '偶尔会把文件建在服务器上',
        text: '步骤里的路径以 `/data/state/native/` 开头时，Claude 是在服务器上操作的。告诉它“改在我的电脑上做”即可。',
      },
    ],
    related: ['first-steps', 'remote-ops', 'safety'],
    words: '原理 架构 服务器 执行通道 ssh 隧道 上传',
  },
  {
    id: 'first-steps',
    group: 'start',
    title: '第一次使用',
    icon: Rocket,
    lead: '加一个项目，说出任务，看着它做。',
    blocks: [
      {
        kind: 'steps',
        items: [
          {
            title: '登录 Claude 账号',
            text: '服务端登录一次，所有电脑、浏览器和 `ccdt` 共用。',
            action: { label: '账号与额度', target: { settings: 'account' } },
          },
          {
            title: '添加项目',
            text: '选电脑上的一个文件夹。会话按项目分组，Claude 就在这个文件夹里干活。',
            action: { label: '添加项目', target: { doing: 'addProject' } },
          },
          {
            title: '新建会话，说出任务',
            text: '和在终端里用 Claude Code 一样说话。悬停项目点 + 就在这个项目里新建。',
            action: { label: '新建会话', target: { doing: 'newSession' } },
          },
          {
            title: '看着它做',
            text: '每一步折叠成一行，点开看命令和输出。要动手时，按[审批模式](#approval)问你。',
          },
        ],
      },
      {
        kind: 'prompts',
        title: '第一句可以这样说',
        items: [
          { text: '这个项目是做什么的？读一遍目录结构，用三句话告诉我' },
          { text: '把这个项目跑起来，遇到报错就修' },
          { text: '看看最近一周的 git 提交，总结改了什么' },
        ],
      },
      {
        kind: 'callout',
        tone: 'tip',
        title: '临时问点什么，不用建项目',
        text: '直接点“新建会话”，得到一个普通会话，列在“最近”。',
      },
    ],
    related: ['how-it-works', 'approval', 'conversation'],
    words: '入门 开始 上手 新手 教程 添加项目 新建会话',
  },
  {
    id: 'whats-new',
    group: 'start',
    title: '这一版新增',
    icon: Sparkles,
    lead: '0.3.18：一个会话能用上你所有在线的电脑，其他 agent 也能把任务交给 Claude。',
    blocks: [
      {
        kind: 'news',
        items: [
          {
            title: '让 Claude 操作其他电脑',
            text: '在任何会话里说“在 {device} 上……”，它就过去执行，也能在两台电脑间传文件。',
            article: 'remote-ops',
          },
          {
            title: '在另一台电脑上开会话',
            text: '“其他设备”下悬停那台电脑的项目点 +；会话也能移过去。',
            article: 'devices',
          },
          {
            title: '无界面的机器保持在线',
            text: 'NAS、服务器上运行 `ccdt online`，Claude 随时能过去。',
            article: 'always-online',
          },
          {
            title: '其他 agent 调用 Claude',
            text: 'Codex、脚本用 `ccdt -p` 派发任务，审批交回调用方。',
            article: 'agents',
          },
          {
            title: '在编辑器里用',
            text: 'Zed、JetBrains 把 `ccdt acp` 配成 agent 即可。',
            article: 'acp',
          },
          {
            title: '项目各端一致',
            text: '项目由服务端保存，每台电脑、浏览器和 `ccdt` 看到同一份。',
            article: 'sessions',
          },
          {
            title: '自带 ccdt',
            text: '装了图形客户端就有 `ccdt`，随它升级。',
            article: 'ccdt',
          },
        ],
      },
      {
        kind: 'callout',
        tone: 'note',
        title: '完整的变更',
        text: '每一项改动与修复见[关于与更新](settings:about)里的“更新内容”。',
      },
    ],
    words: '新功能 更新 变化 版本',
  },

  // 日常使用
  {
    id: 'sessions',
    group: 'daily',
    title: '项目与会话',
    icon: FolderTree,
    lead: '项目是电脑上的一个文件夹；会话是一段对话，上下文和记忆都在服务端。',
    since: '0.3.18',
    blocks: [
      {
        kind: 'list',
        items: [
          '**项目**：左栏“项目”旁点 + 添加。由服务端登记，每台电脑、浏览器和 `ccdt` 看到同一份，可以改名。在 `ccdt` 里开会话，也会把那个文件夹登记为项目。',
          '**普通会话**：点“新建会话”得到，不属于项目，列在“最近”。工作目录默认在“文档\\CC Desk Tunnel”下，可在[常规](settings:general)里更换。',
          '**移到别处**：点输入框上方的项目标签，把会话移到另一个项目或另一台在线电脑。聊过的会话移走后，仍沿用原项目的记忆。',
          '**编辑重发**：鼠标移到自己的消息上点“编辑重发”，从那条消息之前分叉出新会话。原会话保留，已经做过的文件改动不会撤回。',
          '**移除项目**：只是不再列为项目。文件夹、会话和项目记忆都不动，其中的会话变成普通会话；再添加同一个文件夹，就都回来了。',
        ],
      },
      {
        kind: 'callout',
        tone: 'tip',
        title: '右键会话',
        text: '置顶、重命名、导出 Markdown、用 `ccdt` 打开，都在会话的右键菜单（或 ⋯）里。',
      },
    ],
    related: ['devices', 'conversation', 'ccdt'],
    words: '项目 文件夹 分叉 编辑重发 置顶 重命名 导出 移除 普通会话 最近',
  },
  {
    id: 'conversation',
    group: 'daily',
    title: '对话技巧',
    icon: MessagesSquare,
    lead: '和用 Claude Code 一样说话，这里多了几样顺手的东西。',
    blocks: [
      {
        kind: 'list',
        items: [
          '**运行中也能说**：Claude 在做时直接发消息，会加进正在进行的这一轮，用来纠偏或补充。',
          '**停止与继续**：输入框右下角停止这一轮。停止或断线后点“继续”接着做，不用再写一句话。',
          '**命令菜单**：输入 `/` 或 `\\`：压缩上下文，以及 Claude Code 的命令和 skills。',
          '**给它文件和截图**：点 +，或拖入、粘贴。消息里放的是文件在你电脑上的路径，Claude 去那里读，不上传。',
          '**大改动先出计划**：切到[计划模式](#approval)，它写出计划，你改好、批准后再动手。',
          '**模型与推理强度**：在输入框下方切换，只影响这个会话。',
        ],
      },
      {
        kind: 'callout',
        tone: 'note',
        title: '状态点停下、写着多久没有输出',
        text: '只说明这段时间没有新消息传来，不代表出了问题；跑长命令时常这样。',
      },
      { kind: 'heading', text: '快捷键' },
      { kind: 'keys' },
    ],
    related: ['approval', 'files', 'context'],
    words: '追加 停止 继续 斜杠 命令 skills 附件 截图 图片 粘贴 模型 推理强度 快捷键 查找',
  },
  {
    id: 'approval',
    group: 'daily',
    title: '审批模式',
    icon: ShieldCheck,
    lead: '决定 Claude 动手前问不问你。在输入框左下角切换，[[cycleMode]] 轮换。',
    blocks: [
      { kind: 'figure', name: 'modes' },
      {
        kind: 'list',
        items: [
          '**大多数时候用自动审批**（默认）：由 Claude Code 自己判断风险，只在必要时问你。',
          '**无人值守时一定用自动审批**：长任务、定时任务用别的模式，会停在审批处一直等人。',
          '**要问你时**，对话里出现审批卡片，写着要做什么、在哪台电脑上做。手机和浏览器里也能批准。',
        ],
      },
      { kind: 'figure', name: 'approval', caption: '审批卡片：允许一次，或拒绝并说明原因。' },
      {
        kind: 'callout',
        tone: 'warn',
        title: '绕过权限',
        text: '什么都不问，包括删除文件。默认不出现，要先在[常规](settings:general)里允许。',
      },
    ],
    related: ['conversation', 'remote-ops', 'browser'],
    words: '审批 权限 允许 拒绝 自动 手动 计划 接受编辑 绕过 bypass',
  },
  {
    id: 'files',
    group: 'daily',
    title: '文件面板',
    icon: FolderTree,
    lead: '本机、服务端和每台在线电脑的文件，在一个面板里浏览、预览、互相复制。',
    desktop: true,
    blocks: [
      {
        kind: 'steps',
        items: [
          {
            title: '打开',
            text: '标题栏右侧的文件按钮，或按 [[toggleFiles]]。',
            action: { label: '打开文件面板', target: { doing: 'files' } },
          },
          {
            title: '切换位置',
            text: '左上角选本机、服务端或其他在线电脑。',
          },
          {
            title: '预览、上传下载、复制粘贴',
            text: '在不同位置之间复制粘贴，就是在电脑之间传文件。',
          },
        ],
      },
      {
        kind: 'list',
        items: [
          '服务端上以编号命名的文件夹是会话的工作目录，旁边标出它属于哪个项目或会话。',
          '给 Claude 文件不用经过面板：拖进输入框即可。',
        ],
      },
      {
        kind: 'prompts',
        title: '也可以直接让 Claude 搬',
        items: [{ text: '把这台电脑桌面上的 report.pdf 复制到 {device} 的桌面' }],
      },
    ],
    related: ['remote-ops', 'conversation'],
    words: '文件 浏览 上传 下载 复制 粘贴 预览 SFTP',
  },
  {
    id: 'schedules',
    group: 'daily',
    title: '定时任务',
    icon: CalendarClock,
    lead: '到点自动给会话发一条消息，让 Claude 去做。',
    desktop: true,
    blocks: [
      {
        kind: 'prompts',
        title: '最简单的办法：直接跟 Claude 说',
        items: [
          { text: '每个工作日早上 9 点，在这个会话里检查依赖有没有安全更新' },
          { text: '每周五下午 5 点，总结这周的提交，写成周报草稿' },
        ],
      },
      {
        kind: 'steps',
        items: [
          {
            title: '或者自己建',
            text: '左侧的日历图标打开定时任务，点“新建任务”。',
            action: { label: '打开定时任务', target: { doing: 'schedules' } },
          },
          { title: '选会话和时间', text: '发给哪个会话（或每次新建）、几点、怎么重复。' },
          { title: '写提示词', text: '到点发送的内容，像平时说话一样写。' },
        ],
      },
      {
        kind: 'list',
        items: [
          '由这台电脑上的客户端到点发送：客户端要开着并已连接。关窗口只是收到托盘，不影响。',
          '晚了 10 分钟还发不出的那一次跳过，并通知你。',
          '用自动审批，否则会停在审批处等人。',
        ],
      },
    ],
    related: ['approval', 'background'],
    words: '定时 计划任务 每天 每周 cron 周报 自动',
  },

  // 多台电脑
  {
    id: 'devices',
    group: 'devices',
    title: '多台电脑',
    icon: Laptop,
    lead: '登录同一个服务端的每台电脑，都列在“其他设备”下。',
    since: '0.3.18',
    blocks: [
      { kind: 'figure', name: 'devices' },
      {
        kind: 'list',
        items: [
          '**接入**：在另一台电脑上装图形客户端，登录同一个服务端。没有图形界面的机器用 [ccdt online](#always-online)。',
          '**在那台电脑上开会话**：它在线时，悬停它的项目点 +，会话就在那台电脑上执行。',
          '**把会话移过去**：点输入框上方的项目标签，“移到项目…”按电脑列出。运行中的会话不能移到另一台电脑。',
          '**那台离线时**：会话只能查看，可以接到本机继续，或分叉到本机。',
        ],
      },
      {
        kind: 'callout',
        tone: 'tip',
        title: '不切会话也能用那台电脑',
        text: '在任何会话里直接说“在 {device} 上……”。见[让 Claude 操作其他电脑](#remote-ops)。',
      },
    ],
    related: ['remote-ops', 'always-online', 'browser'],
    words: '其他设备 多台 另一台 电脑 移动 离线 在线 分叉',
  },
  {
    id: 'remote-ops',
    group: 'devices',
    title: '让 Claude 操作其他电脑',
    icon: Network,
    lead: '在任何会话里说出电脑的名字，Claude 就到那台电脑上执行命令，或在两台电脑之间传文件。',
    since: '0.3.18',
    blocks: [
      {
        kind: 'prompts',
        title: '试试这样说',
        items: [
          {
            text: '看看 {device} 上各个磁盘还剩多少空间',
            note: 'Claude 先运行 `devices` 找到它，再 `ssh` 过去查。',
          },
          {
            text: '把这台电脑上的 dist/app.zip 传到 {device} 的桌面',
            note: '用 `scp` 在两台电脑之间直接传。',
          },
          { text: '在 {device} 上把这个仓库拉下来，装好依赖，跑一遍测试' },
          { text: '对比这台和 {device} 上 node、git、python 的版本' },
        ],
      },
      {
        kind: 'figure',
        name: 'remote-approval',
        caption: '到别的电脑上改动前，卡片写明是哪一台。',
      },
      {
        kind: 'list',
        items: [
          '你提到别的电脑时它才过去；没说时，命令都在会话自己的那台电脑上执行。',
          '在那边只做你要求的事，改动前先问你。',
          '那台电脑要在线：图形客户端开着（收在托盘也算），或运行着 `ccdt online`。',
          '名字写出能区分的一段就行。不确定时问它“现在哪些电脑在线”。',
        ],
      },
    ],
    related: ['devices', 'always-online', 'approval'],
    words: '远程 其他电脑 ssh scp 传文件 devices 多台',
  },
  {
    id: 'always-online',
    group: 'devices',
    title: '无界面的机器保持在线',
    icon: Wifi,
    lead: 'NAS、服务器、树莓派这类没有图形界面的机器，用 ccdt online 一直在线，Claude 随时能过去。',
    since: '0.3.18',
    blocks: [
      {
        kind: 'steps',
        items: [
          { title: '在那台机器上安装 ccdt', text: '只为当前用户安装，不需要管理员权限。' },
          { title: '登录', text: '运行 `ccdt login`，填服务地址、证书指纹和服务凭据。' },
          { title: '保持在线', text: '运行 `ccdt online`，断线自动重连，Ctrl+C 结束。' },
        ],
      },
      {
        kind: 'code',
        label: 'Linux、macOS 安装',
        text: 'curl -fsSL https://raw.githubusercontent.com/sun168567/cc-desk-tunnel/main/deploy/install-ccdt.sh | sh',
      },
      {
        kind: 'code',
        label: '放到后台运行',
        text: 'nohup ccdt online >> ~/ccdt-online.log 2>&1 &',
      },
      {
        kind: 'p',
        text: '开机自动在线（systemd 用户服务）和 Windows 的写法见[终端客户端文档](https://github.com/sun168567/cc-desk-tunnel/blob/main/docs/cli.md#保持在线)。',
      },
      {
        kind: 'prompts',
        title: '然后在任何会话里',
        items: [{ text: '看看 nas 上的 docker 容器都在不在跑，挂掉的告诉我原因' }],
      },
      {
        kind: 'callout',
        tone: 'note',
        title: '装了图形客户端的电脑不需要它',
        text: '客户端开着（包括收在托盘）时就在线。',
      },
    ],
    related: ['remote-ops', 'ccdt'],
    words: 'ccdt online 在线 NAS 服务器 树莓派 后台 systemd 无界面 headless',
  },
  {
    id: 'browser',
    group: 'devices',
    title: '浏览器与手机',
    icon: MonitorSmartphone,
    lead: '离开电脑时，用手机看进度、批准、追加指示。',
    blocks: [
      {
        kind: 'steps',
        items: [
          {
            title: '开启浏览器访问',
            text: '在桌面客户端的设置里打开，默认关闭。',
            action: { label: '浏览器访问', target: { settings: 'web' } },
          },
          { title: '登录', text: '打开显示的地址，用服务凭据登录。建议开启两步验证。' },
          { title: '装到手机上', text: '浏览器菜单里“添加到主屏幕”，像应用一样打开。' },
        ],
      },
      {
        kind: 'list',
        items: [
          '浏览器本身不执行命令：它操作在线电脑上的会话，或新建在服务端执行的普通会话。',
          '不用时保持关闭。',
        ],
      },
    ],
    related: ['approval', 'devices', 'safety'],
    words: '手机 浏览器 网页 Web 远程 外出 两步验证 主屏幕',
  },

  // 终端与 agent
  {
    id: 'ccdt',
    group: 'agents',
    title: '终端客户端 ccdt',
    icon: SquareTerminal,
    lead: '在自己的终端里用原版 Claude Code，和这里共用同一批会话。',
    since: '0.3.18',
    blocks: [
      { kind: 'figure', name: 'terminal' },
      {
        kind: 'table',
        head: ['命令', '作用'],
        rows: [
          ['`ccdt`', '在项目文件夹里运行：接着最近的会话，没有就新建'],
          ['`ccdt -r`', '从这个项目的会话里选一个'],
          ['`ccdt new`', '新建会话'],
          ['`ccdt usage`', '额度与调用统计'],
          ['`ccdt config`', '查看和修改设置'],
          ['`ccdt upgrade`', '升级服务端和 ccdt'],
        ],
      },
      {
        kind: 'list',
        items: [
          '**已经装好了**：图形客户端自带 `ccdt`，新开一个终端窗口就能用。macOS 要先把应用放进“应用程序”打开一次。',
          '**从这里打开**：会话右键“用 ccdt 打开”，直接在终端里接着当前会话。',
          '**同一个会话同时只在一处用**：终端开着时，这里显示它在做什么、输入框变灰；关掉终端就能接着在这里聊。',
        ],
      },
      {
        kind: 'callout',
        tone: 'tip',
        title: '更省 5 小时额度',
        text: '长任务放在 `ccdt` 里做，见[额度与用量](#quota)。',
      },
    ],
    related: ['quota', 'agents', 'always-online'],
    words: 'ccdt 终端 命令行 CLI 原版 terminal',
  },
  {
    id: 'agents',
    group: 'agents',
    title: '与其他 agent 协作',
    icon: Bot,
    lead: 'Claude 能调用你电脑上的 Codex 等 agent；其他 agent 和脚本也能把任务交给 Claude。',
    since: '0.3.18',
    blocks: [
      { kind: 'figure', name: 'agents' },
      { kind: 'heading', text: '让 Claude 调用其他 agent' },
      {
        kind: 'prompts',
        items: [
          {
            text: '用 codex exec 让 Codex 独立审一遍这次的改动，把它的意见和你的对比给我',
            note: '电脑上装了 Codex、Gemini CLI 等命令行 agent 就行，不用配置。',
          },
        ],
      },
      { kind: 'heading', text: '让其他 agent 调用 Claude' },
      {
        kind: 'p',
        text: '其他 agent 或脚本在电脑上运行 `ccdt -p`，写法与 `claude -p` 相同。派出的任务就是普通会话，这里看得到、能插话、能审批。',
      },
      {
        kind: 'code',
        label: '派发',
        text: 'ccdt -p "修复登录页的报错" --output-format json',
      },
      {
        kind: 'table',
        head: ['跟进', '作用'],
        rows: [
          ['`ccdt status <会话>`', '在做什么、在等什么'],
          ['`ccdt tell <会话> "…"`', '中途追加指示'],
          ['`ccdt wait <会话>`', '等到这一轮结束'],
          ['`ccdt approve` · `deny`', 'Claude 要批准时（退出码 2），由调用方回答'],
        ],
      },
      {
        kind: 'callout',
        tone: 'tip',
        title: '把用法交给你的 agent',
        text: '告诉它“运行 `ccdt help agents`，按里面的说明把任务交给 Claude”。那是写给模型看的完整说明。',
      },
    ],
    related: ['acp', 'ccdt'],
    words: 'agent Codex Gemini 脚本 ccdt -p 派发 自动化 退出码',
  },
  {
    id: 'acp',
    group: 'agents',
    title: '在编辑器里用（ACP）',
    icon: Plug,
    lead: 'Zed、JetBrains、acpx 等支持 ACP 的工具，把 ccdt acp 配成 agent，就能在编辑器里用服务端上的 Claude。',
    since: '0.3.18',
    blocks: [
      {
        kind: 'code',
        label: 'Zed：settings.json',
        text: '{ "agent_servers": { "CC Desk Tunnel": { "type": "custom", "command": "ccdt", "args": ["acp"] } } }',
      },
      {
        kind: 'code',
        label: 'acpx：项目里的 .acpxrc.json',
        text: '{ "agents": { "ccdt": { "argv": ["ccdt", "acp"] } } }',
      },
      {
        kind: 'list',
        items: [
          '会话建在编辑器打开的文件夹对应的项目里，这里同样看得到。',
          '审批变成编辑器里的权限请求；审批模式变成会话模式。',
          'ACP 没有“提问”：Claude 的问题作为回复显示，下一条消息就是回答。',
          '不能往进行中的一轮追加内容，要纠偏就取消后重发。',
        ],
      },
      {
        kind: 'callout',
        tone: 'note',
        title: '会话建在运行它的那台电脑上',
        text: '要用另一台电脑，在那台电脑上的编辑器里接入；或者载入它已有的会话。',
      },
    ],
    related: ['agents', 'ccdt'],
    words: 'ACP Zed JetBrains acpx 编辑器 IDE',
  },

  // 额度与账号
  {
    id: 'quota',
    group: 'account',
    title: '额度与用量',
    icon: Gauge,
    lead: '5 小时和每周额度在“账号与额度”里看，也可以显示在输入框旁。',
    blocks: [
      { kind: 'figure', name: 'quota' },
      {
        kind: 'list',
        items: [
          '**5 小时额度紧张时用 `ccdt`**：图形客户端经官方 Agent SDK 运行。据社区实测，同样的用量，计入 5 小时额度的比例约为交互式 CLI 的两倍；每周额度不受影响。',
          '**输入框旁显示额度**：在[外观](settings:appearance)里打开。',
          '**调用日志**：每次请求的模型、Token 和等价费用；金额按 API 价格估算，不是账单。',
          '**额度是空的**：它来自 Claude Code 的一次运行，发一条消息，或在账号页里刷新。',
        ],
      },
      { kind: 'actions', items: [{ label: '账号与额度', target: { settings: 'account' } }] },
    ],
    related: ['ccdt', 'context', 'account'],
    words: '额度 用量 5 小时 每周 限额 费用 token 调用日志 省',
  },
  {
    id: 'context',
    group: 'account',
    title: '上下文与缓存',
    icon: Hourglass,
    lead: '会话空闲约 1 小时，提示缓存就过期；之后的第一条消息要按全价重读整段上下文。',
    blocks: [
      { kind: 'figure', name: 'cache' },
      {
        kind: 'list',
        items: [
          '**自动压缩**：开启后，服务端在缓存过期前把会话压缩好，回来时更省。',
          '不开时，快过期会在输入框旁提醒。',
          '**手动压缩**：输入 `/compact`，或从 `/` 命令菜单里选。',
          '输入框上方的上下文占用，显示这个会话用了多少。',
        ],
      },
      {
        kind: 'actions',
        items: [{ label: '上下文与缓存', target: { settings: 'context' } }],
      },
    ],
    related: ['quota', 'conversation'],
    words: '缓存 过期 压缩 compact 上下文 空闲 1 小时',
  },
  {
    id: 'account',
    group: 'account',
    title: 'Claude 账号',
    icon: UserRound,
    lead: '账号登录在服务端，所有电脑、浏览器和 ccdt 共用。',
    blocks: [
      {
        kind: 'list',
        items: [
          '**普通登录**：打开官方授权页，把页面给出的代码粘贴回来。',
          '**Setup token**：由服务端生成，或粘贴已有的；这种方式可能看不到邮箱、订阅类型和完整额度。',
          '**退出登录**：移除服务端保存的令牌，保留会话记录。在 `ccdt` 里执行官方的 `/logout` 不会移除它。',
        ],
      },
      {
        kind: 'callout',
        tone: 'warn',
        title: '服务器所在地就是你的使用地点',
        text: '请求都从服务器发出。请用位于支持地区、来源正常的服务器，见[账号须知](https://github.com/sun168567/cc-desk-tunnel/blob/main/docs/account.md)。',
      },
      { kind: 'actions', items: [{ label: '账号与额度', target: { settings: 'account' } }] },
    ],
    related: ['quota', 'safety'],
    words: '登录 退出 账号 setup token 订阅 授权',
  },

  // 维护与安全
  {
    id: 'background',
    group: 'care',
    title: '后台、通知与断线',
    icon: BellRing,
    lead: '关掉窗口不会断开；任务完成或要你处理时会通知你。',
    blocks: [
      {
        kind: 'list',
        items: [
          '**关窗口只是收到托盘**：连接和任务照常进行，托盘图标右键“退出”才断开。连接期间电脑不会自动睡眠。',
          '**通知**：窗口不在前台时，完成、失败、等待审批、Claude 提问都会通知，每一类可以单独关掉。',
          '**断网不用管**：客户端自己重连，任务在服务端继续。电脑离线超过 5 分钟任务才停下，回来点“继续”。',
          '**多个服务端**：每个服务端一个窗口，凭据、草稿和定时任务各自保存。',
        ],
      },
      { kind: 'actions', items: [{ label: '通知设置', target: { settings: 'notifications' } }] },
    ],
    related: ['schedules', 'upgrade'],
    words: '托盘 后台 通知 断线 重连 睡眠 多个服务端 窗口',
  },
  {
    id: 'upgrade',
    group: 'care',
    title: '升级',
    icon: Download,
    lead: '客户端、ccdt 和服务端要同一版本；在客户端里点一下就能升级，不用登录服务器。',
    blocks: [
      {
        kind: 'steps',
        items: [
          {
            title: '看到新版本',
            text: '左侧出现下载图标，或到“关于与更新”里检查。',
            action: { label: '关于与更新', target: { settings: 'about' } },
          },
          { title: '先升级服务端', text: '约一分钟后自动重连。有会话正在运行时会提示。' },
          {
            title: '再升级客户端',
            text: 'Windows 自动下载安装；macOS、Linux 重新下载安装。',
          },
        ],
      },
      {
        kind: 'list',
        items: ['自带的 `ccdt` 随图形客户端升级；单独安装的运行 `ccdt upgrade`。'],
      },
    ],
    related: ['background', 'troubleshoot'],
    words: '升级 更新 版本 不一致 新版本',
  },
  {
    id: 'safety',
    group: 'care',
    title: '安全须知',
    icon: ShieldAlert,
    lead: '服务器能以你的身份在每台已连接的电脑上执行命令。它必须是你自己控制、可信的机器。',
    blocks: [
      {
        kind: 'list',
        items: [
          '**服务凭据等于完全控制权**：不要截图、不要贴到聊天和 issue 里。泄漏后在服务器上运行 `sudo cc-desk-tunnel token` 更换。',
          '**不是沙箱**：Claude 能访问你的用户在那台电脑上能访问的一切，也能连到你其他在线的电脑。',
          '**数据会离开本机**：读到的文件片段和命令输出，经服务器发往模型服务。',
          '**浏览器访问**不用时关掉，开启时用两步验证。',
        ],
      },
      {
        kind: 'p',
        text: '完整说明见[安全须知](https://github.com/sun168567/cc-desk-tunnel#安全须知)。',
      },
    ],
    related: ['account', 'browser'],
    words: '安全 凭据 token 泄漏 沙箱 风险 隐私',
  },

  // 遇到问题
  {
    id: 'troubleshoot',
    group: 'faq',
    title: '连不上',
    icon: Server,
    lead: '看登录窗口红字的第一行，那是原因。',
    blocks: [
      {
        kind: 'table',
        head: ['提示', '怎么办'],
        rows: [
          ['连接超时、拒绝连接、无法解析', '核对服务地址和端口，确认服务器在线、端口已放行'],
          [
            '证书不受信任、指纹不匹配',
            '自签证书填安装时给出的 SHA256 指纹；服务端换过证书要重新填',
          ],
          ['服务凭据不正确', '核对凭据；连续失败多次会被暂时拒绝'],
          ['版本不一致', '按提示升级其中一端'],
          [
            'SSH 服务没能启动、被拦截',
            '多半是杀毒软件隔离了自带的 sshd.exe 或 PowerShell，先看它的保护记录',
          ],
          ['执行通道没有就绪', '经代理连接时，确认代理允许同一地址的多条连接'],
        ],
      },
      {
        kind: 'p',
        text: '要查是哪一段断的：[关于与更新](settings:about)里“打开日志文件夹”，看 `client.log`。更多见[常见问题与排查](https://github.com/sun168567/cc-desk-tunnel/blob/main/docs/troubleshooting.md)。',
      },
    ],
    related: ['faq', 'upgrade'],
    words: '连不上 连接失败 证书 指纹 凭据 杀毒 sshd 执行通道 代理 日志',
  },
  {
    id: 'faq',
    group: 'faq',
    title: '常见问题',
    icon: CircleHelp,
    lead: '用的时候最常见的疑问。',
    blocks: [
      {
        kind: 'faq',
        items: [
          {
            q: 'Claude 为什么一直在运行 ssh？',
            a: [
              '它就是这样操作你的电脑的：Claude Code 跑在服务器上，经 `ssh device-…` 到你的电脑上执行。见[它是怎么工作的](#how-it-works)。',
            ],
          },
          {
            q: '我的文件会被上传吗？',
            a: [
              '不会整份上传。Claude 在你的电脑上读文件，读到的片段和命令输出经服务器发给模型，和本地用 Claude Code 一样。',
            ],
          },
          {
            q: '5 小时额度掉得很快？',
            a: [
              '图形客户端经 Agent SDK 运行，计入 5 小时额度约为交互式 CLI 的两倍。长任务放到 `ccdt` 里做。见[额度与用量](#quota)。',
            ],
          },
          {
            q: '提示“缓存过期”是什么意思？',
            a: [
              '空闲约 1 小时后，下一条消息要按全价重读上下文。开启自动压缩可以省下这一次。见[上下文与缓存](#context)。',
            ],
          },
          {
            q: '任务停在那里不动了？',
            a: [
              '先看是不是在等你审批或回答问题。状态点写着多久没有输出，只是这段时间没有新消息，长命令常这样。',
            ],
          },
          {
            q: '电脑睡眠或断网了，任务会怎样？',
            a: [
              '任务在服务端继续，命令等电脑连回来再执行。离线超过 5 分钟任务才停下，回来点“继续”。',
            ],
          },
          {
            q: '怎么让 Claude 少问我？',
            a: [
              '用自动审批；只想让它直接改文件、命令仍先问，用接受编辑。见[审批模式](#approval)。',
            ],
          },
          {
            q: 'Claude 把文件建在了服务器上？',
            a: ['步骤里的路径以 `/data/state/native/` 开头时是这样。告诉它“改在我的电脑上做”。'],
          },
          {
            q: '额度、模型列表是空的？',
            a: ['它们来自 Claude Code 的一次运行：发一条消息，或在账号页里刷新。'],
          },
          {
            q: '两个窗口同时在一个文件夹里改东西？',
            a: ['两个连接的会话同时在同一个文件夹里运行时会提示，两边的改动可能互相覆盖。'],
          },
        ],
      },
    ],
    related: ['troubleshoot', 'how-it-works'],
    words: '问题 疑问 为什么',
  },
];

// The prompts the front page and an empty session offer, most telling first. Those naming another computer are
// offered only when one is online.
export const starters: (Prompt & { device?: boolean; article: string })[] = [
  { text: '看看 {device} 上各个磁盘还剩多少空间', device: true, article: 'remote-ops' },
  { text: '这个项目是做什么的？读一遍目录结构，用三句话告诉我', article: 'first-steps' },
  { text: '把这台电脑上的 dist/app.zip 传到 {device} 的桌面', device: true, article: 'remote-ops' },
  { text: '把这个项目跑起来，遇到报错就修', article: 'first-steps' },
  { text: '每周五下午 5 点，总结这周的提交写成周报草稿', article: 'schedules' },
  {
    text: '用 codex exec 让 Codex 独立审一遍这次的改动，把它的意见和你的对比给我',
    article: 'agents',
  },
];

// What an empty session offers to say first: about its project, or about the computer for a session of none, and
// one that reaches another computer when one is online.
export function suggestions({
  project,
  other,
  schedules,
}: {
  project: boolean;
  other?: string;
  schedules: boolean;
}) {
  if (project)
    return [
      '这个项目是做什么的？读一遍目录结构，用三句话告诉我',
      '把这个项目跑起来，遇到报错就修',
      other
        ? `在 ${other} 上把这个仓库拉下来，跑一遍测试`
        : '看看最近一周的 git 提交，总结改了什么',
    ];
  return [
    '看看这台电脑各个磁盘还剩多少空间，哪些文件夹最占地方',
    other
      ? `对比这台和 ${other} 上 node、git、python 的版本`
      : '列出这台电脑上装了哪些开发工具和版本',
    ...(schedules ? ['每周五下午 5 点提醒我写周报，帮我设好定时任务'] : []),
  ];
}
