import React, { useCallback, useMemo, useRef, useState } from 'react';
import ReactDOM from 'react-dom/client';
import './i18n.ts';
// Before any other part of the window: its text is in the chosen language from the first.
import './language.ts';
import WebGate from './WebGate.tsx';
import { App } from './App.tsx';
import Launcher, { desktopSignIns } from './Launcher.tsx';
import type { SignInReport, SignIns } from './Launcher.tsx';
import type { ConnectionForm } from './LoginPage.tsx';
import { getPrefs, onPrefs } from './prefs.ts';
import './style.css';

// For what the stylesheet lays out differently by system: the window buttons' side of the title bar.
document.documentElement.dataset.platform = window.desktop?.platform ?? 'browser';
// The colours chosen in the settings, set before the page first draws.
const showTheme = () => {
  document.documentElement.dataset.theme = getPrefs().theme;
};
showTheme();
onPrefs(showTheme);

// Run in a browser from the source tree, the sign-in page and the page it signs in share the tab, as the sign-in
// window and the connection's window share a process on the desktop: the page connects out of sight while the
// sign-in page tells how it goes, and takes its place once connected.
function BrowserSignIn() {
  const [attempt, setAttempt] = useState<{ form: ConnectionForm; key: number } | null>(null);
  const [entered, setEntered] = useState(false);
  const ended = useRef<string | null>(null);
  const listeners = useRef(new Set<(report: SignInReport) => void>());
  const signIns = useMemo<SignIns>(
    () => ({
      load: async () => {
        const error = ended.current;
        ended.current = null;
        return error ? { error } : {};
      },
      start: async (form) => {
        setAttempt({ form, key: Date.now() });
        return {};
      },
      cancel: () => setAttempt(null),
      subscribe: (callback) => {
        listeners.current.add(callback);
        return () => listeners.current.delete(callback);
      },
    }),
    [],
  );
  const report = useCallback((next: SignInReport) => {
    if (next.status === 'connected') setEntered(true);
    if (next.status === 'disconnected') setAttempt(null);
    for (const listener of listeners.current) listener(next);
  }, []);
  const leave = useCallback((error: string | null) => {
    ended.current = error;
    setEntered(false);
    setAttempt(null);
  }, []);
  return (
    <>
      {!entered && <Launcher signIns={signIns} />}
      {attempt && (
        <div style={{ display: entered ? 'contents' : 'none' }}>
          <App key={attempt.key} signIn={attempt.form} report={report} leave={leave} />
        </div>
      )}
    </>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {window.desktop?.boot?.launcher ? (
      <Launcher signIns={desktopSignIns} />
    ) : window.desktop ? (
      <App />
    ) : import.meta.env.DEV ? (
      <BrowserSignIn />
    ) : (
      <WebGate />
    )}
  </React.StrictMode>,
);
