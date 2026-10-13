export {};
declare global {
  interface Window {
    desktop?: {
      // Run from the source tree, not installed: the login page then also offers the simulation service.
      dev: boolean;
      platform: 'win32' | 'darwin' | 'linux';
      chooseProject: () => Promise<string | null>;
      asOnDisk: (path: string) => Promise<string>;
      // Files to mention in a message; the paths of the ones chosen.
      chooseFiles: () => Promise<string[]>;
      previewFile: (path: string) => Promise<import('./attachments.ts').Preview>;
      readTextFile: (path: string) => Promise<{ text: string; truncated: boolean }>;
      searchFiles: (directory: string, query: string) => Promise<string[]>;
      pathForFile: (file: File) => string;
      // Asks where to save and writes the text there; false when the dialog was cancelled.
      saveFile: (name: string, text: string) => Promise<boolean>;
      openFolder: (path: string) => Promise<void>;
      openChangedFile: (path: string, reveal: boolean) => Promise<void>;
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
      loadDrafts: () => Promise<unknown>;
      saveDrafts: (drafts: import('./drafts.ts').Drafts | Record<string, string>) => Promise<void>;
      loadAttachments: (messageId: string) => Promise<import('./attachments.ts').Attachment[]>;
      saveAttachments: (
        messageId: string,
        attachments: import('./attachments.ts').Attachment[],
        sessionId: string,
      ) => Promise<void>;
      deleteAttachments: (messageId: string) => Promise<void>;
      deleteSessionAttachments: (sessionId: string) => Promise<void>;
      loadSchedules: (initial: string) => Promise<{ path: string; text: string }>;
      saveSchedules: (text: string) => Promise<void>;
      onSchedulesChanged: (callback: (text: string) => void) => () => void;
      windowSettings: () => Promise<{ closeToTray: boolean }>;
      setWindowSettings: (values: { closeToTray: boolean }) => Promise<void>;
      setTheme?: (mode: 'light' | 'dark') => Promise<void>;
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
      quit: () => Promise<void>;
      version: () => Promise<string>;
      // This computer as the service knows it.
      device: () => Promise<import('@cc-desk-tunnel/protocol').Device>;
      // Fetches and runs an installer: the one the connected service holds, or, given a version, that
      // version's from the release page.
      installUpdate: (version?: string) => Promise<void>;
      onUpdateProgress: (
        callback: (progress: { received: number; size: number }) => void,
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
