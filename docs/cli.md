# 终端客户端 `ccdt`

`ccdt` 在你自己的终端里打开服务端上的原版 Claude Code：界面、快捷键和斜杠命令与本地的 `claude` 一样，Claude 的命令经执行通道在这台电脑上运行，与图形客户端相同。它和图形客户端共用会话：终端里接着图形客户端的对话，终端里聊的内容也记入会话。

它是独立的程序，不需要安装或打开图形客户端；两者装在同一台电脑上时，服务端把它们当作同一台设备。设计与取舍见[设计记录](research/standalone-cli.md)。

## 安装

从[发布页](https://github.com/sun168567/cc-desk-tunnel/releases/latest)下载与服务端**相同版本**的包：

| 系统 | 文件 |
| --- | --- |
| Windows x64 | `ccdt-<版本>-windows-x64.zip` |
| macOS Apple 芯片 / Intel | `ccdt-<版本>-mac-arm64.tar.gz` / `ccdt-<版本>-mac-x64.tar.gz` |
| Linux x64 | `ccdt-<版本>-linux-x64.tar.gz` |

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

**升级**：服务端升级后，下载同一版本的包，再运行一次安装脚本。版本不一致时 `ccdt` 会拒绝连接，并给出该下载的版本。

**卸载**：删除安装目录（Windows 还要从用户 PATH 去掉它；macOS、Linux 还有 `~/.local/bin/ccdt`）。设置与保存的登录在 `%APPDATA%\ccdt`（Windows）、`~/Library/Application Support/ccdt`（macOS）或 `~/.config/ccdt`（Linux）。

## 登录

```bash
ccdt login
```

装有图形客户端时，服务地址和证书指纹取自它保存的设置，只需要输入服务凭据（与图形客户端填的相同，输入时不显示）。没有时写上地址：`ccdt login wss://<服务器>:8787/ws --fingerprint <证书指纹>`。

凭据按系统的方式保存：Windows 的 DPAPI、macOS 的钥匙串、Linux 的 Secret Service（GNOME Keyring、KWallet）；都没有时存进只有当前账户能读的设置文件。不想保存时加 `--no-save`，之后用 `CCDT_TOKEN` 环境变量提供。登录过几个服务端时，用 `--server <地址>` 选择。

## 使用

在项目目录里运行：

| 命令 | 作用 |
| --- | --- |
| `ccdt` | 接着这个项目最近的会话，没有就新建（像 `claude -c`） |
| `ccdt -r` | 从这个项目的会话里选一个，方向键选择（像 `claude -r`）；加 `--all` 从全部会话里选 |
| `ccdt new [标题]` | 新建会话 |
| `ccdt sessions [--all]` | 列出这个项目的会话，或全部会话 |
| `ccdt usage` | 订阅额度的已用比例、重置时间与调用统计 |
| `ccdt --help` · `ccdt --version` | 全部命令 · 版本 |

“这个项目”指当前目录：与图形客户端里项目文件夹相同的路径。进入 Claude Code 之前，`ccdt` 先显示一行项目和会话名。Claude Code 界面顶部显示的是服务端为这个项目建的工作目录（`/data/state/native/<编号>`），这是正常的：项目文件仍在你的电脑上，Claude 经执行通道在那里读写和执行。

## 窗口与连接

和本地的 `claude` 一样：窗口开着它就一直运行，适合让它长时间无人值守地做事；退出 Claude Code（`/exit`）或关掉窗口，就结束这个终端，对话留在会话里，下次运行 `ccdt` 接着聊。

`ccdt` 同时是 Claude 回到这台电脑执行命令的通道，所以关掉窗口后不能让它在后台继续。断网不会结束它：`ccdt` 自动重连，服务端在宽限期内（与图形客户端的运行相同，默认 5 分钟）保留终端，连回来后画出原来的屏幕接着用。`ccdt` 不占任何快捷键，所有按键都交给 Claude Code。

同一个会话在第二个窗口里打开时，新窗口接过显示，原来的窗口提示后退出。同一个会话不能同时在图形客户端和终端里使用。终端开着时，图形客户端的会话列表和对话底部显示“终端运行中”“终端等你确认”或“终端打开中”，输入框变灰，关掉终端后可以在图形客户端里接着聊；`ccdt sessions` 和 `ccdt -r` 也标出正在别处使用的会话。会话正在图形客户端里运行时，`ccdt` 提示等这一轮结束后再打开。

## 与图形客户端共用会话

- 两边接续的是同一段原生对话，上下文完整：终端里能看到图形客户端聊过的内容，图形客户端的下一轮也知道终端里聊了什么。
- 终端里每一轮结束时，这一轮的对话就记入会话，图形客户端里随即可见：问题、回答、工具调用和结果、压缩，都标着“终端”，时间是当时的时间。记下的内容比图形客户端里直接运行的少：一轮进行中的流式过程看不到，也没有审批记录。
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
- **服务端升级后提示版本不一致**：按提示下载同一版本的 `ccdt` 并重新运行安装脚本。

## 已验证与未验证

- Windows：在一套真实部署上验证过登录、新建与选择会话、与图形客户端交替接续、断网 55 秒后接回、关窗口即结束、请求身份与调用统计；打包、安装脚本与安装后的启动在 GitHub 的 Windows 机器上检查。
- macOS、Linux：打包、安装脚本与安装后的启动在 GitHub 的机器上检查；没有连接真实服务端用过。
