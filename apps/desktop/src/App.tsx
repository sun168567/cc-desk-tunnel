import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import { flushSync } from 'react-dom';
import { wordsText } from '@cc-desk-tunnel/i18n';
import {
  CircleHelp,
  Download,
  FileDown,
  FolderInput,
  FolderMinus,
  FolderOpen,
  FolderSymlink,
  GitFork,
  Laptop,
  LogOut,
  Pencil,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  ScrollText,
  Settings,
  SquareTerminal,
  Trash2,
  Unplug,
  UserRound,
  X,
} from 'lucide-react';
import { GithubMark, openProject, project } from './project.tsx';
import type {
  Effort,
  EventPayload,
  PermissionMode,
  Project,
  Session,
  SessionEvent,
} from '@cc-desk-tunnel/protocol';
import { FORCED_UPGRADE_SINCE, platformOf, projectOf, runWorking } from '@cc-desk-tunnel/protocol';
import { browserSession, browserSocket, watchActivity } from './browser-api.ts';
import { CertificateWarning } from './WebGate.tsx';
import { hostCapabilities } from './host-capabilities.ts';
import AccountPanel from './AccountPanel.tsx';
import { QuotaSummary } from './QuotaSummary.tsx';
import { ProxyClient, RequestInterruptedError } from './client.ts';
import { Trans } from 'react-i18next';
import { say, useT } from './i18n.ts';
import Composer from './Composer.tsx';
import SessionBar from './SessionBar.tsx';
import { deviceName, isHere, thisDevice } from './device.ts';
import { selfUpdating } from './platform.ts';
import { useClientUpgrade } from './client-upgrade.ts';
import { useDrafts } from './drafts.ts';
import { useDrawerSwipe } from './useDrawerSwipe.ts';
import { useWebNavigation } from './useWebNavigation.ts';
import type { Place } from './useWebNavigation.ts';
import SchedulePanel from './SchedulePanel.tsx';
import { taskMessage, useSchedules } from './schedules.ts';
import type { Scenario } from './Composer.tsx';
import Conversation from './Conversation.tsx';
import FilePanel from './FilePanel.tsx';
import { filePlaces, nativeLabels, sessionFolder, sftpPath } from './files.ts';
import type { FilePlace } from './files.ts';
import type { ConnectionForm } from './LoginPage.tsx';
import type { SignInReport } from './Launcher.tsx';
import { exportSession } from './exportSession.ts';
import { useShared } from './shared.ts';
import { useNotifications } from './notifications.ts';
import { isInside, isNewer, pathKey, projectName } from './paths.ts';
import { getPrefs, setPrefs, toggled, usePrefs } from './prefs.ts';
import { UPDATE_TICK_MS, lookDue } from './update-check.ts';
import { actions, comboOf, keyFor, show as comboText } from './shortcuts.ts';
import type { Action } from './shortcuts.ts';
import { nextMode } from './modes.ts';
import Rail from './Rail.tsx';
import { setHelpOpener } from './help-nav.ts';
import { suggestions } from './help-content.ts';
import type { Target } from './help-content.ts';
import type { Page } from './Rail.tsx';
import {
  AddProjectDialog,
  DeleteSessionDialog,
  RenameProjectDialog,
  RenameSessionDialog,
} from './SessionDialogs.tsx';
import SettingsPage, { sections } from './SettingsPage.tsx';
import type { Section } from './SettingsPage.tsx';
import Sidebar from './Sidebar.tsx';
import TitleBar from './TitleBar.tsx';
import type { BarMenu } from './TitleBar.tsx';
import IdleReminder from './IdleReminder.tsx';
import { CcdtDialog } from './CcdtDialog.tsx';
import { SetupTokenDialog } from './SetupTokenDialog.tsx';
import { IconButton, Menu } from './ui.tsx';
import type { MenuItem, MenuPosition } from './ui.tsx';

// The notes of every version so far are read only when asked for, and stay out of what the window starts with.
const ReleaseNotes = lazy(() => import('./ReleaseNotes.tsx'));
const HelpCenter = lazy(() => import('./HelpCenter.tsx'));

// The newest event of a kind is the session's current native state.
function latest<T extends EventPayload['type']>(events: SessionEvent[], type: T) {
  return (events.findLast((event) => event.payload.type === type)?.payload ?? null) as Extract<
    EventPayload,
    { type: T }
  > | null;
}
// Which menu is open. Its items are built while rendering, so they follow the state as it changes.
type OpenMenu = MenuPosition &
  (
    | { kind: 'session'; sessionId: string }
    | { kind: 'project'; deviceId: string; path: string }
    | { kind: 'move'; sessionId: string }
    | { kind: 'settings' }
    | { kind: 'update' }
    | { kind: 'bar'; label: string }
  );
const narrow = () => matchMedia('(max-width: 700px)').matches;

// Owns the connection, the selection and every request; the components below render and report user intent.
// On the desktop the window is a connection's: it signs in with what its sign-in window handed over, tells that
// window how it goes until it has connected, and gives way to a sign-in window when the connection ends for good
// (see Launcher.tsx). Run in a browser from the source tree, the page that signs in passes the same as `signIn`,
// `report` and `leave` (see main.tsx). `browser`: the service's own page, signed in already.
export function App({
  browser,
  signIn,
  report,
  leave,
}: {
  browser?: { selfSigned: boolean; expired: () => void; logout: () => Promise<void> };
  signIn?: ConnectionForm;
  report?: (report: SignInReport) => void;
  leave?: (error: string | null) => void;
} = {}) {
  const t = useT();
  const host = hostCapabilities(!!browser);
  const [client] = useState(() => new ProxyClient());
  useEffect(() => {
    if (!browser) return;
    client.connectBrowser(
      browserSocket(),
      browser.expired,
      async () => (await browserSession()).authenticated,
    );
    return () => client.disconnect();
  }, [client, browser?.expired]);
  const inBrowser = !!browser;
  useEffect(
    () => (inBrowser ? watchActivity(() => client.markActive()) : undefined),
    [client, inBrowser],
  );
  const [clock] = useState(() => ({ now: client.serviceNow, activityAt: client.activityAt }));
  // The version whose notes are shown, over whichever page is up.
  const [notes, setNotes] = useState<string | null>(null);
  const notesDialog = notes && (
    <Suspense fallback={null}>
      <ReleaseNotes version={notes} onClose={() => setNotes(null)} />
    </Suspense>
  );
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const [form, setForm] = useState<ConnectionForm>(() => ({
    url: localStorage.getItem('proxy-url') ?? 'ws://127.0.0.1:8787/ws',
    token: '',
    fingerprint: '',
    mode: window.desktop ? 'remote' : 'local',
    remember: false,
    autoLogin: false,
  }));
  const changeForm = useCallback(
    (values: Partial<ConnectionForm>) => setForm((current) => ({ ...current, ...values })),
    [],
  );
  const [error, setError] = useState<string | RequestInterruptedError | null>(null);
  // One request at a time from this window; `refreshing` is the slower native status read.
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const statusPending = useRef(false);
  const [quotaError, setQuotaError] = useState<string | null>(null);
  const quotaPrimed = useRef<string | null>(null);
  const [findRequest, setFindRequest] = useState(0);
  const refreshed = useRef(new Set<string>());
  // The folders that hold plain sessions; new ones are made in the first.
  const [workspaceRoots, setWorkspaceRoots] = useState<string[]>([]);
  const [drafts, setDraft] = useDrafts();
  const [scenario, setScenario] = useState<Scenario>('chat');
  const [slashOpen, setSlashOpen] = useState(false);
  // The side column is shown beside the page on a wide window and laid over it on a narrow one.
  const [sideOpen, setSideOpen] = useState(() => !narrow());
  const [place, setPlace] = useState<Place>({
    page: 'chat',
    section: browser ? 'general' : 'account',
    sessionId: null,
  });
  const pendingPlace = useRef(place);
  const webNavigation = useWebNavigation(inBrowser, place, (next, drawer, direction) => {
    if (
      direction &&
      client.state.status === 'connected' &&
      next.sessionId &&
      !client.state.sessions.some((session) => session.id === next.sessionId)
    ) {
      webNavigation.step(webNavigation.canStep(direction) ? direction : -direction);
      return;
    }
    changePlace(next);
    if (narrow()) setSideOpen(drawer);
  });
  function changePlace(next: Place) {
    pendingPlace.current = next;
    const apply = () => {
      if (pendingPlace.current === next) setPlace(next);
    };
    if (
      narrow() &&
      document.startViewTransition &&
      (place.page === 'settings' || next.page === 'settings') &&
      (place.page !== next.page ||
        place.section !== next.section ||
        place.settingsIndex !== next.settingsIndex)
    ) {
      document.documentElement.style.setProperty(
        '--settings-shift',
        next.page !== 'settings' ||
          (place.page === 'settings' && next.settingsIndex && !place.settingsIndex)
          ? '-24px'
          : '24px',
      );
      document.startViewTransition(() => flushSync(apply));
    } else apply();
  }
  const changeSide = (open: boolean) => {
    if (inBrowser && narrow()) webNavigation.drawer(open);
    else setSideOpen(open);
  };
  const closeSide = () => {
    if (narrow()) changeSide(false);
  };
  // Crossing between the layouts also removes a narrow drawer's temporary history entry.
  useEffect(() => {
    const query = matchMedia('(max-width: 700px)');
    const follow = () => {
      if (inBrowser) webNavigation.drawer(false);
      setSideOpen(!query.matches);
    };
    query.addEventListener('change', follow);
    return () => query.removeEventListener('change', follow);
  }, [inBrowser]);
  useEffect(() => {
    if (!inBrowser || state.status !== 'connected') return;
    const id = place.sessionId;
    if (id && client.state.sessions.some((session) => session.id === id)) {
      if (client.state.selectedId !== id) client.select(id);
    } else if (client.state.selectedId) client.update({ selectedId: null });
  }, [client, inBrowser, place.sessionId, state.status]);
  const drawerSwipe = useDrawerSwipe(narrow() && place.page !== 'settings', sideOpen, changeSide);
  // Places visited, for the title bar's way back and forward.
  const trail = useRef<{ places: Place[]; at: number }>({ places: [place], at: 0 });
  const [, setTrailAt] = useState(0);
  const accountOpen = place.page === 'settings' && place.section === 'account';
  const prefs = usePrefs();
  const [version, setVersion] = useState('');
  useEffect(() => {
    void window.desktop?.version().then(setVersion);
  }, []);
  // Opening a session in ccdt found it not installed (`{}`), or of another release (`installed`).
  const [ccdtNeeded, setCcdtNeeded] = useState<{ installed?: string } | null>(null);
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteSession, setDeleteSession] = useState<Session | null>(null);
  const [renameSession, setRenameSession] = useState<Session | null>(null);
  const [renameProject, setRenameProject] = useState<Project | null>(null);
  const [repointProject, setRepointProject] = useState<string | null>(null);

  const nativeMode = state.adapter === 'claude-code';
  const connected = state.status === 'connected';
  const selfSigned = !!browser && (state.browser?.selfSigned ?? browser.selfSigned);
  const othersBusy = useShared('busy');
  const selected = state.sessions.find((session) => session.id === state.selectedId);
  // What is listed and managed here is what is on this computer. Sessions on the user's other computers are
  // shown apart: they can be read, worked on from here while their computer is connected, and taken over or
  // forked into a directory here.
  // Sessions from before computers were told apart name none, and would be listed on every one of the user's
  // computers. Their folders are looked for here; a session whose folder is not here goes with the other
  // computers' sessions, from where it can be taken over like any of them.
  const [absent, setAbsent] = useState<ReadonlySet<string>>(new Set());
  const unplaced = JSON.stringify(
    [
      ...new Set(
        state.sessions.filter((session) => !session.device).map((session) => session.projectPath),
      ),
    ].sort(),
  );
  useEffect(() => {
    const folders: string[] = JSON.parse(unplaced);
    if (!window.desktop || !folders.length) return;
    let current = true;
    void window.desktop.foldersExist(folders).then((found) => {
      if (current) setAbsent(new Set(folders.filter((_, index) => !found[index]).map(pathKey)));
    });
    return () => {
      current = false;
    };
  }, [unplaced]);
  const onThis = (session: Session) => !browser && isHere(session, state.device, absent);
  const sessions = state.sessions.filter((session) => onThis(session));
  const elsewhere = state.sessions.filter((session) => !onThis(session));
  // The user's other computers that are online, by name, for the help's examples.
  const onlineOthers = state.devices
    .filter((device) => device.ready && !device.server && device.id !== state.device?.id)
    .map((device) => device.name);
  // This computer's projects, as the service keeps them for all the user's computers.
  const projects = state.projects.filter((project) => project.device.id === state.device?.id);
  // The project a session is in, of whichever computer; one from before computers were told apart that is
  // listed here is this one's. A session in none is a plain session.
  const projectIn = (session: Session) =>
    projectOf(
      state.projects,
      session.device?.id ?? (onThis(session) ? state.device?.id : undefined),
      session.projectPath,
    );
  const away = !!selected && !onThis(selected);
  // Another computer's session is worked on from here while that computer is connected and its commands
  // reach it: what is sent here runs there, as if sent there.
  const reachable = (session: Session) =>
    state.devices.some((device) => device.id === session.device?.id && device.ready);
  const remote = away && reachable(selected);
  // The file panel, beside the conversation on the desktop, or as a page in its place.
  const filesAvailable = !browser && !!window.desktop?.files && place.page === 'chat';
  const filesOpen = filesAvailable && prefs.filePanel.open;
  const [filesPage, setFilesPage] = useState(false);
  const [filesWidth, setFilesWidth] = useState<number | null>(null);
  const [windowWidth, setWindowWidth] = useState(() => innerWidth);
  useEffect(() => {
    const resized = () => setWindowWidth(innerWidth);
    addEventListener('resize', resized);
    return () => removeEventListener('resize', resized);
  }, []);
  // The conversation keeps room enough beside it; on a narrow window the panel lies over it instead.
  const filesOver = windowWidth <= 1000;
  const filesMax = Math.max(
    280,
    windowWidth - 52 - (sideOpen && !filesOver ? 284 : 0) - (filesOver ? 0 : 380),
  );
  const filesShownWidth = Math.min(filesWidth ?? prefs.filePanel.width, filesMax);
  const toggleFiles = () => {
    setFilesPage(false);
    setPrefs((current) => ({
      ...current,
      filePanel: { ...current.filePanel, open: !current.filePanel.open },
    }));
  };
  const serverDevice = state.devices.find((device) => device.server)?.id;
  const filesPlaces = useMemo(
    () => filePlaces(state.device, state.devices, state.files),
    [state.device, state.devices, state.files],
  );
  const selectedForFiles = selected;
  const filesStart = useCallback(
    (where: FilePlace) =>
      sessionFolder(
        selectedForFiles ?? undefined,
        where,
        state.device,
        !!selectedForFiles && onThis(selectedForFiles),
        state.files,
        serverDevice,
      ),
    // A session's folders change with its project or computer, which the session record carries.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedForFiles, state.device, state.files, serverDevice],
  );
  // A path shown in the file panel from a link in the conversation: a path on this computer, or one on the
  // computer the session is on, which the panel reaches as that computer's (or the service's) files.
  const [filesRequest, setFilesRequest] = useState<{
    place: string;
    path: string;
    at: number;
  } | null>(null);
  const openInFiles = (path: string, here: boolean) => {
    const device = selected?.device;
    const placeId = here ? 'local' : device?.id === serverDevice ? 'server' : device?.id;
    if (!placeId || !filesPlaces.some((entry) => entry.id === placeId)) {
      setError(t('session:files.offline'));
      return;
    }
    setFilesPage(false);
    setPrefs((current) => ({ ...current, filePanel: { ...current.filePanel, open: true } }));
    setFilesRequest({
      place: placeId,
      path: placeId === 'local' || placeId === 'server' ? path : sftpPath(path, platformOf(device)),
      at: Date.now(),
    });
  };
  function resizeFiles(event: ReactPointerEvent<HTMLDivElement>) {
    const startX = event.clientX;
    const startWidth = filesShownWidth;
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    let width = startWidth;
    const move = (moved: PointerEvent) => {
      width = Math.round(Math.max(280, Math.min(filesMax, startWidth + startX - moved.clientX)));
      setFilesWidth(width);
    };
    const done = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', done);
      handle.removeEventListener('pointercancel', done);
      setFilesWidth(null);
      setPrefs((current) => ({ ...current, filePanel: { ...current.filePanel, width } }));
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', done);
    handle.addEventListener('pointercancel', done);
  }
  // Two connections may have Claude working in one folder at once, each unaware of the other. A window tells
  // the others what it has running, and says so when another's session works where the shown one does. A
  // session this window lists too is the same service's and no other.
  const running = JSON.stringify(
    connected
      ? sessions
          .filter((session) => session.activeRun)
          .map((session) => ({ id: session.id, folder: session.projectPath }))
      : [],
  );
  useEffect(() => {
    void window.desktop?.setBusy(JSON.parse(running));
  }, [running]);
  const overlaps = (one: string, other: string) =>
    pathKey(one) === pathKey(other) || isInside(one, [other]) || isInside(other, [one]);
  const beside =
    selected && !away
      ? othersBusy
          .filter((entry) =>
            entry.runs.some(
              (run) =>
                !state.sessions.some((session) => session.id === run.id) &&
                overlaps(run.folder, selected.projectPath),
            ),
          )
          .map((entry) => `“${entry.name}”`)
      : [];
  const recorded = selected ? state.events[selected.id] : undefined;
  const unfinished = selected ? state.live[selected.id] : undefined;
  const events = useMemo(
    () => (selected ? client.shown(selected.id) : []),
    // What is shown changes with these two.
    [selected?.id, recorded, unfinished],
  );
  const history = selected ? state.history[selected.id] : undefined;
  const nativeSession = latest(events, 'native.session');
  // Each turn's report is a reason to ask for the session's figures again.
  const turnReports = useMemo(
    () => events.filter((event) => event.payload.type === 'turn.stats').length,
    [events],
  );
  const capabilities = latest(events, 'native.capabilities') ?? state.capabilities;
  const metrics = latest(events, 'native.metrics');
  const canCompact = !!latest(events, 'native.context')?.persisted;
  // A chat run holds the CLI's state while it goes; a terminal holds only its own session.
  const anyChat = state.sessions.some(
    (session) => session.activeRun && session.activeRun.surface !== 'terminal',
  );
  const controlsDisabled =
    !connected || busy || refreshing || !!selected?.activeRun || !!history?.loading;
  // A run is that of the computer its session is on, whichever window of whichever computer started it; any
  // of them answers and stops it while that computer can be reached.
  const ownsRun = !!selected?.activeRun && (!away || remote);
  // A native run accepts follow-up messages from wherever it can be worked on; a terminal takes them itself.
  const inputDisabled =
    !connected ||
    busy ||
    !!history?.loading ||
    selected?.activeRun?.surface === 'terminal' ||
    (!!selected?.activeRun && (!nativeMode || !ownsRun)) ||
    refreshing;
  const draft = selected ? (drafts[selected.id] ?? '') : '';
  // The last turn of the session did not reach its end: it can be taken up again from the message box.
  const lastStatus = selected
    ? state.events[selected.id]?.findLast((event) => event.payload.type === 'run.status')?.payload
    : undefined;
  const stopped =
    !!selected &&
    !selected.activeRun &&
    (!away || remote) &&
    lastStatus?.type === 'run.status' &&
    lastStatus.surface !== 'terminal' &&
    (lastStatus.status === 'cancelled' || lastStatus.status === 'failed');
  const signedOut = state.account?.loggedIn === false;
  // The account's quota, as the service holds it; no session's figures carry it.
  const quota = signedOut ? null : state.quota;
  const quotaSession = selected ?? state.sessions[0];
  const actionError = error instanceof RequestInterruptedError ? error.describe(connected) : error;
  const currentError = actionError ?? state.error;
  // Offered when the service holds a newer installer than the running client.
  const upgrade =
    selfUpdating && version && state.release && isNewer(state.release, version)
      ? state.release
      : null;
  // A service newer than this client that holds no installer for it yet, as just after its own upgrade: the
  // release page has it. The service tells when its own arrives.
  const behind =
    selfUpdating && version && state.service && isNewer(state.service, version) && !upgrade
      ? state.service
      : null;
  const upgrading = useClientUpgrade(setError);
  // A service of a newer version: what that version changed can be read here, whether or not this system's
  // client upgrades itself.
  const ahead =
    state.mismatch && version && state.service && isNewer(state.service, version)
      ? state.service
      : null;

  // A check or an upgrade of the service that failed says why to whoever asked for it. The checks a window makes by
  // itself while it is in use fail quietly, to be made again within the hour.
  const live = state.update;
  const asked = useRef(false);
  useEffect(() => {
    if (live?.state === 'failed' && live.detail && asked.current) setError(say(live.detail));
    if (live && !['checking', 'installing'].includes(live.state)) asked.current = false;
  }, [live]);
  // While the service looks again, the release it found last stays offered.
  const [settled, setSettled] = useState(live);
  useEffect(() => {
    if (live?.state !== 'checking') setSettled(live);
  }, [live]);
  const update =
    live?.state === 'checking' && settled && ['available', 'manual'].includes(settled.state)
      ? settled
      : live;
  // While this window is shown, the service looks for a new release at least hourly (see update-check.ts).
  useEffect(() => {
    if (!host.serviceManagement || !nativeMode || !connected) return;
    const look = () => {
      if (!document.hidden && lookDue(client.state.update, Date.now()))
        void client.request({ type: 'service.update.check' }).catch(() => {});
    };
    look();
    const timer = setInterval(look, UPDATE_TICK_MS);
    document.addEventListener('visibilitychange', look);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', look);
    };
  }, [client, nativeMode, connected]);
  // Upgrading the service restarts it. Sessions at work are cut off, so the upgrade asks to be forced past them; an
  // open terminal at rest and background tasks a finished turn left only end. A service before FORCED_UPGRADE_SINCE
  // refuses while anything runs, terminals at rest included, and cannot be forced.
  const working = state.sessions.filter((item) => runWorking(item.activeRun));
  const resting = state.sessions.filter((item) => item.activeRun && !runWorking(item.activeRun));
  const titles = (sessions: Session[]) => {
    const shown = sessions.slice(0, 3).map((item) => item.title);
    return sessions.length > 3
      ? t('connection:update.titlesMore', { titles: shown, count: sessions.length })
      : t('connection:update.titles', { titles: shown });
  };
  const forcible =
    !!state.service &&
    state.service.localeCompare(FORCED_UPGRADE_SINCE, undefined, { numeric: true }) >= 0;
  const serviceUpdate = !nativeMode
    ? null
    : update?.state === 'available'
      ? {
          label: working.length
            ? t('connection:update.serverWorking', {
                version: update.latest ?? '',
                count: working.length,
              })
            : !forcible && resting.length
              ? t('connection:update.serverResting', { version: update.latest ?? '' })
              : t('connection:update.server', { version: update.latest ?? '' }),
          icon: <Download />,
          disabled: busy || (!forcible && (working.length > 0 || resting.length > 0)),
          run: () => {
            const force = working.length > 0;
            const question = force
              ? t('connection:update.forceQuestion', {
                  titles: titles(working),
                  count: working.length,
                  version: update.latest ?? '',
                })
              : [
                  t('connection:update.question', { version: update.latest ?? '' }),
                  ...(resting.length
                    ? [
                        t('connection:update.restingEnd', {
                          titles: titles(resting),
                          count: resting.length,
                        }),
                      ]
                    : []),
                  t('connection:update.continue'),
                ].join('\n\n');
            if (window.confirm(question))
              void act(async () => {
                asked.current = true;
                await client.request({
                  type: 'service.update.install',
                  version: update.latest!,
                  ...(force ? { force } : {}),
                });
              });
          },
        }
      : update?.state === 'manual'
        ? {
            label: t('connection:update.manual', { version: update.latest ?? '' }),
            icon: <Download />,
            disabled: true,
            run: () => undefined,
          }
        : update?.state === 'installing' || update?.state === 'restarting'
          ? {
              label: t('connection:update.installing', {
                step: update.detail
                  ? wordsText(t, update.detail)
                  : t('connection:update.restarting'),
              }),
              icon: <RefreshCw />,
              disabled: true,
              run: () => undefined,
            }
          : {
              label:
                update?.state === 'checking'
                  ? t('connection:update.checking')
                  : update?.state === 'idle' && update.checkedAt
                    ? t('connection:update.latest', { version: state.service ?? '' })
                    : t('connection:update.check'),
              icon: <RefreshCw />,
              disabled: busy || update?.state === 'checking',
              run: () => {
                void act(async () => {
                  asked.current = true;
                  await client.request({ type: 'service.update.check' });
                });
              },
            };

  // The sign-in handed over connects once the page is up. Until it has connected, the sign-in window hears how
  // it goes; once it has, the window is the connection's.
  const attempted = useRef(false);
  const entered = useRef(false);
  const tell = (next: SignInReport) => void (report ?? window.desktop?.reportSignIn)?.(next);
  const signOut = (why: string | null) => void (leave ?? window.desktop?.signOut)?.(why);
  // Taken after the page is up, once: a page mounted twice in development leaves its first client disconnected.
  useEffect(() => {
    if (browser) return;
    let current = true;
    void (signIn ? Promise.resolve(signIn) : (window.desktop?.loadLogin() ?? null))?.then(
      (saved) => {
        if (!current || !saved) return;
        // The installed client has no simulation mode, whatever an earlier version saved.
        const restored =
          !window.desktop || window.desktop.dev ? saved : { ...saved, mode: 'remote' as const };
        setForm(restored);
        void login(restored);
      },
    );
    return () => {
      current = false;
    };
  }, []);
  useEffect(() => {
    if (browser || entered.current || !attempted.current || state.status === 'reconnecting') return;
    if (state.status === 'connected') entered.current = true;
    tell({
      status:
        state.status === 'connected' || state.status === 'disconnected'
          ? state.status
          : 'connecting',
      error: state.error,
      mismatch: state.mismatch,
      service: state.service,
      release: state.release,
      preparing: state.preparing,
    });
  }, [state.status, state.error, state.mismatch, state.service, state.release, state.preparing]);
  useEffect(() => {
    if (connected) void window.desktop?.saveLogin(form);
  }, [connected, form.remember, form.autoLogin]);
  // A page that goes with its window, as the program quits, has not signed out.
  const unloading = useRef(false);
  useEffect(() => {
    const close = () => {
      unloading.current = true;
      client.disconnect();
    };
    // The system says the network is back: the attempt that was waiting for its turn is made now.
    const retry = () => client.retryNow();
    window.addEventListener('beforeunload', close);
    window.addEventListener('online', retry);
    return () => {
      window.removeEventListener('beforeunload', close);
      window.removeEventListener('online', retry);
      client.disconnect();
    };
  }, [client, changeForm]);
  // A connection that breaks is made again by the client, and the window stays where it is. Over for good, ended
  // here or refused by the service, it gives way to a sign-in window that says why; the service's own page signs in
  // again by itself.
  const signedIn = useRef(false);
  useEffect(() => {
    if (state.status === 'connected' || state.status === 'reconnecting') {
      signedIn.current = true;
      return;
    }
    if (state.status !== 'disconnected' || !signedIn.current) return;
    signedIn.current = false;
    void window.desktop?.disconnectProxy();
    if (!browser) return unloading.current ? undefined : signOut(client.state.error);
    if (client.state.error)
      notifications.push({
        kind: 'connection',
        title: t('nav:notice.disconnected'),
        body: client.state.error.split('\n')[0],
      });
  }, [state.status]);
  useEffect(() => {
    if (!connected) setMenu(null);
  }, [connected]);
  useEffect(() => {
    if (connected) void window.desktop?.workspaceRoots().then(setWorkspaceRoots);
  }, [connected]);
  // Before the service kept the projects, the computer kept one list for all its connections. A connection there
  // was then hands it to its service once (see `projects:legacy` in electron/main.cjs).
  useEffect(() => {
    if (!connected || !window.desktop) return;
    void (async () => {
      const legacy = await window.desktop!.legacyProjects();
      if (!legacy) return;
      for (const path of legacy.projects) {
        const name = legacy.names[pathKey(path)]?.trim().slice(0, 60);
        await client.request({ type: 'project.add', path, ...(name ? { name } : {}) });
      }
      await window.desktop!.legacyProjectsMoved();
    })().catch(() => {});
  }, [connected]);
  // Each session's native state is read once when it is first shown idle.
  useEffect(() => {
    if (
      !nativeMode ||
      !selected ||
      !connected ||
      history?.loading ||
      selected.activeRun ||
      anyChat ||
      refreshed.current.has(selected.id)
    )
      return;
    refreshed.current.add(selected.id);
    void refreshStatus(selected.id);
  }, [nativeMode, selected?.id, connected, history?.loading, selected?.activeRun, anyChat]);
  useEffect(() => {
    if (nativeMode && connected) void client.request({ type: 'account.status' }).catch(() => {});
  }, [nativeMode, connected, accountOpen]);
  // The browser has no local sessions; before it opens a conversation it shows the quota the service holds, as the
  // desktop account page does. Only the refresh button asks the service to read it anew.
  useEffect(() => {
    if (!connected || signedOut) quotaPrimed.current = null;
    if (
      !inBrowser ||
      !nativeMode ||
      !connected ||
      (selected && !accountOpen) ||
      !quotaSession ||
      state.account?.loggedIn !== true ||
      quota?.rateLimits ||
      refreshing ||
      statusPending.current ||
      quotaPrimed.current === quotaSession.id
    )
      return;
    quotaPrimed.current = quotaSession.id;
    refreshQuota(false);
  }, [
    inBrowser,
    nativeMode,
    connected,
    signedOut,
    selected?.id,
    accountOpen,
    quotaSession?.id,
    state.account?.loggedIn,
    !!quota?.rateLimits,
    refreshing,
  ]);
  // The service's idle compaction setting decides which reminder a session shows.
  useEffect(() => {
    if (nativeMode && connected) void client.request({ type: 'compaction.get' }).catch(() => {});
  }, [nativeMode, connected]);
  // Each connection tells the service anew whether this client wants the quota kept current.
  useEffect(() => {
    if (nativeMode && connected)
      void client.request({ type: 'quota.watch', active: prefs.quotaReads }).catch(() => {});
  }, [nativeMode, connected, prefs.quotaReads]);
  useEffect(() => {
    if (
      !accountOpen ||
      inBrowser ||
      !nativeMode ||
      !connected ||
      state.capabilities ||
      state.account?.loggedIn !== true ||
      refreshing ||
      anyChat
    )
      return;
    void refreshStatus();
  }, [accountOpen, inBrowser, nativeMode, connected, state.capabilities, state.account?.loggedIn]);

  async function act(action: () => Promise<void>) {
    setError(null);
    setBusy(true);
    try {
      await action();
    } catch (error) {
      setError(
        error instanceof RequestInterruptedError
          ? error
          : error instanceof Error
            ? error.message
            : t('common:failed'),
      );
    } finally {
      setBusy(false);
    }
  }
  // Remote mode connects through the main process, which opens the tunnel and returns a loopback address.
  async function login(form: ConnectionForm) {
    setError(null);
    attempted.current = true;
    try {
      if (form.mode === 'remote') {
        // The address here only has to be a loopback one; each attempt gets its own from the bridge it opens.
        client.connect(
          'ws://127.0.0.1/ws',
          form.token,
          await thisDevice(),
          true,
          async () =>
            (
              await window.desktop!.connectProxy({
                url: form.url,
                fingerprint: form.fingerprint,
                waits: getPrefs().connection,
              })
            ).url,
        );
      } else {
        client.connect(form.url, form.token, await thisDevice());
      }
      localStorage.setItem('proxy-url', form.url);
    } catch (error) {
      if (form.mode === 'remote') await window.desktop?.disconnectProxy();
      tell({
        status: 'disconnected',
        error: error instanceof Error ? error.message : t('connection:connectFailed'),
        mismatch: false,
        service: null,
        release: null,
        preparing: null,
      });
    }
  }
  function stopRun() {
    if (!selected?.activeRun) return;
    const { id: sessionId, activeRun } = selected;
    void act(async () => {
      await client.request({ type: 'run.cancel', sessionId, runId: activeRun.id });
    });
  }
  function disconnect() {
    if (browser) {
      void act(browser.logout);
      return;
    }
    signedIn.current = false;
    client.disconnect();
    void window.desktop?.disconnectProxy();
    signOut(null);
  }
  // Moves the window to a place and remembers it; going back or forward revisits without adding to the trail.
  function visit(next: Place, record = true) {
    if (inBrowser) {
      webNavigation.visit(next);
      return;
    }
    if (next.sessionId && next.sessionId !== client.state.selectedId) client.select(next.sessionId);
    changePlace(next);
    closeSide();
    if (!record) return;
    const { places, at } = trail.current;
    const last = places[at];
    if (
      last.page === next.page &&
      last.section === next.section &&
      last.settingsIndex === next.settingsIndex &&
      last.sessionId === next.sessionId &&
      last.article === next.article
    )
      return;
    trail.current = { places: [...places.slice(0, at + 1), next].slice(-50), at: 0 };
    trail.current.at = trail.current.places.length - 1;
    setTrailAt(trail.current.at);
  }
  function step(by: number) {
    if (inBrowser) {
      webNavigation.step(by);
      return;
    }
    const { places } = trail.current;
    // Sessions deleted since are passed over.
    for (let at = trail.current.at + by; at >= 0 && at < places.length; at += by) {
      const target = places[at];
      if (target.sessionId && !state.sessions.some((item) => item.id === target.sessionId))
        continue;
      trail.current.at = at;
      setTrailAt(at);
      visit(target, false);
      return;
    }
  }
  const stepAvailable = (by: number) => {
    if (inBrowser) return webNavigation.canStep(by);
    const { places } = trail.current;
    for (let at = trail.current.at + by; at >= 0 && at < places.length; at += by)
      if (!places[at].sessionId || state.sessions.some((item) => item.id === places[at].sessionId))
        return true;
    return false;
  };
  const show = (sessionId: string) => visit({ ...place, page: 'chat', sessionId });
  // The help, at an article or its front page; any "?" in the window comes here.
  const showHelp = (article?: string) => visit({ ...place, page: 'help', article });
  useEffect(() => {
    setHelpOpener(showHelp);
    return () => setHelpOpener(null);
  });
  // What an article's button stands for: a setting, or something the window does.
  const runHelp = (target: Target) => {
    if ('article' in target) return showHelp(target.article);
    if ('settings' in target) return open('settings', target.settings);
    if (target.doing === 'schedules') return open('schedules');
    open('chat');
    if (target.doing === 'addProject') void addProject();
    else if (target.doing === 'newSession') void newSession();
    else if (target.doing === 'files' && !prefs.filePanel.open) toggleFiles();
  };
  // A new session with words put in its input box, for the user to change and send.
  async function startWith(text: string) {
    const made = await newSession();
    if (made) setDraft(made, text);
  }
  const open = (page: Page, section: Section = place.section) => {
    if (!host.schedules && page === 'schedules') return;
    if (
      (!host.nativeSettings &&
        ['connection', 'context', 'claude', 'instructions'].includes(section)) ||
      (section === 'connection' && !window.desktop)
    )
      section = 'general';
    visit({ page, section, sessionId: client.state.selectedId });
  };
  // The session in ccdt, signed in as this window is; the window says how to install ccdt where it is missing.
  async function openInCcdt(session: Session) {
    await act(async () => {
      const opened = await window.desktop!.openInCcdt({
        url: form.url,
        fingerprint: form.fingerprint,
        token: form.token,
        sessionId: session.id,
        projectPath: onThis(session) ? session.projectPath : undefined,
      });
      if (opened.status !== 'opened')
        setCcdtNeeded(opened.status === 'outdated' ? { installed: opened.installed } : {});
    });
  }
  // `quota`: asked for on the account page, which reads the plan quota anew.
  async function refreshStatus(
    sessionId = selected?.id ?? sessions[0]?.id,
    quota = false,
    reportError: (error: string | RequestInterruptedError) => void = setError,
  ) {
    if (!sessionId || statusPending.current) return;
    statusPending.current = true;
    setRefreshing(true);
    try {
      await client.request({ type: 'session.status', sessionId, ...(quota ? { quota } : {}) });
    } catch (error) {
      reportError(
        error instanceof RequestInterruptedError
          ? error
          : error instanceof Error
            ? error.message
            : t('session:statusFailed'),
      );
    } finally {
      statusPending.current = false;
      setRefreshing(false);
    }
  }
  // `quota`: read the plan quota anew (the refresh button); without it the service answers with what it holds.
  function refreshQuota(quota = true) {
    if (!connected || signedOut || !quotaSession || statusPending.current) return;
    setQuotaError(null);
    void refreshStatus(quotaSession.id, quota, (error) =>
      setQuotaError(
        error instanceof RequestInterruptedError
          ? error.describe(client.state.status === 'connected')
          : error,
      ),
    );
  }
  // In a folder of this computer, which becomes a project unless the session is a plain one.
  async function createSession(projectPath: string, plain = false) {
    const response = await client.request({
      type: 'session.create',
      title: t('session:newTitle'),
      autoTitle: true,
      projectPath,
      ...(plain ? { plain } : {}),
    });
    if (response.sessionId) show(response.sessionId);
    return response.sessionId;
  }
  async function createInProject(path: string) {
    await act(async () => {
      await createSession(path);
    });
  }
  // A session in a project of another of the user's computers that is connected.
  async function createElsewhere(deviceId: string, projectPath: string) {
    await act(async () => {
      const response = await client.request({
        type: 'session.create',
        title: t('session:newTitle'),
        autoTitle: true,
        projectPath,
        deviceId,
      });
      if (response.sessionId) show(response.sessionId);
    });
  }
  async function addProject() {
    if (!window.desktop?.chooseProject) {
      setCreateOpen(true);
      return;
    }
    await act(async () => {
      const path = await window.desktop!.chooseProject();
      if (path) await client.request({ type: 'project.add', path });
    });
  }
  // The desktop gives an ordinary session a local directory; the browser creates one on the server.
  async function newSession(): Promise<string | undefined> {
    let made: string | undefined;
    if (browser) {
      await act(async () => {
        const response = await client.request({
          type: 'server.session.create',
          title: t('session:newTitle'),
          autoTitle: true,
        });
        made = response.sessionId;
        if (made) show(made);
      });
      return made;
    }
    if (window.desktop) {
      await act(async () => {
        const directory = await window.desktop!.createWorkspace();
        try {
          made = await createSession(directory, true);
        } catch (error) {
          await window.desktop!.removeWorkspace(directory);
          throw error;
        }
      });
      return made;
    }
    const path =
      (away ? undefined : selected?.projectPath) ?? projects[0]?.path ?? sessions[0]?.projectPath;
    if (path)
      await act(async () => {
        made = await createSession(path);
      });
    else await addProject();
    return made;
  }
  // A due task is an ordinary message: to its session once that is idle, or to a session made for it. It is
  // never queued into a run, and waits while a terminal holds a session of this computer.
  const notifications = useNotifications(client, () =>
    place.page === 'chat' ? client.state.selectedId : null,
  );
  useEffect(() => window.desktop?.onNotifyClicked((sessionId) => sessionId && show(sessionId)));
  const schedules = useSchedules(
    async (task, due) => {
      const { status, sessions, selectedId, device } = client.state;
      if (
        status !== 'connected' ||
        sessions.some(
          (session) => session.activeRun?.surface === 'terminal' && isHere(session, device),
        )
      )
        return false;
      let session: Session | undefined;
      if (task.target.type === 'session') {
        const { sessionId } = task.target;
        session = sessions.find((item) => item.id === sessionId);
        if (!session) throw new Error(t('session:schedule.targetGone'));
        if (session.activeRun) return false;
      } else {
        const created = await client.request({
          type: 'session.create',
          title: task.name,
          projectPath: task.target.projectPath,
        });
        session = client.state.sessions.find((item) => item.id === created.sessionId);
        if (!session) throw new Error(t('session:schedule.createFailed'));
        // Creating a session moved the live stream to it; the session being read takes it back.
        if (selectedId) client.select(selectedId);
      }
      if (
        (task.model && task.model !== session.model) ||
        (task.effort && task.effort !== session.effort)
      )
        await client.request({
          type: 'session.configure',
          sessionId: session.id,
          permissionMode: session.permissionMode,
          model: task.model ?? session.model,
          effort: task.effort ?? session.effort,
        });
      await client.request({
        type: 'message.send',
        sessionId: session.id,
        text: taskMessage(task, due),
        scenario: 'chat',
      });
      return true;
    },
    (task, outcome) =>
      notifications.push({
        kind: 'schedule',
        title: t('nav:notice.scheduleNotSent'),
        body: t('nav:notice.scheduleOutcome', { name: task.name, text: outcome.text }),
      }),
    host.schedules,
  );
  // Where a session of another computer is to be on this one; null when the user gives none.
  async function placeHere(session: Session) {
    const path = window.desktop
      ? await window.desktop.chooseProject()
      : window.prompt(t('session:project.pathHere'), session.projectPath);
    return path?.trim() || null;
  }
  // Moves a session to a directory chosen here, on this computer, which also takes it over from the computer
  // it was on: from the next message Claude works there.
  async function takeOver(session: Session) {
    await act(async () => {
      const projectPath = await placeHere(session);
      if (!projectPath) return;
      await client.request({ type: 'session.move', sessionId: session.id, projectPath });
    });
  }
  // A fork continues from the same context in a session of its own. Forking before a message brings that
  // message back as a draft, which is how an earlier message is edited and sent again.
  async function fork(session: Session, before?: { id: string; text: string }) {
    await act(async () => {
      // The copy of a session that is on another computer needs a directory on this one.
      const projectPath = onThis(session) ? undefined : await placeHere(session);
      if (projectPath === null) return;
      const response = await client.request({
        type: 'session.fork',
        sessionId: session.id,
        title: t('session:fork.title', { title: session.title.slice(0, 116) }),
        ...(before ? { beforeMessageId: before.id } : {}),
        ...(projectPath ? { projectPath } : {}),
      });
      if (!response.sessionId) return;
      if (before) setDraft(response.sessionId, before.text);
      show(response.sessionId);
    });
  }
  async function send(text = draft) {
    if (!selected || !text.trim() || inputDisabled) return;
    const sessionId = selected.id;
    setSlashOpen(false);
    await act(async () => {
      await client.request({ type: 'message.send', sessionId, text, scenario });
      setDraft(sessionId, '');
    });
  }
  // Takes up the last turn, which was stopped or cut off, without the user writing anything.
  function resume() {
    if (!selected) return;
    const sessionId = selected.id;
    void act(async () => {
      await client.request({ type: 'run.continue', sessionId });
    });
  }
  async function compact() {
    if (!selected || controlsDisabled || !canCompact) return;
    setSlashOpen(false);
    setDraft(selected.id, '');
    await act(async () => {
      await client.request({ type: 'session.compact', sessionId: selected.id });
    });
  }
  async function configure(values: {
    model?: string | null;
    effort?: Effort | null;
    permissionMode?: PermissionMode;
  }) {
    if (!selected) return;
    await act(async () => {
      await client.request({
        type: 'session.configure',
        sessionId: selected.id,
        permissionMode: selected.permissionMode,
        ...values,
      });
    });
  }
  function sessionMenu(session: Session): MenuItem[] {
    const idle = connected && !busy;
    const pinned = prefs.pinnedSessions.includes(session.id);
    return [
      {
        label: pinned ? t('nav:unpin') : t('nav:pin'),
        icon: pinned ? <PinOff /> : <Pin />,
        run: () =>
          setPrefs((value) => ({
            ...value,
            pinnedSessions: toggled(value.pinnedSessions, session.id),
          })),
      },
      {
        label: t('session:action.rename'),
        icon: <Pencil />,
        disabled: !idle || !!session.activeRun,
        run: () => {
          setError(null);
          closeSide();
          setRenameSession(session);
        },
      },
      ...(host.localProjects
        ? [
            {
              label: t('session:action.fork'),
              icon: <GitFork />,
              disabled: !idle || !!session.activeRun,
              run: () => {
                void fork(session);
              },
            },
          ]
        : []),
      {
        label: t('session:action.export'),
        icon: <FileDown />,
        disabled: !connected,
        run: () => {
          void act(async () => {
            await exportSession(client, session);
          });
        },
      },
      {
        label: t('session:action.resync'),
        icon: <RefreshCw />,
        disabled: !connected,
        run: () => client.resync(session.id),
      },
      // To a project here or of another connected computer; the browser keeps no projects.
      ...(!browser
        ? [
            {
              label: t('session:action.move'),
              icon: <FolderSymlink />,
              disabled: !idle || !!session.activeRun,
              run: () => {
                if (menu) setMenu({ ...menu, kind: 'move', sessionId: session.id });
              },
            },
          ]
        : []),
      ...(nativeMode && host.terminalClient
        ? [
            {
              label: t('session:action.ccdt'),
              icon: <SquareTerminal />,
              // ccdt takes over a terminal of its own left on the session; a chat run has to end first.
              disabled: !idle || (!!session.activeRun && session.activeRun.surface !== 'terminal'),
              run: () => {
                void openInCcdt(session);
              },
            },
          ]
        : []),
      ...(nativeMode
        ? [
            {
              label: t('session:action.refresh'),
              icon: <RefreshCw />,
              disabled: !idle || anyChat || refreshing || !!history?.loading,
              run: () => {
                void refreshStatus(session.id);
              },
            },
          ]
        : []),
      {
        label: t('session:action.delete'),
        icon: <Trash2 />,
        danger: true,
        separated: true,
        disabled: !connected || !!session.activeRun,
        run: () => {
          setError(null);
          closeSide();
          setDeleteSession(session);
        },
      },
    ];
  }
  // A project of this computer or of another of the user's, connected or not. Only this computer's are pinned,
  // opened or pointed at another folder here; a new session goes into another computer's while it is connected.
  function projectMenu(entry: Project): MenuItem[] {
    const { path } = entry;
    const here = entry.device.id === state.device?.id;
    const key = pathKey(path);
    const pinned = prefs.pinnedProjects.includes(key);
    const reached = state.devices.some((device) => device.id === entry.device.id && device.ready);
    return [
      {
        label: t('nav:newSession'),
        icon: <Plus />,
        disabled: !connected || busy || refreshing || (!here && !reached),
        run: () => {
          void (here ? createInProject(path) : createElsewhere(entry.device.id, path));
        },
      },
      ...(here
        ? [
            {
              label: pinned ? t('nav:unpin') : t('nav:pin'),
              icon: pinned ? <PinOff /> : <Pin />,
              run: () =>
                setPrefs((value) => ({
                  ...value,
                  pinnedProjects: toggled(value.pinnedProjects, key),
                })),
            },
          ]
        : []),
      {
        label: t('session:project.rename'),
        icon: <Pencil />,
        disabled: !connected,
        run: () => {
          setError(null);
          setRenameProject(entry);
        },
      },
      ...(here
        ? [
            {
              label: t('session:project.changeFolder'),
              icon: <FolderInput />,
              disabled: !connected || busy,
              run: () => {
                if (!window.desktop) return setRepointProject(path);
                void act(async () => {
                  const chosen = await window.desktop!.chooseProject();
                  if (chosen) await repoint(path, chosen);
                });
              },
            },
          ]
        : []),
      ...(here && window.desktop
        ? [
            {
              label: t('session:project.openFolder'),
              icon: <FolderOpen />,
              separated: true,
              run: () => {
                void act(() => window.desktop!.openFolder(path));
              },
            },
          ]
        : []),
      // The folder and its sessions stay; the sessions are plain ones until it is a project again.
      {
        label: t('session:project.remove'),
        icon: <FolderMinus />,
        danger: true,
        separated: true,
        disabled: !connected || busy,
        run: () => {
          void act(async () => {
            await client.request({ type: 'project.remove', deviceId: entry.device.id, path });
          });
        },
      },
    ];
  }
  // Every project the session could belong to, the one it is in marked. A session of another computer is in
  // none of them, also when a folder here has the same path: moving it into one takes it over.
  function moveMenu(session: Session): MenuItem[] {
    const here = onThis(session);
    return [
      ...projects.map((entry) => ({
        label: projectName(entry),
        detail: entry.path,
        checked: here && pathKey(entry.path) === pathKey(session.projectPath),
        run: () => {
          if (!here || pathKey(entry.path) !== pathKey(session.projectPath))
            void act(async () => {
              await client.request({
                type: 'session.move',
                sessionId: session.id,
                projectPath: entry.path,
              });
            });
        },
      })),
      // The projects of the user's other computers that are connected, under each computer's name.
      ...state.devices
        .filter((device) => device.id !== state.device?.id && !device.server && device.ready)
        .flatMap((device) =>
          state.projects
            .filter((entry) => entry.device.id === device.id)
            .map((entry, index) => ({
              label: projectName(entry),
              detail: `${device.name} · ${entry.path}`,
              separated: index === 0,
              checked:
                session.device?.id === device.id &&
                pathKey(entry.path) === pathKey(session.projectPath),
              run: () => {
                if (
                  session.device?.id !== device.id ||
                  pathKey(entry.path) !== pathKey(session.projectPath)
                )
                  void act(async () => {
                    await client.request({
                      type: 'session.move',
                      sessionId: session.id,
                      projectPath: entry.path,
                      deviceId: device.id,
                    });
                  });
              },
            })),
        ),
      // A folder that is no project yet becomes one with the move.
      {
        label: t('session:project.otherFolder'),
        icon: <FolderOpen />,
        separated: true,
        run: () => {
          void takeOver(session);
        },
      },
    ];
  }
  // Points a project at another folder: the service moves it there, its name and place in the list along with its
  // sessions and what Claude Code keeps of it, and this computer's pin follows.
  async function repoint(from: string, to: string) {
    const key = pathKey(from);
    const next = pathKey(to);
    if (key === next) return;
    await client.request({ type: 'project.move', from, to });
    setPrefs((value) => ({
      ...value,
      pinnedProjects: [
        ...new Set(value.pinnedProjects.map((item) => (item === key ? next : item))),
      ],
    }));
  }
  const adapterName = nativeMode ? 'Claude Code' : 'Simulation';
  const accountName = signedOut
    ? t('nav:bar.signedOut')
    : (state.account?.email ??
      capabilities?.account.email ??
      t(nativeMode ? 'nav:bar.accountUnnamed' : 'nav:bar.simulation'));
  // The client's upgrade, from the service or the release page; while one runs, how it goes and a way to stop it.
  const upgradeItems: MenuItem[] = upgrading.step
    ? [
        { label: upgrading.text!, icon: <Download />, disabled: true, run: () => undefined },
        ...(upgrading.cancellable
          ? [{ label: t('connection:update.cancelClient'), icon: <X />, run: upgrading.cancel }]
          : []),
      ]
    : [upgrade, behind]
        .filter((target): target is string => !!target)
        .map((target) => ({
          label: working.length
            ? t(
                target === upgrade
                  ? 'connection:update.clientWorking'
                  : 'connection:update.githubWorking',
                { version: target, count: working.length },
              )
            : t(target === upgrade ? 'connection:update.client' : 'connection:update.github', {
                version: target,
              }),
          icon: <Download />,
          disabled: busy || working.length > 0,
          run: () => upgrading.start(target === upgrade ? undefined : target),
        }));
  // What an upgrade would bring is read where the upgrade is offered, before it is taken.
  const newer =
    upgrade ??
    behind ??
    ahead ??
    (update && ['available', 'manual'].includes(update.state) ? (update.latest ?? null) : null);
  const updates = [
    ...(newer
      ? [
          {
            label: t('connection:update.notes', { version: newer }),
            icon: <ScrollText />,
            run: () => setNotes(newer),
          },
        ]
      : []),
    ...upgradeItems,
    ...(serviceUpdate ? [serviceUpdate] : []),
  ];
  // The rail shows its button only for an update that exists, not for the standing offer to look for one.
  const pendingUpdate =
    upgrading.text ??
    (upgrade || behind
      ? t('connection:update.clientAvailable', { version: upgrade ?? behind ?? '' })
      : update && ['available', 'manual', 'installing', 'restarting'].includes(update.state)
        ? (serviceUpdate?.label ?? null)
        : null);
  // What a menu shows beside an item that has a shortcut.
  const hint = (action: Action) =>
    (prefs.shortcuts.enabled && comboText(keyFor(prefs, action))) || undefined;
  const settingsMenu: MenuItem[] = [
    ...(host.accountManagement
      ? [
          {
            label: t('nav:bar.account', { name: accountName }),
            icon: <UserRound />,
            detail: signedOut
              ? t('nav:bar.signIn')
              : (state.account?.subscriptionType ??
                capabilities?.account.subscriptionType ??
                t('nav:bar.accountQuota')),
            run: () => open('settings', 'account'),
          },
        ]
      : []),
    {
      label: t('nav:bar.settings'),
      icon: <Settings />,
      hint: hint('settings'),
      separated: true,
      run: () => open('settings', 'general'),
    },
    { label: t('nav:page.help'), icon: <CircleHelp />, run: () => showHelp() },
    {
      label: t(browser ? 'nav:bar.signOut' : 'nav:bar.disconnect'),
      icon: <LogOut />,
      separated: true,
      run: disconnect,
    },
  ];
  const toggleSide = () => changeSide(!sideOpen);
  const canCreate = connected && !busy && !refreshing;
  const barMenus: BarMenu[] = [
    {
      label: t('nav:bar.file'),
      items: [
        {
          label: t('nav:newSession'),
          hint: hint('newSession'),
          disabled: !canCreate,
          run: () => {
            void newSession();
          },
        },
        ...(host.localProjects
          ? [
              {
                label: t('nav:bar.addProject'),
                disabled: !connected || busy,
                run: () => {
                  void addProject();
                },
              },
            ]
          : []),
        {
          label: t('nav:bar.export'),
          disabled: !selected || !connected,
          separated: true,
          run: () => {
            void act(async () => {
              await exportSession(client, selected!);
            });
          },
        },
        {
          label: t(browser ? 'nav:bar.signOut' : 'nav:bar.disconnect'),
          separated: true,
          run: disconnect,
        },
        ...(window.desktop
          ? [{ label: t('nav:bar.quit'), run: () => void window.desktop!.quit() }]
          : []),
      ],
    },
    {
      label: t('nav:bar.view'),
      items: [
        {
          label: t('nav:bar.find'),
          hint: hint('find'),
          disabled: !selected || place.page !== 'chat',
          run: () => setFindRequest((value) => value + 1),
        },
        {
          label: t(sideOpen ? 'nav:collapseSidebar' : 'nav:bar.expandSidebar'),
          hint: hint('toggleSide'),
          run: toggleSide,
        },
        {
          label: t('nav:page.sessions'),
          separated: true,
          checked: place.page === 'chat',
          run: () => open('chat'),
        },
        ...(host.schedules
          ? [
              {
                label: t('nav:page.schedules'),
                checked: place.page === 'schedules',
                run: () => open('schedules'),
              },
            ]
          : []),
        {
          label: t('nav:bar.settings'),
          hint: hint('settings'),
          checked: place.page === 'settings',
          run: () => open('settings'),
        },
        ...(window.desktop
          ? [
              {
                label: t('nav:bar.zoomIn'),
                hint: hint('zoomIn'),
                separated: true,
                run: () => window.desktop!.zoom(1),
              },
              {
                label: t('nav:bar.zoomOut'),
                hint: hint('zoomOut'),
                run: () => window.desktop!.zoom(-1),
              },
              {
                label: t('nav:bar.zoomReset'),
                hint: hint('zoomReset'),
                run: () => window.desktop!.zoom(0),
              },
            ]
          : []),
      ],
    },
    {
      label: t('nav:page.help'),
      items: [
        { label: t('nav:bar.guide'), run: () => showHelp() },
        {
          label: t('nav:bar.shortcuts'),
          run: () => open('settings', 'shortcuts'),
        },
        ...(project.url
          ? [{ label: t('nav:bar.homepage'), separated: true, run: openProject }]
          : []),
        { label: t('connection:update.check'), run: () => open('settings', 'about') },
      ],
    },
  ];
  // The shortcuts, as the user set them. A key press that something else already took, or that belongs to an open
  // dialog, is left alone.
  const keys = useRef<(event: KeyboardEvent) => void>(() => {});
  keys.current = (event) => {
    if (event.defaultPrevented || document.querySelector('dialog[open]')) return;
    if (event.key === 'Escape' && narrow() && sideOpen) {
      changeSide(false);
      return;
    }
    if (!prefs.shortcuts.enabled) return;
    if (!connected && state.status !== 'reconnecting') return;
    const combo = comboOf(event);
    const action = combo && actions.find((item) => keyFor(prefs, item.id) === combo)?.id;
    if (!action) return;
    const run: Record<Action, (() => void) | false | undefined> = {
      back: () => step(-1),
      forward: () => step(1),
      toggleSide,
      newSession: canCreate && (() => void newSession()),
      settings: () => open('settings'),
      find: !!selected && place.page === 'chat' && (() => setFindRequest((value) => value + 1)),
      // As the mode menu, which a run going on keeps closed.
      cycleMode:
        !!selected &&
        place.page === 'chat' &&
        connected &&
        !busy &&
        !selected.activeRun &&
        (() => void configure({ permissionMode: nextMode(selected.permissionMode) })),
      toggleFiles: filesAvailable && toggleFiles,
      zoomIn: window.desktop && (() => window.desktop!.zoom(1)),
      zoomOut: window.desktop && (() => window.desktop!.zoom(-1)),
      zoomReset: window.desktop && (() => window.desktop!.zoom(0)),
    };
    const act = run[action];
    if (!act) return;
    event.preventDefault();
    act();
  };
  useEffect(() => {
    const listener = (event: KeyboardEvent) => keys.current(event);
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);

  if (browser && (state.status === 'disconnected' || state.status === 'connecting'))
    return (
      <main className="web-login">
        <section className="web-login-body">
          <h1>{t('connection:web.workbench')}</h1>
          {browser.selfSigned && <CertificateWarning />}
          <p role="status">{currentError ?? t('connection:connecting')}</p>
          {state.status === 'disconnected' && (
            <button
              className="button"
              onClick={() =>
                client.connectBrowser(
                  browserSocket(),
                  browser.expired,
                  async () => (await browserSession()).authenticated,
                )
              }
            >
              {t('connection:reconnect.button')}
            </button>
          )}
          <button className="button" onClick={disconnect}>
            {t('nav:bar.signOut')}
          </button>
        </section>
      </main>
    );

  // Not connected yet, the window is not shown: its sign-in window tells how the sign-in goes.
  if (state.status === 'disconnected' || state.status === 'connecting')
    return <main className="app-waiting" aria-busy="true" />;
  const menuSession =
    menu?.kind === 'session' ? state.sessions.find((item) => item.id === menu.sessionId) : null;
  const menuProject =
    menu?.kind === 'project' ? projectOf(state.projects, menu.deviceId, menu.path) : undefined;
  const moved =
    menu?.kind === 'move' ? state.sessions.find((item) => item.id === menu.sessionId) : null;
  const openMenu =
    !menu || (menu.kind === 'session' && !menuSession) || (menu.kind === 'project' && !menuProject)
      ? null
      : menu.kind === 'session'
        ? {
            label: t('nav:sessionActionsOf', { title: menuSession!.title }),
            items: sessionMenu(menuSession!),
          }
        : menu.kind === 'project'
          ? {
              label: t('nav:projectActions', { path: menu.path }),
              items: projectMenu(menuProject!),
            }
          : menu.kind === 'move'
            ? {
                label: t('session:composer.project'),
                heading: t('session:project.moveHint'),
                items: moved ? moveMenu(moved) : [],
              }
            : menu.kind === 'settings'
              ? { label: t('nav:page.settings'), items: settingsMenu }
              : menu.kind === 'update'
                ? { label: t('nav:page.update'), items: updates }
                : {
                    label: menu.label,
                    items: barMenus.find((item) => item.label === menu.label)?.items ?? [],
                  };
  const quotaFooter =
    inBrowser && nativeMode ? (
      <QuotaSummary
        quota={quota}
        connected={connected}
        emptyMessage={signedOut ? t('nav:quota.signedOut') : undefined}
        onOpen={() => open('settings', 'account')}
      />
    ) : undefined;
  return (
    <div
      className={`shell page-${place.page} ${sideOpen ? '' : 'side-closed'} ${selfSigned ? 'web-self-signed' : ''} ${filesOpen ? (filesPage ? 'files-page' : filesOver ? 'files-over' : 'files-open') : ''}`}
      style={filesOpen ? ({ '--file-width': `${filesShownWidth}px` } as CSSProperties) : undefined}
      data-settings-index={place.settingsIndex || undefined}
      {...drawerSwipe}
    >
      {selfSigned && <CertificateWarning />}
      <TitleBar
        title={
          place.page === 'chat'
            ? (selected?.title ?? 'CC Desk Tunnel')
            : place.page === 'schedules'
              ? t('nav:page.schedules')
              : place.page === 'help'
                ? t('nav:page.help')
                : place.settingsIndex && narrow()
                  ? t('nav:bar.settings')
                  : inBrowser && place.section === 'account'
                    ? t('nav:title.usage')
                    : (sections.find((item) => item.id === place.section)?.name ??
                      t('nav:bar.settings'))
        }
        back={
          !inBrowser && narrow() && place.page === 'settings'
            ? () => (place.settingsIndex ? open('chat') : visit({ ...place, settingsIndex: true }))
            : stepAvailable(-1)
              ? () => step(-1)
              : undefined
        }
        forward={stepAvailable(1) ? () => step(1) : undefined}
        sideOpen={sideOpen}
        toggleSide={toggleSide}
        menus={barMenus}
        openMenu={(item, position) => setMenu({ kind: 'bar', label: item.label, ...position })}
        connected={connected}
        adapterName={adapterName}
        files={
          filesAvailable
            ? { open: filesOpen, toggle: toggleFiles, hint: hint('toggleFiles') }
            : undefined
        }
      />
      <Rail
        page={place.page}
        go={(page) => {
          if (narrow() && page === 'chat' && place.page === 'chat') return;
          open(page);
          if (narrow() && page === 'chat') changeSide(true);
        }}
        schedules={host.schedules}
        update={host.serviceManagement ? pendingUpdate : null}
        openUpdate={(position) => setMenu({ kind: 'update', ...position })}
        openSettings={(position) =>
          narrow()
            ? visit({ ...place, page: 'settings', settingsIndex: true })
            : setMenu({ kind: 'settings', ...position })
        }
      />
      <button
        className="sidebar-shade"
        aria-label={t('nav:collapseSidebar')}
        onClick={() => changeSide(false)}
      />
      {place.page === 'settings' ? (
        <SettingsPage
          client={client}
          browser={!!browser}
          disconnect={disconnect}
          section={place.section}
          indexOnly={narrow() && !!place.settingsIndex}
          go={(section) => open('settings', section)}
          native={nativeMode}
          here={state.devices.find((device) => device.id === state.device?.id)}
          form={form}
          changeForm={changeForm}
          workspaceRoot={workspaceRoots[0] ?? ''}
          chooseWorkspace={(reset) => {
            void act(async () => {
              setWorkspaceRoots(await window.desktop!.chooseWorkspace(reset));
            });
          }}
          version={version}
          service={state.service}
          adapterName={adapterName}
          updates={host.serviceManagement ? updates : []}
          showNotes={setNotes}
          account={
            <AccountPanel
              client={client}
              usageOnly={!!browser}
              quotaUnavailable={
                inBrowser && !state.sessions.length ? t('nav:quota.afterSession') : undefined
              }
              account={nativeMode ? state.account : null}
              capabilities={signedOut ? null : capabilities}
              quota={quota}
              refreshing={refreshing}
              disabled={
                !state.sessions.length || !connected || refreshing || (inBrowser && signedOut)
              }
              error={inBrowser ? quotaError : currentError}
              refresh={() => {
                if (inBrowser) refreshQuota();
                else void refreshStatus(undefined, true);
              }}
            />
          }
        />
      ) : place.page === 'help' ? (
        <Suspense fallback={null}>
          <HelpCenter
            article={place.article}
            here={state.device?.name ?? t('common:device.here')}
            others={onlineOthers}
            browser={!!browser}
            version={version || state.service || ''}
            go={showHelp}
            run={runHelp}
            tryPrompt={host.localProjects ? (text) => void startWith(text) : undefined}
          />
        </Suspense>
      ) : place.page === 'schedules' ? (
        <SchedulePanel
          schedules={schedules}
          sessions={sessions}
          projects={projects.map((entry) => entry.path)}
          capabilities={capabilities}
        />
      ) : (
        <>
          <Sidebar
            sessions={sessions}
            elsewhere={elsewhere}
            devices={state.devices}
            serverDeviceId={state.serverDeviceId}
            selectedId={selected?.id}
            projects={state.projects}
            localProjects={host.localProjects}
            connected={connected}
            busy={busy}
            refreshing={refreshing}
            notifications={notifications}
            select={show}
            newSession={() => {
              void newSession();
            }}
            addProject={() => {
              void addProject();
            }}
            createInProject={(path) => {
              void createInProject(path);
            }}
            hereId={state.device?.id}
            createElsewhere={
              browser
                ? undefined
                : (deviceId, path) => {
                    void createElsewhere(deviceId, path);
                  }
            }
            sessionMenu={(session, position) =>
              setMenu({ kind: 'session', sessionId: session.id, ...position })
            }
            projectMenu={
              browser
                ? undefined
                : (entry, position) =>
                    setMenu({
                      kind: 'project',
                      deviceId: entry.device.id,
                      path: entry.path,
                      ...position,
                    })
            }
            footer={quotaFooter}
          />
          <main className="workspace">
            {currentError && (
              <div className="error-banner" role="alert">
                <span>{currentError}</span>
                <IconButton
                  title={t('session:closeError')}
                  onClick={() => {
                    setError(null);
                    client.update({ error: null });
                  }}
                >
                  <X />
                </IconButton>
              </div>
            )}
            {!connected && (
              <div className="connection-banner" role="status">
                <Unplug />
                {t('connection:reconnect.waiting')}
              </div>
            )}
            <Conversation
              openInFiles={filesAvailable ? openInFiles : undefined}
              findRequest={findRequest}
              session={selected}
              here={!!selected && onThis(selected)}
              events={events}
              history={history}
              connected={connected}
              native={nativeMode}
              ownsRun={ownsRun}
              clock={clock}
              progress={selected ? state.progress[selected.id] : undefined}
              busy={busy}
              newSession={() => {
                void newSession();
              }}
              loadEarlier={() => client.loadEarlier(selected!.id)}
              suggestions={
                !selected || controlsDisabled || away || inputDisabled
                  ? undefined
                  : suggestions({
                      project: !!projectIn(selected!),
                      other: onlineOthers[0],
                      schedules: host.schedules,
                    })
              }
              suggest={(text) => setDraft(selected!.id, text)}
              moreExamples={() => showHelp()}
              edit={
                controlsDisabled || away
                  ? undefined
                  : (id, text, deliveryStatus) => {
                      // Only a confirmed non-delivery can be resent in place. A missing receipt is not proof.
                      if (deliveryStatus === 'not_sent') {
                        if (draft && draft !== text) {
                          setError(t('session:message.draftFirst'));
                          return;
                        }
                        setError(null);
                        setDraft(selected!.id, text);
                        return;
                      }
                      void fork(selected!, { id, text });
                    }
              }
              stopTask={(taskId) => {
                void act(async () => {
                  await client.request({
                    type: 'run.task.stop',
                    sessionId: selected!.id,
                    runId: selected!.activeRun!.id,
                    taskId,
                  });
                });
              }}
              backgroundTask={(toolId) => {
                void act(async () => {
                  await client.request({
                    type: 'run.task.background',
                    sessionId: selected!.id,
                    runId: selected!.activeRun!.id,
                    toolId,
                  });
                });
              }}
              stop={stopRun}
              replyApproval={async (runId, approvalId, allowed, answers, plan) => {
                let sent = false;
                await act(async () => {
                  await client.request({
                    type: 'approval.reply',
                    sessionId: selected!.id,
                    runId,
                    approvalId,
                    allowed,
                    ...(answers ? { answers } : {}),
                    ...(plan ? { plan } : {}),
                  });
                  sent = true;
                });
                return sent;
              }}
            />
            {state.status === 'reconnecting' && (
              <div className="elsewhere-bar" role="status">
                <Unplug />
                <p>
                  {state.error
                    ? t('connection:reconnect.bodyWithReason', {
                        reason: state.error.split('\n')[0],
                      })
                    : t('connection:reconnect.body')}
                </p>
                <button type="button" className="button" onClick={disconnect}>
                  {t('connection:reconnect.leave')}
                </button>
              </div>
            )}
            {beside.length > 0 && (
              <div className="elsewhere-bar" role="status">
                <Laptop />
                <p>{t('session:elsewhere.beside', { names: beside })}</p>
              </div>
            )}
            {selected && away && host.localProjects && (
              <div className="elsewhere-bar" role="status">
                <Laptop />
                {remote ? (
                  <p>
                    <Trans
                      t={t}
                      i18nKey="session:elsewhere.remote"
                      values={{
                        device: selected.device
                          ? deviceName(t, selected.device, state.serverDeviceId)
                          : '',
                        path: selected.projectPath,
                      }}
                      components={{ code: <code /> }}
                    />
                  </p>
                ) : (
                  <p>
                    <Trans
                      t={t}
                      i18nKey="session:elsewhere.offline"
                      values={{
                        device: selected.device
                          ? deviceName(t, selected.device, state.serverDeviceId)
                          : t('nav:unknownDevice'),
                        path: selected.projectPath,
                      }}
                      components={{ code: <code /> }}
                    />
                  </p>
                )}
                <button
                  type="button"
                  className="button primary"
                  disabled={controlsDisabled}
                  onClick={(event) => {
                    // With projects here the session goes into one of them, or into a folder chosen there.
                    if (!projects.length) return void takeOver(selected);
                    const box = event.currentTarget.getBoundingClientRect();
                    setMenu({
                      kind: 'move',
                      sessionId: selected.id,
                      x: box.left,
                      y: box.top - 6,
                      above: true,
                    });
                  }}
                >
                  {t('session:elsewhere.takeOver')}
                </button>
                <button
                  type="button"
                  className="button secondary"
                  disabled={controlsDisabled}
                  onClick={() => {
                    void fork(selected);
                  }}
                >
                  {t('session:elsewhere.forkHere')}
                </button>
              </div>
            )}
            {browser && selected && away && !remote && (
              <div className="elsewhere-bar" role="status">
                <Laptop />
                <p>
                  {t('session:elsewhere.notConnected', {
                    device: selected.device
                      ? deviceName(t, selected.device, state.serverDeviceId)
                      : t('nav:unknownDevice'),
                  })}
                </p>
              </div>
            )}
            {nativeMode && selected && !selected.activeRun && (!away || remote) && (
              <IdleReminder
                events={events}
                settings={state.compaction}
                canCompact={canCompact && !controlsDisabled}
                compact={() => {
                  void compact();
                }}
                startFresh={() => {
                  if (onThis(selected)) void createInProject(selected.projectPath);
                  else void newSession();
                }}
              />
            )}
            {selected && (!away || remote) && (
              <Composer
                openAccount={() => open('settings', 'account')}
                session={selected}
                projectName={projectIn(selected) ? projectName(projectIn(selected)!) : null}
                chooseProject={
                  controlsDisabled || away
                    ? undefined
                    : (position) => setMenu({ kind: 'move', sessionId: selected.id, ...position })
                }
                draft={draft}
                setDraft={(text) => setDraft(selected.id, text)}
                native={nativeMode}
                connected={connected}
                busy={busy}
                refreshing={refreshing}
                canRefreshModels={!state.sessions.some((session) => session.activeRun)}
                ownsRun={ownsRun}
                inputDisabled={inputDisabled}
                controlsDisabled={controlsDisabled}
                slashOpen={slashOpen}
                setSlashOpen={setSlashOpen}
                canCompact={canCompact}
                scenario={scenario}
                setScenario={setScenario}
                capabilities={capabilities}
                nativeSession={nativeSession}
                metrics={metrics}
                quota={quota}
                send={(text) => {
                  void send(text);
                }}
                resume={stopped && !inputDisabled ? resume : undefined}
                compact={() => {
                  void compact();
                }}
                refresh={() => {
                  void refreshStatus();
                }}
                configure={configure}
                stop={stopRun}
              />
            )}
            {selected && (!away || (browser && remote)) && (
              <SessionBar
                client={client}
                sessionId={selected.id}
                refresh={turnReports}
                metrics={metrics}
                native={nativeMode}
              />
            )}
          </main>
          {filesOpen && (
            <aside className="file-column" aria-label={t('session:files.title')}>
              {!filesPage && (
                <div
                  className="file-resizer"
                  role="separator"
                  aria-orientation="vertical"
                  aria-label={t('session:files.resize')}
                  onPointerDown={resizeFiles}
                />
              )}
              <FilePanel
                places={filesPlaces}
                start={filesStart}
                sessionKey={selected?.id ?? ''}
                info={state.files}
                layout={filesPage ? 'page' : filesShownWidth < 620 ? 'narrow' : 'wide'}
                setPage={setFilesPage}
                close={toggleFiles}
                noticeKey={window.desktop?.boot.connection ?? ''}
                project={selected && onThis(selected) ? selected.projectPath : null}
                request={filesRequest}
                aliasOf={nativeLabels(state.projects, state.sessions)}
              />
            </aside>
          )}
        </>
      )}
      {menu && openMenu && (
        <Menu
          // One menu may give way to another in the same place, which is then laid out anew.
          key={menu.kind}
          label={openMenu.label}
          heading={'heading' in openMenu ? openMenu.heading : undefined}
          x={menu.x}
          y={menu.y}
          above={menu.above}
          onClose={closeMenu}
          items={openMenu.items}
        />
      )}
      {repointProject && (
        <AddProjectDialog
          title={t('session:project.changeFolderTitle')}
          action={t('session:project.change')}
          busy={busy}
          connected={connected}
          error={actionError}
          close={() => setRepointProject(null)}
          add={(written) => {
            void act(async () => {
              if (!written) return;
              const path = (await window.desktop?.asOnDisk(written)) ?? written;
              await repoint(repointProject, path);
              setRepointProject(null);
            });
          }}
        />
      )}
      {createOpen && (
        <AddProjectDialog
          busy={busy}
          connected={connected}
          error={actionError}
          close={() => setCreateOpen(false)}
          add={(written) => {
            void act(async () => {
              if (!written) return;
              const path = (await window.desktop?.asOnDisk(written)) ?? written;
              await client.request({ type: 'project.add', path });
              setCreateOpen(false);
            });
          }}
        />
      )}
      {deleteSession && (
        <DeleteSessionDialog
          session={deleteSession}
          native={nativeMode}
          busy={busy}
          connected={connected}
          error={actionError}
          close={() => setDeleteSession(null)}
          confirm={() => {
            void act(async () => {
              await client.request({ type: 'session.delete', sessionId: deleteSession.id });
              setDraft(deleteSession.id, '');
              // A plain session's directory goes with it when the session left nothing there.
              if (onThis(deleteSession) && !projectIn(deleteSession))
                void window.desktop?.removeWorkspace(deleteSession.projectPath);
              setDeleteSession(null);
            });
          }}
        />
      )}
      {renameProject && (
        <RenameProjectDialog
          path={renameProject.path}
          name={renameProject.name ?? ''}
          busy={busy}
          connected={connected}
          error={actionError}
          close={() => setRenameProject(null)}
          rename={(name) => {
            void act(async () => {
              await client.request({
                type: 'project.rename',
                deviceId: renameProject.device.id,
                path: renameProject.path,
                name,
              });
              setRenameProject(null);
            });
          }}
        />
      )}
      {renameSession && (
        <RenameSessionDialog
          session={renameSession}
          busy={busy}
          connected={connected}
          error={actionError}
          close={() => setRenameSession(null)}
          rename={(title) => {
            void act(async () => {
              await client.request({ type: 'session.rename', sessionId: renameSession.id, title });
              setRenameSession(null);
            });
          }}
        />
      )}
      {ccdtNeeded && (
        <CcdtDialog
          installed={ccdtNeeded.installed}
          version={version}
          close={() => setCcdtNeeded(null)}
        />
      )}
      {notesDialog}
      {state.setupToken && (
        <SetupTokenDialog
          result={state.setupToken}
          close={() => client.update({ setupToken: null })}
        />
      )}
    </div>
  );
}
