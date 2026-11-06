# 终端客户端 `ccdt`

`ccdt` 在你自己的终端里打开服务端上的原版 Claude Code：界面、快捷键和斜杠命令与本地的 `claude` 一样，Claude 的命令经执行通道在这台电脑上运行，与图形客户端相同。它和图形客户端共用会话：终端里接着图形客户端的对话，终端里聊的内容也记入会话。

它是独立的程序，不需要安装或打开图形客户端；两者装在同一台电脑上时，服务端把它们当作同一台设备。设计与取舍见[设计记录](research/standalone-cli.md)。

## 安装

用一行命令安装，只为当前用户安装，不需要管理员权限：

```powershell
# Windows，在 PowerShell 里运行：装到 %LOCALAPPDATA%\Programs\ccdt，并加入当前用户的 PATH
irm https://raw.githubusercontent.com/sun168567/cc-desk-tunnel/main/deploy/install-ccdt.ps1 | iex
```

```bash
# macOS、Linux：装到 ~/.local/share/ccdt，命令为 ~/.local/bin/ccdt
curl -fsSL https://raw.githubusercontent.com/sun168567/cc-desk-tunnel/main/deploy/install-ccdt.sh | sh
```

脚本从发布页下载这个系统的包，按发布页的 `SHA256SUMS` 校验后，运行包里的安装脚本。Windows 上运行命令的窗口装完就能用 `ccdt`；macOS、Linux 上 `~/.local/bin` 不在 PATH 里时，安装脚本把它写进 shell 的配置文件（zsh 为 `~/.zshrc`，bash 为 `~/.bashrc`，macOS 的 bash 为 `~/.bash_profile`，其他为 `~/.profile`），新开的终端窗口就能用。

`ccdt` 要与服务端**同一版本**。脚本默认装最新的正式版；服务端是别的版本时，先指定版本再运行，例如：

```powershell
$env:CCDT_VERSION = '0.3.9'; irm https://raw.githubusercontent.com/sun168567/cc-desk-tunnel/main/deploy/install-ccdt.ps1 | iex
```

```bash
curl -fsSL https://raw.githubusercontent.com/sun168567/cc-desk-tunnel/main/deploy/install-ccdt.sh | CCDT_VERSION=0.3.9 sh
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

装好后打开一个新的终端窗口。不安装也可以直接运行包里的 `ccdt.cmd`（Windows）或 `bin/ccdt`。包里自带运行所需的一切：Node.js，Windows 上还有与图形客户端安装包相同的 PowerShell 7 和 OpenSSH，所以 Windows 的包有一百多 MB。

**升级**：运行 `ccdt upgrade`，见下面的[升级](#升级)。0.3.8 及更早的 `ccdt` 没有这个命令：下载新版本的包，再运行一次安装脚本。

**卸载**：删除安装目录（Windows 还要从用户 PATH 去掉它；macOS、Linux 还有 `~/.local/bin/ccdt`，以及 shell 配置文件里标着 `# ccdt` 的那一行，如果安装时加过）。设置与保存的登录在 `%APPDATA%\ccdt`（Windows）、`~/Library/Application Support/ccdt`（macOS）或 `~/.config/ccdt`（Linux）。设置里有这台电脑的设备 ID（装有图形客户端时用它的）：删掉设置再登录，服务端会把它当作另一台电脑，原来在这台电脑上的会话要在图形客户端里接到本机才能继续用。升级或重新安装不会动设置。

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
| `ccdt sessions [--all]` | 列出这个项目的会话，或全部会话 |
| `ccdt usage` | 订阅额度的已用比例、重置时间与调用统计 |
| `ccdt config` | 查看和修改设置，方向键选择（见[设置](#设置)） |
| `ccdt config 名称 [值]` | 查看或修改一项，供脚本使用 |
| `ccdt upgrade [--yes]` | 升级服务端，再把 `ccdt` 换成与服务端相同的版本（见[升级](#升级)） |
| `ccdt upgrade --check` | 只检查有没有新版本 |
| `ccdt server` | 选择默认连接的服务端（见[多个服务端](#多个服务端)） |
| `ccdt --help` · `ccdt --version` | 全部命令 · 版本 |

“这个项目”指当前目录：与图形客户端里项目文件夹相同的路径。进入 Claude Code 之前，`ccdt` 先显示一行项目和会话名。Claude Code 界面顶部显示的是服务端为这个项目建的工作目录（`/data/state/native/<编号>`），这是正常的：项目文件仍在你的电脑上，Claude 经执行通道在那里读写和执行。

## 窗口与连接

和本地的 `claude` 一样：窗口开着它就一直运行，适合让它长时间无人值守地做事；退出 Claude Code（`/exit`）或关掉窗口，就结束这个终端，对话留在会话里，下次运行 `ccdt` 接着聊。

`ccdt` 同时是 Claude 回到这台电脑执行命令的通道，所以关掉窗口后不能让它在后台继续。断网不会结束它：`ccdt` 自动重连，服务端在宽限期内（与图形客户端的运行相同，默认 5 分钟）保留终端，连回来后画出原来的屏幕接着用。`ccdt` 不占任何快捷键，所有按键都交给 Claude Code。

同一个会话在第二个窗口里打开时，新窗口接过显示，原来的窗口提示后退出。同一个会话不能同时在图形客户端和终端里使用。终端开着时，图形客户端的会话列表和对话底部显示“终端运行中”“终端等你确认”或“终端打开中”，输入框变灰，关掉终端后可以在图形客户端里接着聊；`ccdt sessions` 和 `ccdt -r` 也标出正在别处使用的会话。会话正在图形客户端里运行时，`ccdt` 提示等这一轮结束后再打开。

## 设置

`ccdt config` 列出全部设置和当前值，用方向键选中一项后回车修改：开关和选项从列表里选，时间和文字直接输入，写 `default` 恢复默认。在脚本里用 `ccdt config 名称 值`，例如 `ccdt config connection.ssh 30`；`ccdt config 名称` 显示这一项的说明和可选值，不在终端里运行 `ccdt config` 时列出全部名称。

| 分组 | 设置 | 保存在 |
| --- | --- | --- |
| 本机 | 连接服务器、本机 SSH 服务启动、执行通道就绪的等待时间 | `ccdt` 自己的设置文件，只影响 `ccdt` |
| 服务端 | 缓存过期前自动压缩（开关、空闲时间、上下文大小）、浏览器访问的开关 | 服务端，与图形客户端相同 |
| Claude Code | 云端 Claude Code 的常用设置，与图形客户端“CLI 设置”的各项相同 | 云端 CLI 的用户设置文件 |

选项、默认值和说明文字与图形客户端相同。全局说明（`CLAUDE.md`）、Claude 账号、浏览器访问的地址与两步验证和证书暂不支持在 `ccdt` 里设置，列表里标着“暂不支持”，选中会说明在哪里设置：前两项也可以在 Claude Code 里用 `/memory`、`/login` 完成。连不上服务端时只列出本机的设置。

## 升级

进入 Claude Code 之前和退出之后，服务端有新版本时 `ccdt` 会提示一行；终端开着时，`ccdt` 和图形客户端一样，至少每小时请服务端查一次新版本。`ccdt upgrade --check` 立即查一次。

`ccdt` 只能连接与自己同一版本的服务端。版本不一致时，在终端里运行的 `ccdt` 会直接问是否升级；也可以运行 `ccdt upgrade`，它依次做两件事：

1. **服务端**：有更新的正式版本时，先问你是否升级（`--yes` 不问），确认后服务端下载并安装新版本，然后重启，约一分钟后可以重新连接。这和图形客户端“设置 → 关于与更新”里的升级相同：服务端上还有运行或终端开着时不能升级，要先结束它们；需要更新镜像的版本，会提示在服务器上执行 `sudo cc-desk-tunnel upgrade`。服务端比这个 `ccdt` 新时，跳过这一步。
2. **`ccdt` 自己**：从发布页下载与服务端相同版本的包，按发布页的 `SHA256SUMS` 校验后，用包里的安装脚本装到原来的位置。其他开着的 `ccdt` 窗口不影响安装，关掉重开就是新版本。服务端比 `ccdt` 旧、又没有升级时，`ccdt` 换回服务端的版本，最早到 0.3.9。

下载走 GitHub。需要代理时，设置 `HTTPS_PROXY` 并加上 `NODE_USE_ENV_PROXY=1`。从源码运行的 `ccdt` 只升级服务端，不替换自己。

## 与图形客户端共用会话

- 图形客户端的会话菜单里有“在 ccdt 中打开”：用图形客户端当前的连接登录 `ccdt`（不用再输凭据），在系统的终端窗口里打开这个会话；没装 `ccdt` 或版本不同时，给出安装命令。
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

## 致谢

`ccdt` 来自社区一次次提出的终端需求，感谢：

- @jiangan-code：[#9](https://github.com/sun168567/cc-desk-tunnel/pull/9) 最早做出了 Linux 上的 `ccdt`，并在自己的分支上继续实践。重新接入时还原整屏、用 hooks 跟踪会话的做法都采纳自那里。
- @MomentDerek：[#97](https://github.com/sun168567/cc-desk-tunnel/issues/97) 希望像 SSH 上去一样使用完整的 Claude Code。
- @3558L：[#136](https://github.com/sun168567/cc-desk-tunnel/issues/136) 反馈了经 SDK 运行时 5 小时额度消耗更快，并提出改进原生终端。
- @Kimi-Bo：[#139](https://github.com/sun168567/cc-desk-tunnel/pull/139) 在 Windows Terminal 里使用服务端的 Claude Code，并接入用量统计（整理后见 [#140](https://github.com/sun168567/cc-desk-tunnel/pull/140)）。
