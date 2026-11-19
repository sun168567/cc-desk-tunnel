import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import LoginPage from './LoginPage.tsx';
import type { ConnectionForm } from './LoginPage.tsx';
import SettingsPage from './SettingsPage.tsx';
import type { Section } from './SettingsPage.tsx';
import { ProxyClient } from './client.ts';
import { isNewer } from './paths.ts';
import { selfUpdating } from './platform.ts';

const ReleaseNotes = lazy(() => import('./ReleaseNotes.tsx'));

// How the connection's window is getting on with its sign-in: connecting, connected, or ended, with why. A service
// that refused this client's version says its own version, the client release it holds, and how far it has
// fetched that release (from 0 to 1) when it is fetching it.
export type SignInReport = {
  status: 'connecting' | 'connected' | 'disconnected';
  error: string | null;
  mismatch: boolean;
  service: string | null;
  release: string | null;
  preparing: number | null;
};
// How a sign-in window signs in. On the desktop the program makes the service's own window, which connects in the
// background and is shown once it has (see `launcher:start` in electron/main.cjs); a page run in a browser from the
// source tree does the same with the page under it (see main.tsx).
export type SignIns = {
  // What to offer: a service, why the sign-in this one takes over from ended, whether to sign in at once.
  load: () => Promise<{ form?: ConnectionForm; error?: string; signIn?: boolean }>;
  start: (form: ConnectionForm) => Promise<{ shown?: string; error?: string }>;
  cancel: () => void;
  subscribe: (callback: (report: SignInReport) => void) => () => void;
};
export const desktopSignIns: SignIns = {
  load: () => window.desktop!.loadLauncher(),
  start: (form) => window.desktop!.startSignIn(form),
  cancel: () => void window.desktop!.cancelSignIn(),
  subscribe: (callback) => window.desktop!.onSignIn(callback),
};

const messageOf = (failure: unknown) =>
  String((failure as Error)?.message ?? failure).replace(/^.*?'[\w:]+': (Error: )?/, '');

// The sign-in window: every step of signing in shows here, until the service's window takes over. That is choosing
// the service, connecting, a refusal and why, a version to upgrade the client or the service to, and this
// computer's settings, which need no connection.
export default function Launcher({ signIns }: { signIns: SignIns }) {
  const [form, setForm] = useState<ConnectionForm>(() => ({
    url: window.desktop ? '' : (localStorage.getItem('proxy-url') ?? 'ws://127.0.0.1:8787/ws'),
    token: '',
    fingerprint: '',
    mode: window.desktop ? 'remote' : 'local',
    remember: false,
    autoLogin: false,
  }));
  // What the user has typed or chosen is not replaced by what is offered once it is read.
  const touched = useRef(false);
  const change = useCallback((values: Partial<ConnectionForm>) => {
    touched.current = true;
    setForm((current) => ({ ...current, ...values }));
  }, []);
  const [connecting, setConnecting] = useState(false);
  // The last word on the sign-in under way, or on the one that ended.
  const [report, setReport] = useState<SignInReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState('');
  const [notes, setNotes] = useState<string | null>(null);
  const [settings, setSettings] = useState<Section | null>(null);
  const [workspaceRoots, setWorkspaceRoots] = useState<string[]>([]);
  // How far an installer being fetched is, from 0 to 1.
  const [downloaded, setDownloaded] = useState<number | null>(null);
  // The settings page takes a client; this one never connects.
  const [client] = useState(() => new ProxyClient());
  useEffect(() => {
    void window.desktop?.version().then(setVersion);
  }, []);
  useEffect(
    () =>
      signIns.subscribe((next) => {
        setReport(next);
        if (next.status === 'disconnected') setConnecting(false);
      }),
    [signIns],
  );
  useEffect(
    () =>
      window.desktop?.onUpdateProgress(({ received, size }) =>
        setDownloaded(size ? received / size : 0),
      ),
    [],
  );
  const settingsOpen = settings !== null;
  useEffect(() => {
    if (settingsOpen) void window.desktop?.workspaceRoots().then(setWorkspaceRoots);
    void window.desktop?.widenLauncher?.(settingsOpen);
  }, [settingsOpen]);

  async function start(next: ConnectionForm) {
    setError(null);
    setReport(null);
    setConnecting(true);
    const result = await signIns.start(next).catch((failure: unknown) => ({
      shown: undefined,
      error: messageOf(failure),
    }));
    if (result.shown) setError(`“${result.shown}”已在另一个窗口登录，已切换到那个窗口。`);
    else if (result.error) setError(result.error);
    // Otherwise the reports tell how it goes.
    else return;
    setConnecting(false);
  }
  // What this window was opened for: a service to offer, to sign in to at once, or one whose sign-in ended.
  const loaded = useRef(false);
  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    void signIns.load().then(({ form: saved, error: ended, signIn }) => {
      // The installed client has no simulation mode, whatever an earlier version saved.
      const restored = saved && {
        ...saved,
        mode: !window.desktop || window.desktop.dev ? saved.mode : ('remote' as const),
      };
      if (ended) setError(ended);
      if (!restored || touched.current) return;
      setForm(restored);
      if (signIn) void start(restored);
    });
  }, []);
  function cancel() {
    signIns.cancel();
    setConnecting(false);
    setReport(null);
  }
  function install(target?: string) {
    setError(null);
    void window
      .desktop!.installUpdate(target)
      .catch((failure: unknown) => setError(messageOf(failure)))
      .finally(() => setDownloaded(null));
  }

  // A refusal for the version: the service's installer for this client, or the release page's; the notes of a
  // newer version; or an upgrade of a service older than this client.
  const ended = report?.status === 'disconnected' ? report : null;
  const refused = ended?.mismatch ? ended : null;
  const upgrade =
    window.desktop &&
    selfUpdating &&
    version &&
    refused?.release &&
    isNewer(refused.release, version)
      ? refused.release
      : null;
  const ahead =
    version && refused?.service && isNewer(refused.service, version) ? refused.service : null;
  const direct = window.desktop && selfUpdating ? ahead : null;
  const older =
    form.mode === 'remote' && version && refused?.service && isNewer(version, refused.service)
      ? refused.service
      : null;
  const failure = error ?? (ended && (ended.error ?? '没能连接到服务，请再试一次。'));
  const shown =
    failure && refused?.service && !upgrade && version && !error
      ? `${failure}${
          isNewer(version, refused.service)
            ? '此客户端较新，请先升级服务端。'
            : !selfUpdating
              ? '这个系统上的客户端需要手动升级：请到 GitHub 发布页下载与服务端同一版本的安装包。'
              : refused.preparing !== null
                ? `服务端正在下载这一版的安装包（${Math.floor(refused.preparing * 100)}%），稍后重新连接就能从服务端升级；也可以现在直接从 GitHub 发布页下载。`
                : '服务端还没有这一版的安装包，它会继续尝试下载；可以直接从 GitHub 发布页下载，或稍后重试。'
        }`
      : failure;
  const notesDialog = notes && (
    <Suspense fallback={null}>
      <ReleaseNotes version={notes} onClose={() => setNotes(null)} />
    </Suspense>
  );

  if (settings)
    return (
      <div className="settings-only">
        <div className="window-drag" />
        <SettingsPage
          client={client}
          section={settings}
          go={setSettings}
          back={() => setSettings(null)}
          native={false}
          account={null}
          form={form}
          changeForm={change}
          workspaceRoot={workspaceRoots[0] ?? ''}
          chooseWorkspace={(reset) => {
            void window.desktop
              ?.chooseWorkspace(reset)
              .then(setWorkspaceRoots, (failure: unknown) => setError(messageOf(failure)));
          }}
          version={version}
          service={null}
          adapterName=""
          updates={[]}
          showNotes={setNotes}
        />
        {notesDialog}
      </div>
    );
  return (
    <>
      {notesDialog}
      <LoginPage
        form={form}
        change={change}
        connecting={connecting}
        cancel={cancel}
        error={shown}
        upgrade={upgrade}
        direct={direct}
        downloaded={downloaded}
        install={install}
        older={older}
        newer={upgrade ?? ahead}
        showNotes={setNotes}
        submit={() => void start(form)}
        openSettings={() => setSettings('general')}
      />
    </>
  );
}
