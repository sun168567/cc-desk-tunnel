# 插件与事件

服务端在需要人或别的系统知道的时候发出事件，交给数据目录里的插件：推送到聊天软件、接家庭自动化、记录到自己的系统，都由插件去做，服务端不认识任何渠道。设备、`ccdt` 终端、跨设备的审批这些状态 Claude Code 里没有，所以事件由服务端发出，而不是用 Claude Code 自带的 hooks。

插件只接收通知，在自己的进程里运行，出错、超时都不影响会话的运行。标准输出留作以后的用途，要记进日志的写到标准错误。

## 插件

插件是 `<数据目录>/plugins/<id>/`（Docker 部署在容器里是 `/data/state/plugins/<id>/`）。id 是 `作者.插件名`，由作者定，两段都用小写字母、数字和连字符，作者一段建议用代码托管平台的用户名；设置、数据和日志都按它保存。目录里面的 `hooks/hooks.json` 与 Claude Code 插件的结构相同：

```json
{
  "hooks": {
    "ApprovalRequested": [
      {
        "hooks": [
          { "type": "command", "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/notify.mjs"] }
        ]
      }
    ],
    "RunEnded": [
      {
        "matcher": "completed|failed",
        "hooks": [{ "type": "command", "command": "./notify.sh", "timeout": 20 }]
      }
    ]
  }
}
```

- 服务端监听这个目录，新增、修改、删除插件片刻后生效，并告诉所有窗口，不用重启。
- `type` 只支持 `command`。有 `args` 时直接启动 `command`，没有时交给 shell 执行。
- `matcher` 的写法与 Claude Code 相同：省略、空或 `*` 匹配全部；只含字母、数字、`_`、`-`、空格、`,`、`|` 时是一个或几个名字；其他是正则表达式。对照的字段见下表，没有列出的事件忽略它。
- `timeout` 是秒数，默认 60，最长 600，到时连同它启动的进程一起结束。默认值比 Claude Code 的 600 短，因为这里只是通知。
- 命令在插件目录里运行，事件是标准输入上的一个 JSON 对象（UTF-8）。环境变量 `CLAUDE_PLUGIN_ROOT` 是插件目录，`CLAUDE_PLUGIN_DATA` 是它存状态用的目录（`<数据目录>/plugin-data/<id>/`），两者也可以在 `command` 和 `args` 里写成 `${…}`；`ui.ts` 里也有。
- 匹配的命令同时启动，事件之间也不排队：要分先后时看 `timestamp`。

## 权限

插件与服务端是同一个 Linux 用户。内核支持 Landlock 时（x86-64 与 arm64），它的命令和 `ui.ts` 默认受限，连同它们启动的进程：

- 能读、运行：插件目录，以及 `/usr`、`/etc`、`/opt` 等系统目录。能写：`CLAUDE_PLUGIN_DATA`，它也是 `HOME` 和 `TMPDIR`。其他文件和 `/proc` 都够不着，包括凭据、会话、其他插件和设备的 SSH 配置；内核够新（Landlock ABI 6）时也不能给别的进程发信号。
- 不能用 unix socket，按路径监视文件，改别的进程的优先级和上限；按路径改文件的权限和属主不起作用。命令结束后，它留下的进程一并结束。
- 能联网，不限地址。环境变量只有 `PATH`、语言、时区和代理。

`plugin.json` 写 `"permissions": ["full"]` 的不受限制，与会话里的 Claude 一样多：能读服务端上的凭据，也能经在线的设备执行命令。内核不支持 Landlock 时，所有插件都不受限制。不受限制的插件装好后停用，由用户确认启用；受限的插件更新后要完整权限，也停下来等确认。

密钥在数据目录里：文件面板（见[部署与安全边界](deployment.md)）和其他受限的插件读不到，会话里的 Claude 能读到。

## 安装

- 桌面客户端的“设置 → 插件 → 安装插件”：zip，不超过 5 MB，内容是插件的文件或装着它们的一个文件夹，要有 `.claude-plugin/plugin.json` 和 `hooks/hooks.json`。服务端先核对格式、列出版本、权限、事件和会运行的命令，这时不运行其中任何代码；同意后才放进去。id 相同的插件被替换，设置、数据和日志保留；作者变了会写明，但压缩包里的 id 和作者都是自称的，来源由用户判断。浏览器里可以设置插件，不能安装和删除。
- 或者直接把目录放进 `plugins`。

`plugin.json` 有 `id`、`displayName`、`description`、`version`、`author`（名字，或 `{ name, url }`）、`homepage`、`repository`（发布新版本的地址），显示在设置页的“关于”里；还有 `minVersion`，它能用的最低服务端版本（如 `0.4.0`），更旧的服务端不安装、不运行它，并说明原因。只有安装压缩包时必须有 `id`。

## 设置

插件目录里有 `ui.ts`（或 `ui.js`、`ui.mjs`）时，它导出的 `settings` 成为设置页上的表单，由客户端绘制，桌面和网页相同：

```ts
export const settings = [
  {
    title: '钉钉',
    description: '在钉钉群的“机器人”里添加自定义机器人。',
    showWhen: 'dingtalk_on',
    fields: {
      dingtalk_on: { type: 'boolean', title: '启用钉钉', description: '推送到钉钉群机器人。' },
      dingtalk_format: {
        type: 'string', title: '格式', default: 'card',
        options: [{ value: 'card', label: '卡片' }, { value: 'text', label: '文本' }],
      },
      dingtalk_url: {
        type: 'string', title: '机器人地址', sensitive: true, required: true,
        validate: (value, all) => ({ valid: value.includes('access_token='), message: '缺少 access_token' }),
      },
      dingtalk_body: { type: 'string', title: '模板', multiline: true, default: '{session}' },
      dingtalk_test: { type: 'button', title: '测试消息', label: '发送', run: async (all) => ({ ok: true, message: '已发送' }) },
    },
  },
];
```

- 类型：`string`（可加 `multiline`、`options`、`sensitive`）、`number`（可加 `min`、`max`）、`boolean`、`button`。分组和字段都有 `title`，可有 `description`（标题下面的一行说明）；`options` 的每一项是一个值，或 `{ value, label }`，最多 600 项，可以在 `ui.ts` 里算出来；按钮上的字是 `label`；除按钮外可有 `default`，文本和数字可有 `required`。字段名在插件里不重复，文字最长 8000 个字符。
- `showWhen` 是一个开关的名字，或几个中的任一个：都关着时只显示这些开关，其余字段不检查。
- `validate(值, 全部值)` 返回 `{ valid, message }`，可以是异步的。没有保存按钮：开关和下拉改了就存，文本在离开输入框或按回车时存；不合规的不存，错误显示在字段下。没填的文字是空串、开关是 `false`。检查超过 2 秒或出错时提示，但仍会保存。
- 按钮的 `run(全部值)` 返回 `{ ok, message }`，用的是表单里的值，包括因不合规没有存下的；先检查它所在的一组。默认最多 20 秒，可用 `timeout` 设到 60 秒；`confirm` 是运行前要问的话。
- `sensitive` 的值只进不出：任何窗口都读不回，留空沿用，日志和消息里原样出现的换成 `***`（编码或签名过的认不出来）。
- 值存在 `<数据目录>/plugin-config/<id>.json`（0600），命令从事件的 `config` 里得到，类型与这里相同。必填的没有填时插件不运行。
- `ui.ts` 只在单独的子进程里运行，Node 只去掉类型，不支持 `enum` 之类需要转换的语法。停用的插件不运行任何代码，也就没有表单。

插件响应的事件可以在设置页“试跑”：用示例事件运行它的命令，和事件真的来时一样。

## 日志

每个插件的运行记在 `<数据目录>/plugin-logs/<id>.log`：哪个事件、哪个会话、成功与否、用时，以及命令打印的内容（标准输出与标准错误，最多留最后 8192 个字符）。超过约 1 MB 换新文件，旧的留一份 `<id>.1.log`。事件的内容不进日志；插件不要把密钥打印出来。

## 兼容

这份规范（事件、`hooks.json`、`plugin.json`、`ui.ts`）独立于客户端与服务端的协议，服务端升级后老插件照常使用：

- 只增加，不删除，也不改变已有的含义；要改时用新的名字。事件的 `version` 现在是 1，以后若有新版本，只发给声明要它的插件。
- 不认识的事件和多余的属性忽略。`status`、`code`、`model`、`effort`、`permission_mode` 这类字段以后可能有新的值；`reason` 和错误的 `message` 是给人看的，不要按文字判断。
- 用到较新的写法（如新的字段类型）的插件写上 `minVersion`，旧服务端会说明需要哪个版本。
- 设置按字段名保存，更新插件时留着，字段改了类型时用默认值。

## 事件

每个事件都有 `version`、`hook_event_name`、`timestamp`（ISO 8601）、`config`（插件的设置）。除设备事件外还有 `session_id`、`session_title`、`project_path`、`run_id`，以及会话所在的设备 `device`（`id`、`name`、`platform`：`win32`、`darwin` 或 `linux`；很早的会话可能没有）和当时的状态：

- `model`（最近一次实际使用的，还没有时是会话选定的）、`effort`、`permission_mode`。
- `context`：最近一次读到的上下文，`used_tokens` 与 `window_tokens`。
- `quota`：账号的订阅额度，每个窗口有 `name`（如 `five_hour`、`seven_day`）、`utilization`（百分比）、`resets_at`，后两者可能是 `null`。

没有值的字段不出现。

| 事件 | 何时 | 其他字段 | `matcher` 对照 |
| --- | --- | --- | --- |
| `ApprovalRequested` | 等待审批，包括批准计划（`ExitPlanMode`） | `wait_id`、`tool_name` | `tool_name` |
| `QuestionAsked` | Claude 提问，等待回答 | `wait_id`、`tool_name` | |
| `TerminalWaiting` | `ccdt` 终端里等待确认 | `wait_id` | |
| `WaitResolved` | 上面三种等待已解除，`wait_id` 与之相同 | `wait_id`、`waiting`（`approval`、`question`、`terminal`）、`tool_name`、`allowed` | `waiting` |
| `BackgroundOnly` | 这一轮已回答完，只剩后台任务；任务结束后 Claude 可能自己接着做 | | |
| `RunError` | 运行出错 | `code`、`message` | `code` |
| `RunEnded` | 一轮结束，包括它的后台任务 | `status`（`completed`、`failed`、`cancelled`）、`reason`、`duration_ms`，失败时还有 `error`（`code`、`message`，这一轮最后一次出错） | `status` |
| `DeviceOnline` | 一台设备连上 | `device` | |
| `DeviceOffline` | 一台设备的最后一条连接离开；它有运行或终端时，等到超过断线宽限期 | `device` | |

- `allowed` 是批准还是拒绝，提问则是回答了还是没有回答；没有人决定时不出现：运行结束了，或等待发生在终端里。
- 事件不含对话、工具的输入和输出。会话标题、项目路径和错误说明会出现在事件里，插件把它们发到第三方之前自行取舍。
- 服务端自己发起的空闲压缩不发事件。`ccdt` 终端只报告等待与解除，不报告一轮结束。服务停止或重启时打断的运行也不发事件。

一条事件的例子：

```json
{
  "version": 1,
  "hook_event_name": "RunEnded",
  "timestamp": "2026-11-24T12:00:00.000Z",
  "session_id": "0f4d1c9e-6a53-4b0c-9a39-3c1d6a6f7b10",
  "session_title": "整理设置页",
  "project_path": "D:\\work\\demo",
  "device": { "id": "5b1f0a52-2f0e-4c63-8d6e-0d0f2b7a9c11", "name": "书房电脑", "platform": "win32" },
  "run_id": "c2a7c1de-1d0b-4a35-8f55-7f3f5e0a4d21",
  "permission_mode": "auto",
  "context": { "used_tokens": 84000, "window_tokens": 200000 },
  "quota": [{ "name": "five_hour", "utilization": 42, "resets_at": "2026-11-24T15:00:00.000Z" }],
  "status": "completed",
  "duration_ms": 84210
}
```
