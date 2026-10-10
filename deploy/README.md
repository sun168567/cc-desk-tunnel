# Linux Docker 部署

Ubuntu amd64 优先。官方 Claude Code、Agent SDK、PTY 同容器；不改 Claude 本体、不加入执行 MCP。容器有可写层和较完整工具环境，不是只读沙箱；以 uid 1000 普通用户运行，无宿主 Docker socket、特权模式或宿主项目挂载。

## 准备

最省事的方式是一条命令。脚本检查 Docker 等依赖（缺少时给出安装命令，不代为安装），从发布页下载最新的服务端程序包并校验，解压到 `/opt/cc-desk-tunnel`，随后进入下面的交互安装；已有部署时改为询问是否升级。程序目录可用环境变量 `CC_DESK_TUNNEL_DIR` 更改。

```sh
sudo bash -c "$(curl -fsSL https://raw.githubusercontent.com/sun168567/cc-desk-tunnel/main/deploy/install.sh)"
```

目前不提供现成镜像：镜像在你的服务器上从程序包构建，首次需要几分钟，期间联网下载系统包、Node.js、Claude Code 和 npm 依赖。

也可以手动准备：从项目的 GitHub 发布页取同一版本的三个文件：服务端程序包 `cc-desk-tunnel-server-X.Y.Z.tar.gz`、Windows 安装包 `CC-Desk-Tunnel-Setup-X.Y.Z-x64.exe` 和 `SHA256SUMS`。放到 VPS 的同一目录后先校验，再把程序包解压到专用程序目录：

```sh
sha256sum -c SHA256SUMS
sudo mkdir -p /opt/cc-desk-tunnel
sudo tar -xzf cc-desk-tunnel-server-X.Y.Z.tar.gz -C /opt/cc-desk-tunnel
cd /opt/cc-desk-tunnel
```

程序包不含秘密、Windows UI、开发测试和依赖。也可以自己打包：本机运行 `npm run package:server`，或直接使用完整仓库。

交互安装：不带参数运行，脚本依次询问公网地址（默认自动探测）、入口方式、端口、数据目录和服务凭据（留空自动生成），随后自动构建、启动，并在结尾汇总客户端要填的地址 / 指纹 / 凭据、需放行的端口和下一步。已有部署配置时跳过问答，只重新构建启动。

```sh
sudo bash deploy/install.sh
```

升级与客户端分发：

```sh
# 原地升级：解包新的源码包覆盖程序目录，重建镜像并替换容器；数据、账号和配置不动
sudo bash deploy/manage.sh upgrade --from /path/cc-desk-tunnel-server.tar.gz
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

- 菜单出现“升级服务端到 x.y.z”：确认后服务端下载程序包并按清单校验、安装依赖、取回同版本的客户端安装包，然后重启，全程几分钟；重启后重新连接，客户端按提示升级自己。运行中的任务、原生终端或账号登录未结束时不能开始升级。
- 菜单显示“服务端 x.y.z 需在服务器上升级”：新版本需要更新的镜像（Node.js 或系统组件有变化），仍用上面的 `manage.sh upgrade --from`。

升级后的程序放在数据目录的 `program/` 下，镜像不变。容器启动时比较两处的版本，运行较新的一个：重建或替换容器不会回到旧版本，用更新的程序包重建镜像后则以镜像为准。升级后的程序连续三次启动失败时退回镜像里的版本，日志里有一行说明。失败的升级不改动正在运行的程序，原因显示在客户端。

改为跟踪自己的私有仓库（例如私有的 fork）时，服务端需要一个只读令牌才能读取发布页：在 GitHub 创建只授权该仓库、Contents 只读的细粒度令牌，存成 VPS 上的一个文件后执行下面的命令，随后删除该文件。令牌只保存在数据目录的 `config/service.env`（0600），不会传给客户端或 Claude Code。

```sh
sudo bash deploy/manage.sh release-token /path/token.txt   # 不带参数则移除
```

跟踪的仓库可在 `config/service.env` 里用 `PROXY_RELEASE_REPO='所有者/仓库'` 更改，设为 `none` 则不查询也不提供升级。容器没有宿主 Docker 的控制权，替换镜像始终要在宿主上执行。

同时进行的运行和终端有上限，默认按服务器内存估算（每个约占 300 MB，1 GB 内存的服务器是 2 个）。要改就在 `config/service.env` 里加 `PROXY_MAX_RUNS='数量'` 并重启服务。

需要脚本化或分步执行时仍可用参数形式：

```sh
sudo bash deploy/install.sh init --host VPS_IP
# 上一步打印数据目录；默认 sudo 安装为 /srv/cc-desk-tunnel
# 按需编辑 <数据目录>/config/provider.json，不把 API key 放进镜像。
sudo bash deploy/manage.sh build
sudo bash deploy/manage.sh up
sudo bash deploy/manage.sh connection
```

`install.sh` 只检查 Docker / Compose 等依赖，缺少或 Docker 未运行时给出安装命令后退出；不安装系统软件，不修改 nginx、防火墙、SSH 或账号。首次构建联网下载系统包、固定 Node / CLI 和锁定 npm 依赖；非 JS 编译安装，node-pty 在镜像构建阶段准备。Node 24 原生执行 TypeScript；发行检查仍必须 typecheck。

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

升级先构建新镜像，构建失败不停止旧容器；成功后替换容器，数据保留。上线前先 backup；可将旧镜像另行打 tag，并在私有 `docker.env` 中设置 `PROXY_IMAGE`，`up` 切回。镜像可 `docker save` 后在 VPS `docker load`，无需 VPS 重建；当前无公共镜像注册表，不假称可直接 pull 产品镜像。

仅导入镜像、手工 Compose 管理时，使用 `deploy/compose.yml`（无 build）。在独立部署目录复制为 `compose.yml`，将初始化生成的 `docker.env` 复制为同目录 `.env`，确认 `PROXY_IMAGE` 为已导入 tag；该配置不含 token / API key，但目录和文件仍保持私有。运行 `sudo docker compose up -d` / `ps` / `logs` / `stop`。调用备份等脚本时设置 `PROXY_DEPLOY_CONFIG=/部署目录/.env`、`PROXY_COMPOSE_FILE=/部署目录/compose.yml`，确保使用相同数据和项目。纯镜像部署升级使用 `docker load`、更新 tag、`docker compose up -d`，不用 `manage.sh build` / `upgrade`。

镜像构建后，`sudo bash deploy/test.sh` 可运行不调用模型的隔离部署回归；占用测试端口 19871..19874，创建临时数据并在结束时回收。不会改既有服务；测试数据被删除，不用来测试生产数据。

备份先停服务保证 SQLite / WAL 与原生数据一致，结束后恢复之前运行状态；排除临时 SSH 凭据及缓存。备份**含 token、API / 账号秘密、证书私钥和历史**，权限 0600，需安全离线保存。恢复仅允许已 stop 且长期数据为空的新初始化部署：

```sh
sudo bash deploy/manage.sh restore /secure/backup.tar.gz
# 核对 config/service.env 中 public host 与证书设置，docker.env 中 URL / 端口。
sudo bash deploy/manage.sh up
```

恢复只接受自己可信的备份，不执行未知归档。卸载仅删除容器与网络，保留数据、配置、镜像和宿主 Docker；要永久删除数据必须由用户确认准确目录后单独删除，不自动卸载其他程序依赖的 Docker。

自签续期：`manage.sh renew`，重启后重新交付客户端指纹。真实证书续期：`manage.sh certificate FULLCHAIN KEY`；可在既有 ACME deploy hook 中调用。nginx 的证书由既有 ACME / nginx 续期流程处理，无需重建容器。替换会断开在途会话，先结束任务。

原生开发部署仍有 `scripts/install-linux.sh` 与 `scripts/deploy-linux.mjs`，目前为普通用户 nohup 调试方式，不是生产部署方案。
