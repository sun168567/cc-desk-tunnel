# Linux 终端客户端 `ccdt`

在你自己的终端里直接使用远端的原版 Claude Code：界面、快捷键和斜杠命令与本地 `claude` 一样，模型和会话在服务端，命令在本机当前目录执行。不需要图形界面和 Electron。

```bash
cd ~/code/myproject
ccdt               # 接着这个目录最近的对话；没有就新建
ccdt -n            # 新建会话，从空白对话开始
ccdt ~/other -m opus --effort high --permission-mode plan
ccdt deck          # 先打开 agent 列表
```

接着的是这个目录的会话里最近的一段原生对话（`claude --continue`），在图形界面里聊的也算。要换一段用 `/resume`，要从空白开始用 `/clear` 或 `ccdt -n`。Claude 账号登录、`/config` 等都在终端里用原版斜杠命令完成。退出 Claude Code（`/exit` 或两次 Ctrl+C）即断开连接并回收本机隧道。

## 多个 agent

在 Claude Code 里按 **Ctrl+Q** 回到 agent 列表，刚才的 agent 在服务端继续运行。列表按项目目录分组，显示每个会话的状态：

| 状态 | 含义 |
| --- | --- |
| 运行中 | 正在处理 |
| 等你 | 等你批准权限或回答问题 |
| 空闲 | 这一轮做完了，等下一条指令 |
| 未启动 | 会话没有运行中的 agent；进入时接着最近的对话 |

按键：`Enter` 进入，`n` 新建（输入目录），`w` 新建 worktree agent，`d` 结束 agent（对话保留），`x` 删除会话，`r` 改名，`/` 搜索，`j`/`k` 或方向键移动，`q` 退出。看不到的 agent 开始等你或做完一轮时会响铃，窗口标题显示有几个在等你；开始等你时还会弹一条桌面通知（`notify-send`，`CCDT_NOTIFY=0` 关闭）。后台服务在运行时由它发通知，没打开 ccdt 也能收到。

列表按 git 仓库分组：一个仓库的主目录和它的各个 worktree 在同一组，每行显示所在分支。

### worktree 隔离

几个 agent 同时改同一个项目时，各自用一个 worktree 互不干扰。选中项目按 `w`，输入分支名（默认 `ccdt/<月日时分>`）：ccdt 在本机执行 `git worktree add`，放在仓库旁边的 `<仓库>.worktrees/<分支>`，新分支从当前检出的提交开始，已有的分支直接检出，然后在那里开一个 agent。删除这个会话（`x`）时一并删除 worktree；有未提交的改动时拒绝删除。分支保留，由你或 Claude 用 git 合并。

一个会话同时只有一个 agent；同一个项目可以开多个会话并行。最多同时运行 8 个。没有后台服务时，退出 ccdt 会结束全部 agent（对话都保留）；断网 3 分钟内恢复则全部接着运行。

## 后台常驻

```bash
ccdt daemon install      # 装成 systemd 用户服务并启动
ccdt daemon status       # 是否在运行
ccdt daemon stop         # 停止（结束它运行的全部 agent）
ccdt daemon uninstall    # 停止并移除
```

后台服务持有这台设备到服务端的连接和执行通道，在 `$XDG_RUNTIME_DIR/ccdt.sock`（权限 0600）等待 `ccdt`。它在运行时，`ccdt` 只负责显示：按 `q` 或关掉终端，agent 照常运行；任何终端里再运行 `ccdt` 都能接回，进入时还原整屏画面。几个终端可以同时显示不同的 agent；同一个 agent 后打开的终端接管显示。

- 安装前先退出正在运行的 `ccdt`：同一服务同时只接受一台执行设备。
- 后台服务启动时从密钥环读凭据；密钥环还锁着时它会失败，systemd 每 10 秒重试，解锁后自动连上。`ccdt login` 换了服务或凭据后，运行 `systemctl --user restart ccdt`。
- Claude 在本机执行的命令继承后台服务的环境。systemd 的 PATH 不含 `~/.local/bin` 等登录 shell 才加的目录，所以安装时会记下当前终端的 PATH；PATH 变了就再运行一次 `ccdt daemon install`（会重启后台服务）。代理变量不会写进服务配置。
- 用户服务随桌面登录启动；退出桌面会话后也要保持运行，执行 `loginctl enable-linger`。
- 日志：`journalctl --user -u ccdt`。与服务端的连接彻底断开（断网超过 3 分钟、服务端重启）时后台服务退出，systemd 10 秒后重新连接，原来的 agent 已结束。状态来自服务端注入原生目录 `.claude/settings.local.json` 的 Claude Code hooks，你在那里加的其他 hooks 会保留。

## 安装与登录

安装 deb 桌面包后直接有 `/usr/bin/ccdt`，由包内的 Electron 以 Node 模式运行。从源码使用需要 Node.js 24：

```bash
npm ci
npm run install:cli      # 在 ~/.local/bin 放一个绑定本源码目录和当前 Node 的 ccdt 启动脚本
ccdt login               # 服务地址、证书指纹默认取自桌面客户端的保存值；凭据不回显
```

服务凭据优先存入系统密钥环（`secret-tool`，GNOME Keyring / KWallet）；密钥环不可用时存入 `~/.config/cc-desk-tunnel/cli.json`，权限 0600。也可以不保存，用 `CCDT_TOKEN` 环境变量提供。脚本化登录：`ccdt login --url wss://… --fingerprint … --token-stdin < token.txt`。

## 工作方式

`ccdt` 复用桌面客户端的连接桥 `apps/desktop/electron/proxy-bridge.mjs`：同样的 WSS 证书校验、经服务端 WSS 中继的执行通道（不需要 frpc 和额外端口，见 [Linux 桌面指南](../../docs/linux-desktop.md#执行通道)）和每次连接临时生成的纯 JS SSH（只提供非交互式 Bash exec）。之后它打开服务端已有的原生终端（`terminal.open`），把本机终端切到 raw 模式，按键作为 `terminal.input` 上传，`SIGWINCH` 时发送 `terminal.resize`，输出写入本机终端后再回 `terminal.ack`，服务端据此做流控。

- 目录到会话：按目录的真实路径匹配 `projectPath`，取最近更新的会话，与桌面客户端里同一项目的会话共用。
- 代理：读取 `https_proxy` / `all_proxy` 与 `no_proxy`，只支持 HTTP CONNECT 代理；回环地址总是直连。
- 同一服务同一时间只接受一台执行设备；桌面客户端已连接时会提示“已有桌面设备连接”。一个会话同时只有一个原生运行或终端。
- 终端在服务端常驻：服务端用一份屏幕模型（xterm headless）记录每个终端的画面，再次进入时先画出当前整屏，再接上实时输出。
- 网络中断时终端暂停，窗口标题显示“正在重连”；3 分钟内恢复则接着用，Claude Code 一直在服务端运行，期间的输出和按键都会补上。超过 3 分钟则结束本次终端。见[断线续接](../../docs/linux-desktop.md#断线续接)。
- 异常断开时恢复本机终端状态（光标、括号粘贴、鼠标与焦点上报、备用屏幕）。

## 已知限制

- 终端会话的 CLI 历史与图形界面里的对话不互通（见[路线与现状](../../docs/roadmap.md)）。
- 不运行定时任务；定时任务仍由桌面客户端执行。
