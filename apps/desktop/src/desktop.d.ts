/// <reference types="vite/client" />
export {};
declare global {
  interface Window {
    desktop?: {
      // Run from the source tree, not installed: the login page then also offers the simulation service.
      dev: boolean;
      platform: 'win32' | 'darwin' | 'linux';
      // Which of this computer's connections the window is ('' the first), and what they all share.
      // `launcher`: a sign-in window, which is no connection's (see Launcher.tsx).
      boot: { connection: string; launcher?: boolean; shared: import('./shared.ts').Shared };
      saveShared: (key: 'prefs' | 'projects', value: unknown) => Promise<void>;
      onSharedChanged: (
        callback: (key: keyof import('./shared.ts').Shared, value: unknown) => void,
      ) => () => void;
      // The sessions running in this window, for the other connections' windows to warn about.
      setBusy: (runs: import('./shared.ts').Run[]) => Promise<void>;
      // Each connection is a window of its own, signed in to one service; the ones that have signed in somewhere,
      // the latest first.
      accounts: () => Promise<import('./shared.ts').Account[]>;
      // Shows the connection's window, or starts it on its sign-in page.
      openAccount: (id: string) => Promise<void>;
      // An empty name has the connection go by its service's address.
      renameAccount: (id: string, name: string) => Promise<import('./shared.ts').Account[]>;
      // Forgets the sign-in, and with it what the connection kept on this computer.
      forgetAccount: (id: string) => Promise<import('./shared.ts').Account[]>;
      // A sign-in page in a window of its own, as starting the program again opens.
      newLoginWindow: () => Promise<void>;
      chooseProject: () => Promise<string | null>;
      asOnDisk: (path: string) => Promise<string>;
      // Whether each folder is on this computer, in the order given.
      foldersExist: (folders: string[]) => Promise<boolean[]>;
      // Files to mention in a message; the paths of the ones chosen.
      chooseFiles: () => Promise<string[]>;
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
      openWeb: (url: string) => Promise<void>;
      // A web address a reply links to, in the user's browser.
      openLink: (url: string) => Promise<void>;
      // What a path a reply links to is on this computer; `runs` when opening it would run something.
      // `editors` are the installed code editors, the one to use first.
      inspectPath: (path: string) => Promise<{
        kind: 'file' | 'directory' | 'missing';
        runs: boolean;
        editors: { scheme: string; name: string }[];
        openWith: boolean;
      }>;
      // Does something with a linked path; what to tell the user, or ''.
      actOnPath: (
        action: 'open' | 'default' | 'editor' | 'with' | 'reveal' | 'content' | 'save',
        path: string,
        options?: { line?: number; column?: number; editor?: string },
      ) => Promise<string>;
      // The folders holding sessions without a project; new ones are made in the first.
      workspaceRoots: () => Promise<string[]>;
      // Asks for another folder, or goes back to the one under Documents; the folders as they are afterwards.
      chooseWorkspace: (reset: boolean) => Promise<string[]>;
      createWorkspace: () => Promise<string>;
      removeWorkspace: (directory: string) => Promise<void>;
      // A sign-in window's form: the latest service whose window is not open, its token left out. A connection's
      // window's own sign-in: `signIn` to connect at once, as the window was started to; `locked` once the
      // connection has its service.
      loadLogin: () => Promise<
        (import('./LoginPage.tsx').ConnectionForm & { signIn?: boolean; locked?: boolean }) | null
      >;
      saveLogin: (login: import('./LoginPage.tsx').ConnectionForm) => Promise<void>;
      // The name of another connection that has signed in to the service, if one has.
      loginOwner: (url: string) => Promise<string | null>;
      // A sign-in window for another service, as this window closes.
      signInElsewhere: () => Promise<void>;
      // A sign-in window's: starts the service's window, which signs in, and closes once it runs. `shown`: the
      // service's window was open already and is shown.
      startService: (
        login: import('./LoginPage.tsx').ConnectionForm,
      ) => Promise<{ shown?: string; error?: string }>;
      // Opens an earlier version's connection that kept no address, to sign in from its own window.
      openLegacy: (id: string) => Promise<{ shown?: boolean; error?: string }>;
      loadDrafts: () => Promise<Record<string, string>>;
      saveDrafts: (drafts: Record<string, string>) => Promise<void>;
      loadSchedules: (initial: string) => Promise<{ path: string; text: string }>;
      saveSchedules: (text: string) => Promise<void>;
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
      quit: () => Promise<void>;
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
        // Upgrades even while sessions are at work (see FORCED_UPGRADE_SINCE).
        force?: boolean;
      }) => Promise<{ version?: string; error?: string; code?: string }>;
      // Opens the session in ccdt, the terminal client, signed in to this window's service with its token; says
      // instead when ccdt is not installed, or not of this client's release.
      openInCcdt: (request: {
        url: string;
        fingerprint: string;
        token: string;
        sessionId: string;
        projectPath?: string;
      }) => Promise<{ status: 'opened' | 'missing' } | { status: 'outdated'; installed: string }>;
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
