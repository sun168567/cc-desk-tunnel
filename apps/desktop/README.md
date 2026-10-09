# Windows 客户端

Electron + React 的 Windows 桌面客户端：界面、到服务端的连接桥，以及随连接启停的本机 OpenSSH / frpc。登录页和“帮助”菜单里的项目链接由 `src/project.tsx` 配置，地址为空时不显示。

## 启动

用户双击 `CC Desk Tunnel.exe` 或快捷方式启动，不需要终端、源码仓库、Node / npm。标准安装包为 `CC-Desk-Tunnel-Setup-<版本>-x64.exe`（构建产物在 `artifacts/windows/`），支持当前用户安装、选择目录、开始菜单 / 桌面快捷方式、覆盖升级和卸载；卸载默认保留客户端项目 / 地址偏好，不删除 Windows 项目或 Linux Claude 登录 / 会话。服务凭据默认只在内存里；勾选“记住凭据”后经 DPAPI 加密保存。

不安装时，直接运行 `artifacts/windows/win-unpacked/CC Desk Tunnel.exe`；必须保留同目录全部资源。应用单实例，重复启动聚焦已有窗口。发行包为 Windows x64，未签名；SmartScreen 与杀毒软件对 frpc 的提示及处理见[根目录说明](../../README.md#杀毒软件与-smartscreen)，应用不自动修改安全软件设置。

开发时根目录执行 `npm ci`；浏览器开发用 `npm run dev`。模拟登录信息位于 `.local/dev-connection.json`；浏览器仅支持环回模拟，原生连接由 Electron 主进程管理。桌面默认选择远程模式，离线测试需选择本地模拟。

Electron 44.5.1 的 npm 包将二进制安装改为显式步骤：先运行 `npm run setup:desktop`（该包的官方 `install-electron`，从 Electron 发布源下载并用其内置 checksums 校验），再执行 `npm run build` / `npm run desktop`。桌面窗口加载同一份生产渲染页，不自动开启另一个代理服务；可连接 `npm run dev` 已启动的模拟服务。

## 发行构建

Windows x64 开发机执行：

```powershell
npm.cmd ci
npm.cmd run setup:desktop
npm.cmd run prepare:windows:package
npm.cmd run package:windows
```

`scripts/package-windows.mjs` 使用 electron-builder 26.15.3 / NSIS；Vite 构建 React 和主进程连接桥 / 协议 / ws，发行包不安装 npm 依赖。`electron/` 下的全部 `.cjs` 模块原样复制，避免新增主进程依赖时遗漏文件。PowerShell 脚本位于 `app.asar.unpacked`；组件位置相对 `resources/vendor`，不依赖开发机器绝对路径。不打包 `.local/` 的秘密 / 历史 / 运维测试文件。版本取自桌面 workspace 的 `package.json`；客户端不自行联网查找新版本：安装包由所连接的服务端提供，下载校验后覆盖升级。

每次打包（包括 `--dir`）完成后，自动对实际 exe 运行 `test/package.spec.ts` 的离线冒烟检查：独立新 profile、移除开发工具 PATH，验证登录页、预加载接口、Git 分支读取和单实例。检查失败使打包命令失败，发布流程不会上传产物；不会使用调用者的真实连接配置。真实连接验证仍需显式启用，不能由离线检查替代。

自带官方 PowerShell 7.6.6 便携包、OpenSSH 10.0p2 与 frpc 0.71.0，SHA256 固定在准备脚本中，保留许可证。无需修改系统 PATH、注册表 shell、系统 sshd / 防火墙，不需要管理员权限正常连接。需要写入受保护的安装目录时由标准安装器处理提权。构建目录是生成物；若测试 exe 正在运行或安全软件占用文件，先关闭该副本再重建，不在应用代码加入重试兼容层。

## 自动远程连接

源码调试用 `npm run prepare:windows` 下载校验官方组件到被忽略的 `vendor/`：frpc 0.71.0、独立官方 OpenSSH 10.0.0.0p2-Preview（当前已测试用户模式的固定版本，并非声称最新稳定）。正式发行包自带独立 PowerShell，不依赖系统 sshd 服务，不更改用户原有 OpenSSH；SHA256 与来源在脚本中，保留组件许可证。

Electron 选择“远程代理”，输入可信 WSS 地址、代理 token；自签证书填写 SHA256 指纹，可信域名证书将指纹留空使用 CA / 有效期 / 主机名验证。不需要 Ubuntu SSH 账号。主进程完成 TLS 身份验证后才发送 token，接收独立 frp 证书与配置后生成临时 SSH key / host key，启动环回 sshd / frpc，Linux 探测成功才进入工作区。

连接跟随 Windows 的系统代理设置（手动、脚本或自动检测，由 Electron 按目标地址解析）：设置里给出 HTTP 代理时，控制连接、安装包下载和 frpc 都经它的 CONNECT 隧道到达服务端，证书校验与直连时相同，代理只转发密文；没有代理、目标被设置排除或只给出 SOCKS 代理时直接连接。不支持需要账号密码的代理。

`prepare-ssh.ps1` 显式以 UTF-8 输出连接 JSON，与主进程的解码方式一致，不受 Windows 当前控制台代码页影响；安装路径含中文、空格时也保留完整的 PowerShell 路径。

`component-host.ps1` 用 Windows 原生 Job Object 管理 sshd、frpc 及子进程。每次连接使用随机回环端口和独立临时配置 / 主机与登录密钥。正常断连、关闭应用、组件启动失败会结束进程并删除临时目录；客户端异常退出也会回收监听。操作系统强杀整棵进程树可能绕过文件清理，留下不可再用于登录的临时文件，崩溃残留清理待后续处理。不安装、保留任何项目系统服务，不修改注册表、默认 shell / 终端或防火墙。

已实测关闭项目组件会终止在途 SSH 命令及其子进程；已经发生的副作用不能撤销。停止单个 Claude 轮次不关闭整个连接，仍不能承诺该轮已发出的 SSH 命令都立即终止。

宿主在启动 sshd 前设置进程内的 `SSH_TEST_ENVIRONMENT=1`，让 OpenSSH 以无窗口方式创建命令进程，命令不再弹出 cmd / Windows Terminal 窗口，命令主动打开的 GUI 程序不受影响。这是 OpenSSH 的内部测试开关，升级 OpenSSH 时按[弹窗报告](../../docs/research/windows-shell-windows.md)核查。

`proxy-bridge.mjs` 只中继会话与连接握手，没有 Windows 命令执行 RPC。杀毒软件拦截时报告失败，不自动加白名单。

## 代码结构

界面在 `src/`，由 Vite 构建；主进程在 `electron/`，不经构建直接运行（发行包里连接桥另打成单文件）。

| 文件 | 职责 |
| --- | --- |
| `src/client.ts` | 唯一的 WebSocket 连接与状态仓库：会话目录、事件缓存、历史分页、请求 / 响应配对。组件经 `useSyncExternalStore` 读取 |
| `src/transcript.ts` | 把会话事件流折叠成界面条目（消息、推理、工具、提示） |
| `src/ConversationFind.tsx`、`conversationSearch.ts`、`messageTime.ts`、`copy.tsx` | 对话内查找、消息日期与复制 |
| `src/App.tsx` | 编排：连接与登录、当前会话、所有请求和禁用条件；不含具体界面 |
| `src/LoginPage.tsx`、`TitleBar.tsx`、`Rail.tsx`、`Sidebar.tsx`、`Conversation.tsx`、`Composer.tsx`、`SessionDialogs.tsx` | 各界面区域，只渲染并上报用户意图：标题栏、图标栏、会话侧栏、会话区、输入区、对话框 |
| `src/SettingsPage.tsx`、`SettingsPanel.tsx`、`Help.tsx` | 设置页的分类与客户端自身的设置；云端 Claude Code 的设置项；帮助文案 |
| `src/shortcuts.ts`、`ShortcutSettings.tsx` | 快捷键的动作、默认组合键与按键的识别；修改它们的设置页 |
| `src/QuestionCard.tsx`、`ComposerControls.tsx`、`PermissionMenu.tsx`、`AccountPanel.tsx`、`UsagePanel.tsx`、`NativeTerminal.tsx` | Claude 提问的作答卡片、模型 / effort / 上下文、审批模式菜单、账号页、调用日志、原生终端 |
| `src/drafts.ts`、`prefs.ts`、`schedules.ts`、`SchedulePanel.tsx` | 只属于这台电脑的数据：未发送的草稿；置顶、项目显示名称、通知开关与快捷键；定时任务的格式、到点判断与面板 |
| `src/notifications.ts`、`NoticeBell.tsx`、`exportSession.ts` | 从会话运行状态的变化得出通知，及其列表；把会话导出为 Markdown |
| `src/ui.tsx`、`paths.ts` | 图标按钮 / 对话框 / 菜单；Windows 路径比较 |
| `electron/main.cjs`、`preload.cjs` | 窗口、托盘、系统通知、IPC（选目录与文件、保存导出、普通会话目录、打开授权页、连接）和暴露给页面的 `window.desktop` |
| `electron/connect-errors.mjs` | 连接失败时给用户的说明：按系统错误码、TLS 错误和组件的输出区分原因，第一行是原因，其后是该检查的地方 |
| `electron/git-branch.cjs` | 从仓库文件读出项目当前所在的分支，不依赖本机安装 git |
| `electron/proxy-bridge.mjs`、`windows-tunnel.mjs` | 主进程连接桥：校验服务证书后转发 WSS，并按服务端下发的配置启动本机隧道 |
| `electron/system-proxy.mjs` | 读出系统代理中的 HTTP 代理，并经它建立到服务端的 TCP 连接 |
| `electron/prepare-ssh.ps1`、`component-host.ps1` | 生成临时 SSH 配置；用 Job Object 托管 sshd / frpc |

`test/` 是 Playwright 界面测试，`test-main/` 是主进程模块与 `client.ts` 的 Node 测试。新增界面状态先看能否放进所属区域的组件，跨区域才上提到 `App.tsx`。

## 当前功能与边界

- 布局：顶部是自绘标题栏（后退 / 前进、侧栏开关、“文件 / 视图 / 帮助”菜单、连接状态），左侧图标栏切换“会话”“定时任务”，底部的齿轮打开账号、设置、帮助与断开连接；有可安装的更新时图标栏多出一个更新按钮。图标栏右边是随页面变化的侧栏（会话列表、任务列表或设置分类），可收起；窄窗口下侧栏浮在页面之上。
- 设置页分两类：云端 Claude Code 的（账号与额度、常用设置项）和这台电脑上的（关闭时留在托盘、普通会话的文件夹、记住凭据与自动登录、通知），另有帮助与版本更新。
- 登录页的“本机设置”不需要连接，可改常规、通知和快捷键。“设置 → 常规”里有三项连接等待时间（连接服务器 15 秒、本机 SSH 服务启动 10 秒、执行通道就绪 45 秒，可设 5–600 秒），下次连接时生效；执行通道的等待至少比 SSH 的多 35 秒。
- 快捷键：后退 / 前进、收起侧栏、新建会话、打开设置、对话内查找和界面缩放各有一个组合键，在设置页的“快捷键”里逐项修改、去掉或整体关闭。按键由页面自己处理，只在本窗口处于前台时起作用，不向系统注册全局热键；内嵌的原生终端里和对话框打开时不响应。安装版不带 Electron 的默认菜单，因此没有设置之外的组合键。
- 通知：窗口收在托盘或不在前台时，任务完成、失败、等待审批、Claude 提问、定时任务没能发出、连接中断经 Windows 系统通知提醒，点通知回到对应会话；侧栏的铃铛保留最近 50 条。每一类可在设置里单独关闭。只有内容已在本窗口缓存的会话能分辨“提问”与“审批”，其余按“等待审批”提醒。
- 会话与项目可以置顶；项目可以另起一个只在本机显示的名称，可在资源管理器中打开。不提供移除项目与归档。会话菜单可把整个会话导出为 Markdown（先把历史分页取全）。
- 消息显示本地日期时间，悬浮查看完整时间。文字可框选、右键复制，消息和代码块各有复制按钮；输入框使用系统的右键编辑菜单。
- Ctrl+F 查找当前对话，Enter / Shift+Enter 跳转，Esc 关闭。查找时临时展开折叠内容，关闭后恢复折叠。只查已经加载的内容：还有更早记录时数量后标注“仅已加载部分”，加载后自动纳入。
- 会话只先取最近一页；向上翻到已加载内容的开头时自动取更早的一页，加载失败后改为点“加载更早记录”重试。
- Claude 向用户提问时，会话区显示问题与选项（单选、多选或自己写），提交后原生继续；不回答等同拒绝。
- 输入框上方显示会话所在的项目与项目当前的 git 分支（只读）。点项目标签可把会话移到另一个项目；项目菜单的“更改文件夹”把整个项目连同其下的会话指向新位置。已经聊过的会话在下一条消息里告诉 Claude 项目变了，做法见[原生运行](../../docs/native-runtime.md#更换项目)。加号、拖入或粘贴文件时，放进消息的是文件在这台电脑上的路径，由 Claude 经执行通道读取；没有上传。
- 关闭窗口默认留在托盘后台，托盘图标右键“退出”才结束连接；可在设置或托盘菜单关掉这一行为。远程连接期间阻止系统睡眠。
- 输入框里未发送的内容按会话保存在本机用户目录的 `drafts.json`（不经过服务端）：切换会话、关闭窗口、崩溃或强杀后重新打开都还在；发送成功或删除会话后才清除。
- 会话菜单“分叉会话”把当前会话连同上下文复制成一个新会话；用户消息上的“编辑重发”从该消息之前分叉，并把原文放回输入框。原会话都保留。已执行的文件改动不会撤回。
- “定时任务”页：到点由客户端向已有会话或新会话发送预设提示词。任务存在用户目录的 `schedules.json`，可在界面编辑，也可以直接改文件或让 Claude 代改；只在客户端运行并已连接时触发，错过超过 10 分钟的那一次跳过。
- 登录页可“记住凭据 / 自动登录”：服务凭据经 Windows 当前账户加密（DPAPI）后存在用户目录，不落明文。
- 会话区默认只显示问题与回复：两段回复之间的工具调用和思考折成一行状态摘要，展开后每个调用一行（动作、对象、增删行数、用时），再点开才是入参与输出；一轮结束后整轮收成“问题—用时—回答”。
- 设置页的“Claude Code”是云端官方 CLI 用户设置的常用项，下次运行生效；“关于与更新”里有“检查更新”（服务端有新版本时变为“升级服务端到 x.y.z”），以及服务端持有更新的安装包时的“升级客户端到 x.y.z”。服务端版本与客户端不一致而拒绝连接时，登录页给出“升级客户端到 x.y.z”。
- 服务凭据认证，新建/切换/删除会话，记录 Windows 项目路径；原生 Bash / SSH 按提示词操作真实项目，不建设严格目录沙箱。
- 真实的模拟事件驱动多轮、流式文本、Markdown、代码块、工具入参/结果和审批状态；允许/拒绝、停止、错误与断线重连历史均可观察。
- 运行归属连接，不向另一连接显示可审批按钮；重连不重发消息。
- 原生运行中输入框保持可用，发送与停止同时存在；提交 / 等待原生处理 / 原生已接收 / 未确认按实际回报显示，不保证立即中断正在执行的工具。
- 原生会话默认自动审批，可在输入框左下的菜单切换手动 / 计划 / 接受编辑，每项带一行说明；模型目录与 effort 来自原生初始化，在输入区右侧设置（先是 effort 滑条，模型列表在下一级），上下文按钮展示原生摘要。账号在设置页，显示订阅额度 / 剩余 / 重置与用量，各额度窗口下列出本周期的请求数、总 token 与等价 API 费用，“调用日志”子页按时间范围 / 模型筛选逐次调用。未登录时在该页点“登录”：打开官方授权页，完成后把页面给出的代码粘贴回来；“退出登录”同在此处。输入 `/` 或 `\` 打开命令菜单，主动压缩走原生 `/compact`。偏好与实际值分开。
- effort 滑条拖动期间本地连续预览，松手 / 键盘松键后仅保存一次，保存期间菜单保持展开。默认恢复、错误恢复与窄屏回归已覆盖，不每帧请求服务端。
- Electron 通过原生 openDirectory 对话框添加项目，按项目一键创建会话，无必填标题表单。新会话使用原生 summary / title 同步；用户手动改名后不再覆盖。浏览器开发入口采用路径表单，不冒充桌面文件夹选择。
- 原生改名 / 删除先执行官方 SDK 操作，不只是管理代理镜像；运行中禁止管理，删除不碰 Windows 项目。
- 会话菜单里的原生终端使用按需加载的 xterm 6.0.0 / fit 0.11.0，Linux node-pty 1.1.0 直接启动同一官方 CLI；不是通用 Linux shell，不增加 MCP。键盘 / ANSI / 尺寸原样转接，输出按实际渲染回执背压，不保存终端画面或登录代码到代理事件 / 日志。
- 当前终端是独立原生控制会话，不恢复所选图形会话，也不将终端问答伪装成图形历史。终端期间所有图形运行 / 配置 / 管理互斥，会话切换锁定；显式关闭、断连和服务退出回收终端进程组。原生任务只在终端存活期间可运行，不建立自研调度器。
- 已验证原生菜单、键盘 / resize 去重、互斥和回收。官方 `claude auth login` 登录后并不记下首次引导已完成，终端会让已登录账号重选主题并再次登录；服务端在终端启动前、官方凭据已存在时补上该标记（见[原生运行](../../docs/native-runtime.md)）。`/config`、技能 / 插件与原生定时任务未验收。
- 会话操作在会话行的右键菜单与悬浮“更多”按钮；鼠标停在会话行上片刻显示完整标题、项目与最近活动时间。消息框随内容增高到 `min(46vh, 420px)` 后滚动。
- “新建会话”创建普通会话：主进程在 `文档\CC Desk Tunnel\<日期>\<时间>` 建工作目录（可在设置里换成别的文件夹），侧栏列在项目分组之下的“最近”里；删除时移除仍为空的目录。项目分组的“+”仍在该项目下建会话。
- 桌面与窄屏布局。侧栏会话、工具输出折叠、新建/删除确认和明确连接状态；模拟模式始终可见。
- 项目分组与名称 / 路径搜索；登录不自动打开所有历史。会话按需取最近一页，向上加载时保留阅读位置；4 会话内容缓存，32ms 合并实时更新。历史连续增量批量还原；公开推理和已结束工具默认折叠。
- Electron `nodeIntegration:false`、`contextIsolation:true`、`sandbox:true`，IPC 提供连接、断连、目录与文件选择、保存导出文件、打开文件夹和系统通知，不暴露 shell 执行器；拒绝页面导航、新窗口和权限申请。
- Markdown 使用 `react-markdown` + GFM，不启用原始 HTML，CSP 限制脚本来源并禁止框架/外部图片。SVG、附件和 Electron 外链打开未实现，不以“富文本”冒充全部需求已完成。
- Markdown 与终端分别按需加载；当前主页面构建约 456 kB（gzip 141 kB），不为压警告提高大包阈值。

`npm run test:ui` 先构建页面，再运行 Playwright 桌面、390px 窄屏、重连和 Windows Electron 测试；后者使用不可见测试窗口，检查实际隔离配置与关闭后取消。默认需要 Playwright Chromium；本机已有 Chrome 时可在 PowerShell 7 设置 `$env:PLAYWRIGHT_CHANNEL='chrome'` 复用。截图放 `.local/screenshots/`，测试数据与 token 独立放 `.local/ui-test/`，均不提交。

显式启用真实测试：设置 `NATIVE_TEST_CONFIG` 指向私有 `{url,token,fingerprint?}` 连接配置，运行 `npm run test:ui`。真实测试会消耗账号额度并操作 `.local/` 下的夹具，不在离线测试中默认启用。总体边界见[架构](../../docs/architecture.md)。

发行回归单独设置 `WINDOWS_PACKAGE_EXE` 为待测 exe 的绝对路径，执行 `npm run test:ui -- --grep "packaged exe"`；同时设置 `NATIVE_TEST_CONFIG` 时只做真实连接 / 账号状态 / 关闭回收，不发送问答。测试移除开发工具 PATH / 组件覆盖变量、从独立 cwd 启动并检查单实例。截图和 profile 仍在忽略目录中，不提交实际账号记录。
