export {};
declare global {
  interface Window {
    desktop?: {
      // Run from the source tree, not installed: the login page then also offers the simulation service.
      dev: boolean;
      remote?: boolean;
      remoteStatus?: () => Promise<RemoteStatus>;
      resetRemotePairing?: () => Promise<RemoteStatus>;
      revokeRemoteSession?: (id: string) => Promise<RemoteStatus>;
      onRemoteSessionsChanged?: (
        callback: (sessions: RemoteBrowserSession[]) => void,
      ) => () => void;
      onRemoteEnabledChanged?: (callback: (enabled: boolean) => void) => () => void;
      onRemoteRequest?: (
        methods: string[],
        callback: (request: {
          id: string;
          viewId?: string;
          method: string;
          args: unknown[];
        }) => unknown | Promise<unknown>,
      ) => () => void;
      publishRemoteEvent?: (event: { viewId?: string; message: unknown }) => void;
      openRemote?: () => Promise<void>;
      configureRemote?: (values: {
        enabled: boolean;
        lan: boolean;
        port: number;
      }) => Promise<RemoteStatus>;
      platform: 'win32' | 'darwin' | 'linux';
      // Which of this computer's connections the window is ('' the first), and what they all share.
      boot: { connection: string; shared: import('./shared.ts').Shared };
      saveShared: (key: 'prefs' | 'projects', value: unknown) => Promise<void>;
      onSharedChanged: (
        callback: (key: keyof import('./shared.ts').Shared, value: unknown) => void,
      ) => () => void;
      // The sessions running in this window, for the other connections' windows to warn about.
      setBusy: (runs: import('./shared.ts').Run[]) => Promise<void>;
      // Each connection is a window of its own; `open` tells whether it is running now.
      connections: () => Promise<import('./shared.ts').ListedConnection[]>;
      createConnection: (name: string) => Promise<import('./shared.ts').ListedConnection[]>;
      openConnection: (id: string) => Promise<void>;
      renameConnection: (
        id: string,
        name: string,
      ) => Promise<import('./shared.ts').ListedConnection[]>;
      removeConnection: (id: string) => Promise<import('./shared.ts').ListedConnection[]>;
      chooseProject: () => Promise<string | null>;
      asOnDisk: (path: string) => Promise<string>;
      // Whether each folder is on this computer, in the order given.
      foldersExist: (folders: string[]) => Promise<boolean[]>;
      // Files to mention in a message; the paths of the ones chosen.
      chooseFiles: () => Promise<string[]>;
      uploadFile?: (file: File) => Promise<string>;
      pathForFile: (file: File) => string;
      // Asks where to save and writes the text there; false when the dialog was cancelled.
      saveFile: (name: string, text: string) => Promise<boolean>;
      openFolder: (path: string) => Promise<void>;
      openLogs: () => Promise<void>;
      openDevTools: () => Promise<void>;
      saveImage: (type: string, bytes: Uint8Array) => Promise<string>;
      // The branch a project's working tree is on, or null outside a repository.
      gitBranch: (path: string) => Promise<string | null>;
      copyText: (text: string) => Promise<void>;
      openExternal: (url: string) => Promise<void>;
      // The folders holding sessions without a project; new ones are made in the first.
      workspaceRoots: () => Promise<string[]>;
      // Asks for another folder, or goes back to the one under Documents; the folders as they are afterwards.
      chooseWorkspace: (reset: boolean) => Promise<string[]>;
      createWorkspace: () => Promise<string>;
      removeWorkspace: (directory: string) => Promise<void>;
      loadLogin: () => Promise<import('./LoginPage.tsx').ConnectionForm | null>;
      saveLogin: (login: import('./LoginPage.tsx').ConnectionForm) => Promise<void>;
      loadDrafts: () => Promise<Record<string, string>>;
      saveDrafts: (drafts: Record<string, string>) => Promise<void>;
      loadSchedules: (initial: string) => Promise<{ path: string; text: string }>;
      saveSchedules: (text: string) => Promise<void>;
      readRemoteSchedules?: () => Promise<{ path: string; text: string; revision: string }>;
      saveRemoteSchedules?: (text: string, revision: string) => Promise<void>;
      scheduleState?: () => Promise<import('./browser-schedules.ts').ScheduleSnapshot | null>;
      runScheduleNow?: (taskId: string) => Promise<void>;
      onSchedulesChanged: (callback: (text: string) => void) => () => void;
      windowSettings: () => Promise<{ closeToTray: boolean }>;
      setWindowSettings: (values: { closeToTray: boolean }) => Promise<void>;
      // A system notification, shown unless the window is in front (`always` shows it regardless). `attention`
      // also flashes the taskbar button, or bounces the Dock icon, of a window left open behind others.
      notify: (notice: {
        title: string;
        body: string;
        sessionId: string | null;
        silent: boolean;
        always?: boolean;
        attention?: boolean;
      }) => Promise<void>;
      onNotifyClicked: (callback: (sessionId: string | null) => void) => () => void;
      // 1 and -1 step the interface size, 0 restores it.
      zoom: (direction: number) => void;
      // `all` also closes the windows of the other connections.
      quit: (all?: boolean) => Promise<void>;
      version: () => Promise<string>;
      // The notes of a released version, read from its page on GitHub.
      releaseNotes: (version: string) => Promise<string>;
      // This computer as the service knows it.
      device: () => Promise<import('@cc-desk-tunnel/protocol').Device>;
      // Fetches and runs an installer: the one the connected service holds, or, given a version, that
      // version's from the release page.
      installUpdate: (version?: string) => Promise<void>;
      onUpdateProgress: (
        callback: (progress: { received: number; size: number }) => void,
      ) => () => void;
      // Has a service that refused this client as the newer one upgrade itself to the newest release, given
      // the service's version from the refusal; ends with the version installed or why it was not.
      upgradeService: (config: {
        url: string;
        fingerprint: string;
        token: string;
        deviceName: string;
        service: string;
      }) => Promise<{ version?: string; error?: string }>;
      onServiceUpgrade: (
        callback: (update: import('@cc-desk-tunnel/protocol').ServiceUpdate) => void,
      ) => () => void;
      connectProxy: (config: {
        url: string;
        fingerprint: string;
        // Seconds allowed for reaching the service, for the local SSH service to start, and for the whole.
        waits?: { connect: number; ssh: number; ready: number };
      }) => Promise<{ url: string }>;
      disconnectProxy: () => Promise<void>;
      onProxyClosed: (callback: () => void) => () => void;
    };
  }
}
export type RemoteStatus = {
  enabled: boolean;
  lan: boolean;
  port: number;
  url: string | null;
  token: string | null;
  sessions: RemoteBrowserSession[];
};
export type RemoteBrowserSession = {
  id: string;
  label: string;
  createdAt: number;
  expiresAt: number;
};
