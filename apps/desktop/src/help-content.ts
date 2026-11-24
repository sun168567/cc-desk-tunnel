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
import type { Section } from './SettingsPage.tsx';

// The help's articles. Text is written once here and laid out by HelpCenter: short paragraphs, steps, prompts to try,
// pictures of the real controls, and links between them.
//
// In text: `code`, **bold**, [[action]] for the key of a shortcut (an action of shortcuts.ts), and [words](target)
// for a link: `#article` or `#article#heading`, `settings:<section>`, `do:<action>` (something the window does) or a
// web address. `{device}` is the name of another of the user's computers that is online, or a stand-in; `{here}` is
// this one.
//
// What is new: `since` on an article that a version brought, or on a block that a version added to an older
// article, with `news` naming the change for the page of what is new. It is marked while the program is of that
// version and goes by itself with the next; the page of what is new is made of these marks. When a release brings
// a feature, write how to use it here and mark it (scripts/release.mjs reminds of this).

export type Doing = 'addProject' | 'newSession' | 'schedules' | 'files' | 'chat';
export type Target = { article: string } | { settings: Section } | { doing: Doing };
export type Prompt = { text: string; note?: string };
type Fresh = { since?: string; news?: string };
export type Block = Fresh &
  (
    | { kind: 'p'; text: string }
    | { kind: 'heading'; text: string; id?: string }
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
    | { kind: 'keys' }
    | { kind: 'actions'; items: { label: string; target: Target }[] }
  );
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
  // The version that brought the whole article.
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
  { id: 'settings', name: '设置', icon: Settings },
  { id: 'care', name: '维护与安全', icon: ShieldCheck },
  { id: 'faq', name: '遇到问题', icon: CircleHelp },
] as const;

const settingsOf = (section: Section, label: string) => ({
  kind: 'actions' as const,
  items: [{ label, target: { settings: section } }],
});

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
    related: ['how-it-works', 'approval', 'settings'],
    words: '入门 开始 上手 新手 教程 添加项目 新建会话',
  },

  // 日常使用
  {
    id: 'sessions',
    group: 'daily',
    title: '项目与会话',
    icon: FolderTree,
    lead: '项目是电脑上的一个文件夹；会话是一段对话，上下文和记忆都在服务端。',
    blocks: [
      {
        kind: 'list',
        items: [
          '**项目**：左栏“项目”旁点 + 添加，可以改名。在 `ccdt` 里开会话，也会把那个文件夹登记为项目。',
          '**普通会话**：点“新建会话”得到，不属于项目，列在“最近”。工作目录默认在“文档\\CC Desk Tunnel”下，可在[常规](settings:general)里更换。',
        ],
      },
      {
        kind: 'list',
        since: '0.3.18',
        news: '项目由服务端保存，各端看到同一份',
        items: [
          '**各端同一份项目**：项目由服务端登记，每台电脑、浏览器和 `ccdt` 看到的一样，离线电脑的项目也在；改名各端一致。',
          '**移除项目**：只是不再列为项目。文件夹、会话和项目记忆都不动，其中的会话变成普通会话；再添加同一个文件夹，就都回来了。',
        ],
      },
      {
        kind: 'list',
        items: [
          '**移到别处**：点输入框上方的项目标签，把会话移到另一个项目或另一台在线电脑。聊过的会话移走后，仍沿用原项目的记忆。',
          '**编辑重发**：鼠标移到自己的消息上点“编辑重发”，从那条消息之前分叉出新会话。原会话保留，已经做过的文件改动不会撤回。',
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
    lead: '决定 Claude 动手前问不问你，在输入框左下角切换。',
    blocks: [
      { kind: 'figure', name: 'modes' },
      {
        kind: 'list',
        items: [
          '**大多数时候用自动审批**（默认）：由 Claude Code 自己判断风险，只在必要时问你。',
          '**无人值守时用自动审批**：别的模式会停在审批处一直等人。自动审批偶尔也会问，搭配[“不等审批，直接拒绝”](#unattended#deny)就不会停。',
          '**切换**：点输入框左下角，或按 [[cycleMode]] 轮换。',
          '**要问你时**，对话里出现审批卡片，写着要做什么、在哪台电脑上做。手机和浏览器里也能批准。',
        ],
      },
      { kind: 'figure', name: 'approval', caption: '审批卡片：允许一次，或拒绝并说明原因。' },
      {
        kind: 'callout',
        tone: 'note',
        title: '“Claude Code 安全拦截”在任何模式下都会问',
        text: '有些操作，Claude Code 自己的安全检查一定会请你确认，自动审批、绕过权限也一样。这类卡片上标着“Claude Code 安全拦截”。',
      },
      {
        kind: 'callout',
        tone: 'warn',
        title: '绕过权限',
        text: '除了安全拦截，什么都不问，包括删除文件和在你的电脑上执行任意命令。默认不出现，要先在[常规](settings:general)里允许；只建议在测试机或虚拟机上用。',
      },
    ],
    related: ['conversation', 'unattended', 'permissions'],
    words: '审批 权限 允许 拒绝 自动 手动 计划 接受编辑 绕过 bypass 安全拦截',
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
          { title: '切换位置', text: '左上角选本机、服务端或其他在线电脑。' },
          {
            title: '预览、上传下载、复制粘贴',
            text: '在不同位置之间复制粘贴，就是在电脑之间传文件。',
          },
        ],
      },
      {
        kind: 'list',
        items: ['给 Claude 文件不用经过面板：拖进输入框即可。'],
      },
      {
        kind: 'list',
        since: '0.3.18',
        news: '文件面板标出服务端工作目录属于哪个会话',
        items: ['服务端上以编号命名的文件夹是会话的工作目录，旁边标出它属于哪个项目或会话。'],
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
          '用自动审批，否则会停在审批处等人；怎么让它一路做完见[让任务自己跑完](#unattended)。',
        ],
      },
    ],
    related: ['unattended', 'approval', 'background'],
    words: '定时 计划任务 每天 每周 cron 周报 自动',
  },

  // 多台电脑
  {
    id: 'devices',
    group: 'devices',
    title: '多台电脑',
    icon: Laptop,
    lead: '登录同一个服务端的每台电脑，都列在“其他设备”下。',
    blocks: [
      { kind: 'figure', name: 'devices' },
      {
        kind: 'list',
        items: [
          '**接入**：在另一台电脑上装图形客户端，登录同一个服务端。没有图形界面的机器用 [ccdt online](#always-online)。',
          '**那台离线时**：会话只能查看，可以接到本机继续，或分叉到本机。',
        ],
      },
      {
        kind: 'list',
        since: '0.3.18',
        news: '在另一台电脑的项目里开会话，或把会话移过去',
        items: [
          '**在那台电脑上开会话**：它在线时，悬停它的项目点 +，会话就在那台电脑上执行。',
          '**把会话移过去**：点输入框上方的项目标签，“移到项目…”按电脑列出。运行中的会话不能移到另一台电脑。',
        ],
      },
      { kind: 'heading', text: '那台电脑上还没有项目' },
      {
        kind: 'p',
        text: '这里只能在别的电脑已有的项目里开会话。它还没有项目时，两种办法：',
      },
      {
        kind: 'list',
        items: [
          '**在那台电脑上添加**：在它的客户端里添加项目，或在它的项目文件夹里运行一次 `ccdt`。之后这里就能在它的项目里开会话。',
          '**不建项目，直接让 Claude 过去做**：在这台电脑的任何会话里说出那台电脑的名字。',
        ],
      },
      {
        kind: 'prompts',
        since: '0.3.18',
        items: [{ text: '看看 {device} 的 D:\\work 下有哪些项目，挑最近改过的那个跑一遍测试' }],
      },
    ],
    related: ['remote-ops', 'always-online', 'browser'],
    words: '其他设备 多台 另一台 电脑 移动 离线 在线 分叉 新建 项目',
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
    blocks: [
      { kind: 'figure', name: 'terminal' },
      { kind: 'heading', text: '推荐用法：在 ccdt 里干活，在客户端里看' },
      {
        kind: 'steps',
        items: [
          {
            title: '在客户端里建好项目和会话',
            text: '项目和会话一目了然，之后在哪一端都能接着。',
            action: { label: '添加项目', target: { doing: 'addProject' } },
          },
          {
            title: '会话右键“用 ccdt 打开”',
            text: '直接在终端里接着这个会话，不用再登录。',
          },
          {
            title: '一边在 ccdt 里做，一边在客户端里看',
            text: '终端里的请求更省 5 小时额度；客户端同步显示它做了什么，折叠排版更好读。',
          },
        ],
      },
      {
        kind: 'callout',
        tone: 'note',
        title: '同一个会话同时只在一处输入',
        text: '终端开着时，客户端里显示它在做什么，输入框变灰；关掉终端就能接着在客户端里聊。',
      },
      { kind: 'heading', text: '常用命令' },
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
        since: '0.3.18',
        news: '图形客户端自带 ccdt',
        items: [
          '**已经装好了**：图形客户端自带 `ccdt`，随它升级，新开一个终端窗口就能用。macOS 要先把应用放进“应用程序”打开一次。',
        ],
      },
    ],
    related: ['quota', 'agents', 'always-online'],
    words: 'ccdt 终端 命令行 CLI 原版 terminal 额度 省',
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
      { kind: 'code', label: '派发', text: 'ccdt -p "修复登录页的报错" --output-format json' },
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
          '**5 小时额度紧张时用 `ccdt`**：图形客户端经官方 Agent SDK 运行。据社区实测，同样的用量，计入 5 小时额度的比例约为交互式 CLI 的两倍；每周额度不受影响。见 [ccdt 的推荐用法](#ccdt)。',
          '**输入框旁显示额度**：在[外观](settings:appearance)里打开。',
          '**快速模式不走套餐额度**：订阅账号开了它，直接从额外用量扣费，见[快速模式](#model-settings#fast)。',
          '**调用日志**：每次请求的模型、Token 和等价费用；金额按 API 价格估算，不是账单。',
          '**额度是空的**：它来自 Claude Code 的一次运行，发一条消息，或在账号页里刷新。',
        ],
      },
      settingsOf('account', '账号与额度'),
    ],
    related: ['ccdt', 'context', 'model-settings'],
    words: '额度 用量 5 小时 每周 限额 费用 token 调用日志 省',
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
      settingsOf('account', '账号与额度'),
    ],
    related: ['quota', 'safety'],
    words: '登录 退出 账号 setup token 订阅 授权',
  },

  // 设置
  {
    id: 'settings',
    group: 'settings',
    title: '设置指南',
    icon: Settings,
    lead: '设置项多，大多数保持默认就好。先看想达到什么效果，再去改对应的几项；几项合起来才起作用的，下面各篇讲清楚怎么搭配。',
    blocks: [
      {
        kind: 'table',
        head: ['想要', '看这里'],
        rows: [
          ['离开一两个小时，回来接着聊也不贵', '[缓存与压缩](#context)'],
          ['夜里、出门时让任务自己跑完', '[让任务自己跑完](#unattended)'],
          [
            '看到 Claude 在想什么；更快；主模型忙时不中断',
            '[思考、速度与备用模型](#model-settings)',
          ],
          ['Claude 记住我的习惯，照我的规矩提交代码', '[记忆与说明](#memory)'],
          ['命令输出被截断、连接总超时、脚本用哪种 Shell', '[在你电脑上执行](#execution)'],
          ['限制 Claude 能改什么', '[权限相关的开关](#permissions)'],
        ],
      },
      {
        kind: 'callout',
        tone: 'tip',
        title: '找设置',
        text: '设置页左上角的搜索框按功能找，比如“托盘”“额度”“压缩”。难懂的设置旁有 ?，点开就是讲它的那一段。',
      },
      { kind: 'heading', text: '设置分三组', id: 'scopes' },
      {
        kind: 'table',
        head: ['分组', '改了影响谁'],
        rows: [
          ['**本机**', '只影响这台电脑上的这个客户端'],
          ['**服务端**', '连到这个服务端的所有电脑（Shell 只对这台电脑）'],
          ['**Claude Code**', '服务器上 Claude Code 自己的设置，所有会话和 `ccdt` 共用'],
        ],
      },
      { kind: 'heading', text: '有几项 CLI 设置只在 ccdt 里起作用', id: 'cli' },
      {
        kind: 'p',
        text: 'CLI 设置和 Claude Code 的 `/config` 是同一份，从下一次运行起生效。其中几项是官方终端界面的功能，图形客户端里的会话用不上：',
      },
      {
        kind: 'table',
        head: ['设置', '在图形客户端里'],
        rows: [
          ['额度用尽后自动继续', '这一轮随额度用尽结束；可以[到点发一句“继续”](#unattended#limit)'],
          ['提问无人回答时', '提问卡片一直等你回答'],
          ['文件检查点', '不记录；图形客户端里没有 `/rewind`'],
          ['触发安全拦截时换模型（关闭时）', '不会暂停让你选，这一轮出错结束'],
        ],
      },
      settingsOf('claude', '打开 CLI 设置'),
    ],
    related: ['context', 'unattended', 'model-settings'],
    words: '设置 选项 配置 本机 服务端 Claude Code CLI config 默认 ccdt',
  },
  {
    id: 'context',
    group: 'settings',
    title: '缓存与压缩',
    icon: Hourglass,
    lead: 'Claude 每一轮都要把整个会话重读一遍。有缓存时重读很便宜；缓存过期或被打断，下一轮就按全价重读。好几项设置都围绕这件事。',
    blocks: [
      { kind: 'figure', name: 'cache' },
      { kind: 'heading', text: '缓存是怎么回事', id: 'how' },
      {
        kind: 'p',
        text: '每发一条消息，Claude Code 都把系统提示、说明文件、之前的每条消息和工具结果整段再发一遍。和上一轮相同的前半段从缓存里读，价格约为正常输入的十分之一；缓存没了，这一整段就要重新处理、重新写入。会话越长，离开后回来的第一轮越慢、越贵。',
      },
      {
        kind: 'list',
        items: [
          '**缓存会过期**：最后一次请求后 5 分钟或 1 小时没有新请求，就过期。每次请求都重新计时。',
          '**这些操作会让缓存作废**：换模型、开关快速模式、接入或移除 MCP 服务、压缩。老一些的模型换推理强度也会。模型最好在会话开头选定。',
          '**改说明文件不会**，但正在进行的会话也读不到新内容，压缩或新建会话后才用上。',
        ],
      },
      { kind: 'heading', text: '缓存时长：5 分钟还是 1 小时', id: 'ttl' },
      {
        kind: 'p',
        text: '1 小时的缓存撑得过午饭、开会这样的空档，代价是写入更贵：按 API 价格，写入 1 小时缓存是正常输入的 2 倍，5 分钟的是 1.25 倍。一直连续对话、从不停下超过 5 分钟的，1 小时只是多花。',
      },
      {
        kind: 'table',
        head: ['请求', '默认'],
        rows: [
          ['订阅账号的主对话', '1 小时'],
          ['订阅账号的子代理、工作流、压缩等', '5 分钟'],
          ['API Key、第三方接口', '都是 5 分钟'],
        ],
      },
      {
        kind: 'callout',
        tone: 'note',
        title: '套餐额度用完后，默认会变成 5 分钟',
        text: '超出套餐额度、开始用额外用量（usage credits）付费时，Claude Code 把主对话改用 5 分钟缓存。想这时也保留 1 小时，把[“提示缓存时长”](settings:claude)明确设为 1 小时。',
      },
      {
        kind: 'p',
        text: '“子任务的提示缓存时长”管子代理、工作流、压缩这些主对话之外的请求，一般保持默认。',
      },
      { kind: 'heading', text: '离开前自动压缩', id: 'idle' },
      {
        kind: 'p',
        text: '压缩把长长的会话换成一份摘要，之后每轮重读的只是摘要。趁缓存还在时压缩，读的是缓存，便宜；过期后再压缩，就得按全价读一遍。[上下文与缓存](settings:context)里的自动压缩就是替你抢在过期前做这件事：会话空闲到设定时间，服务端自己压缩，你的电脑和客户端不用在线。',
      },
      {
        kind: 'list',
        items: [
          '**默认关**，在[上下文与缓存](settings:context)里打开。',
          '**只对 1 小时缓存的会话有效**。“提示缓存时长”设成 5 分钟，或用 API Key 登录时，缓存等不到压缩就过期了，自动压缩不会发生。',
          '**空闲多久后压缩**：默认 50 分钟。越接近 60 分钟，你中途回来、压缩白做的可能越小，但留给它的余量也越少。',
          '**上下文至少**：小会话就算全价重读也不贵，不值得压缩。',
          '**压缩是一次真实请求**，计入额度，摘要也会丢掉细节。离开一会儿就回来的，用不着它。',
          '**关掉时**，快过期时在会话里提醒你，压不压你来定。已经过期的长会话，先切到便宜些的模型再压缩，或者干脆新开一个。',
          '`ccdt` 里的会话由 Claude Code 自己压缩：开关和上下文大小用这里的，时间固定在约 54 分钟。',
        ],
      },
      { kind: 'heading', text: '上下文快满时的压缩', id: 'window' },
      {
        kind: 'p',
        text: '这是另一回事：会话长到接近模型的上下文上限时，Claude Code 自动压缩后接着做。由 [CLI 设置](settings:claude)里的“自动压缩上下文”控制，默认开。',
      },
      {
        kind: 'list',
        items: [
          '**自动压缩窗口**：上下文到多大就压缩，最小 10 万。设小一些，每轮重读的少，更省、Claude 也更专注；代价是更常压缩、丢细节。1M 上下文的模型可以设在 30 万～50 万，免得会话越聊越贵。',
          '**提前准备压缩摘要**：后台先把摘要算好，到压缩时少等一会儿。',
          '**关掉“自动压缩上下文”**，上下文满了只能手动压缩或新开会话；`ccdt` 里的空闲压缩也随之关闭。',
        ],
      },
      {
        kind: 'callout',
        tone: 'tip',
        title: '手动压缩挑时机',
        text: '在两件事之间输入 `/compact`，比做到一半被自动压缩好。走错了路、想整段放弃时，新开一个会话比压缩更干净。',
      },
      { kind: 'heading', text: '从数字看缓存', id: 'numbers' },
      {
        kind: 'p',
        text: '回复小结和会话栏可以显示“缓存读取”和“缓存写入”，在[外观](settings:appearance)里选。',
      },
      {
        kind: 'list',
        items: [
          '**读取远大于写入**：缓存在起作用。',
          '**某一轮写入特别大**：缓存刚作废，通常是离开太久、换了模型或刚压缩过。',
          '**每一轮写入都很大**：有什么在不断打断缓存，比如来回换模型。',
        ],
      },
      {
        kind: 'actions',
        items: [
          { label: '打开上下文与缓存', target: { settings: 'context' } },
          { label: '打开 CLI 设置', target: { settings: 'claude' } },
        ],
      },
    ],
    related: ['quota', 'model-settings', 'conversation'],
    words:
      '缓存 过期 压缩 compact 上下文 空闲 1 小时 5 分钟 ttl 提示缓存 自动压缩 窗口 缓存读取 缓存写入 省',
  },
  {
    id: 'unattended',
    group: 'settings',
    title: '让任务自己跑完',
    icon: Moon,
    lead: '长任务、夜里的任务、定时任务，最怕停在一个问题上干等。几项设置配合起来，任务能自己走到底。',
    blocks: [
      { kind: 'heading', text: '任务会停在哪里', id: 'stops' },
      {
        kind: 'table',
        head: ['停在', '怎么办'],
        rows: [
          ['等你审批', '用**自动审批**，再打开[“不等审批，直接拒绝”](#unattended#deny)'],
          ['Claude 提问', '在任务里写明不要提问，见[下文](#unattended#question)'],
          ['额度用尽', '[到点发一句“继续”](#unattended#limit)'],
          ['你的电脑睡了或断了', '客户端开着时电脑不会自动睡眠；离线超过 5 分钟任务才停下'],
        ],
      },
      { kind: 'heading', text: '不等审批，直接拒绝', id: 'deny' },
      {
        kind: 'list',
        items: [
          '[CLI 设置](settings:claude)里打开后，要你批准的调用不再等你，立即拒绝；Claude 知道被拒，会换个做法，或者在最后告诉你。',
          '**和自动审批一起用**：允许规则和自动审批照常先判断，自动审批放行它认为安全的，剩下的才被拒绝。手动审批下几乎什么都做不成。',
          '**对所有会话生效**，包括 `ccdt`。任务跑完记得关掉，不然你在旁边时它也不会再问你。',
        ],
      },
      { kind: 'heading', text: 'Claude 提问', id: 'question' },
      {
        kind: 'p',
        text: '图形客户端里的提问卡片会一直等你回答。无人值守的任务，在提示词里说清楚做到哪一步、不要提问：',
      },
      {
        kind: 'prompts',
        items: [
          {
            text: '把 docs 目录里过时的说明都改掉，改完再停。中途不要问我，拿不准的按最保守的做法，最后把这些地方列给我。',
          },
        ],
      },
      {
        kind: 'p',
        text: '`ccdt` 里还可以用 CLI 设置“提问无人回答时”：过一会儿带着已选的选项自己继续。',
      },
      { kind: 'heading', text: '额度用尽', id: 'limit' },
      {
        kind: 'p',
        text: '图形客户端里，额度用尽这一轮就结束了。想让它在额度重置后接着做，直接跟 Claude 说，它会建一个[定时任务](#schedules)：',
      },
      {
        kind: 'prompts',
        items: [{ text: '额度重置以后，在这个会话里发一句“继续刚才的任务”' }],
      },
      {
        kind: 'p',
        text: '重置时间在[账号与额度](settings:account)里看。`ccdt` 里不用这样做：CLI 设置“额度用尽后自动继续”默认开，终端会等到重置后接着做。',
      },
      { kind: 'heading', text: '一套可靠的搭配', id: 'recipe' },
      {
        kind: 'steps',
        items: [
          { title: '审批模式选自动审批', text: '在输入框左下角切换。' },
          {
            title: '打开“不等审批，直接拒绝”',
            text: '跑完记得关掉。',
            action: { label: 'CLI 设置', target: { settings: 'claude' } },
          },
          { title: '提示词说清终点', text: '做到哪一步为止，拿不准时怎么办，最后汇报什么。' },
          {
            title: '客户端开着',
            text: '关窗口只是收到托盘；完成和失败的通知开着，回来一眼看到结果。',
            action: { label: '通知设置', target: { settings: 'notifications' } },
          },
        ],
      },
    ],
    related: ['schedules', 'approval', 'background'],
    words: '无人值守 夜里 长任务 定时 自动 不等审批 直接拒绝 提问 超时 额度用尽 继续 睡眠',
  },
  {
    id: 'model-settings',
    group: 'settings',
    title: '思考、速度与备用模型',
    icon: Brain,
    lead: '这几项决定 Claude 想多深、跑多快、主模型忙时怎么办。最容易误会的两点：新模型上关掉“思考”没有用；订阅账号的快速模式要另外付费。',
    blocks: [
      { kind: 'heading', text: '思考', id: 'thinking' },
      {
        kind: 'list',
        items: [
          '**思考**：只对老一些的模型有用。Opus 5.5、Sonnet 5.5、Haiku 5.5 和 Fable 系列总会思考，关掉也照样想。',
          '**想让它少想、快一点**：在输入框左下角的“模型与推理强度”里调低强度，每个会话可以不同。',
          '**显示思考过程**：只决定你看不看得到思考的摘要，Claude 想多少、用多少额度都不变。想知道它为什么这样做时打开，对话里会多出可以展开的思考。',
        ],
      },
      { kind: 'heading', text: '快速模式', id: 'fast' },
      {
        kind: 'list',
        items: [
          '输出明显更快，每个 Token 也更贵。只有部分模型支持，比如 Opus 5.5、Fable 5.2。',
          '**订阅账号不走套餐额度**：快速模式直接从额外用量（usage credits）扣费，套餐额度还有剩也一样；没开通额外用量就用不了。',
          '中途开关会让下一轮全价重读。要用，就在会话开头打开。',
          '额外用量用完时，自动退回普通速度继续。',
        ],
      },
      { kind: 'heading', text: '主模型忙或出问题时', id: 'fallback' },
      {
        kind: 'list',
        items: [
          '**备用模型**：主模型过载或不可用时，按顺序换下一个，把这一轮做完；下一条消息又先试主模型。不填时只重试主模型，还不行就报错。',
          '最多 3 个，用逗号分开，比如 `sonnet, haiku`。换过去的那一轮没有缓存，会贵一些。',
          '**触发安全拦截时换模型**：Claude Code 的安全检查偶尔会拦下一条请求，默认换一个模型继续。关掉后，图形客户端里这一轮出错结束；`ccdt` 里会暂停，让你选换模型还是改提示词。',
        ],
      },
      settingsOf('claude', '打开 CLI 设置'),
    ],
    related: ['context', 'quota'],
    words:
      '思考 thinking 推理强度 effort 显示思考 快速模式 fast 额外用量 usage credits 备用模型 fallback 安全拦截 换模型',
  },
  {
    id: 'memory',
    group: 'settings',
    title: '记忆与说明',
    icon: NotebookPen,
    lead: 'Claude 的每个会话都从空白开始，靠说明文件和自动记忆知道你的习惯。它们放在哪里，决定了 Claude 记得什么。',
    blocks: [
      {
        kind: 'table',
        head: ['', '在哪里，谁会读'],
        rows: [
          [
            '**全局说明**',
            '服务器上的用户级 `CLAUDE.md`，每个会话开头都读。在[全局说明](settings:instructions)里编辑',
          ],
          [
            '**项目里的 `CLAUDE.md`、`AGENTS.md`**',
            '在你电脑的项目文件夹里。Claude Code 在服务器上，**不会自动读**',
          ],
          ['**自动记忆**', 'Claude 自己记的笔记，在服务器上按项目保存'],
        ],
      },
      { kind: 'heading', text: '让 Claude 读你项目里的说明', id: 'project' },
      {
        kind: 'p',
        text: '省事的做法是在全局说明里写一句，以后每个会话都会照做：',
      },
      {
        kind: 'code',
        label: '写进全局说明',
        text: '进入一个项目后，先读项目根目录的 CLAUDE.md 或 AGENTS.md（如果有），按其中的约定工作。',
      },
      { kind: 'heading', text: '自动记忆', id: 'auto' },
      {
        kind: 'list',
        items: [
          'Claude 在工作中记下你纠正过的做法、偏好和项目情况，下次会话开头读入。',
          '**按项目分开**：同一台电脑上同一个项目文件夹的会话共用一份；普通会话各有各的。聊过的会话移到别的项目，仍用原来项目的记忆。',
          '想让它记住什么，直接说“记住：……”；记错了，说“把关于……的记忆删掉”。',
          '“后台整理记忆”在空闲时归并、整理已有的记忆。关掉“自动记忆”，Claude 既不读也不写这些笔记。',
        ],
      },
      {
        kind: 'callout',
        tone: 'note',
        title: '改了说明什么时候生效',
        text: '说明在会话开头读一次。中途改了，正在进行的会话读不到，压缩或新建会话后才用上。',
      },
      { kind: 'heading', text: '回复语言与 Git 习惯', id: 'habits' },
      {
        kind: 'list',
        items: [
          '**回复语言**：原样交给 Claude，作为“总是用这种语言回复”的要求，写 `chinese` 或 `中文` 都行。',
          '**提交与 PR 的署名**：默认在提交信息和 PR 描述里加上 Claude 的署名，选“不加署名”去掉。',
          '**内置的提交与 PR 流程说明**：官方附带的提交、开 PR 的做法和仓库状态。有自己的规范时关掉它，把规范写进全局说明。',
        ],
      },
      {
        kind: 'actions',
        items: [
          { label: '打开全局说明', target: { settings: 'instructions' } },
          { label: '打开 CLI 设置', target: { settings: 'claude' } },
        ],
      },
    ],
    related: ['conversation', 'sessions'],
    words:
      '记忆 memory 自动记忆 CLAUDE.md AGENTS.md 全局说明 说明文件 记住 忘掉 回复语言 中文 署名 git 提交 PR',
  },
  {
    id: 'execution',
    group: 'settings',
    title: '在你电脑上执行',
    icon: SquareTerminal,
    lead: 'Claude 在你电脑上读文件、改文件、跑构建，都是经执行通道运行命令完成的。Shell、命令输出上限和连接等待时间，决定这条路走得顺不顺。',
    blocks: [
      { kind: 'heading', text: 'Shell：PowerShell 还是 Git Bash', id: 'shell' },
      {
        kind: 'list',
        items: [
          '不指定时 Claude 按任务选。选了也只是优先，任务明显适合另一种时它仍会换。',
          '**PowerShell**：操作 Windows 本身（服务、注册表、进程）更顺。',
          '**Git Bash**：熟悉 Linux 命令、项目里多是 shell 脚本时。先装 Git for Windows，重新连接后才能选。',
          'PowerShell 7 随客户端自带。这一项每台 Windows 电脑分别设置，从每个会话的下一条消息起生效。',
        ],
      },
      settingsOf('shell', '打开 Shell'),
      { kind: 'heading', text: '命令输出上限', id: 'output' },
      {
        kind: 'list',
        items: [
          '一条命令的输出超过上限，多出的部分存成文件，Claude 只看到开头和文件位置，要再去读。',
          '构建日志、测试结果常被截断、Claude 反复去翻文件时调大。上限越大，每次输出占的上下文越多，会话更快变长。',
          '范围 4K～128K 字符，默认 30K。',
        ],
      },
      { kind: 'heading', text: '工具搜索与 Artifact', id: 'tools' },
      {
        kind: 'list',
        items: [
          '**工具搜索**：工具的说明不再每次全部发出，用到时再查。接了很多 MCP 工具时能省下大量上下文。官方账号默认开；第三方接口要支持才能开。',
          '**Artifact 网页**：Claude 可以把文档、方案、图表发布成 claude.ai 上只有你能看的网页，需要时再分享。用不上可以关掉。',
        ],
      },
      { kind: 'heading', text: '连接等待时间', id: 'waits' },
      {
        kind: 'list',
        items: [
          '连上服务器、启动本机的 SSH 服务、执行通道就绪，三步各有时限，超时就重试。',
          '**大多数电脑不用改**。公司域账号连不上域控制器，或安全软件扫描很慢时，第二步会久一些；总是超时才调大。',
          '“执行通道就绪”至少比“本机 SSH 服务启动”多 35 秒。只影响这台电脑。',
        ],
      },
      settingsOf('connection', '打开连接'),
    ],
    related: ['remote-ops', 'devices', 'troubleshoot'],
    words:
      'shell powershell git bash 命令输出 截断 上限 工具搜索 mcp artifact 连接等待 超时 域控制器 安全软件',
  },
  {
    id: 'permissions',
    group: 'settings',
    title: '权限相关的开关',
    icon: Lock,
    lead: '问不问你由审批模式决定。下面几个开关各管一小块，容易高估它们的作用。',
    blocks: [
      { kind: 'heading', text: '允许绕过权限', id: 'bypass' },
      {
        kind: 'p',
        text: '在[常规](settings:general)里打开后，审批模式里才出现“绕过权限”，只影响这台电脑。选了它，除了 Claude Code 安全拦截，什么都不问，包括删除文件、在你电脑上执行任意命令。只在测试机或虚拟机上用。',
      },
      { kind: 'heading', text: '禁止在工作目录外写文件', id: 'writes' },
      {
        kind: 'list',
        items: [
          '它限制的是 Claude Code 的写文件、编辑工具，这些工具只作用于**服务器上的文件**。',
          '**它挡不住对你电脑的修改**：Claude 在你电脑上改文件经命令完成，不受这个开关限制。要防误改，靠审批模式。',
          '开启后，这些工具也不能改 Claude Code 自己的设置文件；Claude 的记忆和计划文件不受影响。',
        ],
      },
      { kind: 'heading', text: '文件检查点', id: 'checkpoints' },
      {
        kind: 'p',
        text: '编辑前留快照，供 `/rewind` 撤回。只在 `ccdt` 里有用，也只覆盖服务器上用编辑工具改的文件。你电脑上的项目用 Git 管理更可靠。',
      },
      {
        kind: 'callout',
        tone: 'note',
        title: '还有两条',
        text: '“不等审批，直接拒绝”见[让任务自己跑完](#unattended#deny)。Claude Code 安全拦截在任何模式下都会问，见[审批模式](#approval)。',
      },
      settingsOf('claude', '打开 CLI 设置'),
    ],
    related: ['approval', 'safety'],
    words: '权限 绕过 bypass 工作目录 写文件 检查点 rewind 撤回 拦截',
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
      settingsOf('notifications', '通知设置'),
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
          { title: '再升级客户端', text: 'Windows 自动下载安装；macOS、Linux 重新下载安装。' },
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
            q: '在另一台电脑上开不了会话？',
            a: [
              '那台电脑要在线，而且要有项目。没有项目时，在任何会话里让 Claude 连过去做。见[多台电脑](#devices#那台电脑上还没有项目)。',
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

// The page of what is new in a version is made of the articles and blocks marked with it.
export type News = { title: string; text: string; article: string; icon: typeof Bot };
export function newsOf(version: string, list: Article[] = articles): News[] {
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
            text: `见“${article.title}”`,
            article: article.id,
            icon: article.icon,
          });
  }
  return found;
}
export const hasNews = (version: string) => newsOf(version).length > 0;
// How new an article is in a version: brought by it, or changed by it.
export const freshness = (article: Article, version: string) =>
  article.since === version
    ? 'new'
    : article.blocks.some((block) => block.since === version)
      ? 'changed'
      : null;

// The prompts the front page offers, most telling first. Those naming another computer are offered only when one is
// online.
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
