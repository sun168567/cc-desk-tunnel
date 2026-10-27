# Linux Docker 部署

Ubuntu amd64 优先；arm64 为实验性支持：镜像构建、部署自测和服务端测试在 arm64 上自动运行通过，还没有人在 arm64 服务器上用真实账号跑过会话。官方 Claude Code、Agent SDK、PTY 同容器；不改 Claude 本体、不加入执行 MCP。容器有可写层和较完整工具环境，不是只读沙箱；以 uid 1000 普通用户运行，无宿主 Docker socket、特权模式或宿主项目挂载。

## 准备

最省事的方式是一条命令。脚本检查 Docker 等依赖（缺少时给出安装命令，不代为安装），将部署脚本保存到 `/opt/cc-desk-tunnel`，从发布页确定版本并拉取 GHCR 镜像，随后进入下面的交互安装；已有部署时改为询问是否升级。程序目录可用环境变量 `CC_DESK_TUNNEL_DIR` 更改。

```sh
sudo bash -c "$(curl -fsSL https://raw.githubusercontent.com/sun168567/cc-desk-tunnel/main/deploy/install.sh)"
```

默认使用 `ghcr.io/sun168567/cc-desk-tunnel:X.Y.Z`，同一标签同时支持 amd64 和 arm64。部署固定具体版本；`latest` 仅指向最新正式版。镜像只含服务端运行环境与 Web 界面，不含桌面安装包。服务启动后在 `/data/state/client` 缓存对应 Windows 安装包，供客户端更新；下载失败不会阻止服务启动。

一键脚本每次安装从 `main` 解析一个固定提交，下载同一提交的部署脚本；应用镜像则使用所选 Release 的固定版本。可用 `sudo env CC_DESK_TUNNEL_VERSION=X.Y.Z bash -c "$(curl -fsSL https://raw.githubusercontent.com/sun168567/cc-desk-tunnel/main/deploy/install.sh)"` 指定版本。普通部署不下载应用源码；需要自行修改时用完整源码目录并显式选择 `CC_DESK_TUNNEL_BUILD=1`。

需要源码构建时，也可以从发布页下载服务端程序包 `cc-desk-tunnel-server-X.Y.Z.tar.gz` 和 `SHA256SUMS`。放到服务器的同一目录，校验后解压；客户端安装包仍单独下载到电脑：

```sh
grep "  cc-desk-tunnel-server-X.Y.Z.tar.gz$" SHA256SUMS | sha256sum -c -
sudo mkdir -p /opt/cc-desk-tunnel
sudo tar -xzf cc-desk-tunnel-server-X.Y.Z.tar.gz -C /opt/cc-desk-tunnel
cd /opt/cc-desk-tunnel
```

程序包不含秘密、Windows UI、开发测试和依赖。也可以自己打包：本机运行 `npm run package:server`，或直接使用完整仓库。

交互安装：不带参数运行，脚本依次询问公网地址（默认自动探测）、入口方式、端口、数据目录和服务凭据（留空自动生成），随后自动拉取镜像、启动，并在结尾汇总客户端要填的地址 / 指纹 / 凭据、需放行的端口和下一步。已有部署配置时跳过问答，只重新准备镜像并启动。

```sh
sudo env CC_DESK_TUNNEL_BUILD=1 bash deploy/install.sh
```

升级与客户端分发：

```sh
# 原地升级到最新正式镜像；数据、账号和配置不动
sudo bash deploy/manage.sh upgrade
# 或指定版本
sudo env CC_DESK_TUNNEL_VERSION=X.Y.Z bash deploy/manage.sh upgrade
# 把 Windows 安装包交给服务端；已连接的旧客户端下次连接时在左下角连接菜单看到“升级到 x.y.z”
sudo bash deploy/manage.sh client /path/CC-Desk-Tunnel-Setup-X.Y.Z-x64.exe
# 更换服务凭据（留空则随机生成）并重启；已保存旧凭据的客户端需重新填写
sudo bash deploy/manage.sh token
# 随时重看汇总
sudo bash deploy/manage.sh summary
```

nginx 模式需按示例配置反代 `/client/installer`，客户端自升级才能下载。服务端只保留最近 3 个版本的安装包，更旧的自动删除。

### 从客户端升级

服务端每 6 小时查询一次项目的 GitHub 发布页，客户端连接菜单里的“检查更新”立即查询一次。有新版本时：

- 菜单出现“升级服务端到 x.y.z”：确认后服务端下载程序包并按清单校验、安装依赖，然后重启；对应客户端安装包在启动后后台下载，全程几分钟；重启后重新连接，客户端按提示升级自己。运行中的任务、原生终端或账号登录未结束时不能开始升级。
- 客户端比服务端新、登录页提示“此客户端较新”时：点登录页的“升级服务端”，服务端同样升级到最新的正式版并重启，然后照常连接。多个连接各连一台服务端时，从其中一台升级客户端后，其余服务端都这样升级。
- 菜单显示“服务端 x.y.z 需在服务器上升级”：新版本需要更新的镜像（Node.js 或系统组件有变化），使用 `manage.sh upgrade` 拉取新版镜像。

升级后的程序放在数据目录的 `program/` 下，镜像不变。容器启动时比较两处的版本，运行较新的一个：重建或替换容器不会回到旧版本，用更新的程序包重建镜像后则以镜像为准。升级后的程序连续三次启动失败时退回镜像里的版本，日志里有一行说明。失败的升级不改动正在运行的程序，原因显示在客户端。

改为跟踪自己的私有仓库（例如私有的 fork）时，服务端需要一个只读令牌才能读取发布页：在 GitHub 创建只授权该仓库、Contents 只读的细粒度令牌，存成 VPS 上的一个文件后执行下面的命令，随后删除该文件。令牌只保存在数据目录的 `config/service.env`（0600），不会传给客户端或 Claude Code。

```sh
sudo bash deploy/manage.sh release-token /path/token.txt   # 不带参数则移除
```

跟踪的仓库可在 `config/service.env` 里用 `PROXY_RELEASE_REPO='所有者/仓库'` 更改，设为 `none` 则不查询也不提供升级。容器没有宿主 Docker 的控制权，替换镜像始终要在宿主上执行。

同时进行的运行和终端有上限，默认按服务器内存估算（每个约占 300 MB，1 GB 内存的服务器是 2 个）。要改就在 `config/service.env` 里加 `PROXY_MAX_RUNS='数量'` 并重启服务。

电脑断线后，它的任务在服务端继续，等它连回来；离线超过 5 分钟才停止。要改这个时间就加 `PROXY_GRACE_SECONDS='秒数'`（0 到 3600，0 表示断线即停止）并重启服务。

需要脚本化或分步执行时仍可用参数形式：

```sh
sudo bash deploy/install.sh init --host VPS_IP
# 上一步打印数据目录；默认 sudo 安装为 /srv/cc-desk-tunnel
# 按需编辑 <数据目录>/config/provider.json，不把 API key 放进镜像。
sudo bash deploy/manage.sh pull
sudo bash deploy/manage.sh up
sudo bash deploy/manage.sh connection
```

`install.sh` 只检查 Docker / Compose 等依赖，缺少或 Docker 未运行时给出安装命令后退出；不安装系统软件，不修改 nginx、防火墙、SSH 或账号。默认安装只拉取镜像。显式源码构建才联网下载系统包、固定 Node / CLI 和锁定 npm 依赖，node-pty 在镜像构建阶段准备。Node 24 原生执行 TypeScript；发行检查仍必须 typecheck。

默认一个公网 TCP 端口：WSS / HTTPS `8787`，登录、对话和执行通道都经它。运维 SSH 遵循服务器已有端口。云防火墙与主机策略自行放行，**不需要 UDP 或公开 Windows / Linux 随机 SSH 端口**。从 0.2.9 及更早版本升级的部署原先还放行了 `7000`，不再使用，可以去掉；用 `manage.sh upgrade` 升级时容器也不再发布它。Docker 发布端口可能绕过 UFW 的常规 INPUT 规则，应采用云安全组或 Docker 对应防火墙策略，不把启用 UFW 当成已限制发布端口。

nginx 模式下服务按 `X-Real-IP` 区分来源地址做登录限速，请保留示例里的这一行。

## 三种 TLS 入口

初始化只能进行一次，避免覆盖长期上下文或秘密；另一个安装用 `PROXY_DEPLOY_CONFIG=/绝对路径/docker.env`，并选独立数据目录 / 端口。

```sh
# 无域名：自签证书，客户端明确固定 SHA256 指纹
sudo bash deploy/manage.sh init --host VPS_IP --data /srv/cc-desk-tunnel

# 真实域名证书：检查证书/私钥配对、到期及域名，复制进私有数据目录
sudo bash deploy/manage.sh init --host proxy.example.com --mode certificate \
  --cert /path/fullchain.pem --key /path/privkey.pem --data /srv/cc-desk-tunnel

# 已有 nginx：只将上游 HTTP 发布至宿主回环，WSS 证书由 nginx 管理
sudo bash deploy/manage.sh init --host proxy.example.com --mode nginx \
  --url wss://proxy.example.com/ws --data /srv/cc-desk-tunnel
```

nginx 的配置步骤、检查方法和常见问题见[用 nginx 反代](nginx.md)。容器内监听 `0.0.0.0:8787` 是为 Docker bridge 接入，不是宿主公网 HTTP。同一 Docker 网络的可信边界也需考虑；不要把未知容器接入此网络。nginx 模式默认宿主 `127.0.0.1:8787`、公网 `443`；已有 nginx 入口端口由用户决定。不自动申请证书或改现有 nginx。

客户端填 `connection` 输出的 URL / token。自签模式填指纹；真实可信 CA 或 nginx 域名证书将指纹留空，使用 CA、有效期和主机名校验。私有 CA 可选择明确指纹；指纹模式不额外验证有效期 / 域名，首次信任应由可信 SSH 渠道获得。没有任何关闭验证且不校验指纹的模式。

执行通道与控制连接用同一个地址和同一张证书，没有单独的隧道证书；每次连接另有随机生成的通道密钥，经已验证的 WSS 下发。自签证书默认一年。

## 模型与可写空间

`config/provider.json` 是官方 Claude settings 结构，初始 `{}`；API 环境配置可写入 `env` 中的 `ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_MODEL`，使用提供方正式支持的接口。不要将 key 放进命令行、Git 或截图。使用订阅登录还是 API key，以及是否符合提供方条款，由使用者自行确认。

持久数据位于指定 `--data`：

- `home/`：原生 Claude 账号 / 配置 / 上下文、用户安装工具及缓存。
- `state/`：代理 SQLite / WAL、原生工作目录、连接期临时 SSH 配置。
- `workspace/`：Linux 辅助工作空间。
- `config/`、`tls/`：服务秘密、模型配置和两套 TLS 身份。

预装 Git / SSH / rsync、Node / npm、Python / pip / venv、GCC / make、curl / wget、jq / rg、文本编辑器、压缩工具、SQLite、网络与进程工具。普通用户可往 `home` / `workspace` / `/tmp` 写入、建 venv 或用户级安装 npm 包；不能直接 apt 安装系统软件。需要更多系统组件时扩展 Dockerfile。容器 root 文件层也并非全盘只读，但升级重建会丢弃其中临时修改；重要工具和记忆须存 `/data`。默认项目任务仍通过 Windows SSH。

## 运维

无需找到脚本位置或先 `cd`：在线安装入口也接受管理命令。状态、日志、改密和备份直接调用已有部署的 `manage.sh`；在线 `upgrade` 询问确认后更新部署工具并拉取新版镜像，旧的源码部署也可通过这个入口迁移。其他管理操作不会触发升级。

```sh
sudo bash -c "$(curl -fsSL https://raw.githubusercontent.com/sun168567/cc-desk-tunnel/main/deploy/install.sh)" -- status
sudo bash -c "$(curl -fsSL https://raw.githubusercontent.com/sun168567/cc-desk-tunnel/main/deploy/install.sh)" -- token
sudo bash -c "$(curl -fsSL https://raw.githubusercontent.com/sun168567/cc-desk-tunnel/main/deploy/install.sh)" -- backup /secure/backup.tar.gz
```

其他操作替换末尾参数即可：`logs`、`restart`、`upgrade`、`connection` 等；`help` 显示列表。默认寻找 `/opt/cc-desk-tunnel`；自定义目录在 `sudo` 后加 `env CC_DESK_TUNNEL_DIR=/原安装目录`。`token` 不带新凭据时随机生成，重启后原客户端凭据失效；不要把秘密写进命令行。备份路径的父目录需要已经存在，文件不能存在。

已进入程序目录或离线管理时，原来的直接调用仍然可用：

```sh
sudo bash deploy/manage.sh status
sudo bash deploy/manage.sh logs
sudo bash deploy/manage.sh stop
sudo bash deploy/manage.sh up
sudo bash deploy/manage.sh restart
sudo bash deploy/manage.sh upgrade
sudo bash deploy/manage.sh backup /secure/backup.tar.gz
sudo bash deploy/manage.sh uninstall
```

Compose 崩溃 / 主机重启恢复，`tini -g` 管理信号与孤儿进程；停止给代理 30 秒正常回收，强杀则 Docker 回收容器中全部进程。日志上限 3 × 10MB。健康检查不发模型请求，也不是深度外部可用性探测；Docker 不会仅因 unhealthy 自动重启进程。

升级先拉取完整镜像，拉取失败不修改原镜像配置、不停止旧容器；成功后替换容器，保留原 `/data`。先备份再升级。新程序启动时执行已有的数据迁移，两种升级方式共用同一逻辑，可跳过中间版本；不承诺旧程序能读取已迁移的数据，因此换旧镜像不等于恢复备份。数据目录中若有应用内升级安装的更高版本，现有入口仍优先启动它。

源码构建是显式选项：在完整源码或服务端程序包目录执行 `sudo env CC_DESK_TUNNEL_BUILD=1 bash deploy/manage.sh setup` 或 `upgrade`；也可分开执行 `manage.sh build`、`manage.sh up`。`upgrade --from /path/server.tar.gz` 保留源码包升级行为。需要系统组件时仍可修改 Dockerfile 自行构建；普通镜像部署目录不包含这些源码。

手工 Compose 管理时，使用 `deploy/compose.yml`（无 build）。在独立部署目录复制为 `compose.yml`，将初始化生成的 `docker.env` 复制为同目录 `.env`，确认 `PROXY_IMAGE` 为 `ghcr.io/sun168567/cc-desk-tunnel:X.Y.Z` 或自行导入的 tag；该配置不含 token / API key，但目录和文件仍保持私有。运行 `sudo docker compose up -d` / `ps` / `logs` / `stop`。调用备份等脚本时设置 `PROXY_DEPLOY_CONFIG=/部署目录/.env`、`PROXY_COMPOSE_FILE=/部署目录/compose.yml`，确保使用相同数据和项目。纯镜像部署升级时更新 `.env` 中的版本，执行 `docker compose pull`、`docker compose up -d --no-build`；保持同一数据目录。也可用上述环境变量调用 `manage.sh upgrade`。离线部署仍可 `docker save` / `load`。

镜像构建后，`sudo bash deploy/test.sh` 可运行不调用模型的隔离部署回归；占用测试端口 19871..19874，创建临时数据并在结束时回收。不会改既有服务；测试数据被删除，不用来测试生产数据。

`bash deploy/test-scripts.sh` 使用模拟 Docker 和网络验证部署脚本；Linux 上另测无源码安装与重复升级。`sudo bash deploy/test-image.sh` 用真实容器和临时本地注册表验证拉取、失败时保留原配置、换容器、重复启动，以及合成旧数据的启动迁移。它检查镜像不含桌面安装包，测试不使用真实账号；合成数据测试不代表所有历史部署都已实测。这两类检查已加入 CI。

备份先停服务保证 SQLite / WAL 与原生数据一致，结束后恢复之前运行状态；排除临时 SSH 凭据、缓存和升级时留下的会话库副本（`state/backups`）。备份**含 token、API / 账号秘密、证书私钥和历史**，权限 0600，需安全离线保存。恢复仅允许已 stop 且长期数据为空的新初始化部署：

```sh
sudo bash deploy/manage.sh restore /secure/backup.tar.gz
# 核对 config/service.env 中 public host 与证书设置，docker.env 中 URL / 端口。
sudo bash deploy/manage.sh up
```

恢复只接受自己可信的备份，不执行未知归档。卸载仅删除容器与网络，保留数据、配置、镜像和宿主 Docker；要永久删除数据必须由用户确认准确目录后单独删除，不自动卸载其他程序依赖的 Docker。

自签续期：`manage.sh renew`，重启后重新交付客户端指纹。真实证书续期：`manage.sh certificate FULLCHAIN KEY`；可在既有 ACME deploy hook 中调用。nginx 的证书由既有 ACME / nginx 续期流程处理，无需重建容器。替换会断开在途会话，先结束任务。

原生开发部署仍有 `scripts/install-linux.sh` 与 `scripts/deploy-linux.mjs`，目前为普通用户 nohup 调试方式，不是生产部署方案。
