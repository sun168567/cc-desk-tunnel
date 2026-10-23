import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { ChevronRight, Copy, ExternalLink, Pencil, RotateCcw, Search, Trash2 } from 'lucide-react';
import type {
  WebCertificateState,
  WebProof,
  WebSettingsState,
  WebTotpSetup,
} from '@cc-desk-tunnel/protocol';
import { webPublicOriginSchema } from '@cc-desk-tunnel/protocol';
import type { ProxyClient } from './client.ts';
import { IconButton, Switch } from './ui.tsx';
import { CopyButton } from './copy.tsx';
import ReverseProxyHelp from './ReverseProxyHelp.tsx';
import { passkeySupportError, resolveWebProof, supportsPasskeys } from './passkey.ts';
import { DialogForm, ProofFields, Row, message, useSubmit } from './WebSettingsForm.tsx';
import { PasskeyDialog, RenamePasskeyDialog } from './PasskeySettings.tsx';

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
  const renderGeneration = generation.current;
  const applyValues = (next: WebSettingsState) => {
    if (generation.current === renderGeneration) setValues(next);
  };
  const applyCertificate = (next: WebCertificateState) => {
    if (generation.current === renderGeneration) setCertificate(next);
  };
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
                      <span className="muted">请在访问设置中填写 Web 对外地址</span>
                    )}
                  </div>
                </Row>
                <Row title="访问设置" detail={values.publicOrigin || 'Web 对外地址未设置'}>
                  <button className="button" disabled={busy} onClick={() => setDialog('access')}>
                    设置
                  </button>
                </Row>
                <Row
                  title="两步验证"
                  detail={
                    values.totpEnabled
                      ? '使用服务凭据登录时，需要验证器动态码。'
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
                <Row
                  title="添加通行密钥"
                  detail={
                    !values.passkeyAvailable
                      ? (values.passkeyUnavailableReason ?? '请先设置使用域名的 Web 对外地址。')
                      : browser && !supportsPasskeys()
                        ? passkeySupportError()
                        : '使用指纹、面容或设备锁屏密码登录 Web 工作台。'
                  }
                >
                  <button
                    className="button"
                    disabled={busy || !values.passkeyAvailable || (browser && !supportsPasskeys())}
                    onClick={() => setDialog('passkey')}
                  >
                    添加
                  </button>
                </Row>
                <details className="web-sessions web-passkeys">
                  <summary>
                    已添加的通行密钥{' '}
                    <span>
                      {values.passkeys.length}
                      <ChevronRight aria-hidden="true" />
                    </span>
                  </summary>
                  {values.passkeys.length === 0 ? (
                    <p className="muted">尚未添加通行密钥</p>
                  ) : (
                    <ul>
                      {values.passkeys.map((key) => (
                        <li key={key.id}>
                          <span>
                            <strong>{key.name}</strong>
                            <small>
                              {key.available
                                ? key.lastUsedAt
                                  ? `最近使用 ${new Date(key.lastUsedAt).toLocaleString()}`
                                  : '尚未使用'
                                : `绑定于 ${key.rpId}，当前域名不可用`}
                            </small>
                            <small>创建于 {new Date(key.createdAt).toLocaleString()}</small>
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
                  title="服务端直连证书"
                  detail={
                    certificate.error ??
                    (certificate.mode === 'custom'
                      ? `自定义证书 · ${certificate.details?.domain ?? ''}`
                      : certificate.mode === 'external'
                        ? '由反向代理管理'
                        : certificate.mode === 'unavailable'
                          ? '当前服务未配置 TLS'
                          : certificate.selfSigned
                            ? '默认自签名证书'
                            : '部署证书')
                  }
                >
                  <div className="web-row-actions">
                    {values.enabled && !['external', 'unavailable'].includes(certificate.mode) && (
                      <button
                        className="button"
                        disabled={busy || !values.domain}
                        title={values.domain ? undefined : '请先设置使用域名的 Web 对外地址'}
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
      {values && dialog === 'access' && (
        <AccessDialog
          client={client}
          browser={browser}
          values={values}
          certificate={certificate}
          connectionUrl={connectionUrl}
          close={close}
          changed={applyValues}
        />
      )}
      {values && dialog === 'totp' && (
        <TotpDialog
          client={client}
          browser={browser}
          passkeyAvailable={values.passkeyAvailable && values.passkeys.some((key) => key.available)}
          close={close}
          changed={applyValues}
        />
      )}
      {values && dialog === 'disable' && (
        <ConfirmDialog
          title="关闭两步验证"
          text="关闭两步验证后，使用服务凭据即可登录。已登录浏览器将退出。"
          proof={browser ? values.totpEnabled : undefined}
          passkeyAvailable={
            browser && values.passkeyAvailable && values.passkeys.some((key) => key.available)
          }
          act={async (proof) => {
            const result = await client.fetch({ type: 'web.totp.disable', ...proof });
            applyValues(result.values);
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
              : '退出这个浏览器的登录？它需要重新验证身份。'
          }
          // Ending another login from a browser asks for proof; a desktop or this browser itself need none.
          proof={browser && dialog.revoke !== own ? values.totpEnabled : undefined}
          passkeyAvailable={
            browser && values.passkeyAvailable && values.passkeys.some((key) => key.available)
          }
          act={async (proof) => {
            const result = await client.fetch({
              type: 'web.sessions.revoke',
              sessionId: dialog.revoke,
              ...proof,
            });
            applyValues(result.values);
          }}
          close={close}
        />
      )}
      {dialog === 'passkey' && values && (
        <PasskeyDialog
          client={client}
          browser={browser}
          values={values}
          close={close}
          changed={applyValues}
        />
      )}
      {values && typeof dialog === 'object' && dialog && 'rename' in dialog && (
        <RenamePasskeyDialog
          client={client}
          values={values}
          browser={browser}
          id={dialog.rename}
          close={close}
          changed={applyValues}
        />
      )}
      {values && typeof dialog === 'object' && dialog && 'remove' in dialog && (
        <ConfirmDialog
          title="删除通行密钥"
          text={`删除“${values.passkeys.find((key) => key.id === dialog.remove)?.name ?? '通行密钥'}”？通过它登录的浏览器也将退出。你仍可使用服务凭据登录。`}
          proof={browser ? values.totpEnabled : undefined}
          passkeyAvailable={
            browser && values.passkeyAvailable && values.passkeys.some((key) => key.available)
          }
          act={async (proof) => {
            const result = await client.fetch({
              type: 'web.passkeys.remove',
              passkeyId: dialog.remove,
              ...proof,
            });
            applyValues(result.values);
          }}
          close={close}
        />
      )}
      {dialog === 'certificate' && values && (
        <CertificateDialog
          client={client}
          domain={values.domain}
          close={close}
          changed={applyCertificate}
        />
      )}
      {dialog === 'reset' && (
        <ConfirmDialog
          title="恢复默认证书"
          text="恢复部署时的默认证书？当前自定义证书将被移除，直连访问可能需要重新确认信任。反向代理对外提供的证书不受影响。"
          act={async () => applyCertificate(await client.fetch({ type: 'web.certificate.reset' }))}
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
  const [proof, setProof] = useState<WebProof>({ password: '' });
  const { busy, error, run } = useSubmit();
  return (
    <DialogForm
      title={title}
      busy={busy}
      error={error}
      close={close}
      submit={() =>
        void run(async (signal) => {
          await act(totp === undefined ? {} : { proof: await resolveWebProof(proof, signal) });
          signal.throwIfAborted();
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
  const [proof, setProof] = useState<WebProof>({ password: '' });
  const [draft, setDraft] = useState({
    publicOrigin: values.publicOrigin.replace(/^https:\/\//, ''),
    path: values.path,
    idleMinutes: values.idleMinutes,
    proxyEnabled: values.proxyEnabled,
    trustedProxies: values.trustedProxies.join('\n'),
  });
  const [originEdited, setOriginEdited] = useState(false);
  const proxyInputId = useId();
  const [detecting, setDetecting] = useState(false);
  const [detected, setDetected] = useState(false);
  const { busy, error, run } = useSubmit();
  const origin = webPublicOriginSchema.safeParse(
    draft.publicOrigin.trim() ? `https://${draft.publicOrigin.trim()}` : '',
  );
  const detectionHint = !values.publicOrigin
    ? '请先保存 Web 对外地址，再自动检测。'
    : !origin.success || origin.data !== values.publicOrigin || draft.path.trim() !== values.path
      ? '地址或路径有改动，请先保存后再检测。'
      : '';
  const detect = () =>
    run(async (signal) => {
      setDetecting(true);
      setDetected(false);
      try {
        const result = await client.fetch({ type: 'web.proxy.detect' });
        signal.throwIfAborted();
        if (result.publicOrigin !== values.publicOrigin || result.path !== values.path)
          throw new Error('服务端访问地址已变更，请关闭并重新打开访问设置后检测。');
        const addresses = [
          ...new Set([
            ...draft.trustedProxies
              .split(/[\n,]/)
              .map((value) => value.trim())
              .filter(Boolean),
            result.address,
          ]),
        ];
        if (addresses.length > 16)
          throw new Error('最多保存 16 个代理 IP，请先移除不用的地址后重试。');
        setDraft((current) => ({ ...current, trustedProxies: addresses.join('\n') }));
        setDetected(true);
      } finally {
        if (!signal.aborted) setDetecting(false);
      }
    });
  // A browser may only move the entry, and proves itself for it; a desktop saves the rest as well.
  const save = () =>
    run(async (signal) => {
      const path = draft.path.trim();
      const authority = draft.publicOrigin.trim();
      const publicOrigin = webPublicOriginSchema.safeParse(authority ? `https://${authority}` : '');
      if (!publicOrigin.success)
        throw new Error('Web 对外地址只填写域名或 IP，可带端口；不要包含协议、路径或参数。');
      const result = await client.fetch({
        type: 'web.settings.update',
        ...(browser
          ? { values: { path }, proof: await resolveWebProof(proof, signal) }
          : {
              values: {
                ...(originEdited ? { publicOrigin: publicOrigin.data } : {}),
                path,
                idleMinutes: draft.idleMinutes,
                proxyEnabled: draft.proxyEnabled,
                trustedProxies: draft.trustedProxies
                  .split(/[\n,]/)
                  .map((value) => value.trim())
                  .filter(Boolean),
              },
            }),
      });
      signal.throwIfAborted();
      if (browser && result.values.path !== values.path) {
        const expected = result.values.path ? `/${result.values.path}/` : '/';
        const url = new URL(result.values.url ?? expected, location.origin);
        if (url.origin !== location.origin || url.pathname !== expected || url.search || url.hash)
          throw new Error('路径已保存，请从桌面端复制新的访问地址。');
        location.assign(url.href);
      }
      changed(result.values);
      close();
    });
  return (
    <DialogForm
      title="访问设置"
      busy={busy}
      error={error}
      close={close}
      submit={() => void save()}
      submitLabel={detecting ? '确认' : undefined}
    >
      {!browser && (
        <label>
          Web 对外地址
          <div className="web-origin-input">
            <span aria-hidden="true">https://</span>
            <input
              aria-label="Web 对外地址"
              value={draft.publicOrigin}
              placeholder="web.example.com:1443"
              maxLength={259}
              autoCapitalize="none"
              spellCheck={false}
              onChange={(event) => {
                setOriginEdited(true);
                setDetected(false);
                setDraft({ ...draft, publicOrigin: event.target.value });
              }}
            />
          </div>
          <small className="muted">
            填写浏览器访问的域名或 IP，可带端口。留空不生成访问链接，与桌面连接地址无关。
          </small>
          <small className="muted">证书由服务端或反代提供；填写地址不会申请或验证证书。</small>
          {certificate?.mode === 'custom' && (
            <small className="muted">端口可修改；修改或清空域名前，请先恢复默认证书。</small>
          )}
          {!values.publicOrigin && values.domain && (
            <small className="muted">
              当前仍限制域名 {values.domain}，请补全实际对外地址及端口。
            </small>
          )}
          {values.passkeys.length > 0 && (
            <small className="muted">
              更换域名后，原通行密钥在新域名不可用；仅修改端口不需要重新添加。
            </small>
          )}
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
            onChange={(event) => {
              setDetected(false);
              setDraft({ ...draft, path: event.target.value });
            }}
          />
        </div>
        <small className="muted">
          留空使用根路径。修改对外地址或路径后，已登录浏览器需要重新登录。
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
          <Row
            title="识别真实访客 IP"
            detail="让反代后的访客分别计算登录尝试次数。关闭不影响正常访问。"
          >
            <Switch
              label="识别真实访客 IP"
              checked={draft.proxyEnabled}
              disabled={busy}
              onChange={(proxyEnabled) => {
                setDetected(false);
                setDraft({ ...draft, proxyEnabled });
              }}
            />
          </Row>
          {draft.proxyEnabled && (
            <div className="web-proxy-detection">
              <div className="web-proxy-detection-heading">
                <span className="muted">不知道代理 IP？可通过已保存的 Web 地址检测。</span>
                <button
                  type="button"
                  className="button"
                  disabled={busy || !!detectionHint}
                  onClick={() => void detect()}
                >
                  <Search />
                  {detecting ? '正在检测…' : '自动检测'}
                </button>
              </div>
              <label>
                可信反向代理 IP
                <textarea
                  id={proxyInputId}
                  aria-describedby={`${proxyInputId}-help`}
                  rows={3}
                  required
                  value={draft.trustedProxies}
                  onChange={(event) => {
                    setDraft({ ...draft, trustedProxies: event.target.value });
                  }}
                  placeholder="每行一个 IP 地址"
                />
                <small className="muted" id={`${proxyInputId}-help`}>
                  填写 NGINX 等代理的来源 IP，不是访客 IP。可自动检测，也可每行填写一个。
                </small>
              </label>
              {detectionHint && <small className="muted">{detectionHint}</small>}
              {detected && (
                <small className="muted" role="status">
                  已填入检测到的地址，确认是你的反向代理后保存。
                </small>
              )}
            </div>
          )}
          <ReverseProxyHelp
            connectionUrl={connectionUrl}
            publicOrigin={draft.publicOrigin ? `https://${draft.publicOrigin.trim()}` : ''}
            path={draft.path}
            certificate={certificate}
          />
        </>
      )}
      {browser && (
        <ProofFields
          proof={proof}
          change={setProof}
          totp={values.totpEnabled}
          passkeyAvailable={values.passkeyAvailable && values.passkeys.some((key) => key.available)}
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
  const [proof, setProof] = useState<WebProof>({ password: '' });
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
        ...(browser ? { proof: await resolveWebProof(proof, signal) } : {}),
      });
      try {
        const value = await pending.current;
        if (!signal.aborted) setSetup(value);
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
          if (current) setError('二维码生成失败，请手动输入密钥。');
        },
      );
    return () => {
      current = false;
    };
  }, [setup]);
  const enable = () =>
    run(async (signal) => {
      const result = await client.fetch({ type: 'web.totp.enable', code });
      signal.throwIfAborted();
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
        void run(async (signal) => {
          const result = await client.fetch({ type: 'web.certificate.set', cert, key });
          signal.throwIfAborted();
          changed(result);
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
