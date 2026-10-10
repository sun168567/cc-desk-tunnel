# 原生运行与会话存储

本页说明代理如何驱动官方 CLI，以及会话上下文归谁管。只记录代码与对实际进程的检查结果。

## 本体与外层

本项目按固定版本从官方 npm 安装 `@anthropic-ai/claude-code`（当前 2.1.293）。不改写 CLI、替换内部工具或注入代码；自动与手动审批均交给原生处理。

外层采用官方 Agent SDK 0.3.286，指定 `pathToClaudeCodeExecutable`，经官方双向 stream-json / stdio 控制接口传递用户输入、公开事件、审批与取消。SDK 自身使用真实 `CLAUDE_CODE_ENTRYPOINT=sdk-ts`、版本标记与 `--permission-prompt-tool stdio`；这是原生 stdio 请求 / 回复入口，不是 MCP 工具。没有伪装成交互式终端，也没有覆盖官方标记。

模型列表来自 CLI 初始化，桌面端不维护型号名单。CLI 按账号和提供方使用官方动态目录或内置目录；SDK 的 `supportedModels()` 返回初始化快照。空闲时“刷新模型列表”启动新的 CLI 读取状态。动态目录可带来新型号，内置目录和能力支持仍随 CLI 版本更新。

代理有意变化限于外层：稳定 cwd / session ID、Windows SSH 提示词、用户选择的审批模式、可选的提供方 settings、公开增量输出、思考摘要显示（`--thinking-display summarized`）和官方持久化 / 恢复。不再额外设置禁用遥测 / 自动更新的变量，不默认限制任务轮数。服务读完自身配置后即从进程环境删除 `PROXY_*` / `FRPS_*` 与四个服务专用的 `CLAUDE_*` 变量，原生 CLI、其 shell 与控制终端继承到的只有宿主环境本身（容器内为 `HOME`、`PATH` 等），不含代理 token 或部署配置；用户有意放进环境的其他变量原样保留。这只避免无意带出：CLI 与服务同属一个 Linux 用户，配置文件仍可被读取，不构成多用户隔离。对“内层完全不变”的工程解释是同一原生可执行与 agent 引擎，不是声称 headless / SDK 和终端 TTY 环境或未公开服务端判断逐项相同。

后台任务（后台 Bash 命令、子代理）活在 CLI 进程里，任务结束时 CLI 自己开始下一轮。一轮结束时若还有后台任务，服务端不关闭 CLI：运行状态改为“等待后台任务”，界面把这一轮视为已完成，列出任务并可逐个结束，期间可以继续发消息。任务结束后 CLI 开始的那一轮照常显示；任务全部结束且没有新的一轮时运行结束。停止运行会结束 CLI，后台任务随之终止。任务列表取自 SDK 的 `background_tasks_changed` 消息，不计标记为 ambient 的任务；结束单个任务用 SDK 的 `stopTask`。

原生控制终端另外用 node-pty 启动同一 CLI 交互式入口，不走 SDK、不设置 SDK 入口标记、不启动通用 shell。正常 flags / 私有提供方 env / Windows SSH 提示词属于外层配置；用户已有 settings.env 原样复用。键盘与画面经 WSS 接至 xterm，不解释 OAuth 内容或存储终端日志。当前终端使用独立原生会话，不能声称已替换同一图形会话的 CLI 壳；图形历史不会包括终端问答。

登录 / 退出 / 状态由服务端驱动官方 `claude auth login / logout / status`，授权链接与回填代码经桌面端转交，凭据只由 CLI 自己读写。官方 `auth login` 不记下首次引导已完成（2.1.286 实测），交互式终端因此会让已登录账号重走主题与登录。

**代理唯一直接改动 CLI 状态文件的地方**（`src/native-onboarding.ts`）：终端启动前，若官方凭据文件里已有登录而 `~/.claude.json` 缺少 `hasCompletedOnboarding`，服务端补上这一项；判断时只看凭据是否存在，不读取、不复制也不转发其内容，未登录时不动，引导照常出现。除此之外，代理对 CLI 的配置只通过官方 settings 文件与命令行参数表达。

每次模型调用的统计来自 CLI 自带的 OpenTelemetry 日志导出（`claude_code.api_request`）：服务在环回地址起接收端，只给自己启动的 CLI 进程设置 `CLAUDE_CODE_ENABLE_TELEMETRY` 与 `OTEL_*LOGS*` 变量，只保存模型、token、费用估算、耗时与会话 ID，不保存账号标识和内容；未开启提示词 / 回复导出。费用是 CLI 按 API 价格的估算，不是订阅账单。

运行中补充复用 SDK async user input，保持同一原生进程与 session ID；human origin 不把用户补充伪装成工具输出或系统提醒。原生可在工具间采纳或合并输入，回执通过消息 UUID 同步；代理不开发独立调度 / 记忆。输入收尾、断连 / 取消及重启按实际确认程度记录，无自动重放。

## 更换项目与换电脑

会话可以改指另一个项目目录，也可以从使用者的另一台电脑接过去。系统提示词不在原生记录里，每次启动 CLI 时由 `systemPrompt.append` 给出，它一变，模型侧的提示缓存从它之后全部失效。为了不让更换项目和重连白白丢掉提示缓存，一个会话的系统提示词在压缩之前逐字不变：

- 更换之后，系统提示词继续写原来的路径；变更由下一条用户消息前面的一段说明告诉 Claude（`[CC Desk Tunnel: the user moved this session …]`），界面只显示用户自己写的内容。
- 换电脑同理：会话被另一台设备接过去之后，说明里写明换了电脑、那台电脑的名字和它上面的项目目录（`[CC Desk Tunnel: the user now continues this session from another of their computers …]`）。
- 重连不需要说明：SSH 配置用会话固定的路径（见下文“存储”），不随连接变化；提示词里不写设备上任何程序或文件的位置，PowerShell 和定时任务文件由设备上的环境变量 `CC_DESK_TUNNEL_PWSH`、`CC_DESK_TUNNEL_SCHEDULES` 指明，客户端装在哪里都一样。
- 系统提示词在缓存前缀本来就要失效的时刻跟上当前值：观察到压缩事件之后的下一轮。
- 还没有原生上下文的会话直接改路径，没有说明。

压缩只把消息历史改写成摘要，不涉及系统提示词。一轮运行中途发生自动压缩时，这一轮余下的部分仍用旧的系统提示词，摘要不保证保留那段说明；从下一轮起系统提示词已是新路径。这一情形和 Claude 对说明的遵循都尚未在真实会话中核对。

## 上下文的权威

Claude Code 原生存储是模型会话上下文的唯一权威，包含原生消息链、工具结果、压缩记录与原生长期记忆。Linux 普通用户的原生配置目录由 CLI 决定（默认 `~/.claude/`）；本项目不解析和重写 JSONL，不在 Windows 自建上下文管理器，也不用 UI transcript 重新拼历史提示词。

- 每个代理会话绑定同一个 native session ID，Linux cwd 固定为 `PROXY_DATA_DIR/native/<id>/`。
- 首轮 `sessionId`，后续 `resume`；显式 `persistSession: true`。即使每轮启动新 CLI 进程，原生上下文仍由同一 session 恢复。
- 恢复前通过官方 `getSessionInfo` 检查原生记录存在；缺失则明确失败，不静默另开会话，不用代理事件假装恢复。
- 运行结束通过官方接口确认记录已保存，并同步保存状态到 GUI。压缩由 CLI 执行，客户端只展示实际公开的压缩 / 状态事件。
- 临时 SSH config / key 在 `connections/<connection-id>/`；断连回收这个目录，不碰 `native/<session-id>/`、CLI 原生 transcript 或记忆。系统提示词里写的不是这个目录，而是每个会话固定的 `session-ssh/<session-id>.conf`，它只有一行 `Include`，每次运行前指向当前连接的配置：连接目录每次重连都换，提示词若跟着变，模型侧的提示缓存从系统提示词之后全部失效，整段对话要重新写入缓存。重连不丢失会话，也不改变提示词。

代理 `PROXY_DATA_DIR/sessions.sqlite` 只是 GUI 事件、项目绑定、审批偏好与索引的展示镜像；Windows 只有有界会话内容缓存与草稿，打开会话按页拉取，不重放所有 token。不应把“界面历史存在”当作“原生上下文存在”。

已实测：写入唯一记忆值后退出 CLI、关闭隧道、更换临时密钥并重启代理服务；再次只发送新问题，原生会话准确回忆该值。没有重发历史消息，没有把代理事件拼成 prompt。该测试证明当前恢复链路可用，不替代极长任务压缩、磁盘故障和备份恢复验收。

## 长期保存

使用原生 `cleanupPeriodDays` 管理保留期；本项目为代理拥有的稳定 cwd 写外部 `.claude/settings.local.json`，默认 3650 天，可通过 `CLAUDE_CONTEXT_RETENTION_DAYS` 配置（最低 1）。这不是改写 CLI 或手工清理原生 transcript；其他原生 settings 仍加载，更高优先级配置可能覆盖本值。不能承诺无限保留，磁盘损坏 / 清理也不会因设置而避免。

长线项目应备份 Linux 原生配置目录及代理 state，二者缺一可能损失上下文或索引。Docker 部署将原生 home、state 与工作目录一起持久化，提供停服一致性备份 / 空数据恢复入口，见[部署操作手册](../deploy/README.md)；不自建摘要模型。

当前 Docker `HOME=/data/home`，`/data` 为宿主物理目录绑定；原生凭据、`.claude.json`、设置与 transcript 不在容器临时层。升级前完整私有备份，镜像更新仍使用同一 volume；重建容器后登录状态保持。只有实际丢失才恢复，不把旧备份覆盖正常刷新的认证与新会话。

会话改名 / 删除先调用官方 `renameSession` / `deleteSession`，成功后更新代理索引 / 展示镜像；运行中禁止管理，原生更新失败保留代理记录。删除不碰 Windows 项目文件。卸载应默认保留原生用户数据，不能误删 `~/.claude/`。

## 默认审批

新会话默认请求原生 `auto`，CLI 自己判断风险；没有本项目第二套 AI 审批器，也不把 auto 换成 bypassPermissions。GUI 可改为原生 `default` / `plan` / `acceptEdits`，偏好保存在 Linux。实际模式读取 `system.init.permissionMode`；版本 / 模型 / 提供方不支持时显示实际值及原生提示。

`canUseTool` 仍接出原生升级到用户的请求，仅作为必要时人工允许 / 拒绝入口；Claude 的提问（`AskUserQuestion`）走同一入口，界面展示问题与选项，用户的选择按官方结构放进 `updatedInput.answers` 返回，不回答则按拒绝返回；不能因默认 auto 就移除或自动允许所有请求。`auto` 下多数操作不需要人工，但这不是所有命令、模型或提供方都不需要人工的保证。
