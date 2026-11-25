# 插件与事件

服务端在需要人或别的系统知道的时候发出事件，交给数据目录里的插件：推送到聊天软件、接家庭自动化、记录到自己的系统，都由插件去做，服务端不认识任何渠道。设备、`ccdt` 终端、跨设备的审批这些状态 Claude Code 里没有，所以事件由服务端发出，而不是用 Claude Code 自带的 hooks。

插件只接收通知，在自己的进程里运行，出错、超时都不影响会话的运行。标准输出留作以后的用途。

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

- 服务端监听这个目录，新增、修改、删除插件片刻后生效，不用重启。
- `type` 只支持 `command`。有 `args` 时直接启动 `command`，没有时交给 shell 执行。
- `matcher` 的写法与 Claude Code 相同：省略、空或 `*` 匹配全部；只含字母、数字、`_`、`-`、空格、`,`、`|` 时是一个或几个名字；其他是正则表达式。对照的字段见下表，没有列出的事件忽略它。
- `timeout` 是秒数，默认 60，最长 600，到时连同它启动的进程一起结束。默认值比 Claude Code 的 600 短，因为这里只是通知。
- 命令在插件目录里运行，事件是标准输入上的一个 JSON 对象（UTF-8）。环境变量 `CLAUDE_PLUGIN_ROOT` 是插件目录，`CLAUDE_PLUGIN_DATA` 是它存状态用的目录（`<数据目录>/plugin-data/<id>/`），两者也可以在 `command` 和 `args` 里写成 `${…}`。
- 匹配的命令同时启动，事件之间也不排队：要分先后时看 `timestamp`。

插件与服务端是同一个 Linux 用户，能做的与会话里的 Claude 一样多，只装信得过的。

## 事件

这份合约独立于客户端与服务端的协议，只增加，不删除，也不改变已有的含义。

每个事件都有 `version`、`hook_event_name`、`timestamp`（ISO 8601）。除设备事件外还有 `session_id`、`session_title`、`project_path`、`run_id`，以及会话所在的设备 `device`（`id`、`name`、`platform`：`win32`、`darwin` 或 `linux`；很早的会话可能没有）和当时的状态：

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
