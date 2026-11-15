# 原生运行与会话存储

本页说明代理如何驱动官方 CLI，以及会话上下文归谁管。只记录代码与对实际进程的检查结果。

## 本体与外层

本项目按固定版本从官方 npm 安装 `@anthropic-ai/claude-code`（当前 2.1.321）。不改写 CLI、替换内部工具或注入代码；自动与手动审批均交给原生处理。

外层采用官方 Agent SDK 0.3.321，指定 `pathToClaudeCodeExecutable`，经官方双向 stream-json / stdio 控制接口传递用户输入、公开事件、审批与取消。SDK 自身使用真实 `CLAUDE_CODE_ENTRYPOINT=sdk-ts`、版本标记与 `--permission-prompt-tool stdio`；这是原生 stdio 请求 / 回复入口，不是 MCP 工具。没有伪装成交互式终端，也没有覆盖官方标记。

模型列表来自 CLI 初始化，桌面端不维护型号名单。CLI 按账号和提供方使用官方动态目录或内置目录；SDK 的 `supportedModels()` 返回初始化快照。空闲时“刷新模型列表”启动新的 CLI 读取状态。动态目录可带来新型号，内置目录和能力支持仍随 CLI 版本更新。

代理有意变化限于外层：稳定 cwd / session ID、Windows SSH 提示词、用户选择的审批模式、可选的提供方 settings、公开增量输出、思考摘要显示（`--thinking-display summarized`）和官方持久化 / 恢复。不设置禁用遥测的变量，不默认限制任务轮数。自动更新关闭（`DISABLE_AUTOUPDATER=1`）：CLI 版本随服务端发布固定，交互式 CLI 不再在 ccdt 里提示更新、也不再自己执行 `npm install -g`。服务读完自身配置后即从进程环境删除 `PROXY_*` / `FRPS_*` 与四个服务专用的 `CLAUDE_*` 变量，原生 CLI、其 shell 与控制终端继承到的只有宿主环境本身（容器内为 `HOME`、`PATH` 等），不含代理 token 或部署配置；用户有意放进环境的其他变量原样保留。这只避免无意带出：CLI 与服务同属一个 Linux 用户，配置文件仍可被读取，不构成多用户隔离。对“内层完全不变”的工程解释是同一原生可执行与 agent 引擎，不是声称 headless / SDK 和终端 TTY 环境或未公开服务端判断逐项相同。

后台任务（后台 Bash 命令、子代理）活在 CLI 进程里，任务结束时 CLI 自己开始下一轮。一轮结束时若还有后台任务，服务端不关闭 CLI：运行状态改为“等待后台任务”，界面把这一轮视为已完成，列出任务并可逐个结束，期间可以继续发消息。任务结束后 CLI 开始的那一轮照常显示；任务全部结束且没有新的一轮时运行结束。停止运行会结束 CLI，后台任务随之终止。任务列表取自 SDK 的 `background_tasks_changed` 消息，不计标记为 ambient 的任务；结束单个任务用 SDK 的 `stopTask`。

`ccdt` 的终端另外用 node-pty 启动同一 CLI 交互式入口，不走 SDK、不设置 SDK 入口标记、不启动通用 shell。正常 flags / 私有提供方 env / Windows SSH 提示词属于外层配置；用户已有 settings.env 原样复用。键盘与画面经 WSS 接至用户自己的终端，不解释 OAuth 内容或存储终端日志。终端接着会话的原生会话（`--resume`，或以会话 ID 新建）。hooks 报告终端在做什么，也给出 CLI 记录的位置：服务端跟着读记录新写的行，分段记入会话；每一轮结束再经 SDK 完整读一遍，补上遗漏并发现回退。轮次结束时按状态行和本轮的 usage 记下上下文与缓存时长，供空闲提醒使用。

浏览器登录由服务端驱动官方 `claude auth login`，授权链接与回填代码经桌面端转交，原生凭据只由 CLI 自己读写；setup token 使用官方用户设置，见下节。状态由官方 `claude auth status` 读取。官方 `auth login` 不记下首次引导已完成（2.1.286 实测），交互式终端因此会让已登录账号重走主题与登录。

**代理唯一直接改动 CLI 状态文件的地方**（`src/native-onboarding.ts`）：终端启动前，若官方凭据文件里已有登录，或用户设置中已配置 setup token，而 `~/.claude.json` 缺少 `hasCompletedOnboarding`，服务端补上这一项。读取凭据仅判断是否配置，不复制或转发其内容；未配置时引导照常出现，文件夹信任确认仍由 CLI 决定。除此之外，代理对 CLI 的配置只通过官方 settings 文件与命令行参数表达。

每次模型调用的统计来自 CLI 自带的 OpenTelemetry 日志导出（`claude_code.api_request`）：服务在环回地址起接收端，只给自己启动的 CLI 进程设置 `CLAUDE_CODE_ENABLE_TELEMETRY` 与 `OTEL_*LOGS*` 变量，只保存模型、token、费用估算、耗时与会话 ID，不保存账号标识和内容；未开启提示词 / 回复导出。费用是 CLI 按 API 价格的估算，不是订阅账单。

运行中补充复用 SDK async user input，保持同一原生进程与 session ID；human origin 不把用户补充伪装成工具输出或系统提醒。原生可在工具间采纳或合并输入，回执通过消息 UUID 同步；代理不开发独立调度 / 记忆。输入收尾、断连 / 取消及重启按实际确认程度记录，无自动重放。

## 更换项目与换电脑

会话可以改指另一个项目目录，也可以从使用者的另一台电脑接过去。系统提示词不在原生记录里，每次启动 CLI 时由 `systemPrompt.append` 给出，它一变，模型侧的提示缓存从它之后全部失效。为了不让更换项目和重连白白丢掉提示缓存，一个会话的系统提示词在压缩之前逐字不变：

- 更换之后，系统提示词继续写原来的路径；变更由下一条用户消息前面的一段说明告诉 Claude（`[CC Desk Tunnel: the user moved this session …]`），界面只显示用户自己写的内容。
- 换电脑同理：会话被另一台设备接过去之后，说明里写明换了电脑、那台电脑的名字和它上面的项目目录（`[CC Desk Tunnel: the user now continues this session from another of their computers …]`）。
- 设备能用的 shell 变了（装上或卸掉 Git for Windows），或用户在“设置 → Shell”里改了偏好，也由下一条消息前的说明告诉 Claude，连同新的脚本写法（`[CC Desk Tunnel: the shells the device runs scripts in changed …]`、`[CC Desk Tunnel: the user now prefers …]`）。
- 重连不需要说明：会话的 `ssh` 读会话固定的配置（见下文“存储”），不随连接变化；提示词里不写服务端或设备上任何程序和文件的位置，PowerShell、Git Bash 和定时任务文件由设备上的环境变量 `CC_DESK_TUNNEL_PWSH`、`CC_DESK_TUNNEL_BASH`、`CC_DESK_TUNNEL_SCHEDULES` 指明，客户端装在哪里都一样。
- 系统提示词在缓存前缀本来就要失效的时刻跟上当前值：观察到压缩事件之后的下一轮。
- 还没有原生上下文的会话直接改路径，没有说明。

压缩只把消息历史改写成摘要，不涉及系统提示词。一轮运行中途发生自动压缩时，这一轮余下的部分仍用旧的系统提示词，摘要不保证保留那段说明；从下一轮起系统提示词已是新路径。这一情形和 Claude 对说明的遵循都尚未在真实会话中核对。

Linux 工作目录（见下文“上下文的权威”）在会话有了原生上下文以后不再改变：CLI 只在会话所在的工作目录里找得到它的历史，本项目又不搬动原生记录。所以聊过的会话移到另一个项目、换到另一台电脑或分叉到别处以后，仍沿用原项目的工作目录，自动记忆和项目级设置也还是原项目的；新项目的记忆从那里新建的会话开始。这与 Codex、opencode 移动会话时历史留在原处的做法一致。还没有原生上下文的会话随移动换到新项目的目录。项目菜单的“更改文件夹”是整个项目换位置，工作目录跟着项目走，原有记忆不丢；新位置已有自己的工作目录时，各会话的历史仍留在原处。

## 上下文的权威

Claude Code 原生存储是模型会话上下文的唯一权威，包含原生消息链、工具结果、压缩记录与原生长期记忆。Linux 普通用户的原生配置目录由 CLI 决定（默认 `~/.claude/`）；本项目不解析和重写 JSONL，不在 Windows 自建上下文管理器，也不用 UI transcript 重新拼历史提示词。

- 每个代理会话绑定同一个 native session ID。Linux cwd 按项目分配：一台设备上的一个项目目录对应 `PROXY_DATA_DIR/native/<root>/`，该项目的会话共用它，如同在本机项目目录里使用 Claude Code，原生的会话历史、自动记忆和项目级设置因此按项目共享。没有项目的普通会话各有自己的文件夹，也就各有一个目录。对应关系记在 `sessions.sqlite` 的 `native_roots` 表里，项目路径按 Windows 不区分大小写、两种分隔符等同的规则比较；会话记下自己的 `nativeRoot`。按项目分配之前建立的会话没有记下它，仍在 `native/<会话 ID>/`，照常恢复，不迁移。
- 首轮 `sessionId`，后续 `resume`；显式 `persistSession: true`。即使每轮启动新 CLI 进程，原生上下文仍由同一 session 恢复。
- 恢复前通过官方 `getSessionInfo` 检查原生记录存在；缺失则明确失败，不静默另开会话，不用代理事件假装恢复。
- 运行结束通过官方接口确认记录已保存，并同步保存状态到 GUI。压缩由 CLI 执行，客户端只展示实际公开的压缩 / 状态事件。
- SSH 配置里一台设备的每种 shell 一个主机名，另有 `device`。`device` 原样执行一条命令行（Windows 上由 cmd.exe 解析），scp / sftp 也用它；`device-pwsh`、`device-bash`（Windows 上的 Git Bash）、`device-zsh` 等是同一台设备加上一条固定的 `RemoteCommand`，把标准输入整段当作那种 shell 的脚本执行，UTF-8、保留退出码。提示词让 Claude 按脚本所用的 shell 把它用 here-document 送给对应的主机，脚本不经过任何一层命令行，不需要转义或编码，也没有长度限制；偏好的 shell 只是提示词里的一句话，两种都能用。就绪探测走设备一定有的那种 shell。PowerShell 自带的 `-Command -` 与 `-File -` 逐行处理标准输入，跨行的块会丢失，所以 `device-pwsh` 先读完整段再执行；Git Bash 前先把命令共用的无窗口控制台切到 UTF-8，脚本调用的 cmd、ping 等 Windows 程序才不按系统代码页（中文系统是 GBK）输出。
- 每台设备另有一个固定的入口 `devices/<device-id>/`：端口和配置路径在设备在线及宽限期内不变，密钥随每次连接更换；会话的 SSH 配置指向它，所以重连对正在运行的 CLI 没有任何可见变化，设备不在时新发起的命令在入口处等待（最长一分钟）。
- 临时 SSH config / key 在 `connections/<connection-id>/`；断连回收这个目录，不碰 `native/` 下的工作目录、CLI 原生 transcript 或记忆。每个会话另有固定的 `session-ssh/<session-id>/`：`config` 先 `Include` 设备入口的配置，其余主机再读用户和系统自己的 ssh 配置（`ssh -F` 会替换掉它们）；`bin/` 里的 `ssh`、`scp`、`sftp` 只是带上 `-F config` 调用系统的同名程序，服务端把这个目录放在会话 CLI 的 PATH 最前面。于是 Claude 照常写 `ssh device-pwsh`，连其他主机也和普通 `ssh` 一样；提示词里不出现任何路径，重连和换连接都不改变它，模型侧的提示缓存保持有效。

代理 `PROXY_DATA_DIR/sessions.sqlite` 只是 GUI 事件、项目绑定、审批偏好与索引的展示镜像；Windows 只有有界会话内容缓存与草稿，打开会话按页拉取，不重放所有 token。镜像里一段输出只存一条；输出途中的片段只转发给正在看的窗口，不落盘。不应把“界面历史存在”当作“原生上下文存在”。

已实测：写入唯一记忆值后退出 CLI、关闭隧道、更换临时密钥并重启代理服务；再次只发送新问题，原生会话准确回忆该值。没有重发历史消息，没有把代理事件拼成 prompt。该测试证明当前恢复链路可用，不替代极长任务压缩、磁盘故障和备份恢复验收。

## 登录方式

桌面「设置 → 账号与额度」提供普通登录与 Setup token 登录两个入口。后者可以让服务端运行官方 `claude setup-token`，通过现有授权链接与回填代码流程生成令牌并自动保存，也可以通过 `account.token` 直接粘贴已有令牌。两条路径都写入官方用户 `settings.json` 的 `env.CLAUDE_CODE_OAUTH_TOKEN`，保留其他设置，不改 `.credentials.json`。配置目录遵循 `CLAUDE_CONFIG_DIR`，默认 `~/.claude/`。文件按原子替换保存，Linux 权限为 `0600`；令牌不回传到账号或常用设置接口，不持久保存在客户端。它与原生凭据一样属于服务端私有数据，包含它的备份也应按凭据保管。

生成的令牌通过 `account.token.created` 只发给发起生成的连接，客户端展示一次并提供复制按钮，关闭弹窗或断线后清空，不写入客户端存储。其他连接、普通账号状态与设置查询都拿不到它；服务重启也不重放。生成后写入失败时，弹窗仍提供这次令牌，并明确显示保存错误，便于用户复制后处理。

`NativeLogin` 按登录方式启动 `auth login` 或 `setup-token`，复用原有进程、超时与取消管理。核对固定 CLI 2.1.321 的命令注册与 SDK 0.3.321：没有 token 生成的结构化输出接口。`setup-token` 使用 Ink 局部重绘，直接删除 ANSI 控制符会丢空格或字母，已在官方错误输出中复现。因此复用项目已有的 `@xterm/headless` 还原屏幕文字，再读取官方成功标记下的令牌；退出前等待屏幕写入完成，清屏不会丢失已经读取的结果，不增加依赖或自建 OAuth。普通 `auth login` 的文本读取保持原样。升级 CLI 时需要复核授权链接、成功文案与错误输出。

OAuth 错误保留官方的具体说明，包括多行网络错误；设置保存、退出失败保留底层错误，超时与成功退出但没有读到令牌分别说明原因。需要按键重试的官方错误界面结束本次尝试，用户重新获取链接。令牌和回填授权码不混入错误提示。

| 行为 | 浏览器授权 | Setup token |
| --- | --- | --- |
| 配置来源 | CLI 管理的原生登录凭据 | 官方用户设置中的令牌 |
| 账号身份 | 通常有邮箱、组织、订阅类型 | 固定版本 CLI 通常只报告 `oauth_token`，不提供完整身份 |
| 有效性 | CLI 管理认证状态 | `auth status` 只确认配置存在；无效令牌也会报已配置，以实际请求结果为准 |
| 到期与续期 | 由官方 CLI 管理原生凭据，提供到期时间时显示 | 不导入刷新令牌，不能从粘贴时间推算到期；失效后退出并重新配置 |
| 订阅额度 | SDK 可请求完整订阅额度 | SDK 报告完整额度不可用；仍显示模型回复携带的额度窗口与本项目记录的调用统计 |
| 对话与终端 | 同一官方 CLI / SDK | 同一官方 CLI / SDK，继续使用现有会话、模型与审批机制 |

账号变更沿用原有运行与终端互斥，浏览器授权进行中需先取消。更换令牌通过“退出登录 → 使用 setup token”，不引入独立账号库。退出先调用官方 `auth logout`，再移除设置中的 token，并清空额度缓存；会话记录保留，也不会撤销该令牌在其他地方的使用。在 `ccdt` 内单独执行官方 `/logout` 不会移除用户设置里的 token，请用桌面账号页退出。直接在部署环境或提供方配置中设置的认证仍由部署方管理。

验证使用官方 CLI 2.1.321 与 SDK 0.3.321，在隔离 Linux 容器中对接本地模拟接口，分别装载合成的浏览器登录凭据与 setup token：两种方式的首轮、续聊、Bearer 认证、回复额度均正常；无效 token 的 401 正确导致失败。真实服务端的 WebSocket 保存、重启恢复、退出、浏览器授权链接与两种方式的终端启动均已检查。官方 `setup-token` 的授权链接（`user:inference`）和错误授权码已实测；成功签发输出用夹具模拟，再由真实服务端保存、官方 CLI 读取状态，并验证重启与退出。未使用真实账号，未验证真实授权兑换、订阅权益、服务端风控、实际令牌到期或长期续期。

## 长期保存

使用原生 `cleanupPeriodDays` 管理保留期；本项目为代理拥有的稳定 cwd 写外部 `.claude/settings.local.json`，默认 3650 天，可通过 `CLAUDE_CONTEXT_RETENTION_DAYS` 配置（最低 1）。这不是改写 CLI 或手工清理原生 transcript；其他原生 settings 仍加载，更高优先级配置可能覆盖本值。不能承诺无限保留，磁盘损坏 / 清理也不会因设置而避免。

长线项目应备份 Linux 原生配置目录及代理 state，二者缺一可能损失上下文或索引。Docker 部署将原生 home、state 与工作目录一起持久化，提供停服一致性备份 / 空数据恢复入口，见[部署操作手册](../deploy/README.md)；不自建摘要模型。

当前 Docker `HOME=/data/home`，`/data` 为宿主物理目录绑定；原生凭据、`.claude.json`、设置与 transcript 不在容器临时层。升级前完整私有备份，镜像更新仍使用同一 volume；重建容器后登录状态保持。只有实际丢失才恢复，不把旧备份覆盖正常刷新的认证与新会话。

会话改名 / 删除先调用官方 `renameSession` / `deleteSession`，成功后更新代理索引 / 展示镜像；运行中禁止管理，原生更新失败保留代理记录。删除不碰 Windows 项目文件。卸载应默认保留原生用户数据，不能误删 `~/.claude/`。

## 默认审批

新会话默认请求原生 `auto`，CLI 自己判断风险；没有本项目第二套 AI 审批器，也不把 auto 换成 bypassPermissions。GUI 可改为原生 `default` / `plan` / `acceptEdits`，偏好保存在 Linux；`bypassPermissions`（绕过权限，什么都不再询问）只在使用者于“设置 → 常规 → 审批”里允许后才出现在选项里，选中前再确认一次，从不作为默认。实际模式读取 `system.init.permissionMode`；版本 / 模型 / 提供方不支持时显示实际值及原生提示。

`canUseTool` 仍接出原生升级到用户的请求，仅作为必要时人工允许 / 拒绝入口；Claude 的提问（`AskUserQuestion`）走同一入口，界面展示问题与选项，用户的选择按官方结构放进 `updatedInput.answers` 返回，不回答则按拒绝返回；不能因默认 auto 就移除或自动允许所有请求。`auto` 下多数操作不需要人工，但这不是所有命令、模型或提供方都不需要人工的保证。
