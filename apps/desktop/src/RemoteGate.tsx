import { useEffect, useRef, useState } from 'react';
import { SquareTerminal } from 'lucide-react';
import { App } from './App.tsx';
import {
  hostInfo,
  installBrowserHost,
  HostAccessError,
  pairBrowser,
  resumeOrPairBrowser,
} from './browser-host.ts';
import type { HostInfo } from './browser-host.ts';
import { consumePairingLink } from './pairing-link.ts';

export default function RemoteGate() {
  const [info, setInfo] = useState<HostInfo | null>(null);
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const startup = useRef<Promise<HostInfo> | null>(null);
  const pairing = useRef(false);
  const polling = useRef(false);
  const generation = useRef(0);
  const mounted = useRef(false);
  const pendingLink = useRef<string | null>(null);
  const drainLink = useRef(() => {});
  useEffect(() => {
    let active = true;
    let ready = false;
    mounted.current = true;
    const accept = (value: HostInfo) => {
      if (!window.desktop) installBrowserHost(value);
      setInfo(value);
      setError('');
    };
    const drain = () => {
      if (!active || pairing.current || !pendingLink.current) return;
      const code = pendingLink.current;
      pendingLink.current = null;
      pairing.current = true;
      const revision = ++generation.current;
      setBusy(true);
      setError('');
      void resumeOrPairBrowser(code)
        .then((value) => {
          if (active && revision === generation.current) accept(value);
        })
        .catch((reason: Error) => {
          if (active && revision === generation.current) setError(reason.message);
        })
        .finally(() => {
          if (!active || revision !== generation.current) return;
          pairing.current = false;
          setBusy(false);
          drain();
        });
    };
    drainLink.current = drain;
    const followLink = () => {
      const code = consumePairingLink(window.location, window.history);
      if (!code) return;
      // Consume immediately; serialize a later link after any pending login operation.
      pendingLink.current = code;
      drain();
    };
    window.addEventListener('hashchange', followLink);
    const refresh = () => {
      if (!ready || pairing.current || polling.current) return;
      polling.current = true;
      const revision = generation.current;
      void hostInfo()
        .then((value) => {
          if (active && revision === generation.current) accept(value);
        })
        .catch((reason: Error) => {
          if (active && revision === generation.current) {
            if (reason instanceof HostAccessError && reason.status === 401) setInfo(null);
            setError((previous) => previous || reason.message);
          }
        })
        .finally(() => {
          polling.current = false;
        });
    };
    // StrictMode re-subscribes to this same operation instead of submitting the code twice.
    if (!startup.current) {
      const initialToken = consumePairingLink(window.location, window.history);
      pairing.current = !!initialToken;
      startup.current = initialToken ? resumeOrPairBrowser(initialToken) : hostInfo();
    }
    const revision = generation.current;
    setBusy(pairing.current);
    void startup.current
      .then((value) => {
        if (active && revision === generation.current) accept(value);
      })
      .catch((reason: Error) => {
        if (active && revision === generation.current) setError(reason.message);
      })
      .finally(() => {
        if (!active) return;
        ready = true;
        if (revision === generation.current) {
          pairing.current = false;
          setBusy(false);
        }
        drain();
      });
    const timer = setInterval(refresh, 3000);
    return () => {
      active = false;
      mounted.current = false;
      drainLink.current = () => {};
      window.removeEventListener('hashchange', followLink);
      clearInterval(timer);
    };
  }, []);
  if (info?.connected) return <App />;
  return (
    <main className="login-page">
      <div className="login-content">
        <div className="brand">
          <SquareTerminal />
          <span>CC Desk Tunnel · Web</span>
        </div>
        <div className="login-title">
          <h1>{info ? `已连接 ${info.device.name}` : '连接桌面客户端的工作台'}</h1>
        </div>
        {info ? (
          <>
            <p className="muted">
              Web 服务已就绪。请先在桌面客户端连接代理服务，连接成功后这里会自动进入工作台。
            </p>
            <button className="button" onClick={() => void window.desktop?.quit()}>
              退出此浏览器
            </button>
          </>
        ) : (
          <form
            className="connection-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (pairing.current) return;
              pairing.current = true;
              generation.current++;
              setBusy(true);
              setError('');
              void pairBrowser(token)
                .then((value) => {
                  if (!mounted.current) return;
                  installBrowserHost(value);
                  setInfo(value);
                  setToken('');
                  setError('');
                })
                .catch((reason: Error) => {
                  if (mounted.current) setError(reason.message);
                })
                .finally(() => {
                  pairing.current = false;
                  if (mounted.current) {
                    setBusy(false);
                    drainLink.current();
                  }
                });
            }}
          >
            <p className="muted">
              在桌面客户端打开「设置 → 常规 → 远程控制」，复制配对码。无需填写代理服务凭据。
            </p>
            <label>
              配对码
              <input
                type="password"
                value={token}
                disabled={busy}
                onChange={(event) => setToken(event.target.value)}
                autoComplete="off"
                required
                autoFocus
              />
            </label>
            {error && (
              <p role="alert" className="remote-error">
                {error}
              </p>
            )}
            <button className="button primary" disabled={busy || !token.trim()}>
              {busy ? '正在配对…' : '连接工作台'}
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
