# 插件

服务端在等待审批、一轮结束、电脑上下线等时刻发出事件，交给数据目录里的插件：推送到手机或聊天软件、接家庭自动化、记到自己的系统，都由插件去做，服务端不认识任何渠道。这些状态（多台电脑、`ccdt` 终端、跨设备的审批）Claude Code 自己没有，所以事件由服务端发出，而不是用会话里 Claude Code 的 hooks。

插件的写法照 [Claude Code 的插件](https://code.claude.com/docs/en/plugins-reference)：同样的目录结构、`plugin.json`、`hooks/hooks.json`、`userConfig` 和环境变量，不同的只是事件。会写 Claude Code 插件的人和 Claude 都可以照着写；会话里要的扩展（技能、MCP、拦截工具调用）仍然装 Claude Code 自己的插件。

插件只接收通知：命令在自己的进程里运行，出错、超时都不影响会话，结果记进插件的日志。

## 目录

插件是 `<数据目录>/plugins/<id>/`（Docker 部署在容器里是 `/data/state/plugins/<id>/`），`id` 由小写字母、数字、`.`、`_`、`-` 组成。目录放进去、改了或移走，片刻后生效，不用重启。

```text
<id>/
├── .claude-plugin/
│   └── plugin.json     名字、版本、设置项；可以没有
├── hooks/
│   └── hooks.json      哪个事件运行哪个命令
└── notify.mjs          插件自己的文件
```

最简单的插件只有 `hooks/hooks.json`，比如一轮结束时把事件交给自己的脚本：

```json
{
  "hooks": {
    "RunEnded": [{ "hooks": [{ "type": "command", "command": "/opt/notify/run.sh" }] }]
  }
}
```

## hooks.json

结构与 Claude Code 相同：事件 → 一组组 `matcher` 与命令。

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

- `type` 只支持 `command`。有 `args` 时直接启动 `command`（不经过 shell），没有时交给 shell 执行。
- `matcher` 的写法与 Claude Code 相同：省略、空或 `*` 匹配全部；只含字母、数字、`_`、`-`、空格、`,`、`|` 时是一个或几个名字；其他是正则表达式。对照的字段见[事件](#事件)，没有列出的事件忽略它。
- `timeout` 是秒数，默认 60，最长 600，到时连同它启动的进程一起结束。
- 命令在插件目录里运行，事件是标准输入上的一个 JSON 对象（UTF-8）。匹配的命令同时启动，事件之间不排队，要分先后时看 `timestamp`；同时运行的命令最多 8 个，其余排队。
- 环境变量与 Claude Code 给 hooks 的相同：`CLAUDE_PLUGIN_ROOT` 是插件目录；`CLAUDE_PLUGIN_DATA` 是插件存状态的目录（`<数据目录>/plugin-data/<id>/`，换掉插件目录时保留）；每个设置项是 `CLAUDE_PLUGIN_OPTION_<KEY>`（键名大写）。`command` 和 `args` 里可以写 `${CLAUDE_PLUGIN_ROOT}`、`${CLAUDE_PLUGIN_DATA}`；`args` 里还可以写 `${user_config.KEY}`，它不经过 shell，不会被再解析一遍。
- 标准输出与标准错误记进日志，留作以后的用途；插件不要把密钥打印出来，原样出现的密钥会被换成 `***`。

## plugin.json

照 Claude Code 的 `plugin.json`，服务端读这些字段，其余忽略：

| 字段 | 说明 |
| --- | --- |
| `name` / `displayName` | 名字；设置页显示 `displayName`，没有时显示 `name`，再没有时显示目录名 |
| `version`、`description`、`author`（`{ name, url }`）、`homepage`、`repository` | 显示在设置页 |
| `userConfig` | 设置项，见下 |

## 设置

`userConfig` 声明插件要用户填的值，写法与 Claude Code 相同。设置页按它画出表单，桌面和网页一样；插件自己的代码不参与画界面。

```json
{
  "userConfig": {
    "webhook": {
      "type": "string",
      "title": "机器人地址",
      "description": "群机器人的 Webhook 地址",
      "sensitive": true,
      "required": true
    },
    "format": { "type": "string", "title": "格式", "options": ["card", "text"], "default": "card" },
    "delay": { "type": "number", "title": "延迟（分钟）", "min": 0, "max": 30, "default": 0 },
    "night": { "type": "boolean", "title": "夜里也推送", "default": false }
  }
}
```

- `type`：`string`、`number`、`boolean`。`title` 必填；可有 `description`、`required`、`default`；`string` 可有 `options`（下拉选择）；`number` 可有 `min`、`max`。不认识的键是错误，插件不运行，设置页说明原因。
- `sensitive` 的值只进不出：任何窗口都读不回，留空保持原值。
- 必填的没有值时，插件不运行，设置页提示要先设置哪些。
- 开关和下拉改了就存，文字和数字在离开输入框或按回车时存；不合规的不存，原因显示在字段下。
- 值存在 `<数据目录>/plugin-config/<id>.json`（权限 0600），换掉插件目录时保留。

## 试跑与日志

设置页列出插件响应的事件，点一下就用示例事件运行它的命令（不看 `matcher`，最长 60 秒），结果进日志。每次运行记在 `<数据目录>/plugin-logs/<id>.log`：事件、会话、成败、退出码、用时，以及命令最后打印的 8192 个字符；约 1 MB 后换新文件，旧的留一份。

## 信任

插件和服务端是同一个 Linux 用户，命令拥有与会话里的 Claude 相同的权限：能读服务端上的凭据，也能经在线的电脑执行命令。这和 Claude Code、VS Code 的插件一样，装上即信任，服务端不限制它。只放信得过的插件；事件里的会话标题、项目路径和错误说明，插件发给第三方之前自行取舍。

## 兼容

这份规范独立于客户端与服务端的协议，服务端升级后插件照常使用：

- 只增加，不删除，也不改变已有的含义；要改时用新的名字。事件的 `version` 现在是 1。
- 不认识的事件和多余的字段忽略。`status`、`code`、`model`、`effort`、`permission_mode` 这类字段以后可能有新的值；`reason` 和错误的 `message` 是给人看的（目前是中文），不要按文字判断。

## 事件

每个事件都有 `version`、`hook_event_name`、`timestamp`（ISO 8601）。除电脑上下线外还有 `session_id`、`session_title`、`project_path`、`run_id`，会话所在的电脑 `device`（`id`、`name`、`platform`：`win32`、`darwin` 或 `linux`），以及当时的状态：

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
| `DeviceOnline` | 一台电脑连上 | `device` | |
| `DeviceOffline` | 一台电脑的最后一条连接离开；它有运行或终端时，等到超过断线宽限期 | `device` | |

- `allowed` 是批准还是拒绝，提问则是回答了还是没有回答；没有人决定时不出现：运行结束了，或等待发生在终端里。
- 事件不含对话、工具的输入和输出。
- 服务端自己发起的空闲压缩不发事件。`ccdt` 终端只报告等待与解除，不报告一轮结束。服务停止或重启时打断的运行也不发事件。
- 只剩后台任务和一轮结束分成两个事件：只剩后台任务时多半在等构建或测试，等完会接着干，要不要在这时通知由插件决定。

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
