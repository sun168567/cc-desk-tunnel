import { Fragment } from 'react';
import { project } from './project.tsx';
import { Page } from './ui.tsx';

// What the product is first, then what people need to find their way: the concepts that are not obvious, and the
// features one would not notice. What anyone knows from other programs is left out; details are in the docs.
const topics: { title: string; lines: string[] }[] = [
  {
    title: '这是什么',
    lines: [
      'Claude Code 运行在你的服务器上，文件和命令留在你自己的电脑上：Claude 经一条加密的执行通道，在你的电脑上读写文件、运行命令。',
      '一个服务端集中管理你的各台电脑、所有会话和 agent。图形客户端、浏览器、终端里的 `ccdt`，以及其他 agent，用的都是同一批会话，在哪一端都能接着做。',
      '会话的上下文和记忆保存在服务端的 Claude Code 里，关掉客户端、换一台电脑都不会丢。',
    ],
  },
  {
    title: '会话、项目与电脑',
    lines: [
      '项目是某台电脑上的一个文件夹，由服务端登记，各台电脑看到同一份，离线电脑的项目也列出。在“项目”旁点加号添加；用 `ccdt` 或其他 agent 在一个文件夹里开会话，也会把它登记为项目。',
      '“新建会话”得到不属于项目的普通会话，列在“最近”，工作目录默认在“文档\\CC Desk Tunnel”下，可在“设置 → 常规”更换。',
      '移除项目只是不再把文件夹列为项目：文件夹、会话和 Claude 记下的项目记忆都不动，其中的会话变为普通会话；再添加这个文件夹就都回来。',
      '会话在它所在的那台电脑上执行。“其他设备”下是你其他电脑上的项目和会话：那台电脑在线时，可以在这里直接对话、审批，或在它的项目里新建会话；离线时只能查看，可以在本机继续或分叉到本机。',
      '点输入框上方的项目标签，可以把会话移到另一个项目，或另一台在线电脑。聊过的会话移走后，仍沿用原项目的记忆。',
      '消息上的“编辑重发”从那条消息之前分叉出一个新会话，原会话保留，已经执行的文件改动不会撤回。标着“未送达原生”的消息则直接放回输入框重发。',
    ],
  },
  {
    title: '终端客户端 ccdt',
    lines: [
      '`ccdt` 在你自己的终端里打开原版 Claude Code，与这里共用会话和上下文。在项目文件夹里运行 `ccdt` 接着最近的会话，`ccdt -r` 选一个，`ccdt new` 新建；会话菜单的“用 ccdt 打开”直接在终端里打开当前会话。',
      'Windows 安装版自带 `ccdt`，安装时已加入 PATH；其他系统按项目主页的一行命令安装。`ccdt` 与服务端需要同一版本，不一致时它会提示升级。',
      '同一个会话同时只能在一处使用：终端开着时，这里显示它在做什么，输入框变灰，关掉终端后接着在这里聊。',
      '比起图形客户端，`ccdt` 更省 5 小时额度，见“上下文、缓存与额度”。',
      '`ccdt online` 不开终端，只让这台电脑保持在线，供 Claude 在这里执行命令；适合没有图形界面的服务器，或想让电脑一直可用时。',
    ],
  },
  {
    title: '与其他 agent 协作',
    lines: [
      '让 Claude 调用其他 agent：你的电脑上装了 Codex、Gemini CLI 等命令行 agent 时，直接在对话里让 Claude 用它们，例如经 `codex exec` 交出一个子任务、拿回结果，不需要额外配置。Claude 的命令结束时，它启动的程序也随之结束，所以适合一次性完成的调用。',
      '让其他 agent 调用 Claude：其他 agent 或脚本在电脑上运行 `ccdt -p "任务"`，就把任务交给了服务端上的 Claude，写法与 `claude -p` 相同；之后用 `ccdt status`、`ccdt tell`、`ccdt wait`、`ccdt approve` 等查看进度、追加指示、等结果、处理审批。Claude 请求批准或提问时，交给调用方回答。',
      '这样派出的任务就是普通会话，这里看得到它在做什么，也可以插话、审批。会说 ACP 的编辑器和工具（Zed、JetBrains、acpx 等）把 `ccdt acp` 配成 agent 即可接入。完整写法见 `ccdt help agents`。',
    ],
  },
  {
    title: '文件',
    lines: [
      '文件面板（标题栏右侧的按钮）浏览本机、服务端和其他在线电脑的文件：预览、上传下载，在不同位置之间复制粘贴。服务端上以编号命名的工作目录，旁边标出它属于哪个项目或会话。',
      '给 Claude 文件：点输入框的加号，或把文件拖入、粘贴。消息里放的是文件在你电脑上的路径，Claude 经执行通道去读，文件不会上传。',
    ],
  },
  {
    title: '审批模式',
    lines: [
      '在输入框左下切换，每种模式旁有一行说明。自动审批由 Claude Code 自己判断风险，只在必要时询问。',
      '无人值守的长任务和定时任务请用自动审批，否则会停在审批处一直等人。',
    ],
  },
  {
    title: '上下文、缓存与额度',
    lines: [
      '会话空闲约 1 小时后提示缓存过期，之后的第一条消息要按全价重读整段上下文。“设置 → 上下文与缓存”可以让服务端在过期前自动压缩；不开时，快过期会在输入框旁提醒。',
      '输入 `/` 或 `\\` 打开命令菜单：压缩上下文，以及 Claude Code 的命令和 skills。',
      '额度和调用统计在“账号与额度”；在“设置 → 外观”可以让输入框旁显示 5 小时和每周额度。',
      '5 小时额度紧张时用 `ccdt`：图形客户端经官方 Agent SDK 运行 Claude Code，`ccdt` 终端里是交互式的原版 CLI。据社区实测，同样的用量，经 SDK 计入 5 小时额度的比例约为交互式的两倍；每周额度不受影响。',
      '运行中的状态点停下、写明多久没有输出，只说明这段时间没有新消息传来，不代表出了问题。',
    ],
  },
  {
    title: '定时任务',
    lines: [
      '到点时由客户端向指定会话或新会话发送预设的提示词，也可以直接让 Claude 帮你设置。只在客户端开着并已连接时发出，晚于计划 10 分钟仍发不出的那一次跳过。',
    ],
  },
  {
    title: '多个服务端与浏览器',
    lines: [
      '每个服务端一个窗口，凭据、草稿和定时任务各自保存。打开程序先是登录窗口，选登录过的服务或输入新地址；在 Mac 上，新的登录窗口从托盘菜单或“设置 → 连接”打开。通知、快捷键等本机设置各窗口共用。',
      '两个连接的会话同时在同一个文件夹里运行时会提示：两边同时改动文件可能互相覆盖。',
      '在“设置 → 浏览器访问”开启后，可以用浏览器或手机操作在线电脑上的会话，或新建在服务端执行的普通会话；手机上可以安装为应用。',
    ],
  },
  {
    title: '后台与通知',
    lines: [
      '关闭窗口默认只是收到托盘，连接和任务照常进行，托盘图标右键“退出”才断开；连接期间电脑不会自动睡眠。',
      '窗口不在前台时，任务完成、失败、等待审批或 Claude 提问会发系统通知，每一类可在“设置 → 通知”关闭。',
    ],
  },
  {
    title: 'Claude 账号',
    lines: [
      '在“账号与额度”登录：普通登录走官方授权；也可以用 Setup token，由服务端生成或粘贴已有的。Setup token 登录时可能看不到邮箱、订阅类型和完整额度，以实际请求为准。',
      '退出登录会移除服务端保存的令牌、保留会话记录，但不会撤销令牌在别处的使用；在 `ccdt` 里执行官方的 /logout 不会移除它。',
    ],
  },
  {
    title: '常见问题',
    lines: [
      '连不上：看登录窗口红字的第一行，那是原因。连接分两段：先连服务地址（地址、证书、服务凭据），通过后服务端再经同一个地址连回本机的执行通道，所以只需要这一个端口。',
      'SSH 服务没能启动，或执行通道没有就绪：Windows 上多半是杀毒软件隔离了自带的 sshd.exe 或 PowerShell，先看它的保护记录。它们只在连接期间运行、只监听本机，是否放行由你决定。经代理连接时，确认代理允许同一地址的多条连接。',
      '证书不受信任或指纹不匹配：自签证书要填安装时给出的 SHA256 指纹，服务端换过证书后要重新填。',
      '版本不一致：客户端、`ccdt` 与服务端需要同一版本，按登录窗口的提示升级其中一端。',
      '额度、模型列表是空的：它们来自 Claude Code 的一次运行，发一条消息，或在“账号与额度”里刷新。',
    ],
  },
];

// `code` in a line is shown as code.
function Line({ text }: { text: string }) {
  return (
    <p>
      {text
        .split('`')
        .map((part, index) =>
          index % 2 ? <code key={index}>{part}</code> : <Fragment key={index}>{part}</Fragment>,
        )}
    </p>
  );
}

export default function Help() {
  return (
    <Page title="帮助">
      {topics.map((topic) => (
        <div key={topic.title}>
          <h2 className="page-heading">{topic.title}</h2>
          <div className="card help-text">
            {topic.lines.map((line) => (
              <Line key={line} text={line} />
            ))}
          </div>
        </div>
      ))}
      <p className="muted">快捷键在“设置 → 快捷键”里查看和修改。</p>
      {project.url && (
        <p className="muted">
          完整的部署与使用说明见项目主页 <code>{project.url}</code>。
        </p>
      )}
    </Page>
  );
}
