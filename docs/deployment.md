# 部署与安全边界

服务端以 Docker / Compose 部署在 Ubuntu amd64 上。安装与日常操作见[部署操作手册](../deploy/README.md)，整体威胁模型见 [SECURITY.md](../SECURITY.md)；本页说明端口、证书、凭据、数据和信任边界。

## 部署选择

官方 CLI、PTY、frps 与代理服务在同一个容器里，随机的 Windows SSH 映射只在容器回环上，不需要 host 网络、特权容器或 Docker socket。镜像是较完整的 Ubuntu 工具环境，预装 Git、SSH、Node、Python 以及编译、文本、网络工具，保留可写层与持久的工作目录，普通用户可以安装用户级工具。

`deploy/install.sh` 检查 Docker 与 Compose（缺少时只给出安装命令），单独运行时还会从发布页下载并校验最新的程序包；`deploy/manage.sh` 负责初始化、构建、启动、升级、更换证书与凭据、备份恢复和卸载。`npm run package:server` 生成不含秘密的源码包；也可以在别处构建镜像后 `docker save` / `load`，配合不含构建步骤的 `deploy/compose.yml` 使用。目前没有公共镜像仓库。

Node.js、Claude Code、Agent SDK、frp 均为固定版本（见 `scripts/install-linux.sh` 与 `package-lock.json`），不声称最新或无漏洞。`scripts/install-linux.sh` 与 `scripts/deploy-linux.mjs` 另提供一条普通用户直接运行的开发调试路径，没有进程监督，不用于生产。

## 端口与协议

| 位置 | 默认监听 | 协议 / 用途 | 公网 |
| --- | --- | --- | --- |
| 直连入口 | 宿主 `0.0.0.0:8787` → 容器 8787 | HTTPS `/health`、WSS `/ws` | 客户端可访问 |
| nginx 入口 | 通常 `443`，遵循已有配置 | nginx 终止 TLS，WSS 反代 | 客户端可访问 |
| nginx 上游 | 宿主 `127.0.0.1:8787` → 容器 8787 | HTTP / WS，只允许可信反代 | 不开放 |
| frps | 宿主 `0.0.0.0:7000` → 同端口 | frp TCP，强制 TLS，每连接启动 | 客户端可访问 |
| Windows 映射 | 容器 `127.0.0.1:<随机>` | SSH 到 Windows | 不开放 |
| Windows sshd / UI bridge | Windows `127.0.0.1:<随机>` | SSH / 本机 nonce + Origin WS | 不开放 |
| 运维 SSH | 遵循 VPS 原有端口，常见 22 | SSH / SFTP 管理 | 管理者可访问 |

`--control-port` / `--frps-port` 可改，nginx 公网端口由既有服务决定。无需 UDP、Windows 入站规则或公开随机 SSH 映射端口；暂不支持 IPv6 配置。业务双向控制、原生终端均走 WSS，没有 REST 会话 / 配置 / 上传接口或公网 Web UI。无认证的 `GET /health` 只返回状态、协议版本和适配器类型；`GET /client/installer` 凭服务凭据下载客户端安装包；其他 HTTP 路径 404。服务端自身只向外访问 GitHub 的发布接口（查询版本、下载程序包与安装包）和升级时的 npm 仓库，可用 `PROXY_RELEASE_REPO='none'` 关闭。

容器内反代模式监听 `0.0.0.0` 供 Docker bridge 接入；宿主仅回环发布。不要将不可信容器加入同一网络或单独公开上游。Docker 端口发布与 UFW 常规 INPUT 的关系需核对，公网来源限制优先在云安全组 / Docker 防火墙策略实施。

## TLS 与凭据

- 无域名默认自签控制证书（RSA3072 / SHA256，365 天）；Windows 精确固定整张叶证书 SHA256 后才发送 token。这一路径不额外验证有效期 / 域名；初次指纹从可信 SSH 或独立可信渠道取得，不自动信任网络返回的指纹。`renew` 更换后客户端更新指纹。
- 指定真实证书 / 域名时，初始化检查私钥配对、证书到期和主机名；私有复制进数据目录。客户端指纹留空时启用 CA、有效期、主机名校验。没有无需验证的 TLS 模式。证书续期用 `certificate` 命令，不重建镜像。
- nginx 负责公网 TLS 时使用已有真实证书 / ACME；代理不需要公网私钥。示例传递 WebSocket Upgrade / Connection，保持长连接超时；不自动改现有 nginx 或签发 / 续期证书。
- frp TLS 身份独立于控制面：私有证书有效十年，仅用于本应用隧道，经已验证 WSS 下发信任，不安装系统 CA。nginx / 公网证书续期不影响它；到期前维护其证书并重启连接。frps 强制 TLS，每次连接独立随机 token，只允许一个指定回环映射端口。
- 代理 token 为随机 32 字节单用户共享秘密，不是模型账号凭据。WSS 首帧认证后才读取历史 / 管理会话；同一来源地址连续 5 次凭据错误后需等待（1 分钟起逐次翻倍，最长 1 小时），未认证连接有数量上限并在 5 秒后关闭，失败记入日志；nginx 模式须按示例传递 `X-Real-IP`，否则所有客户端共用一个计数。`manage.sh token` 更换凭据。没有多用户隔离、多因素认证或凭据自动轮换，限速也不是完整的抗拒绝服务方案。
- Windows 每连接生成 SSH identity / host key；Linux 固定 SSH host key、禁止 agent forwarding，Windows 关闭密码认证 / TCP forwarding / 隧道。私钥仅保存在临时连接目录，提示词提供 SSH config 路径，不放私钥。

## 生命周期与数据

Compose `unless-stopped`、`tini -g`、30 秒正常停止、日志上限 3 × 10MB；强杀由 Docker 回收容器全部进程。正常代理退出 / 断连仍负责临时隧道与终端回收，服务启动删除失效连接目录。健康检查不调用模型，不代表提供方 / Windows 在线；unhealthy 不自动触发 Docker 重启。

`--data` 默认 root 初始化为 `/srv/cc-desk-tunnel`，持久化原生 home、代理 state / SQLite / WAL、workspace、配置和证书。目录 0700、秘密文件 0600；容器 uid 1000 可写数据，程序与官方运行时由 root 拥有。备份停止服务保持一致，排除临时 SSH identity，结束恢复原运行状态。恢复只允许空的长期数据目录；卸载保留数据与镜像，不卸宿主 Docker，不自动删除上下文。升级先成功构建再替换，备份与旧镜像 tag 可供回退。

## 信任边界

- VPS 持有连接期 Windows 私钥，权限是当前 Windows 用户，不是项目沙箱；VPS 被攻陷可绕过 Claude 审批直接 SSH。只开回环 / 使用 TLS 不能消除这层授权。
- 官方 auto 默认启用，人工入口只转接原生请求，无额外 AI 审批器。提示词指导 Windows 执行，不是严格 Linux 工具沙箱；容器限制不等于对同一 Linux 用户秘密的隔离。
- 原生上下文由 Linux Claude 管理，代理 SQLite 是展示镜像。账号 / API 配置、历史及备份可能包含秘密和代码，无磁盘层加密，宿主 root / Docker 管理者可读。
- Windows 项目不整库搬运，但读出的片段 / 工具结果经过 VPS 与模型提供方，不是 Windows 到模型的端到端加密。原生 CLI 账号与上下文规则不由代理重写。
- Windows SSH / frpc 随客户端连接回收，无常驻服务；异常强杀的临时文件残留仍是已知问题。停止任务不能承诺撤销已经发生的 SSH 副作用。
- 项目不对账号状态或订阅使用授权作承诺。

## 尚未覆盖

- 公网证书的自动续期；到期前需用 `manage.sh certificate` 或 `renew` 手动更换。
- 长任务与高负载下的容量。小内存主机只验证过个人串行使用。
- 迁移到新服务器时，需重新核对架构、云防火墙、域名与证书。
