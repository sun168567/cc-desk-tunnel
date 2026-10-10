# Linux 服务

Linux 上的代理服务：认证客户端、管理会话、驱动官方 Claude Code、维护到 Windows 的执行通道，并记录调用统计。`src/throttle.ts` 按来源地址限制凭据错误的重试和未认证连接的数量。

## 开发入口

根目录 `npm run dev` 同时启动模拟服务和浏览器 GUI，生成随机服务凭据并写入被忽略的 `.local/dev-connection.json`，控制台不输出 token。默认端口 8787 / 5173，已占用时寻找后续可用端口；以启动输出和本地连接文件为准。会话记录在 `.local/sessions/`。

仅启动服务：在 PowerShell 7 设置 `$env:PROXY_TOKEN`（至少 24 字符）后，从根目录运行 `npm run server`。可选 `PROXY_PORT`、`PROXY_DATA_DIR`、逗号分隔的 `PROXY_ORIGINS`。默认数据目录不受 npm workspace 的 cwd 影响。

模拟只监听 `127.0.0.1`，`GET /health` 报告适配模式，`/ws` 用首帧认证。默认浏览器来源为本机 5173，以及 Electron 文件页面的 `file://` / 不透明来源 `null`；没有 Origin 的程序客户端也必须认证。不要将模拟 HTTP 原样暴露公网。

## 原生连接

`scripts/install-linux.sh` 为普通用户准备 Node 24.21.0、官方 Claude Code 2.1.293。CLI 使用官方 npm 发布包，无二进制修改。

开发部署用 `scripts/deploy-linux.mjs`：通过可信 SSH 传输应用与私有配置，生成 IP 可用的固定自签证书，原生服务 WSS 监听 `PROXY_PORT`。生产只需放行这一个端口，通往 Windows 的 SSH 端口只监听 Linux `127.0.0.1`。

生产部署见[操作手册](../../deploy/README.md)。`src/config.ts` 读取配置：`PROXY_ADAPTER=claude-code`、`PROXY_TOKEN`、`PROXY_DATA_DIR`、`CLAUDE_PATH`；旧部署留下的 `PROXY_PUBLIC_HOST` 与 `FRPS_*` 不再读取；直连还需要 `PROXY_TLS_CERT/KEY`，反代明确设置 `PROXY_TLS_MODE=reverse-proxy`。反代原生进程默认仅回环，Compose 显式使用容器网卡并仅宿主回环发布。API 调试可用 `CLAUDE_MODEL`、`CLAUDE_SETTINGS_PATH` 指向私有提供方配置。原生保留期 `CLAUDE_CONTEXT_RETENTION_DAYS` 默认 3650（正整数）。不会自动获取或转发订阅 OAuth。

- `src/tunnel.ts`：每个在线设备一个回环监听和一个随机通道密钥。每来一条 SSH 连接就先不读它，经控制连接要一条通道（`tunnel.open`），客户端带着密钥连上来后把两者的字节对接；十秒没有等到就关掉这条 SSH 连接。同时等待的连接和已对接的通道各有上限。注册密钥后用原生 ssh 探测。生成的 SSH 配置打开连接复用（`ControlMaster`，套接字在连接目录里）：一台设备的命令共用一条 SSH 连接，省掉每条命令的登录往返；Windows 上的 `ssh` 没有连接复用、数据目录过长放不下套接字路径时不启用。凭据在 `connections/<id>/`（目录 0700、文件 0600），断连关闭监听和全部通道并删除目录。通道连接的认领在 `server.ts`：首帧是 `tunnel.attach` 的连接不成为控制连接，密钥不对按登录失败计数。会话的系统提示词引用的是固定的 `session-ssh/<会话>.conf`（只含指向当前连接配置的 `Include`，不含凭据），重连不改变提示词，见[原生运行时](../../docs/native-runtime.md)。
- `src/claude.ts`：官方 SDK `query` 驱动指定的原生 CLI；提示词给 Windows cwd、PowerShell 和 SSH config 路径。`canUseTool` 只转发原生权限请求，不注册新增 MCP 工具、不自行决定审批策略。
- `src/native-input.ts`：同一运行可追加 async user message，带客户端 UUID、human origin，原生负责调度 / 合并。结果按 `user_message_uuids` 和 `queued_turn_count` 处理，不能首个 result 就丢弃后续输入；收尾同步停止接收。取消 / 断连 / 重启不重放，未送达与接收未确认分别记录。
- `src/claude-stream.ts`：适配公开文字 / 思考 / 工具入参和结果。不解析未公开隐藏推理，不把自建结果格式塞回原生工具。
- 工具进度来自原生 `tool_progress`；Bash 输出按原生工具结果展示，不承诺每行 stdout 实时接出。
- 原生 session ID / resume / abort 均由官方组件管理。改名 / 删除已有原生会话先调用官方 renameSession / deleteSession，再更新代理索引；原生更新失败保留代理记录，运行中禁止管理。
- 默认请求原生 auto，可选 default / plan / acceptEdits；回传 requested / actual 模式，不自建 AI 审批。原生 canUseTool 仍转发需要用户的请求。
- `src/native-controls.ts` 转接初始化的模型目录、命名账号字段、原生上下文摘要与用量；实验额度接口独立隔离、五秒超时，状态获取失败不让完成的任务失败。按模型的每周额度（如 Max 订阅的 Fable）以 `seven_day:<模型>` 命名，与其他每周窗口一样划分统计周期。累计 token / CLI 费用估算不冒充当前上下文 / 提供方账单；API 无订阅额度时明确不可用。
- 会话 model / effort 偏好在下轮传给 SDK，实际值仅按原生报告展示。主动压缩发送原生 `/compact`，转接真实 compact boundary，不自行总结上下文。
- 原生持久化开启；恢复前官方 getSessionInfo 验证上下文存在，不存在则明确失败，不用 GUI 历史重建。每轮回传原生保存状态。
- 不改 CLI 或注入代码；已安装可执行文件与官方同版本 Linux 包 SHA256 一致，实际进程 / 环境核对见[原生运行](../../docs/native-runtime.md)。
- `src/native-terminal.ts`：node-pty 直接启动同一官方 CLI，普通 PTY / ANSI 双向传输，不走 SDK、不伪装入口、不提供通用 shell；复用私有提供方进程环境和 Windows SSH 提示词。当前是独立原生控制会话，不恢复图形 session、不导入终端文本到代理历史。所有图形运行 / 会话管理与终端互斥。
- 终端原始输出仅发所属连接；128 KiB 未确认输出暂停 PTY，低于 32 KiB 恢复，30 秒无回执回收进程。前端回执在 xterm write 完成后发送；终端输入 / 尺寸 / 回执不创建逐键响应缓存。关闭、断连与服务退出结束进程组，不保存终端画面或授权代码。

当前个人自用，多会话，同一使用者的几台设备可以同时在线，各有各的执行通道。会话记着它所在的设备（`device`），只有那台设备能向它发消息或打开它的终端；别的设备先用 `session.move` 给出本机的项目目录把它接过来，或用带 `projectPath` 的 `session.fork` 分叉到本机。升级前没有设备信息的会话归第一个使用它的设备。设备标识在登录之后由单独的 `device` 帧给出，登录帧保持各版本都能读的形状。运行和终端合计有上限，默认按“（内存 − 300 MB）÷ 300 MB”取整，至少 1，可用 `PROXY_MAX_RUNS` 指定。停止或断连不会静默重放；未确认的工具结果标记 unknown。SSH 终止不保证远端子进程全部结束。

## 实现与验证

- 模块：`main.ts` / `config.ts` 读环境并启动；`server.ts` 是连接与命令的唯一入口；`store.ts` 持久化；`claude.ts`（SDK 运行）、`claude-stream.ts`（原生消息转协议事件）、`native-input.ts`（运行中追加输入）、`native-controls.ts`（账号 / 模型 / 额度）、`native-terminal.ts`、`native-account.ts`、`native-onboarding.ts` 组成原生适配；`tunnel.ts` 管执行通道与 SSH 配置；`usage.ts` 收集调用统计；`simulation.ts` 是离线模拟；`errors.ts` 是可回给客户端的错误。
- `src/server.ts`：认证、请求、连接归属和广播；每类命令一个处理函数，`execute` 只做分发。模拟器在 `src/simulation.ts`。三种场景为聊天、一次 PowerShell 审批、上游错误。PowerShell 仅显示固定 `Get-Location` 和模拟结果，从不创建命令进程。
- `src/store.ts`：Node 24 内置 SQLite / WAL，摘要与原始事件分表、每事件事务落盘，不逐 token 重写整份历史。旧 UTF-8 JSON 一次性事务导入、原文件保留作迁移备份；日后备份以 SQLite 和原生 CLI 存储为准。启动恢复未结束轮次，不重放。
- 状态读取不改变会话的最近使用时间。升级时修正旧的活动时间和用量周期边界，原始事件与调用记录保留。提前重置的时间靠额度读数推断，历史读数缺失时不能精确恢复。
- 登录只发会话目录，打开会话取最近页且仅订阅当前会话；向上加载完整轮次。1000 事件 / 512 KiB 软预算，单个大轮次不切断；历史连续文本增量在传输层合并，原始事件不改写。重连小差量按游标补齐，大差量回到最近页，不整段逐 token 重播。
- `session.fork` 用 SDK 的 `forkSession` 复制原生会话并复制事件记录，可截到某条用户消息之前。分叉的原生记录在源会话的 Linux 目录里，会话元数据的 `nativeRoot` 指向它。带截取点的分叉分两步：先截到该消息，再截到它的前一条，中间副本随即删除；该消息之前没有内容时新会话不带原生上下文。
- 同时允许多会话，单会话只有一个运行。审批/取消仅原连接可操作。断线的在途模拟工具标记未执行；真实执行的“结果未知”语义由 P2 定义，不能套用模拟结论。
- 15 秒 ping，下一次仍未收到 pong 则终止连接；正常关闭立即取消。删除原生会话及代理展示记录，不碰 Windows 项目目录。
- 保存内容损坏会明确启动失败，不自动覆盖历史；Docker 部署提供停服一致性备份 / 空数据恢复。Claude 登录凭据在数据目录的原生 HOME 里，重建容器后保持。

根目录 `npm test` 覆盖认证、UTF-8、原生事件适配、SSH 配置、流、审批、取消、恢复和持久化；真实 Ubuntu / API 测试需显式启用，协议见[协议模块](../../packages/protocol/README.md)，连接设计见[架构](../../docs/architecture.md)。

VPS 默认端口、脚本能力、TLS 信任、Windows 用户权限和待验证范围见[部署与安全说明](../../docs/deployment.md)。
