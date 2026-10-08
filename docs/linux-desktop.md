# Linux 桌面客户端（Ubuntu 26.04 LTS x86_64）

Linux 桌面也可以作为项目执行端；Claude Code 仍在远端服务运行。不是把服务端目录当作本机项目。Windows 客户端继续使用原有 OpenSSH / PowerShell 通道。

## 构建与运行

需要普通用户、Node.js 24、npm、tar，以及图形桌面。安装发行包后不需要 Node 或 npm。

```bash
npm ci
npm run setup:desktop
npm run build
npm run desktop
```

Linux 不使用 frp：执行通道经服务端的 WSS 中继到达本机 SSH（见下文“执行通道”），不需要 frpc、额外端口或任何系统服务。

```bash
npm run package:linux
sudo apt install ./artifacts/linux/CC-Desk-Tunnel-0.2.5-amd64.deb
```

产物包含 Electron、前端、连接桥、锁定依赖版本的纯 JS SSH 实现，以及终端客户端 `/usr/bin/ccdt`（由包内 Electron 以 Node 模式运行，不需要另装 Node）。可用 `npm run package:linux -- --dir` 只生成免安装目录。只支持 Linux x64；没有宣称验证其他发行版、架构或 Windows 打包。

在程序里填写可信远端服务的 WSS 地址、证书指纹和服务凭据，再选择本机绝对项目路径。

**客户端与服务端必须一起使用本次代码（协议 12）。** 旧协议会明确拒绝连接。Linux 当前使用 deb 覆盖升级；服务端提供的 Windows exe 自升级不适用于 Linux。现有用户数据保持在 Electron 的 userData 目录（通常为 `~/.config/CC Desk Tunnel`，服从 XDG 配置），实际计划任务路径随握手传给服务端。

## 终端客户端

不想开图形界面时，可以用 [`ccdt`](../apps/cli/README.md) 在系统终端里直接使用远端原版 Claude Code：安装 deb 后即有 `ccdt`（源码目录用 `npm run install:cli`），`ccdt login` 保存连接信息，之后在项目目录运行 `ccdt`。它与桌面客户端共用同一套连接桥、中继和 SSH 实现。同一服务同一时间只接受一台执行设备，`ccdt` 与桌面客户端二选一。

## 执行通道

Linux 客户端在认证时声明 `tunnelTransport=relay`。服务端不启动 frps，只在容器回环地址监听一个随机端口，并发给客户端一个每连接随机的 256 位中继密钥。客户端预先建立两条到同一 `/ws` 的 WSS 连接（证书校验与控制连接相同，校验通过才发送密钥），用 `tunnel.attach` 登记为中继。服务端的 `ssh` 每建立一条 TCP 连接，就占用一条空闲中继并发送 `tunnel.begin`；客户端把它接到本机 SSH 端点，同时补开一条新的空闲连接，因此命令不必等待新的 TLS 握手。

- 只用控制端口：不需要公网 7000 端口，nginx 模式下中继与控制连接同走 `location = /ws`，配置无需改动。
- 每条 SSH 连接独占一条 WebSocket，背压沿 TCP 与 WebSocket 自然传递，大输出不会阻塞控制通道或其他命令。
- 密钥错误的中继连接按错误凭据计入来源地址的登录限速；中继池满时多余连接被拒绝；连接结束（主动退出，或断线超过宽限期）即关闭全部中继、监听和临时 SSH 配置。
- 服务端的 SSH 配置用 `ControlMaster` 让所有命令共用一条 SSH 连接：经中继每次握手要往返桌面好几趟，远端服务上约 1.5 秒；复用后一条命令只开一个通道，约 0.4 秒。这条连接随中继结束。

## 断线续接

Linux 客户端认证时声明 `resumable`，服务端在 `ready` 里发一个续接密钥和宽限期（3 分钟，`resumeGraceMs`）。此后两端给认证之后的每一帧计数，保留对方尚未确认的帧，大约每秒互相确认一次。

- 连接桥每 10 秒 ping 一次服务，35 秒没有任何回应即判定断线（服务端 15 秒 ping、45 秒判定）。除主动关闭（1000）和服务的明确拒绝（4xxx）外，断开都视为网络问题。
- 断线期间服务端保留连接：运行、审批、终端和中继监听都不结束，发给这个连接的帧继续记下（上限 16 MiB，超出即放弃）。终端不因输出未确认而关闭。Claude 此时发起的 `ssh` 会等待中继，最多 30 秒（`ConnectTimeout` 与中继等待一致），所以短暂中断时命令只是慢一些。
- 连接桥立刻开始重连，间隔逐步加长到 5 秒。新连接以 `auth.resume`（连接 ID、密钥、已收到的帧数）认证；服务端回 `resumed`（它已收到的帧数），把新 socket 交给原连接，补发客户端漏收的帧；连接桥再补发服务端漏收的帧，并换掉可能已失效的空闲中继连接。不会重复也不会丢帧。
- 连接桥的客户端（`ccdt` 或图形界面）不会感知到换了连接，只收到 `connection.state`（`reconnecting` / `connected`）用于提示；期间发出的消息在恢复后送出。
- 超过宽限期、服务重启或续接被拒绝时，与此前一样结束运行，客户端收到明确的错误。主动退出（关闭窗口、`/exit`）以 1000 关闭，服务端立即回收，不等宽限期。
- 掉线后还在宽限期内的设备会被同一服务凭据的新登录接管（大概率是同一台桌面重新启动了客户端），不会提示“已有设备连接”。
- Windows 客户端仍使用 frp；服务端两种方式并存，仍需为 Windows 客户端放行 7000 端口。

## 平台行为

- 路径区分大小写，保留 POSIX 文件名中的反斜杠；Windows 盘符 / UNC 路径保留原比较规则。
- SSH 仅绑定 `127.0.0.1` 的随机端口，每次连接生成独立 Ed25519 主机密钥与认证密钥；只允许当前用户名与该公钥。主机密钥在服务端固定验证。
- SSH 仅提供非交互式 Bash exec，不提供密码认证、PTY、SFTP 或端口转发。所有命令以桌面当前用户权限运行，并非目录沙箱。
- 常规断连、启动失败和退出会回收中继连接、SSH 监听和命令进程组。强杀桌面进程可能留下命令子进程；主动脱离进程组的命令也不能保证回收。这不等同于 Windows Job Object 的强杀保证。
- 记住凭据要求可用的 GNOME Keyring / KWallet 等安全存储。Electron `basic_text` 回退不会被用于保存凭据；不可用时界面显示错误，可以不记住凭据继续使用。
- Linux 默认关闭窗口即退出，避免 GNOME 不显示托盘导致窗口无法找回。支持托盘的桌面可以显式开启“关闭窗口时留在后台”。
- 保留 Electron sandbox、contextIsolation 和 TLS / 证书指纹验证；不要用 `--no-sandbox` 规避系统问题。

## 验证

```bash
npm run typecheck
npm test
npm run build
xvfb-run -a npx playwright test apps/desktop/test/app.spec.ts -g 'Electron loads'
```

测试使用真实系统 OpenSSH 验证临时密钥、错误认证、中文标准输出 / 错误、退出码、进程组清理和 Linux 路径。`relay.test.mjs` 启动真实的 TLS 原生模式服务（CLI 不启动），经连接桥和中继用 OpenSSH 执行并发命令、8 MiB 输出与 3 MiB 输入，并验证错误中继密钥被拒、断开后清理；另经一个可切断的 TCP 转发模拟断网，验证续接后双向消息不丢、断网期间发起的 ssh 命令在恢复后完成、超过宽限期两端放弃，以及新登录接管掉线设备。桌面 smoke test 使用离线模拟服务，不消费 Claude 配额。真实远端 Claude 会话仍需要用户的服务地址与凭据才能验收。
