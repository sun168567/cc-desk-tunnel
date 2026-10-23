import { useCallback, useEffect, useRef, useState } from 'react';
import { Fingerprint } from 'lucide-react';
import type { WebLoginState } from '@cc-desk-tunnel/protocol';
import { browserLogin, browserLogout, browserSession } from './browser-api.ts';
import { App } from './App.tsx';
import PasskeyBrowser from './PasskeyBrowser.tsx';
import SecureContextWarning from './SecureContextWarning.tsx';
import {
  cancelPasskey,
  loginWithPasskey,
  passkeyError,
  passkeySupportError,
  readPasskeyLink,
} from './passkey.ts';

const passkeyLink = readPasskeyLink();

export default function WebGate() {
  const [link, setLink] = useState(passkeyLink);
  useEffect(() => {
    const changed = () => {
      const next = readPasskeyLink();
      if (next) setLink(next);
    };
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, []);
  return link ? <PasskeyBrowser key={link.token} link={link} /> : <BrowserLogin />;
}
function BrowserLogin() {
  const passkeySupport = passkeySupportError();
  const [session, setSession] = useState<WebLoginState | null>(null);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const passkeyRequest = useRef<AbortController | null>(null);
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
      passkeyRequest.current?.abort();
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
  async function passkeyLogin() {
    const current = ++generation.current;
    const controller = new AbortController();
    passkeyRequest.current = controller;
    setBusy(true);
    setError('');
    try {
      const value = await loginWithPasskey(controller.signal);
      if (current !== generation.current) return;
      setPassword('');
      setCode('');
      setSession(value);
    } catch (error) {
      if (current === generation.current) setError(passkeyError(error));
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }
  if (session?.authenticated) return <App browser={{ expired, logout }} />;
  return (
    <main className="web-login">
      <section className="web-login-body">
        <h1>CC Desk Tunnel</h1>
        <p className="muted">登录服务端工作台</p>
        {!window.isSecureContext && <SecureContextWarning />}
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
              if (busy) return;
              const current = ++generation.current;
              setBusy(true);
              setError('');
              void browserLogin({ password, ...(session.totpEnabled ? { code } : {}) })
                .then(
                  (value) => {
                    if (current !== generation.current) return;
                    setPassword('');
                    setCode('');
                    setSession(value);
                  },
                  (error: unknown) => {
                    if (current === generation.current)
                      setError(error instanceof Error ? error.message : '登录失败。');
                  },
                )
                .finally(() => {
                  if (current === generation.current) setBusy(false);
                });
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
              <button
                className="button web-passkey-login"
                type="button"
                disabled={busy || !!passkeySupport}
                title={passkeySupport}
                onClick={() => void passkeyLogin()}
              >
                <Fingerprint aria-hidden="true" />
                使用通行密钥登录
              </button>
            )}
            {session.passkeyAvailable && passkeySupport && (
              <p className="muted" role="status">
                {passkeySupport}
              </p>
            )}
          </form>
        )}
      </section>
    </main>
  );
}
