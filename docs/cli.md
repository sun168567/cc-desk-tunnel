# 终端客户端 `ccdt`

`ccdt` 在你自己的终端里打开服务端上的原版 Claude Code：界面、快捷键和斜杠命令与本地的 `claude` 一样，Claude 的命令经执行通道在这台电脑上运行，与图形客户端相同。它和图形客户端共用会话：终端里接着图形客户端的对话，终端里聊的内容也记入会话。

它是独立的程序，不需要安装或打开图形客户端；两者装在同一台电脑上时，服务端把它们当作同一台设备。图形客户端在各个系统上都自带 `ccdt`，见[安装](#安装)。设计与取舍见[设计记录](research/standalone-cli.md)。

## 安装

**装了 Windows 图形客户端就已经有 `ccdt`**：安装时它被加入当前用户的 PATH，新开的终端窗口里直接运行 `ccdt` 即可。它和单独安装的 `ccdt` 相同（同一个程序和 Node），只是 PowerShell 和 OpenSSH 用图形客户端安装包里的；它随图形客户端升级和卸载。

只用终端，或在 macOS、Linux 上，用一行命令单独安装，只为当前用户安装，不需要管理员权限：

```powershell
# Windows，在 PowerShell 里运行：装到 %LOCALAPPDATA%\Programs\ccdt，并加入当前用户的 PATH
irm https://github.com/sun168567/cc-desk-tunnel/releases/latest/download/install-ccdt.ps1 | iex
```

```bash
# macOS、Linux：装到 ~/.local/share/ccdt，命令为 ~/.local/bin/ccdt
curl -fsSL https://github.com/sun168567/cc-desk-tunnel/releases/latest/download/install-ccdt.sh | sh
```

脚本从发布页下载这个系统的包，按发布页的 `SHA256SUMS` 校验后，运行包里的安装脚本。Windows 上运行命令的窗口装完就能用 `ccdt`；macOS、Linux 上 `~/.local/bin` 不在 PATH 里时，安装脚本把它写进 shell 的配置文件（zsh 为 `~/.zshrc`，bash 为 `~/.bashrc`，macOS 的 bash 为 `~/.bash_profile`，其他为 `~/.profile`），新开的终端窗口就能用。

`ccdt` 要与服务端**同一版本**。脚本默认装最新的正式版；服务端是别的版本时，先指定版本再运行，例如：

```powershell
$env:CCDT_VERSION = '0.3.9'; irm https://github.com/sun168567/cc-desk-tunnel/releases/latest/download/install-ccdt.ps1 | iex
```

```bash
curl -fsSL https://github.com/sun168567/cc-desk-tunnel/releases/latest/download/install-ccdt.sh | CCDT_VERSION=0.3.9 sh
```

装错了版本也不要紧：连接时 `ccdt` 会提示版本不一致，并问你是否换成服务端的版本。设置 `CCDT_DOWNLOAD_ONLY=1` 时，脚本只把校验过的包解压到当前目录，不安装。

### 手动安装

从[发布页](https://github.com/sun168567/cc-desk-tunnel/releases/latest)下载与服务端**相同版本**的包：

| 系统 | 文件 |
| --- | --- |
| Windows x64 | `ccdt-<版本>-windows-x64.zip` |
| macOS Apple 芯片 / Intel | `ccdt-<版本>-mac-arm64.tar.gz` / `ccdt-<版本>-mac-x64.tar.gz` |
| Linux x64 / arm64 | `ccdt-<版本>-linux-x64.tar.gz` / `ccdt-<版本>-linux-arm64.tar.gz` |

解压后在 `ccdt` 文件夹里运行安装脚本，只为当前用户安装，不需要管理员权限：

```powershell
# Windows：装到 %LOCALAPPDATA%\Programs\ccdt，并加入当前用户的 PATH
powershell -ExecutionPolicy Bypass -File install.ps1
```

```bash
# macOS、Linux：装到 ~/.local/share/ccdt，命令为 ~/.local/bin/ccdt
./install.sh
```

装好后打开一个新的终端窗口。Windows 上在 PowerShell、cmd 和 Git Bash 里都可以直接运行 `ccdt`。不安装也可以直接运行包里的 `ccdt.cmd`（Windows；Git Bash 里是同一目录下的 `ccdt`）或 `bin/ccdt`。包里自带运行所需的一切：Node.js，Windows 上还有与图形客户端安装包相同的 PowerShell 7 和 OpenSSH，所以 Windows 的包有一百多 MB。

**升级**：运行 `ccdt upgrade`，见下面的[升级](#升级)。0.3.8 及更早的 `ccdt` 没有这个命令：下载新版本的包，再运行一次安装脚本。

**装了图形客户端就不用另装**：Windows 安装时把自带的 `ccdt` 加入当前用户的 PATH；macOS、Linux 上图形客户端启动时把 `~/.local/bin/ccdt` 链接到自带的那份，PATH 的处理与安装脚本相同。macOS 要先把应用拖进“应用程序”再打开，见 [macOS 客户端](macos.md#终端客户端-ccdt)。

两者都装时以图形客户端自带的为准：Windows 安装器把它排在 PATH 中单独安装的前面，macOS、Linux 上 `~/.local/bin/ccdt` 指向它。单独安装的那份留在原处；再运行它的安装脚本只更新文件，不会把命令改回去。

**卸载**：图形客户端自带的随图形客户端卸载：Windows 上 PATH 里的那一项一并去掉；macOS、Linux 上留下的 `~/.local/bin/ccdt` 链接失效，删掉即可。单独安装的，删除安装目录（Windows 还要从用户 PATH 去掉它；macOS、Linux 还有 `~/.local/bin/ccdt`，以及 shell 配置文件里标着 `# ccdt` 的那一行，如果安装时加过）。设置与保存的登录在 `%APPDATA%\ccdt`（Windows）、`~/Library/Application Support/ccdt`（macOS）或 `~/.config/ccdt`（Linux）。设置里有这台电脑的设备 ID（装有图形客户端时用它的）：删掉设置再登录，服务端会把它当作另一台电脑，原来在这台电脑上的会话要在图形客户端里接到本机才能继续用。升级或重新安装不会动设置。

## 登录

```bash
ccdt login
```

用方向键在图形客户端保存的服务端里选一个（按它的连接名列出，已登录的会标出），地址和证书指纹取自它的设置，只需要输入服务凭据（与图形客户端填的相同，输入时不显示）。最后一项“输入其他地址…”用来登录图形客户端没有保存的服务端；也可以直接写上地址：`ccdt login wss://<服务器>:8787/ws --fingerprint <证书指纹>`。还没有登录过任何服务端时，直接运行 `ccdt` 也会先进入登录。

凭据按系统的方式保存：Windows 的 DPAPI、macOS 的钥匙串、Linux 的 Secret Service（GNOME Keyring、KWallet）。没有这些，或者它们用不了时（例如通过 SSH 登录、没有图形界面的 Linux 服务器，或 SSH 会话里锁着的钥匙串），存进只有当前账户能读的设置文件，登录时会说明。不想保存时加 `--no-save`，之后用 `CCDT_TOKEN` 环境变量提供。

### 多个服务端

可以登录几个服务端，凭据各自保存；登录新的不会替换已有的。不指定时，`ccdt` 连接**上一次连接的**服务端，连接时会显示它的名字（图形客户端里的连接名，没有时是主机名）。

| 命令 | 作用 |
| --- | --- |
| `ccdt -s`，如 `ccdt -s -r` | 先用方向键选服务端，再做后面的事；选中的成为之后默认连接的 |
| `ccdt --server <名称>` | 直接指定服务端，供脚本使用：连接名、主机名或地址，写出能区分的一段即可，如 `--server tokyo` |
| `ccdt server` | 列出已登录的服务端和上次使用的时间，选一个作为默认连接的；最后一项是登录新的服务端 |
| `ccdt logout` | 退出一个服务端，登录了几个时先选；其他的不受影响 |

## 使用

在项目目录里运行：

| 命令 | 作用 |
| --- | --- |
| `ccdt` | 接着这个项目最近的会话，没有就新建（像 `claude -c`） |
| `ccdt -r` | 从这个项目的会话里选一个，方向键选择（像 `claude -r`）；加 `--all` 从全部会话里选 |
| `ccdt new [标题]` | 新建会话 |
| `ccdt sessions [--all] [--json]` | 列出这个项目的会话，或全部会话 |
| `ccdt online` | 不开终端，让这台电脑保持在线（见[保持在线](#保持在线)） |
| `ccdt -p "任务"` 等 | 供程序和其他 agent 派发任务、跟进、审批（见[供程序和其他 agent 使用](#供程序和其他-agent-使用)） |
| `ccdt acp` | 作为 ACP agent 运行，供 Zed、JetBrains、acpx 等接入（见 [ACP](#acp)） |
| `ccdt usage` | 订阅额度的已用比例、重置时间与调用统计 |
| `ccdt config` | 查看和修改设置，方向键选择（见[设置](#设置)） |
| `ccdt config 名称 [值]` | 查看或修改一项，供脚本使用 |
| `ccdt upgrade [--yes] [--force]` | 升级服务端，再把 `ccdt` 换成与服务端相同的版本（见[升级](#升级)） |
| `ccdt upgrade --check` | 只检查有没有新版本 |
| `ccdt server` | 选择默认连接的服务端（见[多个服务端](#多个服务端)） |
| `ccdt --help` · `ccdt --version` | 全部命令 · 版本 |

“这个项目”指当前目录：与图形客户端里项目文件夹相同的路径。在一个目录里开会话会把它登记为项目，图形客户端里随即出现。进入 Claude Code 之前，`ccdt` 先显示一行项目和会话名，项目有名称时一并显示；不属于项目的普通会话显示它的文件夹。Claude Code 界面顶部显示的是服务端为这个项目建的工作目录（`/data/state/native/<编号>`），这是正常的：项目文件仍在你的电脑上，Claude 经执行通道在那里读写和执行。

## 窗口与连接

和本地的 `claude` 一样：窗口开着它就一直运行，适合让它长时间无人值守地做事；退出 Claude Code（`/exit`）或关掉窗口，就结束这个终端，对话留在会话里，下次运行 `ccdt` 接着聊。

`ccdt` 同时是 Claude 回到这台电脑执行命令的通道，所以关掉窗口后不能让它在后台继续；要让这台电脑一直在线，用 [`ccdt online`](#保持在线)。断网不会结束它：`ccdt` 自动重连，服务端在宽限期内（与图形客户端的运行相同，默认 5 分钟）保留终端，连回来后画出原来的屏幕接着用。`ccdt` 不占任何快捷键，所有按键都交给 Claude Code。

同一个会话在第二个窗口里打开时，新窗口接过显示，原来的窗口提示后退出。同一个会话不能同时在图形客户端和终端里使用。终端开着时，图形客户端的会话列表和对话底部显示“终端运行中”“终端等你确认”或“终端打开中”，输入框变灰，关掉终端后可以在图形客户端里接着聊；`ccdt sessions` 和 `ccdt -r` 也标出正在别处使用的会话。会话正在图形客户端里运行时，`ccdt` 提示等这一轮结束后再打开。

## 保持在线

`ccdt online` 不开终端，只让这台电脑在线：登录服务端、启动本机的 SSH 服务和执行通道，然后一直等着，断线自动重连（间隔逐渐拉长，最长一分钟），按 Ctrl+C 结束。它在线期间，你的会话（图形客户端、浏览器或别处的 `ccdt` 里的）都能让 Claude 在这台电脑上执行命令，与图形客户端开着时相同；凭据被拒或版本不一致时它会退出。

它在线时，在这台电脑上打开 `ccdt` 会话不再自己启动 SSH 服务，直接用它的执行通道，所以进入得更快；它中途退出了，打开着的终端在几秒内自动换成自己的通道，Claude Code 照常运行。

适合没有图形界面的服务器：登录一次后让它在后台运行。

```bash
# Linux、macOS：放到后台，输出写进日志
nohup ccdt online >> ~/ccdt-online.log 2>&1 &
```

```ini
# Linux：开机即在线，用 systemd 的用户服务，写到 ~/.config/systemd/user/ccdt-online.service
[Unit]
Description=ccdt online
After=network-online.target

[Service]
ExecStart=%h/.local/bin/ccdt online
Restart=on-failure
RestartSec=30

[Install]
WantedBy=default.target
```

然后运行 `systemctl --user enable --now ccdt-online`；要在没有登录时也运行，再执行一次 `loginctl enable-linger`。凭据存在系统钥匙串里的电脑，后台服务可能读不到它；没有图形界面的服务器上凭据本来就存在设置文件里，不受影响。

```powershell
# Windows：不留窗口地运行，注销前一直在线
Start-Process ccdt -ArgumentList online -WindowStyle Hidden
```

## 供程序和其他 agent 使用

其他 agent（Codex、Gemini CLI、DeepSeek Harness 等）和脚本可以把任务交给服务端上的 Claude：派发、查看进度、中途追加指示、处理审批、等结果。它们只需要会运行命令，经的是这台电脑上已登录的 `ccdt`，不用另配凭据，也不用了解服务端和多台电脑的关系。任务就是普通会话，图形客户端里能看到它在做什么，也能插话和审批。

派发的写法与 `claude -p` 相同：

```bash
ccdt -p "修复登录页的报错"                      # 当前目录的项目里新建会话，这一轮结束后输出 Claude 的回复
ccdt -p -c "再补上测试"                          # 接这个项目最近的会话；-r <会话 ID> 接指定会话
ccdt -p "整理文档" --bg                          # 发出后立即返回会话 ID
ccdt -p "…" --output-format json                # 一个 JSON：{"session_id","state","result","is_error","approval"?}
ccdt -p "…" --permission-mode acceptEdits --model sonnet --effort high
```

之后用会话 ID（可只写开头几位）跟进：

| 命令 | 作用 |
| --- | --- |
| `ccdt status <会话>` | 在做什么、在等什么、任务清单做到哪 |
| `ccdt wait <会话> [--timeout 秒]` | 等到这一轮结束，或 Claude 等人批准、回答 |
| `ccdt tell <会话> "补充"` | 追加指示：Claude 正在做时加进这一轮，用来中途纠偏 |
| `ccdt approve <会话>` · `ccdt deny <会话> ["意见"]` | 批准或拒绝 Claude 等待的请求，再等到它下次停下；计划被拒时，意见是让它怎么改 |
| `ccdt answer <会话> "答案1" ["答案2" …]` | 按顺序回答 Claude 的提问，多选用逗号隔开，再等到它下次停下 |
| `ccdt logs <会话> [--last N]` | 最近的对话和工具调用 |
| `ccdt stop <会话>` | 停止这一轮 |

这些命令都可以加 `--json`（`-p` 和 `wait` 用 `--output-format`，还有逐行输出事件的 `stream-json`：回复文字、工具调用与结果、状态和最后的结果；CLI 设置开了“显示思考过程”时也有思考）。结果写在标准输出，说明和下一步该怎么做写在标准错误。退出码：0 完成，2 在等批准或回答，3 失败，4 已停止，5 连不上或未登录，6 到 `--timeout` 时仍在运行。`ccdt help agents` 给出写给 agent 看的完整说明。

- **审批交给调用方**：Claude 请求批准或提问时，`ccdt -p` 和 `ccdt wait` 停下来（退出码 2），把要批准什么、为什么一并输出，由调用方用 `approve`、`deny`、`answer` 处理。这三个命令回复后像 `ccdt -p` 一样接着等到 Claude 再停下，输出和退出码相同，等待期间提供这台电脑的执行通道；加 `--bg` 只回复不等。图形客户端里同时也能处理，谁先回答算谁的。不想被问，派发时带 `--permission-mode`。
- **长任务**：调用方把 `ccdt -p` 放进自己的后台任务里运行，结束时它的工具就会通知它；或者用 `--bg` 发出，之后 `ccdt wait`。Claude 这一轮结束、只剩它启动的后台任务时，状态是 `background`：后台任务结束后 Claude 会自动接着做，`ccdt wait` 可以等到那时。
- **执行通道**：任务在会话所在的电脑上执行，新建的会话就是运行 `ccdt` 的这台。`ccdt -p`、`wait`、`tell` 等待期间自己提供这台电脑的执行通道；用 `--bg` 发出后就退出的，要有图形客户端或 `ccdt online` 开着，否则服务端只等 5 分钟。

### ACP

`ccdt acp` 让 `ccdt` 作为 [Agent Client Protocol](https://agentclientprotocol.com) 的 agent 运行，经标准输入输出通信。会说 ACP 的编辑器和 agent 工具（Zed、JetBrains、[acpx](https://github.com/openclaw/acpx) 等）把它配成 agent 命令，就能像使用本地 agent 一样使用服务端上的 Claude：会话在启动目录对应的项目里新建，也可以加载已有会话（回放最近一页记录）；回复和工具调用逐条显示；审批作为权限请求交给客户端。模型、推理强度和审批模式作为会话选项（ACP 的 session config options）给出，客户端显示成选择器：模型列表就是图形客户端里的那份，取自 Claude Code，这个 `ccdt acp` 进程里第一次新建会话时读一次（要几秒）；选的模型和强度存在会话上，和在窗口里选的一样，在窗口里改了也会同步到客户端。只认会话模式的旧客户端照常能切换审批模式。

```json
// acpx：项目目录里的 .acpxrc.json，之后 acpx ccdt "任务"、acpx ccdt exec "任务"
{ "agents": { "ccdt": { "argv": ["ccdt", "acp"] } } }
```

Windows 上 acpx 只接受可执行文件，写 `ccdt` 自带的 node 和脚本：`["%LOCALAPPDATA%\\Programs\\ccdt\\node.exe", "%LOCALAPPDATA%\\Programs\\ccdt\\ccdt.mjs", "acp"]`（把 `%LOCALAPPDATA%` 换成实际路径）。

```json
// Zed：settings.json
{ "agent_servers": { "CC Desk Tunnel": { "type": "custom", "command": "ccdt", "args": ["acp"] } } }
```

与 ACP 的差别：ACP 没有“提问”，Claude 提问时问题作为回复文字显示、这一轮结束，下一条消息就是回答；ACP 不能往进行中的一轮追加内容，要纠偏就取消后重发（图形客户端照常可以插话）；客户端传来的 MCP 服务暂不连接。

## 设置

`ccdt config` 列出全部设置和当前值，用方向键选中一项后回车修改：开关和选项从列表里选，时间和文字直接输入，写 `default` 恢复默认。在脚本里用 `ccdt config 名称 值`，例如 `ccdt config connection.ssh 30`；`ccdt config 名称` 显示这一项的说明和可选值，不在终端里运行 `ccdt config` 时列出全部名称。

| 分组 | 设置 | 保存在 |
| --- | --- | --- |
| 本机 | `ccdt` 的语言（默认跟随系统：`LANG` 等环境变量），连接服务器、本机 SSH 服务启动、执行通道就绪的等待时间 | `ccdt` 自己的设置文件，只影响 `ccdt` |
| 服务端 | 缓存过期前自动压缩（开关、空闲时间、上下文大小）、浏览器访问的开关 | 服务端，与图形客户端相同 |
| Claude Code | 云端 Claude Code 的常用设置，与图形客户端“CLI 设置”的各项相同 | 云端 CLI 的用户设置文件 |

选项、默认值和说明文字与图形客户端相同。全局说明（`CLAUDE.md`）、Claude 账号、浏览器访问的地址与两步验证和证书暂不支持在 `ccdt` 里设置，列表里标着“暂不支持”，选中会说明在哪里设置：前两项也可以在 Claude Code 里用 `/memory`、`/login` 完成。连不上服务端时只列出本机的设置。

## 升级

进入 Claude Code 之前和退出之后，服务端有新版本时 `ccdt` 会提示一行；终端开着时，`ccdt` 和图形客户端一样，至少每小时请服务端查一次新版本。`ccdt upgrade --check` 立即查一次。

`ccdt` 只能连接与自己同一版本的服务端。版本不一致时，在终端里运行的 `ccdt` 会直接问是否升级；也可以运行 `ccdt upgrade`，它依次做两件事：

1. **服务端**：有更新的正式版本时，先问你是否升级（`--yes` 不问），确认后服务端下载并安装新版本，然后重启，约一分钟后可以重新连接。这和图形客户端“设置 → 关于与更新”里的升级相同：有会话正在运行（正在回答、等你确认，或终端里的 Claude Code 正在执行）时，`ccdt` 列出这些会话，可以选择强行升级，正在运行的会被中断（`--force` 直接强行升级）；只是开着终端、或在等后台任务的，不挡升级，它们随重启结束，会话本身保留。服务端是 0.3.14 及更早的版本时，开着的终端和后台任务也会挡住升级，不能强行升级；需要更新镜像的版本，会提示在服务器上执行 `sudo cc-desk-tunnel upgrade`。服务端比这个 `ccdt` 新时，跳过这一步。
2. **`ccdt` 自己**：从发布页下载与服务端相同版本的包，按发布页的 `SHA256SUMS` 校验后，用包里的安装脚本装到原来的位置。其他开着的 `ccdt` 窗口不影响安装，关掉重开就是新版本。服务端比 `ccdt` 旧、又没有升级时，`ccdt` 换回服务端的版本，最早到 0.3.9。

下载走 GitHub。需要代理时，设置 `HTTPS_PROXY` 并加上 `NODE_USE_ENV_PROXY=1`。从源码运行的 `ccdt` 只升级服务端，不替换自己。图形客户端自带的 `ccdt` 也只升级服务端，然后提示升级图形客户端：图形客户端连接时会提供服务端版本的安装包，`ccdt` 随它更新。

## 与图形客户端共用会话

- 图形客户端的会话菜单里有“用 ccdt 打开”：用图形客户端当前的连接登录 `ccdt`（不用再输凭据，也不再连一次去验证），在系统的终端窗口里打开这个会话。用的是图形客户端自带的 `ccdt`，版本总是对得上。
- 两边接续的是同一段原生对话，上下文完整：终端里能看到图形客户端聊过的内容，图形客户端的下一轮也知道终端里聊了什么。
- 终端里的对话随 CLI 写下的记录分段记入会话，图形客户端里约一两秒后可见：问题、回答、工具调用和结果、压缩，问题标着“终端”，时间是当时的时间。一轮结束后和图形客户端里的一样折成“问题—用时—回答”，提示缓存的计时也从这一轮算起。`/model`、`/effort` 这类在终端里执行的命令，显示成回答下面的一行说明。记下的内容比图形客户端里直接运行的少：回复按段出现而不是逐字出现，也没有审批记录和每轮的用量统计。
- 在 Claude Code 里用 `/clear` 或 `/resume` 换到另一段对话后，那之后的内容不属于这个会话，会话里会记一条提示；在终端里回退对话（`/rewind`）也会提示。要换会话，退出后用 `ccdt -r` 或 `ccdt new`。
- 调用统计里，终端的请求和图形客户端的一样算在这个会话名下。终端的请求以交互式 Claude Code 的身份发出，和在终端里直接运行 `claude` 相同；图形客户端经官方 Agent SDK 运行。

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `CCDT_TOKEN` | 服务凭据，代替保存的凭据 |
| `CCDT_LOG` | 一个文件路径：把连接过程写进去，用于排查连不上或断线 |
| `CCDT_CONFIG_DIR` | 设置目录，代替默认位置 |
| `https_proxy` / `all_proxy`、`no_proxy` | 经 HTTP 代理连接服务端；回环地址和 `no_proxy` 里的地址直连 |

## 常见情况

- **第一次在一个项目里打开时，Claude Code 问是否信任工作目录**：这是 Claude Code 自己的对话框，用方向键选“Yes, I trust this folder”再回车；默认选项是退出。每个项目只问一次。
- **连不上**：报错会说明原因（凭据、证书指纹、网络、版本）。原因不明时设置 `CCDT_LOG` 再试一次，日志里有每一步。
- **提示版本不一致**：在终端里选“升级”，或运行 `ccdt upgrade`；0.3.8 及更早的 `ccdt` 要下载同一版本的包，再运行一次安装脚本。

## 已验证与未验证

- Windows：在一套真实部署上验证过登录、新建与选择会话、与图形客户端交替接续、断网 55 秒后接回、关窗口即结束、请求身份与调用统计；打包、安装脚本与安装后的启动在 GitHub 的 Windows 机器上检查。
- Linux（x64）：在一台没有图形界面、经 SSH 登录的 Ubuntu 上，用 GitHub 打出的包验证过安装、登录（系统密钥服务用不了时凭据存进设置文件）、新建与选择会话、Claude 的命令经执行通道在这台电脑上运行、终端状态与每一轮的导入、服务端断开 50 秒后接回、关窗口即结束。arm64 的包在 GitHub 的 arm64 机器上打包、安装并启动过。
- macOS：打包、安装脚本与安装后的启动，钥匙串的保存与读取，以及在真实终端里按键原样传过去（Ctrl+C 交给 Claude Code，不结束 `ccdt`）、窗口尺寸传过去，都在 GitHub 的 Mac 上检查；手头没有 Mac，需要有人操作的部分（连接真实服务端、在“终端”或 iTerm2 里使用、关窗口）没有实际用过。执行通道是与 macOS 图形客户端同一套代码。

- 供程序和其他 agent 使用（`ccdt -p` 与跟进命令、`ccdt acp`）：在离线模拟服务上有自动测试，覆盖派发、续接、事件流输出、工具审批、按顺序回答提问、退回计划、停止、超时，以及 ACP 的新建与加载会话、逐条回复、权限请求、切换模式、模型与推理强度的选项。在 Windows 上连接真实部署验证过：`ccdt -p` 得到回复；“每次询问”模式下停在审批，`approve` 后接着拿到结果；`--bg` 发出后 `tell` 中途改了指令，Claude 照新指令完成；用 acpx 0.22 经 `ccdt acp` 一次性和持久会话各跑通，权限请求的拒绝和批准都生效；`ccdt acp` 第一次新建会话时给出了账号可用的模型和各自的推理强度，选择后存在会话上。在 Linux 上用真实的 Claude Code（接第三方模型）验证过：Claude 经 ccdt 的执行通道在这台电脑上运行命令，`approve`、`deny`、`answer` 回复后接着拿到结果，`ccdt online` 开着时 `--bg`、`tell`、`stop` 生效，acpx 经 `ccdt acp` 的批准和拒绝生效。Zed 和 JetBrains 没有实际接入过。

## 致谢

`ccdt` 来自社区一次次提出的终端需求，感谢：

- @jiangan-code：[#9](https://github.com/sun168567/cc-desk-tunnel/pull/9) 最早做出了 Linux 上的 `ccdt`，并在自己的分支上继续实践。重新接入时还原整屏、用 hooks 跟踪会话的做法都采纳自那里。
- @MomentDerek：[#97](https://github.com/sun168567/cc-desk-tunnel/issues/97) 希望像 SSH 上去一样使用完整的 Claude Code。
- @3558L：[#136](https://github.com/sun168567/cc-desk-tunnel/issues/136) 反馈了经 SDK 运行时 5 小时额度消耗更快，并提出改进原生终端。
- @Kimi-Bo：[#139](https://github.com/sun168567/cc-desk-tunnel/pull/139) 在 Windows Terminal 里使用服务端的 Claude Code，并接入用量统计（整理后见 [#140](https://github.com/sun168567/cc-desk-tunnel/pull/140)）。
