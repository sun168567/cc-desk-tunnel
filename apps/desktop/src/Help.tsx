import { project } from './project.tsx';

const topics: { title: string; lines: string[] }[] = [
  {
    title: '它是怎么工作的',
    lines: [
      'Claude Code 运行在你的云端服务器上，项目和工具留在这台 Windows 电脑上。客户端连接服务后会临时打开一条只通向本机的执行通道，Claude 通过它读写项目文件、执行 PowerShell 命令。',
      '会话的上下文与记忆保存在云端的 Claude Code 里；这里显示的是它的镜像，关闭客户端不会丢失会话。',
    ],
  },
  {
    title: '会话与项目',
    lines: [
      '“新建会话”得到一个不属于任何项目的普通会话，工作目录在“文档\\CC Desk Tunnel”下。在“项目”旁点加号添加一个本机文件夹后，可以在这个项目里建会话。',
      '会话和项目都可以置顶；项目的显示名称只是本机的别名，不改动文件夹。右键会话可以改名、分叉、导出为 Markdown 或删除。删除会话不会动项目文件。',
      '用户消息上的“编辑重发”会从那条消息之前分叉出一个新会话，原会话保留；已经执行的文件改动不会撤回。',
    ],
  },
  {
    title: '审批模式',
    lines: [
      '自动审批：由 Claude Code 自行判断风险，只在必要时来问你。适合长任务和定时任务。',
      '手动审批：编辑文件、执行命令之前都先询问。接受编辑：文件编辑直接通过，命令仍询问。计划模式：只调研并给出计划，不做改动。',
      '这四种都是 Claude Code 自己的模式，客户端只负责把它的询问转给你。',
    ],
  },
  {
    title: '给 Claude 文件',
    lines: [
      '点输入框左下角的加号选择文件，或把文件拖进输入框、从资源管理器复制后粘贴。消息里放进的是文件在这台电脑上的路径，Claude 会通过执行通道去读它。',
    ],
  },
  {
    title: '定时任务',
    lines: [
      '到点时由客户端向指定会话（或每次新开一个会话）发送预设的提示词。只在客户端运行并已连接时触发；晚于计划 10 分钟仍发不出的那一次会跳过。',
      '无人值守时请让目标会话使用自动审批，否则任务会停在审批处等人。',
    ],
  },
  {
    title: '后台与通知',
    lines: [
      '关闭窗口默认只是收到托盘，连接和正在运行的任务不受影响；在托盘图标上右键选“退出”才会结束连接。远程连接期间电脑不会自动睡眠。',
      '窗口不在前台时，任务完成、失败、等待审批或 Claude 向你提问，会通过 Windows 通知提醒；点通知回到对应会话。每一类都可以在“设置 → 通知”里单独关掉。',
    ],
  },
  {
    title: '常见问题',
    lines: [
      '连接不上：登录页的红字第一行是原因，后面是该检查的地方。连接分两段——先是到服务地址的控制连接（地址、证书、服务凭据），通过后本机启动隧道组件连到服务器的隧道端口（默认 7000/TCP）。',
      '提示隧道组件退出、被拦截或找不到：多半是 frpc.exe 被杀毒软件隔离，先看安全软件的保护记录。提示隧道端口超时或被拒绝：到服务器防火墙和云安全组放行隧道端口。',
      '提示证书不受信任或指纹不匹配：自签证书要填写安装时给出的 SHA256 指纹，服务端换过证书后指纹也要换。',
      '登录页提示版本不一致：客户端与服务端需要同一版本，按提示升级其中一端。',
      '额度、模型列表没有显示：它们来自 Claude Code 的一次运行，在“账号与额度”里点刷新，或先发一条消息。',
      '杀毒软件拦截 frpc：它是随客户端分发的开源内网穿透组件，只在连接期间运行；是否放行由你决定，客户端不会自己修改安全软件的设置。',
    ],
  },
];
const keys: [string, string][] = [
  ['Enter', '发送消息'],
  ['Shift + Enter', '换行'],
  ['/ 或 \\', '打开会话命令（压缩上下文、刷新状态）'],
  ['Esc', '关闭菜单与弹出层'],
];

export default function Help() {
  return (
    <section className="page" aria-label="帮助">
      <div className="page-body">
        <h1 className="page-title">帮助</h1>
        {topics.map((topic) => (
          <div key={topic.title}>
            <h2 className="page-heading">{topic.title}</h2>
            <div className="card help-text">
              {topic.lines.map((line) => (
                <p key={line}>{line}</p>
              ))}
            </div>
          </div>
        ))}
        <h2 className="page-heading">按键</h2>
        <dl className="card key-list">
          {keys.map(([key, use]) => (
            <div key={key}>
              <dt>
                <kbd>{key}</kbd>
              </dt>
              <dd>{use}</dd>
            </div>
          ))}
        </dl>
        <p className="muted">
          后退、前进、侧栏、新建会话、缩放等组合键在“设置 → 快捷键”里查看和修改，也可以整体关闭。
        </p>
        {project.url && (
          <p className="muted">
            更完整的部署与使用说明见项目主页 <code>{project.url}</code>。
          </p>
        )}
      </div>
    </section>
  );
}
