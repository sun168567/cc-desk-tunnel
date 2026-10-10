# 架构

## 定位

多端开发时，Claude Code 常部署在云服务器或另一台常开的机器上挂长任务，而项目代码、编辑器和调试工具链在 Windows 本机。两端之间反复拷贝项目、维护两套环境是主要负担。本项目把 agent 的运行端与项目的执行端分开：Linux 承载原生 Claude Code，Windows 承载界面、项目和执行工具，由 Claude 直接远程操作 Windows。

边界：

- 个人自用，单个 Linux 服务、同一时间一台在线的 Windows 设备，多会话。不做多租户。
- 只在官方 Agent SDK 与未修改的官方 CLI 之上做胶水层。不改 CLI 本体，不复制官方客户端的私有协议，不伪造地区、身份或客户端特征，不含针对检测的对抗设计。
- 不把付费订阅转换成共享 API。账号登录只走官方 `claude auth`，凭据由 CLI 自己保存。
- 模型上下文与长期记忆属于云端的 Claude Code；客户端只同步展示，不重组上下文。

## 组成

```text
Windows：桌面客户端 + 回环 OpenSSH + PowerShell 7 + 项目
  │ 主动 WSS：认证、对话、审批、设置
  │ 主动 WSS：执行通道，每条 SSH 连接一条
  ▼
Linux：代理服务 ── 官方 Agent SDK ── 未修改的 Claude Code ── 模型服务
  │                                   │
  │                        原生 Bash 调用 ssh -F <配置>
  └──── 回环端口，与执行通道逐字节对接 ──┘
                    │
                    ▼
Windows：读写文件 / PowerShell 命令 → 结果回到 Claude → 事件回到界面
```

| 部分 | 采用 | 说明 |
| --- | --- | --- |
| 工程 | Node.js 24 + TypeScript，npm workspaces | 服务端由 Node 直接运行 TypeScript，无构建步骤；两端共享 Zod 契约 |
| 客户端 | Electron + React + Vite | 渲染页无 Node 权限；主进程只管连接、本机组件和少量本机文件 |
| 服务端 | Node.js + ws | 一条 WSS 承载全部控制消息，同一个地址另接执行通道的连接；没有 REST 会话接口或网页界面 |
| 原生集成 | 官方 Agent SDK `query` + 指定的 CLI 可执行文件 | 输入、事件、审批、取消都走官方接口；不解析终端画面 |
| 执行通道 | WSS 隧道转发 + OpenSSH | 转发只把字节对接起来；认证、加密与流量控制都是 OpenSSH 自己的 |
| 部署 | Docker / Compose | CLI、PTY 与服务同容器；数据在宿主机目录 |

控制通道负责身份、会话、输入输出和审批；执行通道只负责模型发起的 Windows 操作。客户端不直接调用模型，模型请求都发生在 Linux。

## 连接建立

```text
客户端 ── 校验证书后的 WSS，首帧携带服务凭据 ──▶ 服务
       ◀── 本次连接专用的通道密钥（tunnel.offer）──
客户端：生成临时 SSH 主机密钥与登录密钥，启动回环 sshd
客户端 ── 登录私钥 + 主机公钥（经 WSS）──▶ 服务
服务：写入私有连接目录，用 ssh -F <配置> windows 探测
       ── tunnel.ready ──▶ 客户端，界面此时才允许发起任务
Claude Code：原生 Bash ──▶ ssh -F <配置> windows ──▶ PowerShell 7
```

`ssh` 连的是服务进程在回环上为这台设备开的端口。每来一条 SSH 连接：

```text
ssh ── TCP ──▶ 服务的回环端口
服务 ── tunnel.open（通道编号，经控制连接）──▶ 客户端
客户端 ── 新的 WSS，校验同一张证书，首帧是通道编号 + 通道密钥 ──▶ 服务
客户端 ── TCP ──▶ 本机回环 sshd
服务：把 ssh 的连接与这条 WSS 对接，此后两个方向都只是 SSH 的字节
```

几个要点：

1. 先建立对服务端的信任，再下发秘密。支持“IP + 固定自签证书指纹”，不强制域名，但没有跳过验证的模式。执行通道的每条连接与控制连接走同一个地址、做同样的证书校验，通过后才发出通道密钥。
2. 通道按需建立，用完即关：没有预先保持的空闲连接，也就没有悄悄失效的连接要处理。每条 SSH 连接独占一条 WSS，转发不解析 SSH，也不自己做多路复用。选型过程见[评估记录](research/linux-client-and-tunnel.md)。
3. 通道密钥每个连接随机生成，随连接结束作废。它只能把一条连接接到正在等待的 SSH 连接上；SSH 客户端固定校验主机密钥，拿到通道密钥的人完成不了 SSH 握手。
4. 临时私钥不进入会话文本、事件或提示词。提示词只告诉 Claude SSH 配置文件的路径和主机别名。
5. Windows 侧密钥授权的是当前普通用户；sshd 由一个 Job Object 归属，客户端退出时一并结束。
6. 一条通道中断只影响它承载的那条 SSH 连接，下一条命令会建立新的通道。通道不再送达数据却没有断开时，两端各自发现：服务端的 `ssh` 每 10 秒询问一次，连续两次没有应答就退出；客户端对每条通道每 15 秒发一次 WebSocket ping，连续两次没有应答就放弃它和本机的那条 SSH 连接。SSH 中断不保证 Windows 上的子进程全部结束；界面只报告实际观察到的结果。

模块细节见 [Linux 服务](../apps/server/README.md) 与 [Windows 客户端](../apps/desktop/README.md)，端口与证书见[部署与安全边界](deployment.md)。

## 关键决定

- **提示词优先。** 原生的 Read / Edit / Bash 实际操作的是 CLI 所在的 Linux。项目不禁用或替换这些工具，而是在系统提示词里说明“用户的项目在 Windows，通过给定的 SSH 配置操作”，并提供好用的远程调用方式。偶尔的 Linux 本地操作被视为可接受的低风险偏差。
- **不做执行 MCP。** Claude 用它已经会的 `ssh`，不需要学习自定义工具；代理也不必维护一套远程执行协议。
- **审批交给原生。** 新会话默认原生自动审批，可切换手动、计划、接受编辑。代理只把 CLI 实际发出的权限请求转给界面，并把用户的决定按官方结构返回，不自建风险判断。
- **上下文只有一个权威。** 每个代理会话绑定一个原生会话 ID，首轮创建、之后恢复。代理的 SQLite 只是界面事件的镜像；原生记录缺失时明确报错，不用界面历史冒充。详见[原生运行与会话存储](native-runtime.md)。
- **运行中追加输入。** 补充消息进入同一个原生进程的输入流，由 Claude Code 决定何时采纳；不另开会话代替。
- **Windows 不留常驻组件。** 随包的 OpenSSH 只在连接期间运行，不安装系统服务，不动用户已有的 SSH 配置。命令执行不弹出控制台窗口，原因与做法见[调研记录](research/windows-shell-windows.md)。
- **执行通道不带第三方隧道程序。** 0.2.9 及更早用 frp 做反向映射，需要客户端带 `frpc.exe`、服务器多开一个端口、每个连接多起一个进程；`frpc.exe` 还经常被安全软件隔离。同类的独立隧道程序都有这些代价，而需要的只是把两条连接的字节对接起来，两端已有的 WebSocket 库足够。

## 取舍原则

项目按“个人自用、可信的高能力模型”设计：先用明确的提示词、简单的流程和成熟的组件解决问题，接受低概率且后果可承受的偏差。公网认证、信道加密、秘密不进版本库这类明确的需求必须满足；除此之外，新增一项防护前要说清具体风险、发生的可能和实现与运维成本。项目不打算演化成多租户隔离、强沙箱或防御模型的框架。

## 参考

- [Claude Code 程序化使用](https://code.claude.com/docs/en/headless)、[Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview)、[SDK 权限接口](https://platform.claude.com/docs/en/agent-sdk/permissions)
- [Claude Code 法律与合规说明](https://code.claude.com/docs/en/legal-and-compliance)
- [frp 的连接池与多路复用](https://gofrp.org/zh-cn/docs/features/common/network/network/)：执行通道“按需建立工作连接”的做法取自它
