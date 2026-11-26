import { useState } from 'react';
import { ChevronRight, Copy } from 'lucide-react';
import type { WebCertificateState } from '@cc-desk-tunnel/protocol';
import { useT } from './i18n.ts';
import { IconButton } from './ui.tsx';
import { copyText } from './copy.tsx';
import { proxyCertificateName, proxyConfiguration, proxyUpstream } from './reverse-proxy.ts';

export default function ReverseProxyHelp({
  connectionUrl,
  domain,
  path,
  certificate,
}: {
  connectionUrl: string;
  domain: string;
  path: string;
  certificate: WebCertificateState | null;
}) {
  const t = useT();
  const [kind, setKind] = useState<'nginx' | 'caddy'>('nginx');
  const [upstream, setUpstream] = useState(() => proxyUpstream(connectionUrl));
  const [serverName, setServerName] = useState(() =>
    proxyCertificateName(connectionUrl, certificate),
  );
  const [trustFile, setTrustFile] = useState('/etc/cc-desk-tunnel/upstream.pem');
  const [copyState, setCopyState] = useState({ config: '', message: '' });
  let config = '';
  let error = '';
  try {
    config = proxyConfiguration(kind, { domain, path, upstream, serverName, trustFile });
  } catch (reason) {
    error = reason instanceof Error ? reason.message : t('settings:proxy.checkConfig');
  }
  async function copy() {
    try {
      await copyText(config);
      setCopyState({ config, message: t('settings:proxy.copied') });
    } catch {
      setCopyState({ config, message: t('settings:proxy.copyFailed') });
    }
  }
  return (
    <details className="web-proxy-help">
      <summary>
        {t('settings:proxy.heading')} <ChevronRight />
      </summary>
      <div className="web-proxy-fields">
        <p className="muted">{t('settings:proxy.intro')}</p>
        <label>
          {t('settings:proxy.upstream')}
          <input
            value={upstream}
            onChange={(event) => setUpstream(event.target.value)}
            placeholder="https://127.0.0.1:8787"
            spellCheck={false}
          />
          <small className="muted">{t('settings:proxy.upstreamHint')}</small>
        </label>
        <label>
          {t('settings:proxy.name')}
          <input
            value={serverName}
            onChange={(event) => setServerName(event.target.value)}
            spellCheck={false}
          />
          <small className="muted">{t('settings:proxy.nameHint')}</small>
        </label>
        <label>
          {t('settings:proxy.trustFile')}
          <input
            value={trustFile}
            onChange={(event) => setTrustFile(event.target.value)}
            spellCheck={false}
          />
          <small className="muted">{t('settings:proxy.trustFileHint')}</small>
        </label>
        <details className="web-proxy-trust">
          <summary>{t('settings:proxy.prepare')}</summary>
          <p className="muted">{t('settings:proxy.prepareIntro')}</p>
          <pre>
            <code>
              openssl x509 -in /srv/cc-desk-tunnel/tls/control.crt -out upstream.pem{'\n'}openssl
              x509 -in upstream.pem -noout -ext subjectAltName -fingerprint -sha256
            </code>
          </pre>
          <p className="muted">{t('settings:proxy.prepareCheck')}</p>
        </details>
        <div className="web-proxy-toolbar">
          <div className="segmented" aria-label={t('settings:proxy.software')}>
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
          <IconButton
            title={t('settings:proxy.copy')}
            disabled={!config}
            onClick={() => void copy()}
          >
            <Copy />
          </IconButton>
        </div>
        {error ? (
          <p className="muted">{error}</p>
        ) : (
          <pre aria-label={t('settings:proxy.config')}>
            <code>{config}</code>
          </pre>
        )}
        {config && copyState.config === config && <small role="status">{copyState.message}</small>}
        <p className="muted">
          {kind === 'nginx' ? t('settings:proxy.nginxHint') : t('settings:proxy.caddyHint')}
          {t('settings:proxy.safety')}
        </p>
      </div>
    </details>
  );
}
