export {};
declare global {
  interface Window {
    desktop?: {
      chooseProject: () => Promise<string | null>;
      openExternal: (url: string) => Promise<void>;
      workspaceRoot: () => Promise<string>;
      createWorkspace: () => Promise<string>;
      removeWorkspace: (directory: string) => Promise<void>;
      loadLogin: () => Promise<import('./LoginPage.tsx').ConnectionForm | null>;
      saveLogin: (login: import('./LoginPage.tsx').ConnectionForm) => Promise<void>;
      loadDrafts: () => Promise<Record<string, string>>;
      saveDrafts: (drafts: Record<string, string>) => Promise<void>;
      loadSchedules: (initial: string) => Promise<{ path: string; text: string }>;
      saveSchedules: (text: string) => Promise<void>;
      onSchedulesChanged: (callback: (text: string) => void) => () => void;
      version: () => Promise<string>;
      installUpdate: () => Promise<void>;
      connectProxy: (config: { url: string; fingerprint: string }) => Promise<{ url: string }>;
      disconnectProxy: () => Promise<void>;
      onProxyClosed: (callback: () => void) => () => void;
    };
  }
}
