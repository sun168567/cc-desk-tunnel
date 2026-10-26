import { useCallback, useEffect, useRef, useState } from 'react';
import { Fingerprint, ShieldAlert } from 'lucide-react';
import type { WebLoginState } from '@cc-desk-tunnel/protocol';
import { browserLogin, browserLogout, browserSession } from './browser-api.ts';
import { App } from './App.tsx';
import {
  cancelPasskey,
  loginWithPasskey,
  passkeyError,
  passkeySupportError,
  usePasskeyOptions,
} from './passkey.ts';

export function CertificateWarning() {
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const shell = element.closest<HTMLElement>('.shell');
    if (!shell) return;
    const observer = new ResizeObserver(() =>
      shell.style.setProperty(
        '--web-warning-height',
        `${element.getBoundingClientRect().height}px`,
      ),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return (
    <p ref={ref} className="web-trust-warning" role="note">
      <ShieldAlert aria-hidden="true" />
      当前服务使用自签名证书，请确认访问地址可信。建议在桌面端“设置 → 常规 →
      浏览器访问”导入正规证书，或由反向代理提供 HTTPS。
    </p>
  );
}
export default function WebGate() {
  const [session, setSession] = useState<WebLoginState | null>(null);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const supportError = passkeySupportError();
  const {
    options,
    error: optionsError,
    refresh,
  } = usePasskeyOptions(
    'login',
    !!session?.passkeyAvailable && !session.authenticated && !supportError,
  );
  async function login(task: () => Promise<WebLoginState>, passkey = false) {
    if (busy) return;
    const current = ++generation.current;
    setBusy(true);
    setError('');
    try {
      const value = await task();
      if (current !== generation.current) return;
      setPassword('');
      setCode('');
      setSession(value);
    } catch (error) {
      if (current === generation.current) {
        setError(passkeyError(error));
        if (passkey) refresh();
      }
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }

  const check = useCallback(async () => {
    const current = ++generation.current;
    setBusy(true);
    setError('');
    try {
      const next = await browserSession();
      if (current === generation.current) setSession(next);
    } catch (error) {
      if (current === generation.current)
        setError(error instanceof Error ? error.message : '读取登录状态失败。');
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }, []);
  useEffect(() => {
    void check();
    return () => {
      generation.current++;
      cancelPasskey();
    };
  }, [check]);
  const expired = useCallback(() => {
    setSession((value) => (value ? { ...value, authenticated: false, session: undefined } : null));
    setPassword('');
    setCode('');
    setError('登录已结束，请重新登录。');
    void check();
  }, [check]);
  const logout = useCallback(async () => {
    try {
      await browserLogout();
      expired();
      setError('');
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : '退出登录失败，请重试。');
    }
  }, [expired]);
  if (session?.authenticated)
    return <App browser={{ selfSigned: session.selfSigned, expired, logout }} />;
  return (
    <main className="web-login">
      <section className="web-login-body">
        <h1>CC Desk Tunnel</h1>
        <p className="muted">登录服务端工作台</p>
        {session?.selfSigned && <CertificateWarning />}
        {!session ? (
          <>
            <p role="status">{busy ? '正在连接服务…' : error}</p>
            {!busy && (
              <button className="button" onClick={() => void check()}>
                重试
              </button>
            )}
          </>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void login(() =>
                browserLogin({ password, ...(session.totpEnabled ? { code } : {}) }),
              );
            }}
          >
            <label>
              服务凭据
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
                disabled={busy}
              />
            </label>
            {session.totpEnabled && (
              <label>
                验证器动态码
                <input
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  required
                  disabled={busy}
                />
              </label>
            )}
            {!session.totpEnabled && <p className="muted">建议开启验证器两步验证。</p>}
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <button className="button primary" disabled={busy}>
              {busy ? '正在登录…' : '登录'}
            </button>
            {session.passkeyAvailable && (
              <>
                <button
                  type="button"
                  className="button web-passkey-login"
                  disabled={busy || !!supportError || (!options && !optionsError)}
                  onClick={() => {
                    if (!options) {
                      refresh();
                      return;
                    }
                    void login(() => loginWithPasskey(options), true);
                  }}
                >
                  <Fingerprint aria-hidden="true" />
                  {optionsError ? '重新准备通行密钥' : '使用通行密钥登录'}
                </button>
                {(supportError || optionsError) && (
                  <p className="muted">{supportError || optionsError}</p>
                )}
              </>
            )}
          </form>
        )}
      </section>
    </main>
  );
}
