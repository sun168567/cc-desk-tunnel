# 外部 CLI：在 Windows Terminal 中使用服务端 Claude Code

外部 CLI 让你在自己的终端里直接使用服务器上的官方 Claude Code，界面、命令和快捷键与官方 CLI 一致。项目文件和命令仍在 Windows 上：Claude 读写文件、运行命令时，经桌面客户端已有的执行通道回到这台电脑的项目目录执行，用量记入桌面“账号与额度”的同一份统计。

它和客户端里的原生终端是同一个 CLI，区别在于从哪里打开：

| | 客户端内的原生终端 | 外部 CLI |
|---|---|---|
| 窗口 | 客户端里的终端面板 | Windows Terminal 等自己的终端 |
| 连接方式 | 客户端与服务的连接 | 你自己的 SSH 登录服务器，再进入服务容器 |
| 会话 | 属于某个桌面会话，可与对话界面互相切换 | 单独的会话，不出现在桌面会话列表 |
| 执行通道与用量 | 客户端的执行通道；计入用量统计 | 相同 |

## 准备条件

- 服务端用 `deploy/manage.sh` 以容器方式部署，版本包含外部 CLI。一键升级到这个版本即可，不需要重建镜像。
- 这台 Windows 的桌面客户端已连接该服务，使用期间保持连接（留在托盘也可以）。外部 CLI 的所有项目操作都经它执行。
- 这台 Windows 能用 SSH 登录服务器，登录的账号可以运行 `docker`；需要 `sudo` 时，`sudo` 不能要求输入密码。主机密钥已经核对过，建议在 `~/.ssh/config` 里为服务器起一个别名。
- 使用 Windows 自带的 OpenSSH 客户端（`ssh.exe`）。

## 启动

启动脚本是源码中的 [`scripts/open-external-cli.ps1`](../scripts/open-external-cli.ps1)，请使用与服务端版本相同的那一份。在项目目录下，用普通用户（不要以管理员身份）的 PowerShell 运行：

```powershell
cd D:\Projects\demo
powershell -ExecutionPolicy Bypass -File C:\Tools\open-external-cli.ps1 -SshTarget my-server
```

脚本会做这些事：
1. 从本机客户端的设置读取这台电脑的设备 ID。
2. SSH 登录服务器，找到服务容器，进入后按服务当前运行的程序启动入口。一键升级后，用的也是升级后的程序和 CLI。
3. 入口确认这台电脑的执行通道可用，然后启动官方 Claude Code。Claude 知道项目位于 Windows 的哪个目录，并通过执行通道操作它。

常用参数：

| 参数 | 说明 |
|---|---|
| `-SshTarget` | 必填。SSH 配置里的别名或 `user@host` |
| `-ProjectPath` | 项目目录，默认为当前目录 |
| `-Sudo` | 服务器上需要 `sudo -n docker` 时添加 |
| `-Container` | 服务器上运行着多个服务容器时，指定其中一个；容器名可用 `manage.sh status` 查看 |
| `-Check` | 只检查服务器、容器和执行通道，不启动 Claude |
| `-ContinueSession` | 继续这个项目最近一次外部 CLI 会话 |
| `-DeviceId` / `-ClientSettingsPath` | 设备 ID 读不到时手动指定，一般不需要 |

第一次使用建议先加 `-Check`，看到 `ready` 再正式启动。

第一次在某个项目上启动时，Claude Code 会询问是否信任它在服务器上的工作目录（`/data/state/native/cli-…`），选择“Yes, I trust this folder”。这个目录只保存外部 CLI 的会话历史，项目文件仍在 Windows 上。服务用 API key 而不是 Claude 账号时，第一次启动还会出现 Claude Code 自己的初始设置（选择主题等），和客户端里的原生终端一样。

## 会话、续接与退出

- 同一台电脑上的同一个项目，外部 CLI 的历史保存在服务端固定的位置。用 `-ContinueSession` 继续上一次会话，或在 CLI 中用 `/resume` 选择更早的会话。
- 这些会话与桌面会话分开管理，不出现在桌面的会话列表中。
- 用 `/exit` 正常退出。直接关闭终端或 SSH 断开时，服务器上的 CLI 及它启动的命令也会随之结束；已经发到 Windows 上的命令要另行确认是否执行完，入口不会自动重做任何操作。
- 模型、提供方设置与服务一致，来自服务的 `service.env` 和 `provider.json`。审批模式为“每次询问”，可以在 CLI 中切换。

## 用量

外部 CLI 的模型请求与桌面会话写入同一份统计：在桌面“账号与额度”中刷新，即可在汇总和调用日志里看到。同一请求重复上报只记一次。统计只保存模型、token、费用估算、耗时和会话 ID，不保存提示词、回复内容和账号信息。外部 CLI 的会话不在桌面会话列表中，所以没有单个会话的统计，只计入总量和调用日志。

## 常见问题

| 现象 | 处理 |
|---|---|
| SSH 无法登录 | 先单独运行 `ssh my-server`，核对别名和主机密钥 |
| `No running CC Desk Tunnel container` | 服务没有运行，或不是用 `manage.sh` 部署的；可用 `-Container` 指定容器 |
| `Several CC Desk Tunnel containers` | 服务器上有多个部署，用 `-Container` 指定 |
| `permission denied ... docker.sock` | 登录账号不能直接使用 docker，加 `-Sudo`，并让 `sudo` 免密码运行 docker |
| `The running service has no external CLI entry` | 服务版本过旧，先在客户端里升级服务端 |
| `Windows execution channel was not ready` | 这台电脑的客户端没有连接到该服务，或设备 ID 不是这台电脑的 |
| 用量里看不到新的请求 | 在“账号与额度”页刷新；确认桌面客户端连接的是同一个服务 |
