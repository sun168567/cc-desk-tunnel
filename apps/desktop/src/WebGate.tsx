import { useCallback, useEffect, useRef, useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import type { WebLoginState } from '@cc-desk-tunnel/protocol';
import { useT } from './i18n.ts';
import { browserLogin, browserLogout, browserSession } from './browser-api.ts';
import { App } from './App.tsx';

export function CertificateWarning() {
  const t = useT();
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
      {t('connection:web.selfSigned')}
    </p>
  );
}
export default function WebGate() {
  const t = useT();
  const [session, setSession] = useState<WebLoginState | null>(null);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const check = useCallback(async () => {
    const current = ++generation.current;
    setBusy(true);
    setError('');
    try {
      const next = await browserSession();
      if (current === generation.current) setSession(next);
    } catch (error) {
      if (current === generation.current)
        setError(error instanceof Error ? error.message : t('connection:web.stateFailed'));
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }, []);
  useEffect(() => {
    void check();
    return () => {
      generation.current++;
    };
  }, [check]);
  const expired = useCallback(() => {
    setSession((value) => (value ? { ...value, authenticated: false, session: undefined } : null));
    setPassword('');
    setCode('');
    setError(t('connection:web.ended'));
    void check();
  }, [check]);
  const logout = useCallback(async () => {
    try {
      await browserLogout();
      expired();
      setError('');
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : t('connection:web.logoutFailed'));
    }
  }, [expired]);
  if (session?.authenticated)
    return <App browser={{ selfSigned: session.selfSigned, expired, logout }} />;
  return (
    <main className="web-login">
      <section className="web-login-body">
        <h1>CC Desk Tunnel</h1>
        <p className="muted">{t('connection:web.title')}</p>
        {session?.selfSigned && <CertificateWarning />}
        {!session ? (
          <>
            <p role="status">{busy ? t('connection:web.connecting') : error}</p>
            {!busy && (
              <button className="button" onClick={() => void check()}>
                {t('common:retry')}
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
                      setError(error instanceof Error ? error.message : t('connection:web.failed'));
                  },
                )
                .finally(() => {
                  if (current === generation.current) setBusy(false);
                });
            }}
          >
            <label>
              {t('connection:login.token')}
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
                {t('connection:web.totp')}
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
            {!session.totpEnabled && <p className="muted">{t('connection:web.totpAdvice')}</p>}
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <button className="button primary" disabled={busy}>
              {busy ? t('connection:web.signingIn') : t('connection:web.signIn')}
            </button>
          </form>
        )}
      </section>
    </main>
  );
}
