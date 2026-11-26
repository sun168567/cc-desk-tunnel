import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { ChevronRight, Copy, ExternalLink, RotateCcw, Trash2 } from 'lucide-react';
import type {
  WebCertificateState,
  WebProof,
  WebSettingsState,
  WebTotpSetup,
} from '@cc-desk-tunnel/protocol';
import { wordsText } from '@cc-desk-tunnel/i18n';
import { localeOf, t as say, useT } from './i18n.ts';
import type { ProxyClient } from './client.ts';
import { IconButton, Modal, Row, Switch } from './ui.tsx';
import { CopyButton } from './copy.tsx';
import ReverseProxyHelp from './ReverseProxyHelp.tsx';

const message = (error: unknown) =>
  error instanceof Error ? error.message : say('settings:web.requestFailed');

// The service token, and the current authenticator code once two-step verification is on.
function ProofFields({
  proof,
  change,
  totp,
}: {
  proof: WebProof;
  change: (value: WebProof) => void;
  totp: boolean;
}) {
  const t = useT();
  return (
    <>
      <label>
        {t('settings:web.credential')}
        <input
          type="password"
          autoComplete="current-password"
          required
          value={proof.password}
          onChange={(event) => change({ ...proof, password: event.target.value })}
        />
      </label>
      {totp && (
        <label>
          {t('settings:web.currentCode')}
          <input
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            required
            value={proof.code ?? ''}
            onChange={(event) => change({ ...proof, code: event.target.value })}
          />
        </label>
      )}
    </>
  );
}
function useSubmit() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function run(task: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await task();
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, setError, run };
}
function DialogForm({
  title,
  busy,
  error,
  submit,
  submitLabel,
  close,
  children,
}: {
  title: string;
  busy: boolean;
  error: string;
  submit: () => void;
  submitLabel?: string;
  close: () => void;
  children: ReactNode;
}) {
  const t = useT();
  return (
    <Modal
      title={title}
      onClose={() => {
        if (!busy) close();
      }}
    >
      <form
        className="web-settings-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy) submit();
        }}
      >
        <fieldset disabled={busy}>{children}</fieldset>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="button" disabled={busy} onClick={close}>
            {t('common:cancel')}
          </button>
          <button className="button primary" disabled={busy}>
            {submitLabel ?? (busy ? t('settings:web.saving') : t('settings:web.confirm'))}
          </button>
        </div>
      </form>
    </Modal>
  );
}
export function displayWebAddress(value: string) {
  try {
    const url = new URL(value);
    const path = url.pathname.replace(/^\//, '').replace(/\/$/, '');
    return `${url.origin}/${path.length > 5 ? `${path.slice(0, 5)}…` : path}`;
  } catch {
    return value;
  }
}

type Dialog = 'access' | 'totp' | 'disable' | 'certificate' | 'reset' | { revoke: string };

// The Web entry of the service this window is connected to. Its state lives here, not in ProxyClient; a
// connection that ends or changes closes the dialogs and forgets what was typed into them.
export default function WebAccessSettings({
  client,
  browser,
  connectionUrl = '',
}: {
  client: ProxyClient;
  browser: boolean;
  connectionUrl?: string;
}) {
  const t = useT();
  const connection = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const [values, setValues] = useState<WebSettingsState | null>(null);
  const [certificate, setCertificate] = useState<WebCertificateState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const generation = useRef(0);
  const connected = connection.status === 'connected';
  async function load() {
    const current = ++generation.current;
    setBusy(true);
    setError('');
    try {
      const result = await client.fetch({ type: 'web.settings.get' });
      if (current !== generation.current) return;
      setValues(result.values);
      if (!browser) {
        const cert = await client.fetch({ type: 'web.certificate.get' });
        if (current === generation.current) setCertificate(cert);
      }
    } catch (error) {
      if (current === generation.current) setError(message(error));
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }
  useEffect(() => {
    setValues(null);
    setCertificate(null);
    setDialog(null);
    if (connected) void load();
    return () => {
      generation.current++;
    };
  }, [connection.connectionId, connected, client, browser]);
  async function toggle(enabled: boolean) {
    const current = generation.current;
    setBusy(true);
    setError('');
    try {
      const result = await client.fetch({ type: 'web.settings.update', values: { enabled } });
      if (current === generation.current) setValues(result.values);
    } catch (error) {
      if (current === generation.current) setError(message(error));
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }
  async function copy(text: string) {
    try {
      if (window.desktop) await window.desktop.copyText(text);
      else await navigator.clipboard.writeText(text);
    } catch {
      setError(t('settings:web.copyFailed'));
    }
  }
  async function open(url: string) {
    try {
      if (window.desktop) await window.desktop.openWeb(url);
      else window.open(url, '_blank', 'noopener,noreferrer');
    } catch {
      setError(t('settings:web.openFailed'));
    }
  }
  if (!connected) return <p className="muted">{t('settings:web.connectFirst')}</p>;
  const close = () => setDialog(null);
  const own = connection.browser?.sessionId;
  const expires =
    certificate?.details &&
    Math.ceil((Date.parse(certificate.details.validTo) - Date.now()) / 86400000);
  return (
    <>
      <div className="card web-access-settings" aria-busy={busy}>
        {!values ? (
          <Row title={busy ? t('settings:web.reading') : t('settings:web.readFailed')}>
            <button className="button" disabled={busy} onClick={() => void load()}>
              {t('common:retry')}
            </button>
          </Row>
        ) : (
          <>
            {!browser && (
              <Row title={t('settings:web.enable')} detail={t('settings:web.enableDetail')}>
                <Switch
                  label={t('settings:web.enable')}
                  checked={values.enabled}
                  disabled={busy}
                  onChange={(enabled) => void toggle(enabled)}
                />
              </Row>
            )}
            {values.enabled && (
              <>
                <Row title={t('settings:web.address')}>
                  <div className="web-row-actions">
                    {values.url ? (
                      <>
                        <span className="web-access-address" title={values.url}>
                          {displayWebAddress(values.url)}
                        </span>
                        <IconButton
                          title={t('settings:web.copyAddress')}
                          onClick={() => void copy(values.url!)}
                          disabled={busy}
                        >
                          <Copy />
                        </IconButton>
                        <IconButton
                          title={t('settings:web.openAddress')}
                          onClick={() => void open(values.url!)}
                          disabled={busy}
                        >
                          <ExternalLink />
                        </IconButton>
                      </>
                    ) : (
                      <span className="muted">{t('settings:web.addressNotReady')}</span>
                    )}
                  </div>
                </Row>
                <Row
                  title={t('settings:web.access')}
                  detail={values.domain || t('settings:web.deployAddress')}
                >
                  <button className="button" disabled={busy} onClick={() => setDialog('access')}>
                    {t('settings:web.set')}
                  </button>
                </Row>
                <Row
                  title={t('settings:web.totp')}
                  detail={values.totpEnabled ? t('settings:web.totpOn') : t('settings:web.totpOff')}
                >
                  <button
                    className="button"
                    disabled={busy}
                    onClick={() => setDialog(values.totpEnabled ? 'disable' : 'totp')}
                  >
                    {values.totpEnabled ? t('settings:web.turnOff') : t('settings:web.set')}
                  </button>
                </Row>
                <details className="web-sessions">
                  <summary>
                    {t('settings:web.browsers')}{' '}
                    <span>
                      {values.sessions.length}
                      <ChevronRight aria-hidden="true" />
                    </span>
                  </summary>
                  {values.sessions.length === 0 ? (
                    <p className="muted">{t('settings:web.noBrowsers')}</p>
                  ) : (
                    <ul>
                      {values.sessions.map(({ name, ...session }) => (
                        // A browser that did not say what it is is called one.
                        <li key={session.id}>
                          <span>
                            <strong>
                              {name || t('common:device.browser')}
                              {session.id === own ? t('settings:web.current') : ''}
                            </strong>
                            <small>
                              {t('settings:web.lastActive', {
                                time: new Date(session.lastActiveAt).toLocaleString(localeOf(t)),
                              })}
                            </small>
                          </span>
                          <IconButton
                            title={t('settings:web.revokeOf', {
                              name: name || t('common:device.browser'),
                            })}
                            disabled={busy}
                            onClick={() => setDialog({ revoke: session.id })}
                          >
                            <Trash2 />
                          </IconButton>
                        </li>
                      ))}
                    </ul>
                  )}
                </details>
              </>
            )}
            {!browser &&
              certificate &&
              (values.enabled || certificate.mode === 'custom' || certificate.error) && (
                <Row
                  title={t('settings:web.cert.title')}
                  detail={
                    (certificate.error && wordsText(t, certificate.error)) ??
                    (certificate.mode === 'custom'
                      ? t('settings:web.cert.custom', { domain: certificate.details?.domain ?? '' })
                      : certificate.mode === 'external'
                        ? t('settings:web.cert.external')
                        : certificate.mode === 'unavailable'
                          ? t('settings:web.cert.unavailable')
                          : certificate.selfSigned
                            ? t('settings:web.cert.selfSigned')
                            : t('settings:web.cert.deployed'))
                  }
                >
                  <div className="web-row-actions">
                    {values.enabled && !['external', 'unavailable'].includes(certificate.mode) && (
                      <button
                        className="button"
                        disabled={busy || !values.domain}
                        title={values.domain ? undefined : t('settings:web.cert.domainFirst')}
                        onClick={() => setDialog('certificate')}
                      >
                        {t('settings:web.cert.import')}
                      </button>
                    )}
                    {(certificate.mode === 'custom' || certificate.error) && (
                      <IconButton
                        title={t('settings:web.cert.reset')}
                        disabled={busy}
                        onClick={() => setDialog('reset')}
                      >
                        <RotateCcw />
                      </IconButton>
                    )}
                  </div>
                </Row>
              )}
            {!browser &&
              certificate?.details &&
              (values.enabled || certificate.mode === 'custom') && (
                <div className="web-certificate-details">
                  <span>
                    {t('settings:web.cert.issuer', { issuer: certificate.details.issuer })}
                  </span>
                  <span>
                    {t('settings:web.cert.validTo', {
                      date: new Date(certificate.details.validTo).toLocaleString(localeOf(t)),
                    })}
                  </span>
                </div>
              )}
            {expires !== undefined && expires <= 30 && (
              <p className="web-expiry" role="status">
                {expires < 0
                  ? t('settings:web.cert.expired')
                  : t('settings:web.cert.expiring', { count: expires })}
              </p>
            )}
          </>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </div>
      {values && dialog === 'access' && (
        <AccessDialog
          client={client}
          browser={browser}
          values={values}
          certificate={certificate}
          connectionUrl={connectionUrl}
          close={close}
          changed={setValues}
        />
      )}
      {values && dialog === 'totp' && (
        <TotpDialog client={client} browser={browser} close={close} changed={setValues} />
      )}
      {values && dialog === 'disable' && (
        <ConfirmDialog
          title={t('settings:web.totpTurnOff')}
          text={t('settings:web.totpTurnOffDetail')}
          proof={browser ? values.totpEnabled : undefined}
          act={async (proof) => {
            const result = await client.fetch({ type: 'web.totp.disable', ...proof });
            setValues(result.values);
          }}
          close={close}
        />
      )}
      {values && typeof dialog === 'object' && dialog && (
        <ConfirmDialog
          title={t('settings:web.revoke')}
          text={dialog.revoke === own ? t('settings:web.revokeOwn') : t('settings:web.revokeOther')}
          // Ending another login from a browser asks for proof; a desktop or this browser itself need none.
          proof={browser && dialog.revoke !== own ? values.totpEnabled : undefined}
          act={async (proof) => {
            const result = await client.fetch({
              type: 'web.sessions.revoke',
              sessionId: dialog.revoke,
              ...proof,
            });
            setValues(result.values);
          }}
          close={close}
        />
      )}
      {dialog === 'certificate' && values && (
        <CertificateDialog
          client={client}
          domain={values.domain}
          close={close}
          changed={setCertificate}
        />
      )}
      {dialog === 'reset' && (
        <ConfirmDialog
          title={t('settings:web.cert.reset')}
          text={t('settings:web.cert.resetQuestion')}
          act={async () => setCertificate(await client.fetch({ type: 'web.certificate.reset' }))}
          close={close}
        />
      )}
    </>
  );
}

// `proof` is whether the authenticator code is asked too; leaving it out asks for nothing.
function ConfirmDialog({
  title,
  text,
  proof: totp,
  act,
  close,
}: {
  title: string;
  text: string;
  proof?: boolean;
  act: (proof: { proof?: WebProof }) => Promise<void>;
  close: () => void;
}) {
  const t = useT();
  const [proof, setProof] = useState<WebProof>({ password: '' });
  const { busy, error, run } = useSubmit();
  return (
    <DialogForm
      title={title}
      busy={busy}
      error={error}
      close={close}
      submit={() =>
        void run(async () => {
          await act(totp === undefined ? {} : { proof });
          close();
        })
      }
    >
      <p>{text}</p>
      {totp !== undefined && <ProofFields proof={proof} change={setProof} totp={totp} />}
    </DialogForm>
  );
}

function AccessDialog({
  client,
  browser,
  values,
  certificate,
  connectionUrl,
  close,
  changed,
}: {
  client: ProxyClient;
  browser: boolean;
  values: WebSettingsState;
  certificate: WebCertificateState | null;
  connectionUrl: string;
  close: () => void;
  changed: (values: WebSettingsState) => void;
}) {
  const t = useT();
  const [proof, setProof] = useState<WebProof>({ password: '' });
  const [draft, setDraft] = useState({
    domain: values.domain,
    path: values.path,
    idleMinutes: values.idleMinutes,
    proxyEnabled: values.proxyEnabled,
    trustedProxies: values.trustedProxies.join('\n'),
  });
  const { busy, error, run } = useSubmit();
  // A browser may only move the entry, and proves itself for it; a desktop saves the rest as well.
  const save = () =>
    run(async () => {
      const path = draft.path.trim();
      const result = await client.fetch({
        type: 'web.settings.update',
        ...(browser
          ? { values: { path }, proof }
          : {
              values: {
                ...draft,
                domain: draft.domain.trim(),
                path,
                trustedProxies: draft.trustedProxies
                  .split(/[\n,]/)
                  .map((value) => value.trim())
                  .filter(Boolean),
              },
            }),
      });
      if (browser && result.values.path !== values.path) {
        const url = new URL(result.values.url ?? '', location.href);
        const expected = result.values.path ? `/${result.values.path}/` : '/';
        if (url.origin !== location.origin || url.pathname !== expected || url.search || url.hash)
          throw new Error(t('settings:web.pathSaved'));
        location.assign(url.href);
      }
      changed(result.values);
      close();
    });
  return (
    <DialogForm
      title={t('settings:web.access')}
      busy={busy}
      error={error}
      close={close}
      submit={() => void save()}
    >
      {!browser && (
        <label>
          {t('settings:web.domain')}
          <input
            value={draft.domain}
            disabled={certificate?.mode === 'custom'}
            placeholder="web.example.com"
            maxLength={253}
            onChange={(event) => setDraft({ ...draft, domain: event.target.value })}
          />
          <small className="muted">
            {certificate?.mode === 'custom'
              ? t('settings:web.domainLocked')
              : t('settings:web.domainHint')}
          </small>
        </label>
      )}
      <label>
        {t('settings:web.path')}
        <div className="web-path-input">
          <span>/</span>
          <input
            value={draft.path}
            maxLength={64}
            pattern="[a-z0-9]([a-z0-9-]*[a-z0-9])?|"
            onChange={(event) => setDraft({ ...draft, path: event.target.value })}
          />
        </div>
        <small className="muted">{t('settings:web.pathHint')}</small>
      </label>
      {!browser && (
        <>
          <label>
            {t('settings:web.idle')}
            <input
              type="number"
              min={15}
              max={1440}
              required
              value={draft.idleMinutes}
              onChange={(event) => setDraft({ ...draft, idleMinutes: Number(event.target.value) })}
            />
          </label>
          <Row title={t('settings:web.trustProxy')}>
            <Switch
              label={t('settings:web.trustProxy')}
              checked={draft.proxyEnabled}
              disabled={busy}
              onChange={(proxyEnabled) => setDraft({ ...draft, proxyEnabled })}
            />
          </Row>
          {draft.proxyEnabled && (
            <>
              <label>
                {t('settings:web.proxyIps')}
                <textarea
                  rows={3}
                  required
                  value={draft.trustedProxies}
                  onChange={(event) => setDraft({ ...draft, trustedProxies: event.target.value })}
                  placeholder={t('settings:web.proxyIpsHint')}
                />
                <small className="muted">{t('settings:web.proxyIpsDetail')}</small>
                {values.forwardedBy &&
                  !draft.trustedProxies
                    .split(/[\n,]/)
                    .map((value) => value.trim())
                    .includes(values.forwardedBy) && (
                    <small className="muted">
                      {t('settings:web.forwardedBy', { address: values.forwardedBy })}
                    </small>
                  )}
              </label>
              <ReverseProxyHelp
                connectionUrl={connectionUrl}
                domain={draft.domain}
                path={draft.path}
                certificate={certificate}
              />
            </>
          )}
        </>
      )}
      {browser && <ProofFields proof={proof} change={setProof} totp={values.totpEnabled} />}
    </DialogForm>
  );
}

// A browser proves itself before it sees a new secret; one correct code from it then turns it on.
function TotpDialog({
  client,
  browser,
  close,
  changed,
}: {
  client: ProxyClient;
  browser: boolean;
  close: () => void;
  changed: (values: WebSettingsState) => void;
}) {
  const t = useT();
  const [proof, setProof] = useState<WebProof>({ password: '' });
  const [setup, setSetup] = useState<WebTotpSetup | null>(null);
  const [qr, setQr] = useState('');
  const [code, setCode] = useState('');
  const { busy, error, setError, run } = useSubmit();
  // One request however often React runs the effect that asks for it.
  const pending = useRef<Promise<WebTotpSetup> | null>(null);
  const prepare = () =>
    run(async () => {
      pending.current ??= client.fetch({ type: 'web.totp.setup', ...(browser ? { proof } : {}) });
      try {
        setSetup(await pending.current);
      } finally {
        pending.current = null;
      }
    });
  useEffect(() => {
    if (!browser) void prepare();
  }, []);
  useEffect(() => {
    if (!setup) return;
    let current = true;
    void import('qrcode')
      .then((module) => module.default.toDataURL(setup.uri, { width: 200, margin: 1 }))
      .then(
        (url) => {
          if (current) setQr(url);
        },
        () => {
          if (current) setError(t('settings:web.qrFailed'));
        },
      );
    return () => {
      current = false;
    };
  }, [setup]);
  const enable = () =>
    run(async () => {
      const result = await client.fetch({ type: 'web.totp.enable', code });
      changed(result.values);
      close();
    });
  return (
    <DialogForm
      title={t('settings:web.totpSetup')}
      busy={busy}
      error={error}
      close={close}
      submit={() => void (setup ? enable() : prepare())}
      submitLabel={
        setup
          ? undefined
          : busy
            ? t('settings:web.preparing')
            : browser
              ? t('settings:web.next')
              : t('common:retry')
      }
    >
      {!setup && browser && <ProofFields proof={proof} change={setProof} totp={false} />}
      {!setup && !browser && busy && <p role="status">{t('settings:web.generating')}</p>}
      {setup && (
        <div className="web-totp-setup">
          <div className="web-totp-qr">
            {qr && <img src={qr} width="200" height="200" alt={t('settings:web.qr')} />}
          </div>
          <div className="web-totp-manual">
            <span>{t('settings:web.manualKey')}</span>
            <div className="web-totp-secret-row">
              <code className="web-totp-secret">{setup.secret}</code>
              <CopyButton
                key={setup.secret}
                text={setup.secret}
                label={t('settings:web.copyKey')}
              />
            </div>
          </div>
          <label>
            {t('settings:web.verify')}
            <input
              value={code}
              required
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              onChange={(event) => setCode(event.target.value)}
            />
          </label>
        </div>
      )}
    </DialogForm>
  );
}

function CertificateDialog({
  client,
  domain,
  close,
  changed,
}: {
  client: ProxyClient;
  domain: string;
  close: () => void;
  changed: (certificate: WebCertificateState) => void;
}) {
  const t = useT();
  const [cert, setCert] = useState('');
  const [key, setKey] = useState('');
  const { busy, error, setError, run } = useSubmit();
  async function read(file: File | undefined, kind: 'cert' | 'key') {
    if (!file) return;
    if (file.size > (kind === 'cert' ? 65536 : 16384)) {
      setError(
        kind === 'cert' ? t('settings:web.cert.chainTooLarge') : t('settings:web.cert.keyTooLarge'),
      );
      return;
    }
    try {
      (kind === 'cert' ? setCert : setKey)(await file.text());
    } catch {
      setError(t('settings:web.cert.readFailed'));
    }
  }
  return (
    <DialogForm
      title={t('settings:web.cert.importTitle')}
      busy={busy}
      error={error}
      close={close}
      submit={() =>
        void run(async () => {
          changed(await client.fetch({ type: 'web.certificate.set', cert, key }));
          close();
        })
      }
    >
      <p className="muted">{t('settings:web.cert.forDomain', { domain })}</p>
      <label>
        {t('settings:web.cert.chain')}
        <textarea
          rows={5}
          value={cert}
          required
          maxLength={65536}
          onChange={(event) => setCert(event.target.value)}
        />
        <input
          type="file"
          aria-label={t('settings:web.cert.chooseChain')}
          accept=".pem,.crt,.cer"
          onChange={(event) => void read(event.target.files?.[0], 'cert')}
        />
      </label>
      <label>
        {t('settings:web.cert.key')}
        <textarea
          rows={5}
          value={key}
          required
          maxLength={16384}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => setKey(event.target.value)}
        />
        <input
          type="file"
          aria-label={t('settings:web.cert.chooseKey')}
          accept=".pem,.key"
          onChange={(event) => void read(event.target.files?.[0], 'key')}
        />
      </label>
    </DialogForm>
  );
}
