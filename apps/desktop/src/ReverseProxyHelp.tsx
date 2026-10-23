import { useState } from 'react';
import { ChevronRight, Copy } from 'lucide-react';
import type { WebCertificateState } from '@cc-desk-tunnel/protocol';
import { IconButton } from './ui.tsx';
import { copyText } from './copy.tsx';
import { proxyCertificateName, proxyConfiguration, proxyUpstream } from './reverse-proxy.ts';

export default function ReverseProxyHelp({
  connectionUrl,
  publicOrigin,
  path,
  certificate,
}: {
  connectionUrl: string;
  publicOrigin: string;
  path: string;
  certificate: WebCertificateState | null;
}) {
  const [kind, setKind] = useState<'nginx' | 'caddy'>('nginx');
  const [upstream, setUpstream] = useState(() => proxyUpstream(connectionUrl));
  const [serverName, setServerName] = useState(() =>
    proxyCertificateName(connectionUrl, certificate),
  );
  const [trustFile, setTrustFile] = useState('/etc/cc-desk-tunnel/upstream.pem');
  const httpUpstream = upstream.startsWith('http://');
  const [copyState, setCopyState] = useState({ config: '', message: '' });
  let config = '';
  let error = '';
  try {
    config = proxyConfiguration(kind, { publicOrigin, path, upstream, serverName, trustFile });
  } catch (reason) {
    error = reason instanceof Error ? reason.message : '请检查配置。';
  }
  async function copy() {
    try {
      await copyText(config);
      setCopyState({ config, message: '配置已复制' });
    } catch {
      setCopyState({ config, message: '复制失败，请选中下方配置手动复制。' });
    }
  }
  return (
    <details className="web-proxy-help">
      <summary>
        反向代理配置示例 <ChevronRight />
      </summary>
      <div className="web-proxy-fields">
        <p className="muted">
          先保存 Web 对外地址与路径，再在反代机器部署配置。以下字段仅用于生成示例，不修改服务端。
        </p>
        <label>
          上游地址
          <input
            value={upstream}
            onChange={(event) => setUpstream(event.target.value)}
            placeholder="https://127.0.0.1:8787"
            spellCheck={false}
          />
          <small className="muted">
            仅按桌面连接提供示例，请改为反代机器可达的后端地址。此处不是 Web
            对外地址，避免填入反代入口造成循环。
          </small>
        </label>
        {!httpUpstream && (
          <>
            <label>
              上游证书校验名
              <input
                value={serverName}
                onChange={(event) => setServerName(event.target.value)}
                spellCheck={false}
              />
              <small className="muted">
                必须与上游证书 SAN 中的 DNS 名称一致；默认部署自签名为 cc-desk-tunnel.local。
              </small>
            </label>
            <label>
              受信任 PEM 文件
              <input
                value={trustFile}
                onChange={(event) => setTrustFile(event.target.value)}
                spellCheck={false}
              />
              <small className="muted">
                填反代机器上的文件路径。自签名使用证书本身；CA 签发的证书使用对应的根 CA 信任文件。
              </small>
            </label>
            <details className="web-proxy-trust">
              <summary>如何准备信任文件</summary>
              <p className="muted">
                从部署机器安全复制公开证书，不复制私钥。默认 Docker
                自签名部署可导出下列文件；若更改过数据目录或证书，请使用实际文件。
              </p>
              <pre>
                <code>
                  openssl x509 -in /srv/cc-desk-tunnel/tls/control.crt -out upstream.pem{'\n'}
                  openssl x509 -in upstream.pem -noout -ext subjectAltName -fingerprint -sha256
                </code>
              </pre>
              <p className="muted">
                核对 SAN 和桌面连接的 SHA-256 指纹后，将 upstream.pem
                安全复制到上方路径，并允许反代进程读取。指纹只用于核对，不能替代 PEM
                文件。自签名证书更新后需同步信任文件。
              </p>
            </details>
          </>
        )}
        <div className="web-proxy-toolbar">
          <div className="segmented" aria-label="反向代理软件">
            {(['nginx', 'caddy'] as const).map((value) => (
              <button
                type="button"
                key={value}
                aria-pressed={kind === value}
                onClick={() => {
                  setKind(value);
                }}
              >
                {value === 'nginx' ? 'NGINX' : 'Caddy'}
              </button>
            ))}
          </div>
          <IconButton title="复制反代配置" disabled={!config} onClick={() => void copy()}>
            <Copy />
          </IconButton>
        </div>
        {error ? (
          <p className="muted">{error}</p>
        ) : (
          <pre aria-label="反代配置">
            <code>{config}</code>
          </pre>
        )}
        {config && copyState.config === config && <small role="status">{copyState.message}</small>}
        <p className="muted">
          {kind === 'nginx'
            ? '替换域名证书与私钥路径，执行 nginx -t 后再重载。'
            : 'Caddy 管理公网域名证书；执行 caddy validate --config Caddyfile 后再重载。'}
          {httpUpstream
            ? 'HTTP 仅用于反代到上游的连接，公网入口仍使用 HTTPS。'
            : 'HTTPS 上游会校验证书，不关闭 TLS 校验。'}
          示例保留访问路径，并转发桌面连接和安装包入口。需要区分访客 IP 时，再开启「识别真实访客
          IP」并检测代理来源，核对后保存；关闭不影响反代访问。
        </p>
      </div>
    </details>
  );
}
