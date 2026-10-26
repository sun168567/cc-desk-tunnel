import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { ChevronRight, Copy, ExternalLink, Pencil, RotateCcw, Trash2 } from 'lucide-react';
import type {
  WebCertificateState,
  WebProof,
  WebSettingsState,
  WebTotpSetup,
} from '@cc-desk-tunnel/protocol';
import type { ProxyClient } from './client.ts';
import { IconButton, Switch } from './ui.tsx';
import { CopyButton } from './copy.tsx';
import ReverseProxyHelp from './ReverseProxyHelp.tsx';
import { DialogForm, ProofFields, message, useSubmit } from './WebSettingsForm.tsx';
import { confirmedWebProof, passkeySupportError } from './passkey.ts';
import type { ProofInput } from './passkey.ts';
import { PasskeyDialog, RenamePasskeyDialog } from './PasskeySettings.tsx';

function Row({ title, detail, children }: { title: string; detail?: string; children: ReactNode }) {
  return (
    <div className="setting-row">
      <span>
        <strong>{title}</strong>
        {detail && <small>{detail}</small>}
      </span>
      {children}
    </div>
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

type Dialog =
  | 'access'
  | 'totp'
  | 'disable'
  | 'certificate'
  | 'reset'
  | 'passkey'
  | { revoke: string }
  | { rename: string }
  | { remove: string };

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
  useEffect(() => {
    if (!browser || !connected || !values || busy) return;
    const locate = () => {
      if (location.hash !== '#passkeys') return;
      const element = document.getElementById('passkeys');
      if (!(element instanceof HTMLDetailsElement)) return;
      element.open = true;
      element.scrollIntoView({ block: 'center' });
      element.querySelector('summary')?.focus();
      if (values.passkeyAvailable && !passkeySupportError()) setDialog('passkey');
      history.replaceState(history.state, '', `${location.pathname}${location.search}`);
    };
    locate();
    window.addEventListener('hashchange', locate);
    return () => window.removeEventListener('hashchange', locate);
  }, [browser, connected, values, busy]);
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
      setError('复制失败，请选中地址后复制。');
    }
  }
  async function open(url: string) {
    try {
      if (window.desktop) await window.desktop.openWeb(url);
      else window.open(url, '_blank', 'noopener,noreferrer');
    } catch {
      setError('打开浏览器失败，请复制地址访问。');
    }
  }
  if (!connected)
    return (
      <>
        <h2 className="page-heading">浏览器访问</h2>
        <p className="muted">连接服务端后管理浏览器访问。</p>
      </>
    );
  const close = () => setDialog(null);
  const own = connection.browser?.sessionId;
  const expires =
    certificate?.details &&
    Math.ceil((Date.parse(certificate.details.validTo) - Date.now()) / 86400000);
  return (
    <>
      <h2 className="page-heading">浏览器访问</h2>
      <div className="card web-access-settings" aria-busy={busy}>
        {!values ? (
          <Row title={busy ? '正在读取…' : '读取设置失败'}>
            <button className="button" disabled={busy} onClick={() => void load()}>
              重试
            </button>
          </Row>
        ) : (
          <>
            {!browser && (
              <Row title="启用 Web 访问" detail="控制当前服务端的浏览器入口。">
                <Switch
                  label="启用 Web 访问"
                  checked={values.enabled}
                  disabled={busy}
                  onChange={(enabled) => void toggle(enabled)}
                />
              </Row>
            )}
            {values.enabled && (
              <>
                <Row title="服务端访问地址">
                  <div className="web-row-actions">
                    {values.url ? (
                      <>
                        <span className="web-access-address" title={values.url}>
                          {displayWebAddress(values.url)}
                        </span>
                        <IconButton
                          title="复制服务端访问地址"
                          onClick={() => void copy(values.url!)}
                          disabled={busy}
                        >
                          <Copy />
                        </IconButton>
                        <IconButton
                          title="打开服务端访问地址"
                          onClick={() => void open(values.url!)}
                          disabled={busy}
                        >
                          <ExternalLink />
                        </IconButton>
                      </>
                    ) : (
                      <span className="muted">地址未就绪</span>
                    )}
                  </div>
                </Row>
                <Row title="访问设置" detail={values.domain || '使用部署地址'}>
                  <button className="button" disabled={busy} onClick={() => setDialog('access')}>
                    设置
                  </button>
                </Row>
                <Row
                  title="两步验证"
                  detail={
                    values.totpEnabled
                      ? '使用服务凭据登录时需要验证器动态码。'
                      : '建议开启验证器两步验证。'
                  }
                >
                  <button
                    className="button"
                    disabled={busy}
                    onClick={() => setDialog(values.totpEnabled ? 'disable' : 'totp')}
                  >
                    {values.totpEnabled ? '关闭' : '设置'}
                  </button>
                </Row>
                <details id="passkeys" className="web-sessions web-passkeys">
                  <summary>
                    通行密钥{' '}
                    <span>
                      {values.passkeys.length}
                      <ChevronRight aria-hidden="true" />
                    </span>
                  </summary>
                  <div className="web-passkey-actions">
                    <p className="muted">用于登录 Web 工作台。</p>
                    <button
                      className="button"
                      disabled={
                        busy ||
                        !values.passkeyAvailable ||
                        (browser ? !!passkeySupportError() : !values.url)
                      }
                      onClick={() =>
                        browser ? setDialog('passkey') : void open(`${values.url}#passkeys`)
                      }
                    >
                      添加通行密钥
                    </button>
                  </div>
                  {(values.passkeyReason || (browser && passkeySupportError())) && (
                    <p className="muted">{values.passkeyReason || passkeySupportError()}</p>
                  )}
                  {values.passkeys.length === 0 ? (
                    <p className="muted">暂无通行密钥</p>
                  ) : (
                    <ul>
                      {values.passkeys.map((key) => (
                        <li key={key.id}>
                          <span>
                            <strong>{key.name}</strong>
                            <small>
                              {key.rpId}
                              {key.available ? '' : ' · 当前域名不可用'}
                            </small>
                            <small>
                              {key.lastUsedAt
                                ? `最近使用 ${new Date(key.lastUsedAt).toLocaleString()}`
                                : `创建于 ${new Date(key.createdAt).toLocaleString()}`}
                            </small>
                          </span>
                          <div className="web-row-actions">
                            <IconButton
                              title={`重命名 ${key.name}`}
                              disabled={busy}
                              onClick={() => setDialog({ rename: key.id })}
                            >
                              <Pencil />
                            </IconButton>
                            <IconButton
                              title={`删除 ${key.name}`}
                              disabled={busy}
                              onClick={() => setDialog({ remove: key.id })}
                            >
                              <Trash2 />
                            </IconButton>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </details>
                <details className="web-sessions">
                  <summary>
                    已登录浏览器{' '}
                    <span>
                      {values.sessions.length}
                      <ChevronRight aria-hidden="true" />
                    </span>
                  </summary>
                  {values.sessions.length === 0 ? (
                    <p className="muted">暂无已登录浏览器</p>
                  ) : (
                    <ul>
                      {values.sessions.map((session) => (
                        <li key={session.id}>
                          <span>
                            <strong>
                              {session.name}
                              {session.id === own ? '（当前浏览器）' : ''}
                            </strong>
                            <small>
                              最近活动 {new Date(session.lastActiveAt).toLocaleString()}
                            </small>
                          </span>
                          <IconButton
                            title={`退出 ${session.name}`}
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
                  title="HTTPS 证书"
                  detail={
                    certificate.error ??
                    (certificate.mode === 'custom'
                      ? `自定义证书 · ${certificate.details?.domain ?? ''}`
                      : certificate.mode === 'external'
                        ? '由反向代理管理'
                        : certificate.mode === 'unavailable'
                          ? '当前服务未配置 TLS'
                          : certificate.selfSigned
                            ? '使用默认自签名证书'
                            : '使用部署证书')
                  }
                >
                  <div className="web-row-actions">
                    {values.enabled && !['external', 'unavailable'].includes(certificate.mode) && (
                      <button
                        className="button"
                        disabled={busy || !values.domain}
                        title={values.domain ? undefined : '请先设置访问域名'}
                        onClick={() => setDialog('certificate')}
                      >
                        导入证书
                      </button>
                    )}
                    {(certificate.mode === 'custom' || certificate.error) && (
                      <IconButton
                        title="恢复默认证书"
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
                  <span>签发者：{certificate.details.issuer}</span>
                  <span>有效期至：{new Date(certificate.details.validTo).toLocaleString()}</span>
                </div>
              )}
            {expires !== undefined && expires <= 30 && (
              <p className="web-expiry" role="status">
                {expires < 0
                  ? '证书已过期，请更换证书。'
                  : `证书将在 ${expires} 天内到期，请及时更换。`}
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
      {values && browser && dialog === 'passkey' && (
        <PasskeyDialog client={client} values={values} close={close} changed={setValues} />
      )}
      {values && typeof dialog === 'object' && dialog && 'rename' in dialog && (
        <RenamePasskeyDialog
          client={client}
          browser={browser}
          values={values}
          id={dialog.rename}
          close={close}
          changed={setValues}
        />
      )}
      {values && typeof dialog === 'object' && dialog && 'remove' in dialog && (
        <ConfirmDialog
          title="删除通行密钥"
          text={`删除“${values.passkeys.find((key) => key.id === dialog.remove)?.name ?? ''}”？使用它登录的浏览器也会退出。`}
          proof={browser ? values.totpEnabled : undefined}
          passkeyAvailable={values.passkeys.some((key) => key.available)}
          act={async (proof) => {
            const result = await client.fetch({
              type: 'web.passkeys.remove',
              passkeyId: dialog.remove,
              ...proof,
            });
            setValues(result.values);
          }}
          close={close}
        />
      )}
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
        <TotpDialog
          client={client}
          browser={browser}
          passkeyAvailable={values.passkeys.some((key) => key.available)}
          close={close}
          changed={setValues}
        />
      )}
      {values && dialog === 'disable' && (
        <ConfirmDialog
          title="关闭两步验证"
          text="关闭两步验证后，使用服务凭据即可登录。已登录浏览器将退出。"
          proof={browser ? values.totpEnabled : undefined}
          passkeyAvailable={values.passkeys.some((key) => key.available)}
          act={async (proof) => {
            const result = await client.fetch({ type: 'web.totp.disable', ...proof });
            setValues(result.values);
          }}
          close={close}
        />
      )}
      {values && typeof dialog === 'object' && dialog && 'revoke' in dialog && (
        <ConfirmDialog
          title="退出浏览器登录"
          text={
            dialog.revoke === own
              ? '退出当前浏览器的登录？'
              : '退出这个浏览器的登录？它需要重新验证身份后登录。'
          }
          // Ending another login from a browser asks for proof; a desktop or this browser itself need none.
          proof={browser && dialog.revoke !== own ? values.totpEnabled : undefined}
          passkeyAvailable={values.passkeys.some((key) => key.available)}
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
          title="恢复默认证书"
          text="恢复部署时的默认证书？当前自定义证书将被移除；如果默认证书为自签名，浏览器会重新提示证书确认。"
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
  passkeyAvailable = false,
  act,
  close,
}: {
  title: string;
  text: string;
  proof?: boolean;
  passkeyAvailable?: boolean;
  act: (proof: { proof?: WebProof }) => Promise<void>;
  close: () => void;
}) {
  const [proof, setProof] = useState<ProofInput>({ password: '' });
  const { busy, error, run } = useSubmit();
  return (
    <DialogForm
      title={title}
      busy={busy}
      error={error}
      close={close}
      submit={() =>
        void run(async (signal) => {
          await act(totp === undefined ? {} : { proof: confirmedWebProof(proof) }).finally(() => {
            if (!signal.aborted && 'passkey' in proof) setProof({ passkey: '' });
          });
          close();
        })
      }
    >
      <p>{text}</p>
      {totp !== undefined && (
        <ProofFields
          proof={proof}
          change={setProof}
          totp={totp}
          passkeyAvailable={passkeyAvailable}
        />
      )}
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
  const [proof, setProof] = useState<ProofInput>({ password: '' });
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
    run(async (signal) => {
      const path = draft.path.trim();
      const result = await client
        .fetch({
          type: 'web.settings.update',
          ...(browser
            ? { values: { path }, proof: confirmedWebProof(proof) }
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
        })
        .finally(() => {
          if (!signal.aborted && 'passkey' in proof) setProof({ passkey: '' });
        });
      if (browser && result.values.path !== values.path) {
        const url = new URL(result.values.url ?? '', location.href);
        const expected = result.values.path ? `/${result.values.path}/` : '/';
        if (url.origin !== location.origin || url.pathname !== expected || url.search || url.hash)
          throw new Error('路径已保存，请从桌面端复制新的访问地址。');
        location.assign(url.href);
      }
      changed(result.values);
      close();
    });
  return (
    <DialogForm title="访问设置" busy={busy} error={error} close={close} submit={() => void save()}>
      {!browser && (
        <label>
          访问域名
          <input
            value={draft.domain}
            disabled={certificate?.mode === 'custom'}
            placeholder="web.example.com"
            maxLength={253}
            onChange={(event) => setDraft({ ...draft, domain: event.target.value })}
          />
          <small className="muted">
            {certificate?.mode === 'custom'
              ? '请先恢复默认证书，再修改或清空域名。'
              : '留空使用部署地址；填写后仅允许指定域名访问，其他入口返回 404。'}
          </small>
        </label>
      )}
      <label>
        服务端访问路径
        <div className="web-path-input">
          <span>/</span>
          <input
            value={draft.path}
            maxLength={64}
            pattern="[a-z0-9]([a-z0-9-]*[a-z0-9])?|"
            onChange={(event) => setDraft({ ...draft, path: event.target.value })}
          />
        </div>
        <small className="muted">
          留空使用根路径。修改域名或路径后，已登录浏览器需要重新登录。
        </small>
      </label>
      {!browser && (
        <>
          <label>
            登录空闲有效期（分钟）
            <input
              type="number"
              min={15}
              max={1440}
              required
              value={draft.idleMinutes}
              onChange={(event) => setDraft({ ...draft, idleMinutes: Number(event.target.value) })}
            />
          </label>
          <Row title="信任反向代理">
            <Switch
              label="信任反向代理"
              checked={draft.proxyEnabled}
              disabled={busy}
              onChange={(proxyEnabled) => setDraft({ ...draft, proxyEnabled })}
            />
          </Row>
          {draft.proxyEnabled && (
            <>
              <label>
                反向代理 IP
                <textarea
                  rows={3}
                  required
                  value={draft.trustedProxies}
                  onChange={(event) => setDraft({ ...draft, trustedProxies: event.target.value })}
                  placeholder="每行一个 IP 地址"
                />
                <small className="muted">只信任这些地址转发的客户端 IP 信息。</small>
                {values.forwardedBy &&
                  !draft.trustedProxies
                    .split(/[\n,]/)
                    .map((value) => value.trim())
                    .includes(values.forwardedBy) && (
                    <small className="muted">
                      最近一次带客户端 IP 的请求来自 {values.forwardedBy}
                      ，它不在上面的列表中。确认这是你的反向代理后再填写，不认识的地址不要加入。
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
      {browser && (
        <ProofFields
          proof={proof}
          change={setProof}
          totp={values.totpEnabled}
          passkeyAvailable={values.passkeys.some((key) => key.available)}
        />
      )}
    </DialogForm>
  );
}

// A browser proves itself before it sees a new secret; one correct code from it then turns it on.
function TotpDialog({
  client,
  browser,
  passkeyAvailable,
  close,
  changed,
}: {
  client: ProxyClient;
  browser: boolean;
  passkeyAvailable: boolean;
  close: () => void;
  changed: (values: WebSettingsState) => void;
}) {
  const [proof, setProof] = useState<ProofInput>({ password: '' });
  const [setup, setSetup] = useState<WebTotpSetup | null>(null);
  const [qr, setQr] = useState('');
  const [code, setCode] = useState('');
  const { busy, error, setError, run } = useSubmit();
  // One request however often React runs the effect that asks for it.
  const pending = useRef<Promise<WebTotpSetup> | null>(null);
  const prepare = () =>
    run(async (signal) => {
      pending.current ??= client.fetch({
        type: 'web.totp.setup',
        ...(browser ? { proof: confirmedWebProof(proof) } : {}),
      });
      try {
        const value = await pending.current;
        signal.throwIfAborted();
        setSetup(value);
      } finally {
        pending.current = null;
        if (!signal.aborted && 'passkey' in proof) setProof({ passkey: '' });
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
          if (current) setError('二维码生成失败，请手动输入密钥。');
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
      title="设置两步验证"
      busy={busy}
      error={error}
      close={close}
      submit={() => void (setup ? enable() : prepare())}
      submitLabel={setup ? undefined : busy ? '正在准备…' : browser ? '下一步' : '重试'}
    >
      {!setup && browser && (
        <ProofFields
          proof={proof}
          change={setProof}
          totp={false}
          passkeyAvailable={passkeyAvailable}
        />
      )}
      {!setup && !browser && busy && <p role="status">正在生成验证器密钥…</p>}
      {setup && (
        <div className="web-totp-setup">
          <div className="web-totp-qr">
            {qr && <img src={qr} width="200" height="200" alt="验证器二维码" />}
          </div>
          <div className="web-totp-manual">
            <span>手动设置密钥</span>
            <div className="web-totp-secret-row">
              <code className="web-totp-secret">{setup.secret}</code>
              <CopyButton key={setup.secret} text={setup.secret} label="复制密钥" />
            </div>
          </div>
          <label>
            验证新动态码
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
  const [cert, setCert] = useState('');
  const [key, setKey] = useState('');
  const { busy, error, setError, run } = useSubmit();
  async function read(file: File | undefined, kind: 'cert' | 'key') {
    if (!file) return;
    if (file.size > (kind === 'cert' ? 65536 : 16384)) {
      setError(kind === 'cert' ? '证书链不得超过 64 KB。' : '私钥不得超过 16 KB。');
      return;
    }
    try {
      (kind === 'cert' ? setCert : setKey)(await file.text());
    } catch {
      setError('读取文件失败，请重新选择。');
    }
  }
  return (
    <DialogForm
      title="导入自定义证书"
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
      <p className="muted">证书用于 {domain}。请提供完整证书链与未加密私钥。</p>
      <label>
        证书链 PEM
        <textarea
          rows={5}
          value={cert}
          required
          maxLength={65536}
          onChange={(event) => setCert(event.target.value)}
        />
        <input
          type="file"
          aria-label="选择证书文件"
          accept=".pem,.crt,.cer"
          onChange={(event) => void read(event.target.files?.[0], 'cert')}
        />
      </label>
      <label>
        私钥 PEM
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
          aria-label="选择私钥文件"
          accept=".pem,.key"
          onChange={(event) => void read(event.target.files?.[0], 'key')}
        />
      </label>
    </DialogForm>
  );
}
