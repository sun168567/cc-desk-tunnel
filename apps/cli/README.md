# `ccdt` 终端客户端

在自己的终端里使用 CC Desk Tunnel 服务端上的原版 Claude Code：界面、快捷键和斜杠命令与本地 `claude` 一样，Claude 的命令经执行通道在这台电脑上运行。与图形客户端共用会话：终端里接着图形客户端的对话，终端里聊的内容结束后也记入会话。设计见[设计记录](../../docs/research/standalone-cli.md)。

开发阶段从源码运行，需要 Node.js 24；Windows 上还需要 `npm run prepare:windows` 准备的 OpenSSH 组件。

```bash
node apps/cli/bin/ccdt.mjs login      # 地址和证书指纹取自图形客户端；也可以写 login <wss 地址> --fingerprint <指纹>
cd D:\work\my-project
node apps/cli/bin/ccdt.mjs            # 接着这个项目最近的会话；没有就新建
node apps/cli/bin/ccdt.mjs -r         # 从这个项目的会话里选一个
```

用法和本地的 `claude` 一样：窗口开着它就一直运行，断网会自动接回；退出 Claude Code 或关掉窗口就结束。运行 `ccdt --help` 查看全部命令。
