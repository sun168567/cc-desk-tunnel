# 用 nginx 反代

服务器上已经有 nginx 和域名证书时，可以让客户端经 `wss://你的域名/ws` 连接：TLS 由 nginx 负责，客户端按正常的 CA 与域名校验证书，不需要填指纹，也不必额外放行控制端口。没有域名或没有 nginx 时用默认的自签证书方式即可，不需要看这一页。

## 结构

```text
客户端 ── wss://proxy.example.com/ws（443）──▶ nginx ── http://127.0.0.1:8787 ──▶ 容器
客户端 ── proxy.example.com:7000（frp，TLS）──────────────────────────────────▶ 容器
```

- **经过 nginx 的只有控制通道**：`/ws`（登录与对话）、`/client/installer`（客户端升级下载）和可选的 `/health`。
- **隧道端口不经过 nginx**。frp 使用自己的 TLS，客户端直接连接服务器的隧道端口（默认 7000），防火墙仍需放行它。
- nginx 模式下容器的 8787 只发布在服务器的 `127.0.0.1`，公网无法直接访问。

## 第一步：以 nginx 模式安装

交互安装时，入口方式选 **3**，然后填域名和客户端使用的地址（默认 `wss://域名/ws`）。用参数安装时：

```sh
sudo bash deploy/manage.sh init --host proxy.example.com --mode nginx \
  --url wss://proxy.example.com/ws --data /srv/cc-desk-tunnel
sudo bash deploy/manage.sh build
sudo bash deploy/manage.sh up
```

- `--host` 是客户端连接隧道端口时使用的地址，必须直接解析到这台服务器。
- `--url` 是客户端填写的服务地址。nginx 不在 443 端口时写成 `wss://proxy.example.com:8443/ws`。
- 路径固定为域名根下的 `/ws` 和 `/client/installer`，不支持放到子路径里。

## 第二步：配置 nginx

完整示例见 [`nginx.conf.example`](nginx.conf.example)。先把 `map` 放进 `http` 上下文（通常是 `/etc/nginx/conf.d/` 下的一个文件）：

```nginx
map $http_upgrade $cc_desk_tunnel_connection {
    default upgrade;
    '' close;
}
```

再在域名对应的 `server` 块里加入：

```nginx
location = /ws {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $cc_desk_tunnel_connection;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    proxy_buffering off;
}
location = /client/installer {
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_buffering off;
}
location = /health {
    proxy_pass http://127.0.0.1:8787;
}
```

各项的作用：

| 配置 | 为什么需要 |
| --- | --- |
| `proxy_http_version 1.1` 与 `Upgrade` / `Connection` | WebSocket 握手依赖它们，缺少时连接无法建立 |
| `X-Real-IP $remote_addr` | 服务端按来源地址做登录限速。缺少这一行时所有客户端共用一个计数，一处输错凭据会连累全部 |
| 两个 3600s 超时 | nginx 默认 60 秒没有数据就断开，长时间等待模型回复时会掉线 |
| `proxy_buffering off` | 流式输出和安装包下载不在 nginx 里积压 |
| `/client/installer` | 客户端一键升级从这里下载安装包；缺少时升级报下载失败 |
| `/health` | 可选，只返回运行状态，方便自己检查 |

- **与现有网站共用域名**：只需把这三个 `location` 加进现有的 `server` 块。它们是精确匹配，不影响其他路径。
- **单独的域名**：按示例新建一个 `server` 块，其余路径返回 404。
- 证书的申请和续期由你现有的方式负责（例如 certbot），本项目不处理；续期后照常 `nginx -s reload`，不需要重启容器。

检查并重新加载：

```sh
sudo nginx -t && sudo nginx -s reload
```

## 第三步：检查

在任意一台机器上：

```sh
# 应返回 {"status":"ok",...}
curl https://proxy.example.com/health

# 应返回 HTTP/1.1 101 Switching Protocols（随后按 Ctrl+C 结束）
curl -i -N --http1.1 https://proxy.example.com/ws \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: SGVsbG8sIHdvcmxkIQ=='
```

然后在客户端填写：服务地址 `wss://proxy.example.com/ws`，证书指纹**留空**，服务凭据见 `sudo bash deploy/manage.sh summary`。

## 防火墙

| 端口 | 是否放行 |
| --- | --- |
| nginx 的 443/TCP（或你使用的端口） | 放行 |
| 隧道端口（默认 7000/TCP） | 放行 |
| 8787 | 不需要；它只监听服务器本机 |

## 常见问题

| 现象 | 多半的原因 |
| --- | --- |
| 客户端提示连接失败，`curl` 检查 `/ws` 返回 400 或 404 | 缺少 `Upgrade` / `Connection` 两行或 `map`，或 `location` 没有写在正确的 `server` 块里 |
| 返回 502 | 容器没有运行，或控制端口不是 8787。用 `manage.sh status` 查看，端口见部署配置里的 `CONTROL_PORT` |
| 证书错误 | 客户端的指纹一栏没有留空；或 nginx 用的不是完整证书链（应使用 `fullchain.pem`） |
| 能登录，但提示 Windows SSH 连接准备超时 | 隧道端口没有放行，或域名没有直接解析到这台服务器 |
| 空闲一会儿就断开 | 缺少两个超时设置 |
| 所有设备同时被提示“登录失败次数过多” | 缺少 `X-Real-IP` |
| 客户端升级时下载失败 | 缺少 `/client/installer` |

## 关于 CDN

不建议把这个域名放到 CDN 或其他第三方代理后面：对方能看到包括服务凭据在内的全部内容，隧道端口也无法经由它转发，登录限速看到的还会是 CDN 的地址。域名直接解析到服务器即可。

## 已有部署改用 nginx

入口方式在初始化时确定，没有专门的切换命令。需要切换时先备份（`manage.sh backup`），然后修改两个文件并重建容器：

- 部署配置（默认 `.local/docker.env`）：`MODE='nginx'`、`CONTROL_BIND='127.0.0.1'`、`CONNECTION_URL='wss://proxy.example.com/ws'`。
- `<数据目录>/config/service.env`：`PROXY_TLS_MODE='reverse-proxy'`；`PROXY_PUBLIC_HOST` 改成域名或保持原来的公网 IP 均可。

```sh
sudo bash deploy/manage.sh up
sudo bash deploy/manage.sh summary
```

客户端随后改填新的服务地址，并清空证书指纹。
