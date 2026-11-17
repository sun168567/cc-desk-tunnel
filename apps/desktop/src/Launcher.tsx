import { useEffect, useState } from 'react';
import LoginPage from './LoginPage.tsx';
import type { ConnectionForm } from './LoginPage.tsx';

const messageOf = (failure: unknown) =>
  String((failure as Error)?.message ?? failure).replace(/^.*?'launcher:\w+': (Error: )?/, '');

// A sign-in window (see electron/connections.cjs). It chooses the service; the service's own window, started for
// it, signs in, and this one closes once that window runs. Problems of signing in, a refused token or a version to
// upgrade, are told there.
export default function Launcher() {
  const [form, setForm] = useState<ConnectionForm>({
    url: '',
    token: '',
    fingerprint: '',
    mode: 'remote',
    remember: false,
    autoLogin: false,
  });
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  useEffect(() => {
    void window.desktop!.loadLogin().then(
      (saved) =>
        saved &&
        setForm({
          url: saved.url,
          token: '',
          fingerprint: saved.fingerprint,
          // The installed client has no simulation mode, whatever an earlier version saved.
          mode: window.desktop!.dev ? saved.mode : 'remote',
          remember: saved.remember,
          autoLogin: saved.autoLogin,
        }),
    );
  }, []);
  async function start() {
    setError(null);
    setStarting(true);
    const result: { shown?: string; error?: string } = await window
      .desktop!.startService(form)
      .catch((failure: unknown) => ({
        error: messageOf(failure),
      }));
    if (result.shown) setError(`“${result.shown}”已在另一个窗口登录，已切换到那个窗口。`);
    else if (result.error) setError(result.error);
    // Otherwise the window goes as the service's window runs.
    else return;
    setStarting(false);
  }
  return (
    <LoginPage
      launcher
      form={form}
      change={(values) => setForm((current) => ({ ...current, ...values }))}
      connecting={starting}
      error={error}
      upgrade={null}
      direct={null}
      downloaded={null}
      install={() => {}}
      older={null}
      newer={null}
      showNotes={() => {}}
      submit={() => void start()}
    />
  );
}
