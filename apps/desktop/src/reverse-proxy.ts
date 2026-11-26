import { t } from './i18n.ts';
import { webDomainSchema, webPathSchema } from '@cc-desk-tunnel/protocol';
import type { WebCertificateState } from '@cc-desk-tunnel/protocol';

export type ProxyConfiguration = {
  domain: string;
  path: string;
  upstream: string;
  serverName: string;
  trustFile: string;
};

// The saved desktop address, not the Web public URL (which may already name this proxy).
export function proxyUpstream(connectionUrl: string) {
  try {
    const url = new URL(connectionUrl);
    if (!['wss:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
    return `https://${url.host}`;
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
  const domain = webDomainSchema.safeParse(values.domain);
  if (!domain.success || !domain.data) throw new Error(t('settings:proxy.domainFirst'));
  const path = webPathSchema.safeParse(values.path);
  if (!path.success) throw new Error(t('settings:proxy.pathFirst'));
  // Reject configuration metacharacters before URL normalization can remove them.
  if (!/^https:\/\/[a-zA-Z0-9.:[\]-]+\/?$/.test(values.upstream))
    throw new Error(t('settings:proxy.upstreamForm'));
  let upstream: URL;
  try {
    upstream = new URL(values.upstream);
  } catch {
    throw new Error(t('settings:proxy.upstreamInvalid'));
  }
  const serverName = values.serverName.trim().toLowerCase();
  if (
    serverName.length > 253 ||
    !/[a-z]/.test(serverName) ||
    !serverName.split('.').every((part) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part))
  )
    throw new Error(t('settings:proxy.nameForm'));
  const trustFile = values.trustFile.trim();
  if (!/^\/(?:[a-zA-Z0-9._-]+\/)*[a-zA-Z0-9._-]+$/.test(trustFile))
    throw new Error(t('settings:proxy.trustFileForm'));
  const prefix = path.data ? `/${path.data}/` : '/';
  if (kind === 'caddy')
    return `${domain.data} {
${path.data ? `    redir /${path.data} /${path.data}/?{query} 308\n` : ''}    @web path ${path.data ? `/${path.data}/*` : '/*'}
    handle @web {
        reverse_proxy ${upstream.origin} {
            header_up Host {hostport}
            header_up X-Real-IP {remote_host}
            transport http {
                tls_server_name ${serverName}
                tls_trust_pool file ${trustFile}
            }
        }
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
    listen 443 ssl;
    server_name ${domain.data};
    # Replace these with the public domain's certificate and private key.
    ssl_certificate /etc/nginx/tls/fullchain.pem;
    ssl_certificate_key /etc/nginx/tls/privkey.pem;
${
  path.data
    ? `
    location = /${path.data} { return 308 ${prefix}$is_args$args; }
`
    : ''
}
    location ${path.data ? '^~ ' : ''}${prefix} {
        proxy_pass ${upstream.origin};
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $cc_web_connection;
        proxy_ssl_server_name on;
        proxy_ssl_name ${serverName};
        proxy_ssl_trusted_certificate ${trustFile};
        proxy_ssl_verify on;
        proxy_ssl_verify_depth 4;
        proxy_buffering off;
        proxy_read_timeout 3600s;
    }${path.data ? '\n\n    location / { return 404; }' : ''}
}
`;
}
