import { webDomainSchema, webPathSchema, webPublicOriginSchema } from '@cc-desk-tunnel/protocol';
import type { WebCertificateState } from '@cc-desk-tunnel/protocol';

export type ProxyConfiguration = {
  publicOrigin: string;
  path: string;
  upstream: string;
  serverName: string;
  trustFile: string;
};

// The saved desktop address, not the Web public URL (which may already name this proxy).
export function proxyUpstream(connectionUrl: string) {
  try {
    const url = new URL(connectionUrl);
    if (!['ws:', 'wss:', 'http:', 'https:'].includes(url.protocol) || url.username || url.password)
      return '';
    return `${url.protocol === 'ws:' || url.protocol === 'http:' ? 'http:' : 'https:'}//${url.host}`;
  } catch {
    return '';
  }
}

export function proxyCertificateName(
  connectionUrl: string,
  certificate: WebCertificateState | null,
) {
  if (certificate?.details?.domain) return certificate.details.domain;
  // Both managed deployment scripts use this SAN for their default self-signed certificate.
  if (certificate?.mode === 'default' && certificate.selfSigned) return 'cc-desk-tunnel.local';
  try {
    const hostname = new URL(connectionUrl).hostname;
    return hostname.includes(':') || !/[a-z]/i.test(hostname) ? '' : hostname;
  } catch {
    return '';
  }
}

export function proxyConfiguration(kind: 'nginx' | 'caddy', values: ProxyConfiguration) {
  const publicOrigin = webPublicOriginSchema.safeParse(values.publicOrigin);
  if (!publicOrigin.success || !publicOrigin.data)
    throw new Error('请先填写有效的 Web 对外地址，再生成反代配置。');
  const publicUrl = new URL(publicOrigin.data);
  const domain = webDomainSchema.safeParse(publicUrl.hostname);
  if (!domain.success || !domain.data) throw new Error('域名反代示例需要使用域名的 Web 对外地址。');
  const path = webPathSchema.safeParse(values.path);
  if (!path.success) throw new Error('请先修正服务端访问路径。');
  // Reject configuration metacharacters before URL normalization can remove them.
  if (!/^https?:\/\/[a-zA-Z0-9.:[\]-]+\/?$/.test(values.upstream))
    throw new Error('上游地址应为 HTTP 或 HTTPS 地址，不含路径、凭据或查询参数。');
  let upstream: URL;
  try {
    upstream = new URL(values.upstream);
  } catch {
    throw new Error('请填写有效的上游 HTTP 或 HTTPS 地址。');
  }
  const tls = upstream.protocol === 'https:';
  const serverName = values.serverName.trim().toLowerCase();
  if (
    tls &&
    (serverName.length > 253 ||
      !/[a-z]/.test(serverName) ||
      !serverName.split('.').every((part) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part)))
  )
    throw new Error('证书校验名应为证书 SAN 中的 DNS 名称，不含协议或端口。');
  const trustFile = values.trustFile.trim();
  if (tls && !/^\/(?:[a-zA-Z0-9._-]+\/)*[a-zA-Z0-9._-]+$/.test(trustFile))
    throw new Error('请填写反代机器上的 PEM 绝对路径，仅使用字母、数字、点、横线和下划线。');
  const prefix = path.data ? `/${path.data}/` : '/';
  if (kind === 'caddy')
    return `https://${publicUrl.host} {
${path.data ? `    redir /${path.data} /${path.data}/?{query} 308\n` : ''}    @web path ${path.data ? `/${path.data}/* /ws /client/installer` : '/*'}
    handle @web {
        reverse_proxy ${upstream.origin} {
            header_up Host {hostport}
            header_up X-Real-IP {remote_host}
${
  tls
    ? `            transport http {
                tls_server_name ${serverName}
                tls_trust_pool file ${trustFile}
            }
`
    : ''
}        }
    }
    handle {
        respond 404
    }
}
`;
  return `# Place this in the http context (for example, conf.d/cc-desk-tunnel.conf).
map $http_upgrade $cc_web_connection {
    default upgrade;
    '' close;
}

server {
    listen ${publicUrl.port || '443'} ssl;
    server_name ${domain.data};
    # Replace these with the public domain's certificate and private key.
    ssl_certificate /etc/nginx/tls/fullchain.pem;
    ssl_certificate_key /etc/nginx/tls/privkey.pem;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $cc_web_connection;
${
  tls
    ? `    proxy_ssl_server_name on;
    proxy_ssl_name ${serverName};
    proxy_ssl_trusted_certificate ${trustFile};
    proxy_ssl_verify on;
    proxy_ssl_verify_depth 4;
`
    : ''
}    proxy_buffering off;
    proxy_read_timeout 3600s;
${
  path.data
    ? `
    location = /${path.data} { return 308 ${prefix}$is_args$args; }
    location = /ws { proxy_pass ${upstream.origin}; }
    location = /client/installer { proxy_pass ${upstream.origin}; }
`
    : ''
}
    location ${path.data ? '^~ ' : ''}${prefix} {
        proxy_pass ${upstream.origin};
    }${path.data ? '\n\n    location / { return 404; }' : ''}
}
`;
}
