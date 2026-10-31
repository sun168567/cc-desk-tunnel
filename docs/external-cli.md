# 在 Windows Terminal 中使用服务端 Claude Code

外部 CLI 入口让你在 Windows Terminal 中，通过已有管理 SSH 使用 Linux 服务端的官方 Claude Code。项目文件和工具继续留在 Windows，文件读写、编译和测试复用已连接的 CC Desk Tunnel 客户端执行通道；CLI 请求用量回到桌面端的“账号与额度”查看。

上游已有内嵌原生终端和用量界面。本功能增加外部终端入口，并把这条入口接到现有统计实现，不创建第二套会话管理器或统计界面。

## 准备条件

- 服务端包含本功能源码，使用 Node.js 24，官方 Claude Code 已安装并按正常流程授权。
- Windows 客户端已连接到这个服务端，保持在线或留在托盘。它提供回到 Windows 的临时 SSH 执行通道。
- Windows 已能通过自己的 SSH 配置别名登录服务端，主机密钥已经核对。脚本不安装 SSH 服务、不开放公网端口、不配置代理。
- 项目是 Windows 中现有的文件夹，使用当前普通用户权限。

本文用 `ai-server`、`D:\Projects\demo` 和文档用设备 ID 举例。把它们替换成自己的值，不要把连接凭据写进仓库。

## 取得这个功能

服务端和 Windows 启动脚本需要来自包含本改动的同一份源码。官方 v0.3.7 发行包没有这个外部入口。按[部署手册](../deploy/README.md)从对应源码构建并部署服务端；Docker 构建入口例如：

```sh
docker build -f deploy/docker/Dockerfile -t cc-desk-tunnel:external-cli .
```

镜像的源码复制步骤会包含 `apps/server/src/external-cli.ts`。Windows 使用同一源码中的 `scripts/open-external-cli.ps1`。先在独立测试部署验证，再按原有部署流程升级；不需要安装第二套 Windows SSH 服务或同步整个项目。

## 运行结构

```text
Windows Terminal
  → 既有管理 SSH / PTY
  → Linux 容器中的 external-cli.ts
  → 官方 Claude Code
       ├─ 工具：CC Desk 临时 SSH 执行通道 → Windows 项目
       └─ 用量：仅回环的 CLI 采集器 → 同一 sessions.sqlite
                                                ↓
                                      CC Desk 用量查询和界面
```

外部 CLI 为本次进程启动回环采集器，复用现有 `UsageLog`、事件白名单和请求去重。它不用读取服务进程的私有环境文件，不要求重启服务端，也不新增对外监听端口。

## 从 Windows 启动

在普通用户 PowerShell 或 Windows Terminal 中，从源码仓库运行：

```powershell
.\scripts\open-external-cli.ps1 `
  -SshTarget ai-server `
  -ProjectPath 'D:\Projects\demo' `
  -DeviceId '11111111-1111-4111-8111-111111111111'
```

设备 ID 来自对应客户端的设备身份；也可以通过 `-ClientSettingsPath` 显式指定客户端的 `settings.json`，脚本只取其中的 `deviceId`。不要复制整份设置文件到服务端或仓库。

服务器需要 `sudo -n docker` 时，添加 `-Sudo`。容器名、容器用户、数据目录、Node、CLI 和配置文件位置可通过脚本参数调整；用 `Get-Help .\scripts\open-external-cli.ps1 -Full` 查看接口。

默认容器内位置：

| 参数 | 默认值 |
|---|---|
| 容器 | `cc-desk-tunnel` |
| 执行身份 | `1000:1000` |
| 数据目录 | `/data/state`，直接包含 `sessions.sqlite` 和 `devices` |
| Node | `/opt/runtime/node/bin/node` |
| 官方 CLI | `/opt/runtime/cli/bin/claude` |
| 提供方设置 | `/data/config/provider.json` |
| 本功能入口 | `/app/apps/server/src/external-cli.ts` |

数据目录必须是同一服务正在使用且已经初始化的目录。入口先检查数据库和对应设备执行通道，再启动 CLI；目录写错时应修正参数，不创建另一份空用量库。

Windows 路径用 UTF-8 Base64 传输，避免空格、中文和引号被远程 shell 改写。管理 SSH 保留严格主机密钥检查和 PTY；脚本不会关闭验证或传输私钥内容。

## 检查、续接和退出

- 添加 `-Check`：只检查项目、设备通道和启动条件，不发送模型请求。
- 添加 `-ContinueSession`：继续这个设备、项目对应的最近一份原生 CLI 历史。
- 在 CLI 内使用 `/resume` 选择原生历史，使用 `/exit` 正常退出。
- CLI 退出后外层 SSH 返回，采集器与数据库连接随本次入口关闭。

同一设备、规范化后的同一 Windows 项目路径对应稳定的服务端辅助目录。该目录保存 CLI 的工作上下文，项目文件仍在 Windows。GUI 与外部 CLI 的会话列表分别管理，共用官方身份与统计账本。

连接断开后先检查此前工具命令是否已经完成，再决定是否重试；入口不会自动重放模型任务。客户端执行通道离线时，先恢复客户端连接，再重开 CLI 并使用 `/resume`。

入口的退出收尾覆盖本次采集器、数据库连接和 Linux CLI 进程组。已经在 Windows 端启动的命令需要另查执行状态，不能从外层终端退出推断它们已经停止。

## 用量怎样查看

1. 从本入口启动 CLI 并完成请求。
2. 回到 CC Desk 的“账号与额度”页刷新，查看汇总和调用日志。
3. 需要逐会话核对时，按原生会话和调用记录判断；GUI 的“当前会话”只计算当前 GUI 会话。

同一请求重复导出时，沿用请求 ID 去重。每次入口使用独立 SQLite 连接，设置写锁等待，支持与服务端和其他外部 CLI 连接共用账本。

Token 和 API 折算金额来自官方 CLI 的请求事件；金额是 API 价格估算，订阅额度由账号额度信息另行展示。统计只保存现有白名单字段，不开启提示词、回复正文或账号信息导出。

环境只对新启动的进程生效。已经运行的旧入口没有采集配置时，退出后重新打开，再用 `/resume` 续接。本功能不扫描、导入或改写旧 CLI JSONL，也不自动补记历史。

## 登录、权限与网络

入口复用容器现有的官方登录和提供方配置，不导入浏览器会话令牌。需要重新授权时，按原有服务端授权流程操作；要求授权浏览器也位于服务端环境的部署，应在该环境打开授权页。

Claude 的模型请求走服务端既有网络，本文脚本不改变代理、DNS、防火墙或出口。Windows 工具命令按 Windows 本机环境执行。项目选择不是强制沙箱，工具返回的 Windows 路径和系统信息会进入模型上下文。

外部 CLI 与服务端同属一个可信用户环境。删除 `PROXY_*` 等环境变量用于避免无意继承服务秘密；它不会把同用户可读文件变成权限隔离区。

## 定位问题

| 现象 | 检查位置 |
|---|---|
| SSH 无法登录 | 先独立运行 `ssh ai-server`，核对别名和主机密钥 |
| 找不到入口模块 | 容器必须包含本分支源码；旧发行镜像没有新增文件 |
| 数据库或设备配置不存在 | 数据目录、设备 ID、客户端是否已成功连接 |
| Windows 通道探测失败 | CC Desk 客户端连接状态、临时 SSH 与本机执行组件 |
| CLI 能工作而界面没有新增用量 | 是否从更新后的入口新开；是否查询同一数据库；账号页是否已刷新 |
| 模型请求失败 | 按既有服务端登录、提供方和网络日志排查 |

开发验证使用合成事件、临时数据库和模拟 CLI；真实模型、生产登录、网络代理不应进入单元测试。具体测试命令沿用仓库的 `npm test`、`npm run typecheck` 和 `npm run format:check`。
