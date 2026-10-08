# 原生运行与会话存储

本页说明代理如何驱动官方 CLI，以及会话上下文归谁管。只记录代码与对实际进程的检查结果。

## 本体与外层

本项目按固定版本从官方 npm 安装 `@anthropic-ai/claude-code`（当前 2.1.286）。对该版本核对过：已安装的 `bin/claude.exe` 与官方 npm 包 `@anthropic-ai/claude-code-linux-x64@2.1.286` 中的 `claude`，SHA256 同为：

```text
fe503f65c6289d59c23e5b21ae44f03583f997dd33a2cbfc75ab4f96fb8fc73f
```

运行时 `/proc/<pid>/exe` 指向这个已安装文件；没有改写 CLI、替换内部工具、注入 `NODE_OPTIONS` / `LD_PRELOAD`、补丁包或执行 MCP。代理不提供自行判断工具风险的审批策略。自动与手动模式均交给 CLI。

外层采用官方 Agent SDK 0.3.286，指定 `pathToClaudeCodeExecutable`，经官方双向 stream-json / stdio 控制接口传递用户输入、公开事件、审批与取消。SDK 自身使用真实 `CLAUDE_CODE_ENTRYPOINT=sdk-ts`、版本标记与 `--permission-prompt-tool stdio`；这是原生 stdio 请求 / 回复入口，不是 MCP 工具。没有伪装成交互式终端，也没有覆盖官方标记。

代理有意变化限于外层：稳定 cwd / session ID、Windows SSH 提示词、用户选择的审批模式、可选的提供方 settings、公开增量输出、思考摘要显示（`--thinking-display summarized`）和官方持久化 / 恢复。不再额外设置禁用遥测 / 自动更新的变量，不默认限制任务轮数。服务读完自身配置后即从进程环境删除 `PROXY_*` / `FRPS_*` 与四个服务专用的 `CLAUDE_*` 变量，原生 CLI、其 shell 与控制终端继承到的只有宿主环境本身（容器内为 `HOME`、`PATH` 等），不含代理 token 或部署配置；用户有意放进环境的其他变量原样保留。这只避免无意带出：CLI 与服务同属一个 Linux 用户，配置文件仍可被读取，不构成多用户隔离。对“内层完全不变”的工程解释是同一原生可执行与 agent 引擎，不是声称 headless / SDK 和终端 TTY 环境或未公开服务端判断逐项相同。

原生控制终端另外用 node-pty 启动同一 CLI 交互式入口，不走 SDK、不设置 SDK 入口标记、不启动通用 shell。正常 flags / 私有提供方 env / Windows SSH 提示词属于外层配置；用户已有 settings.env 原样复用。键盘与画面经 WSS 接至 xterm，不解释 OAuth 内容或存储终端日志。当前终端使用独立原生会话，不能声称已替换同一图形会话的 CLI 壳；图形历史不会包括终端问答。

登录 / 退出 / 状态由服务端驱动官方 `claude auth login / logout / status`，授权链接与回填代码经桌面端转交，凭据只由 CLI 自己读写。官方 `auth login` 不记下首次引导已完成（2.1.286 实测），交互式终端因此会让已登录账号重走主题与登录。

**代理唯一直接改动 CLI 状态文件的地方**（`src/native-onboarding.ts`）：终端启动前，若官方凭据文件里已有登录而 `~/.claude.json` 缺少 `hasCompletedOnboarding`，服务端补上这一项；判断时只看凭据是否存在，不读取、不复制也不转发其内容，未登录时不动，引导照常出现。除此之外，代理对 CLI 的配置只通过官方 settings 文件与命令行参数表达。

每次模型调用的统计来自 CLI 自带的 OpenTelemetry 日志导出（`claude_code.api_request`）：服务在环回地址起接收端，只给自己启动的 CLI 进程设置 `CLAUDE_CODE_ENABLE_TELEMETRY` 与 `OTEL_*LOGS*` 变量，只保存模型、token、费用估算、耗时与会话 ID，不保存账号标识和内容；未开启提示词 / 回复导出。费用是 CLI 按 API 价格的估算，不是订阅账单。

运行中补充复用 SDK async user input，保持同一原生进程与 session ID；human origin 不把用户补充伪装成工具输出或系统提醒。原生可在工具间采纳或合并输入，回执通过消息 UUID 同步；代理不开发独立调度 / 记忆。输入收尾、断连 / 取消及重启按实际确认程度记录，无自动重放。

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

`canUseTool` 仍接出原生升级到用户的请求，仅作为必要时人工允许 / 拒绝入口；不能因默认 auto 就移除或自动允许所有请求。`auto` 下多数操作不需要人工，但这不是所有命令、模型或提供方都不需要人工的保证。
