# Linux 客户端（实验性）

Linux 上的客户端与 Windows、macOS 上的是同一套界面和同一条连接。它是实验性支持，只以一个系统为准：当前的 Ubuntu LTS，x64。维护者不在 Linux 桌面上日常使用它，构建、自动测试和安装后的启动检查都在 GitHub 的 Ubuntu 机器上完成。

本机一侧与 macOS 相同：SSH 服务是应用自身的一个进程，脚本由你自己的 shell（zsh 或 bash）执行，文件传输用系统的 sftp-server。这些的说明、与 Windows 的差别和实现都在 [macOS 客户端](macos.md)，此处只写 Linux 上不同的地方。

## 安装

```sh
sudo apt install ./CC-Desk-Tunnel-<版本>-linux-amd64.deb
```

安装包会带上 `openssh-client` 与 `openssh-sftp-server`，并推荐安装中文字体 `fonts-noto-cjk`（界面是中文的）。后者只是一个供 SFTP 使用的程序，不包含也不会启动 SSH 服务端，本机不会因此多出监听的端口。卸载用 `sudo apt remove cc-desk-tunnel`。

升级需要手动：到发布页下载新版本的安装包，用同一条命令再安装一次，设置会保留。两端版本要一致，不一致时登录页会提示去发布页下载。

其他发行版没有安装包，可以[从源码运行](macos.md#从源码运行与打包)；需要系统里有 OpenSSH 的客户端和 sftp-server。

## 与 macOS 的不同

- 没有系统对个别文件夹的授权询问。
- “记住凭据”依赖桌面的密钥环（GNOME Keyring、KWallet 等）；没有可用的密钥环时凭据不会被保存，每次需要重新填写。
- 关闭窗口后留在后台依赖系统托盘。Ubuntu 的桌面带有托盘；在没有托盘的桌面上，关闭窗口后可以再启动一次应用把窗口唤回，或在“设置 → 常规”里关掉“关闭窗口时留在后台”。
- 快捷键与 Windows 相同，用 Ctrl。

## 打包

```sh
npm ci
npm run setup:desktop
npm run package:linux     # 在 artifacts/linux/ 生成 deb
```

只能在 Linux x64 上进行。有图形界面时，打好的程序会被离线启动一次做检查；没有时可以放在 `xvfb-run` 里运行。GitHub 的 `package` 工作流里，安装包是按上面的命令装进系统、再从安装位置启动来检查的。

## 已验证与未验证

在 GitHub 的 Ubuntu 24.04 机器上自动验证的：本机 SSH 服务的全部测试（与 macOS 相同的一套）；经真实的服务端、连接桥和执行通道执行脚本、并发命令和传输文件；安装包的安装，以及安装后的程序在虚拟屏幕上启动并执行脚本。

尚未验证，需要真机：在真实的桌面（GNOME、KDE，X11 与 Wayland）上的窗口、标题栏按钮、托盘、通知和输入法；密钥环；连接真实的服务端由 Claude 完成任务。

遇到问题请到[议题](https://github.com/sun168567/cc-desk-tunnel/issues)反馈，附上“设置 → 关于与更新”里的连接日志和桌面环境。
