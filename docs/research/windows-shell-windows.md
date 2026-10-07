# Windows SSH 命令弹窗：根因与处理

2026-10-03 初查，2026-10-06 复核并落地。环境：Windows build 26200，随包 Win32-OpenSSH `10.0.0.0p2-Preview`，默认终端为 Windows Terminal。

## 结论

项目独立 sshd 启动前在其宿主进程内设置 `SSH_TEST_ENVIRONMENT=1`，sshd 就以 `CREATE_NO_WINDOW` 创建命令进程，不再出现窗口，也不再抢焦点。已在 `component-host.ps1` 落地，回归测试覆盖。它是 OpenSSH 的内部测试开关而非公开的静默选项，升级 OpenSSH 时须按本文“升级核查”重新确认。

## 根因

- OpenSSH 对每条非 PTY 命令执行 `cmd.exe /c "<命令>"`（`w32-doexec.c`），远端命令再指定 PowerShell 也改变不了这层外壳。
- `w32fd.c` 的 `spawn_child_internal` 给 `sshd-session.exe` / `sshd-auth.exe` 加 `DETACHED_PROCESS`，会话进程没有控制台；它再创建 `cmd.exe` 时既无控制台可继承、也没有无窗口标志，Windows 于是为 `cmd.exe` 新建一个控制台。
- 官方部署形态是系统服务，进程在 session 0，新控制台不会出现在任何人的桌面上。上游维护者在 [#1898](https://github.com/PowerShell/Win32-OpenSSH/issues/1898) 明确说明“新进程创建在 session 0，看不到窗口”，并把非服务方式运行称为调试形态；2026-02 有用户在同一 issue 报告以普通用户直接运行 `sshd.exe` 时每次 SFTP 都弹空白 cmd，未获修复。
- 本项目有意不装系统服务，sshd 运行在用户的交互会话里，新控制台因此可见；默认终端是 Windows Terminal 时表现为每条命令一个标题为 `c:\windows\system32\cmd.exe` 的新窗口。
- 所以隐藏 sshd 自身、给宿主分配隐藏控制台、在内层命令加 `-WindowStyle Hidden` 都无效：窗口是会话进程之后才新建的。

同一函数里已有现成分支：`is_bash_test_env()`（读取 `SSH_TEST_ENVIRONMENT`，非零为真）成立时追加 `CREATE_NO_WINDOW`。该环境变量须在 sshd 进程自身的环境里；`sshd_config` 的 `SetEnv` 只影响命令环境，实测无效。

## 实测

隔离的测试 sshd（随机回环端口、临时密钥，与产品相同的无窗口方式启动），客户端用 `ssh2`，3 ms 轮询新出现的可见顶层窗口和前台窗口变化。

| 启动方式 | 4 条命令的新可见窗口 | 前台窗口被夺 | 输出 / 退出码 |
| --- | --- | --- | --- |
| 现状 | 4 / 4，Windows Terminal 窗口 | 4 / 4 | 正常；`echo` 约 140 ms |
| `SSH_TEST_ENVIRONMENT=1` | 0 | 0 | 正常；`echo` 约 46 ms |

开关开启后另行确认：中文 stdout、独立 stderr、退出码 7、stdin 管道、SFTP 中文文件名往返、命令内再启动 git / ping 等控制台子进程均正常且无窗口；命令主动启动的 GUI 程序（charmap）窗口照常显示。产品真实宿主的回归测试在修复前判定命令控制台可见、修复后不可见。

未覆盖：完整 Electron + frp + 原生 Claude 链路上的肉眼确认需重新打包并重启客户端；交互式 PTY（`ssh -t`）走 `ssh-shellhost` 另一分支，未测。

## 开关的其他作用

`v10.0.0.0` 全部引用共五处，除无窗口标志外都只处理 `/cygdrive/<盘符>/` 前缀的路径：

- `misc.c` 路径解析与命令行拼装：把该前缀转成盘符路径；普通 Windows 路径原样通过。
- `scp.c` / `sftp.c`：仅当在 Windows 上运行这两个客户端且继承到该变量时，对同一前缀做转换。

不涉及认证、权限或 `StrictModes`。命令进程可能继承到这个变量（未单独验证），影响仅限上述前缀的路径。

## 升级核查

换 OpenSSH 版本时确认 `contrib/win32/win32compat/w32fd.c` 的 `spawn_child_internal` 仍有 `is_bash_test_env()` → `CREATE_NO_WINDOW`，并复查 `is_bash_test_env` 的全部引用。2026-10-06 上游 `latestw_all` 分支该逻辑未变。`component-host.test.mjs` 的无可见控制台用例会在开关失效时失败。

## 未采用的方向

| 方向 | 原因 |
| --- | --- |
| 用 `ssh2` 自建 Windows SSH 服务端并以 `windowsHide` 启动命令 | 可行，同样无窗口，但要自行补齐 SFTP、PTY 与进程归属；仅在上游移除该开关时再考虑 |
| 安装系统服务让进程进 session 0 | 需要管理员和常驻服务，命令也无法再显示用户要看的 GUI |
| 独立桌面 / 窗口站承载 sshd | 此前实测未消除弹窗；即使成立，用户要看的 GUI 也会被藏起来 |
| `ssh -tt` 走 PTY | 丢失独立 stderr 与非零退出码 |
| 改全局 `DefaultShell` 或默认终端 | 影响用户其他 SSH 与终端使用，且外层进程仍由 sshd 创建 |
| 事后隐藏窗口或夺回焦点 | 发生在显示之后，仍会闪烁，且可能误伤用户窗口 |
| 降级到旧版 OpenSSH | [#2465](https://github.com/PowerShell/Win32-OpenSSH/issues/2465) 称 7.9 无此现象，但要放弃多年安全修复 |

同类产品（Codex 的 `CREATE_NO_WINDOW` 后台进程、OpenCode 的 `windowsHide`）都是在真正创建命令进程的那一层设置无窗口标志；本方案等价于让 OpenSSH 在同一层做同样的事。

## 来源

- [w32fd.c](https://github.com/PowerShell/openssh-portable/blob/v10.0.0.0/contrib/win32/win32compat/w32fd.c)、[w32-doexec.c](https://github.com/PowerShell/openssh-portable/blob/v10.0.0.0/contrib/win32/win32compat/w32-doexec.c)、[misc.c](https://github.com/PowerShell/openssh-portable/blob/v10.0.0.0/contrib/win32/win32compat/misc.c)
- [Process Creation Flags](https://learn.microsoft.com/en-us/windows/win32/procthread/process-creation-flags)
- Win32-OpenSSH [#1898](https://github.com/PowerShell/Win32-OpenSSH/issues/1898)、[#2465](https://github.com/PowerShell/Win32-OpenSSH/issues/2465)、[#1153](https://github.com/PowerShell/Win32-OpenSSH/issues/1153)
- [Codex background_command](https://github.com/openai/codex/blob/8f7a0f7a878199c6886600370e5be6bd37ca38a3/codex-rs/utils/process/src/lib.rs)、[OpenCode PR #48879](https://github.com/anomalyco/opencode/pull/48879)
