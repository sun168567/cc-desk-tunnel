# 两端消息契约

当前版本见 `src/index.ts` 的 `PROTOCOL_VERSION`，导出 TypeScript 类型和 Zod 运行时校验。两端需一起升级。服务适配原生公开事件，不复制 CLI 私有控制协议；该部分由官方 SDK 管理。

## 连接与消息

- WebSocket `/ws` 建立后，首帧必须是 `auth`：协议版本、代理服务 token、设备名称。5 秒内不认证则关闭；token 不进入会话事件。服务回传 `ready`、连接 ID 和会话目录。
- `requestId`、会话/运行/消息/审批 ID 为 UUID；工具 ID 保留原生 opaque ID。请求收到 `response` 只表示接纳/拒绝，不表示运行完成。
- 请求包括 `session.create/delete/rename/move/subscribe/history/configure/compact/status`、`message.send`、`run.cancel`、`approval.reply`；`instructions.get/update` 读写云端 CLI 的用户级 `CLAUDE.md`，以 `instructions.state` 回复，更新带上读取时的版本，文件已变则拒绝。`message.send.scenario` 是模拟器专用场景选择，原生适配不据此构造虚假能力。
- 原生运行的所属连接可继续 `message.send`，同一 run / 原生进程接入 streaming input，不要求停止。`message.delivery` 按 messageId 更新提交 / 等待处理 / 原生回执 / 未送达 / 未确认；response 不等于原生采纳。消息合并和处理时机交给 CLI，未知状态不自动重放；每运行传输等待上限 32 条。
- 服务事件为 `session.event`，包含会话 ID、运行 ID、时间和从 1 起的会话内递增 `sequence`。每个事件落盘后才广播。实时与历史可按 sequence 去重。
- 分片到达的输出（`text.delta`、`thinking.delta`、`tool.input.delta`、`tool.output`）在到达时以 `session.fragment` 发给订阅者：不落盘、没有 `sequence`。一段输出结束（同一运行记下任何别的事件之前，或累计满 64K 字符）时，才作为一条同类型、含全部文字的 `session.event` 落盘并广播；客户端以它取代此前拼起来的片段。`session.subscribe` 的快照之后，服务端把运行当前未结束的那一段整段补发一次。
- `session.subscribe` 只订阅当前会话，游标为 0 时取最近一页，非零游标补齐小差量，大差量回最近页。`session.history.beforeSequence` 加载更早完整轮次，不改变订阅。`session.snapshot` 有 `requestId`、replace/prepend/append 模式、原始 first/lastSequence 游标和 hasEarlier；历史里一段输出就是一条事件；0.2.12 之前写入的历史在升级时合并过，合并事件的 sequence 为该段末事件，所以 sequence 递增但不保证连续，分页游标由独立字段提供。`session.updated/deleted` 更新目录。
- `auth` 之后客户端紧接着发一帧 `device`，给出这台电脑的标识（客户端生成一次并保存）；名字取 `auth.deviceName`。`auth` 这一帧的形状各版本都要能读，版本不一致的客户端靠它得知服务端版本，所以新字段不加在它上面。没有发过 `device` 的连接可以查看，不能创建会话或发消息。服务端在 `ready` 之后、以及有设备上线、下线或执行通道就绪时，向所有连接发 `devices`：当前在线的设备列表，每项带 `ready`（命令能否到达它）；不在列表里的设备视为离线。
- 比服务端新的客户端可以让它升级：登录被拒时 `version_mismatch` 给出服务端版本，客户端按 `PROTOCOL_HISTORY` 查出那一版的协议版本，另开一条连接以它登录，发 `service.update.check`，状态为 `available` 时发 `service.update.install`，跟着 `service.update` 的进度直到 `restarting`。0.2.4 起的服务端都这样应答，以后的版本要保持这几帧（`auth`、`ready`、`response`、`connection.error`、`service.update` 与这两条命令）的形状和含义；改 `PROTOCOL_VERSION` 时在 `PROTOCOL_HISTORY` 加上新版本，测试会核对。
- 原生桌面 `auth.tunnel=true`，服务发送 `tunnel.offer`（本次连接的通道密钥）；主进程返回绑定 connection ID 的 `tunnel.credentials`（SSH identity / host key / 用户），服务实际探测后发送 `tunnel.ready`。服务端每收到一条 SSH 连接就发一条 `tunnel.open`，主进程为它另开一条到同一地址的连接，首帧发 `tunnel.attach`（连接 ID、通道 ID、通道密钥），此后这条连接只转发 SSH 的字节。这些消息不进入 GUI 历史，所有秘密经加密且验证身份的控制连接传递。
- 不含 `execution.*` 请求、远程执行能力标志或执行 MCP。原生审批仍用 `approval.requested/reply/resolved`，只传递官方引擎发出的请求 / 用户决定。
- `session.configure` 保存原生 `auto/default/plan/acceptEdits`、model / effort 偏好，新会话默认 auto，运行中不可更改。`native.session` 分别回传请求 / 实际模式与 effort；`native.capabilities` 传原生模型目录、命名账号字段及命令名；`native.metrics` 分开当前上下文摘要、累计用量估算和订阅额度，不可用为 null / unavailable。`native.compact` 是实际压缩边界，不是代理摘要。
- `native.context` 报告官方原生会话存储检查结果，不传输私有 JSONL 或将镜像作为模型输入。改名 / 删除先更新官方原生记录，失败保留代理镜像；禁止与运行并发管理。
- `session.status` 无模型提示，读取原生公开控制状态。`native.metrics.errors` 区分上下文 / 用量失败；额度标注测量时间。`native.title` 只同步未被用户改名的自动标题；旧会话默认不自动覆盖。
- `terminal.open/close` 为带 requestId 的操作，`terminal.opened/data/closed` 仅发所属连接；独立的 terminalId，摘要 `activeRun.surface=terminal` 表示互斥占用，不意味着终端上下文与图形 session 相同。终端原始文本不存入 session.event。
- `terminal.input/resize/ack` 无逐键请求响应；校验归属、terminalId 和大小。`ack.bytes` 是 xterm 已渲染的 UTF-8 字节数，控制 PTY 背压；不能超过服务尚未确认的输出。原始数据帧按 16384 个 UTF-16 code units 分片且不切开 surrogate pair。

## 浏览器连接

桌面 `/ws` 及其首帧认证保持不变。启用 Web 后，浏览器先在入口路径下通过 HTTPS 登录，取得 `HttpOnly` Cookie，再连接该路径下的 `/api/ws`；握手校验 Cookie 和同源关系，首帧为 `web.auth`，不携带服务凭据或设备身份。`ready.browser` 标识这是一条浏览器控制连接，之后复用已有会话、运行和终端消息，不建立执行通道。

`passkey.ts` 定义通行密钥管理请求、注册状态与敏感操作证明。`web.passkeys.start/status/cancel` 管理绑定发起连接的注册授权，`rename/remove` 管理注册；密码证明与短时一次性的 Passkey 再验证证明互斥。WebAuthn 注册、浏览器登录和再次验证通过当前 Web 前缀下的 HTTPS 接口完成，服务端校验域名、Origin、用户验证与一次性 challenge，认证结果不通过页面自报或客户端名称判定。

`src/web.ts` 定义登录状态、`web.settings.*`、浏览器会话撤销和 TOTP；`src/index.ts` 定义 `server.session.create`；`src/web-certificate.ts` 定义桌面专用的证书命令与状态。Web 设置回复通过各自的状态消息返回，不进入 `ProxyClient` 的通用会话状态。服务端用显式命令白名单限制浏览器，新命令不会自动开放；浏览器不能发送 `device`、`tunnel.*`、项目管理或其他设备的会话创建 / 分叉命令。

浏览器页面上有点击、按键、滚动或触摸时，最多每分钟发一次无 requestId 的 `web.activity` 帧，服务端据此更新空闲时间；发消息、审批等修改类命令本身也会更新。读取命令、自动加载和重连不会更新；桌面连接发送这一帧会被视为无效消息。它不改变命令权限，也不延长 30 天绝对期限。

`server.session.create` 创建归属稳定服务端设备的普通会话，跨浏览器或服务重启保留归属；原生工具直接在容器里执行。浏览器仍可操作其他在线设备的已有会话。登录与权限边界见[浏览器访问](../../docs/server-web.md)。

## 生命周期

运行状态为 `running → awaiting_approval → running → completed`，也可终止为 `cancelled/failed`。拒绝产生 `tool.result(denied)`，模拟器在解释拒绝后正常完成本轮；错误事件与失败状态分开。

运行属于会话所在的设备（会话的 `device`），命令走那台设备的执行通道；消息、追加消息、审批、停止、结束后台任务可以来自任何设备的任何连接，`activeRun.connectionId` 只记录发起它的连接。从别的设备发起新运行时，会话所在设备必须在线且执行通道就绪，否则返回 `device_offline` 或 `execution_offline`。两端同时操作时：同一 `requestId` 重发按同一条处理；审批与提问以先到的答复为准，后到的返回 `approval_answered`；对已结束的运行或后台任务再发停止视为无操作，返回成功；两端各自发出的不同消息都保留。断连不结束运行：设备的最后一条连接断开后，它的运行保留一段宽限期（默认 5 分钟），同一设备重新认证后接着订阅历史、答复审批；超过宽限期或客户端先发了 `leave` 帧则结束。`run.continue` 接着被停止或中断的一轮继续，记录为带 `continued` 的 `message.user`。服务恢复未完成记录时补充工具取消和运行取消事件，不重放操作。

同一连接的相同 requestId 返回已缓存响应；不同内容返回冲突。`session.create` 和同一会话内 `message.send` 的 requestId 在记录存续期间持久去重，即使跨连接或服务重启也不重复创建/发送；删除记录后该去重信息也删除。其他请求不跨连接自动重试。超时/断连可能发生在服务已接纳请求之后，客户端以恢复历史确认结果，不自动重发。

入站控制请求上限 256 KiB，用户输入最多 16000 字符；历史快照不套用入站命令上限，桌面接收使用 `ws` 的默认上限。分页软预算为 1000 原始事件 / 512 KiB，单个过大轮次仍完整返回，极长单轮仍需后续优化。上游特有内容由服务适配层处理，不复制上游私有控制协议。
