# 两端消息契约

当前版本见 `src/index.ts` 的 `PROTOCOL_VERSION`，导出 TypeScript 类型和 Zod 运行时校验。两端需一起升级。服务适配原生公开事件，不复制 CLI 私有控制协议；该部分由官方 SDK 管理。

## 连接与消息

- WebSocket `/ws` 建立后，首帧必须是 `auth`：协议版本、代理服务 token、设备名称。5 秒内不认证则关闭；token 不进入会话事件。服务回传 `ready`、连接 ID 和会话目录。
- `requestId`、会话/运行/消息/审批 ID 为 UUID；工具 ID 保留原生 opaque ID。请求收到 `response` 只表示接纳/拒绝，不表示运行完成。
- 请求包括 `session.create/delete/rename/subscribe/history/configure/compact/status`、`message.send`、`run.cancel`、`approval.reply`。`message.send.scenario` 是模拟器专用场景选择，原生适配不据此构造虚假能力。
- 原生运行的所属连接可继续 `message.send`，同一 run / 原生进程接入 streaming input，不要求停止。`message.delivery` 按 messageId 更新提交 / 等待处理 / 原生回执 / 未送达 / 未确认；response 不等于原生采纳。消息合并和处理时机交给 CLI，未知状态不自动重放；每运行传输等待上限 32 条。
- 服务事件为 `session.event`，包含会话 ID、运行 ID、时间和从 1 起的会话内递增 `sequence`。每个事件落盘后才广播。实时与历史可按 sequence 去重。
- `session.subscribe` 只订阅当前会话，游标为 0 时取最近一页，非零游标补齐小差量，大差量回最近页。`session.history.beforeSequence` 加载更早完整轮次，不改变订阅。`session.snapshot` 有 `requestId`、replace/prepend/append 模式、原始 first/lastSequence 游标和 hasEarlier；历史连续增量批量合并，不逐 token 重播。合并事件 sequence 为该段末事件，分页游标由独立字段提供。`session.updated/deleted` 更新目录。
- 原生桌面 `auth.tunnel=true`，服务发送 `tunnel.configure`（临时 frp token / 证书 / 端口）；主进程返回绑定 connection ID 的 `tunnel.credentials`（SSH identity / host key / 用户 / PowerShell 路径），服务实际探测后发送 `tunnel.ready`。`auth.tunnelTransport=relay` 时服务改发 `tunnel.relay`（每连接随机密钥），不启动 frp：桌面另开若干 WSS 连接到同一 `/ws`，首帧 `tunnel.attach`（连接 ID + 密钥）；服务把 ssh 的每条 TCP 连接交给一条空闲中继连接并发 `tunnel.begin`，此后该连接只承载这条 TCP 的二进制字节，任一端结束即关闭。这些消息不进入 GUI 历史，所有秘密经加密且验证身份的控制连接传递。
- 不含 `execution.*` 请求、远程执行能力标志或执行 MCP。原生审批仍用 `approval.requested/reply/resolved`，只传递官方引擎发出的请求 / 用户决定。
- `session.configure` 保存原生 `auto/default/plan/acceptEdits`、model / effort 偏好，新会话默认 auto，运行中不可更改。`native.session` 分别回传请求 / 实际模式与 effort；`native.capabilities` 传原生模型目录、命名账号字段及命令名；`native.metrics` 分开当前上下文摘要、累计用量估算和订阅额度，不可用为 null / unavailable。`native.compact` 是实际压缩边界，不是代理摘要。
- `native.context` 报告官方原生会话存储检查结果，不传输私有 JSONL 或将镜像作为模型输入。改名 / 删除先更新官方原生记录，失败保留代理镜像；禁止与运行并发管理。
- `session.status` 无模型提示，读取原生公开控制状态。`native.metrics.errors` 区分上下文 / 用量失败；额度标注测量时间。`native.title` 只同步未被用户改名的自动标题；旧会话默认不自动覆盖。
- `terminal.open/close/detach` 为带 requestId 的操作，`terminal.opened/data/closed` 仅发所属连接；独立的 terminalId，摘要 `activeRun.surface=terminal` 表示该会话被终端占用，不意味着终端上下文与图形 session 相同。终端原始文本不存入 session.event。
- 一个会话同时最多一个终端，不同会话的终端可同时运行（每台设备最多 8 个）。`terminal.detach` 后 CLI 继续运行；再对该会话 `terminal.open` 得到同一个 terminalId，服务端先发清屏后的当前整屏，再发实时输出。`terminal.open.continue` 让新终端接着会话目录里最近的原生对话。`terminals.state` 在终端启动、结束、状态变化或显示 / 隐藏时发给所属连接，`terminal.list` 主动索取；状态 `starting/busy/waiting/idle` 来自注入的 Claude Code hooks。
- `terminal.input/resize/ack` 无逐键请求响应；校验归属、terminalId 和大小。`ack.bytes` 是 xterm 已渲染的 UTF-8 字节数，控制 PTY 背压；不能超过服务尚未确认的输出。原始数据帧按 16384 个 UTF-16 code units 分片且不切开 surrogate pair。

## 生命周期

运行状态为 `running → awaiting_approval → running → completed`，也可终止为 `cancelled/failed`。拒绝产生 `tool.result(denied)`，模拟器在解释拒绝后正常完成本轮；错误事件与失败状态分开。

审批与取消必须匹配当前运行及发起连接；摘要里的 `activeRun.connectionId` 让界面显示真实可操作状态。断连结束该连接拥有的运行；重连重新认证，只订阅历史。例外是声明了 `auth.resumable` 的中继连接（Linux 连接桥）：`ready.resume` 给出密钥与宽限期，双方对认证后的帧计数并以 `resume.ack` 确认；断线后以 `auth.resume` 认证，服务回 `resumed` 后双方各自补发对方未收到的帧，连接 ID、运行和终端不变。连接桥只把 `connection.state` 告诉自己的客户端。详见 [Linux 桌面指南](../../docs/linux-desktop.md#断线续接)。服务恢复未完成记录时补充工具取消和运行取消事件，不重放操作。

同一连接的相同 requestId 返回已缓存响应；不同内容返回冲突。`session.create` 和同一会话内 `message.send` 的 requestId 在记录存续期间持久去重，即使跨连接或服务重启也不重复创建/发送；删除记录后该去重信息也删除。其他请求不跨连接自动重试。超时/断连可能发生在服务已接纳请求之后，客户端以恢复历史确认结果，不自动重发。

入站控制请求上限 256 KiB，用户输入最多 16000 字符；历史快照不套用入站命令上限，桌面接收使用 `ws` 的默认上限。分页软预算为 1000 原始事件 / 512 KiB，单个过大轮次仍完整返回，极长单轮仍需后续优化。上游特有内容由服务适配层处理，不复制上游私有控制协议。
