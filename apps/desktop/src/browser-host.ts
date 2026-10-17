import type { Device } from '@cc-desk-tunnel/protocol';
import { createBrowserDrafts } from './browser-drafts.ts';

export type HostInfo = {
  kind: 'desktop-web';
  device: Device;
  platform: 'win32' | 'darwin' | 'linux';
  version: string;
  connected: boolean;
};
export class HostAccessError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}
export async function hostInfo(): Promise<HostInfo> {
  const response = await fetch('/api/info', { cache: 'no-store' });
  if (response.status === 401) throw new HostAccessError('请使用桌面客户端显示的配对码连接。', 401);
  if (!response.ok) throw new Error('桌面客户端的 Web 服务暂时没有响应，请稍后重试。');
  return response.json();
}
export async function pairBrowser(token: string): Promise<HostInfo> {
  const response = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  if (!response.ok)
    throw new Error(
      response.status === 429
        ? '尝试次数较多，请稍后再配对。'
        : response.status === 401
          ? '配对码不正确，请从桌面客户端重新复制。'
          : '配对失败，请检查桌面客户端的远程控制设置。',
    );
  return hostInfo();
}
export async function resumeOrPairBrowser(token: string): Promise<HostInfo> {
  try {
    return await hostInfo();
  } catch (reason) {
    // Reuse a valid cookie so opening another tab does not revoke the first tab's session.
    if (!(reason instanceof HostAccessError) || reason.status !== 401) throw reason;
    return pairBrowser(token);
  }
}
async function rpc<T>(method: string, ...args: unknown[]): Promise<T> {
  const response = await fetch('/api/rpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, args }),
  });
  const value = await response.json();
  if (!response.ok || value.error) throw new Error(value.error || '桌面客户端上的操作失败。');
  return value.result as T;
}
const desktopOnly = async (): Promise<never> => {
  throw new Error('请在桌面客户端执行这项系统操作。');
};
const noop = async () => {};
const subscribe = () => () => {};

async function upload(file: File): Promise<string> {
  if (file.size > 20 * 1024 * 1024) throw new Error('单个附件最多 20 MB。');
  const bytes = new Uint8Array(await file.arrayBuffer());
  let text = '';
  for (let offset = 0; offset < bytes.length; offset += 32768)
    text += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  return rpc('files:upload', file.name, btoa(text));
}
export function installBrowserHost(info: HostInfo) {
  let drafts: ReturnType<typeof createBrowserDrafts> | undefined;
  const draftStore = () => (drafts ??= createBrowserDrafts(localStorage, sessionStorage));
  // getRandomValues works on HTTP LAN origins too; randomUUID is otherwise HTTPS-only.
  if (!crypto.randomUUID)
    Object.defineProperty(crypto, 'randomUUID', {
      value: () => {
        const bytes = crypto.getRandomValues(new Uint8Array(16));
        bytes[6] = (bytes[6]! & 15) | 64;
        bytes[8] = (bytes[8]! & 63) | 128;
        const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      },
    });
  window.desktop = {
    remote: true,
    dev: false,
    platform: info.platform,
    // Browser preferences/projects stay in this browser. Only the owning desktop window reports
    // shared run state; a tab must not overwrite it or manage the computer's other connections.
    boot: { connection: 'browser', shared: { connections: [], busy: [] } },
    saveShared: noop,
    onSharedChanged: subscribe,
    setBusy: noop,
    connections: desktopOnly,
    createConnection: desktopOnly,
    openConnection: desktopOnly,
    renameConnection: desktopOnly,
    removeConnection: desktopOnly,
    chooseProject: async () => {
      const directory = prompt(`请输入 ${info.device.name} 上的项目绝对路径`);
      return directory?.trim() ? rpc<string>('project:check', directory.trim()) : null;
    },
    asOnDisk: (directory) => rpc('project:check', directory),
    foldersExist: (folders) => rpc('folders:exist', folders),
    chooseFiles: () =>
      new Promise((resolve, reject) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = true;
        input.oncancel = () => resolve([]);
        input.onchange = () => {
          void (async () => {
            const paths: string[] = [];
            for (const file of input.files!) paths.push(await upload(file));
            return paths;
          })().then(resolve, reject);
        };
        input.click();
      }),
    pathForFile: () => '',
    uploadFile: upload,
    saveImage: (type, bytes) =>
      upload(new File([Uint8Array.from(bytes)], `image.${type.split('/')[1] || 'png'}`, { type })),
    saveFile: async (name, text) => {
      const link = document.createElement('a');
      link.href = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
      link.download = name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
      return true;
    },
    openFolder: async (directory) => {
      prompt('桌面客户端所在电脑的文件夹路径（可复制）', directory);
    },
    openLogs: desktopOnly,
    openDevTools: desktopOnly,
    gitBranch: (directory) => rpc('git:branch', directory),
    copyText: async (text) => {
      if (navigator.clipboard) return navigator.clipboard.writeText(text);
      const input = document.createElement('textarea');
      input.value = text;
      document.body.append(input);
      input.select();
      const copied = document.execCommand('copy');
      input.remove();
      if (!copied) throw new Error('浏览器未允许复制，请手动选择文本。');
    },
    openExternal: async (target) => {
      const url = new URL(target);
      if (url.protocol === 'https:') window.open(url.href, '_blank', 'noopener,noreferrer');
    },
    workspaceRoots: () => rpc('workspace:roots'),
    chooseWorkspace: desktopOnly,
    createWorkspace: () => rpc('workspace:create'),
    removeWorkspace: (directory) => rpc('workspace:remove', directory),
    loadLogin: async () => ({
      mode: 'remote',
      url: location.origin,
      fingerprint: '',
      token: 'web-session-authenticated-transport',
      remember: false,
      autoLogin: true,
    }),
    saveLogin: noop,
    loadDrafts: async () => draftStore().load(),
    saveDrafts: async (drafts) => draftStore().save(drafts),
    loadSchedules: desktopOnly,
    saveSchedules: desktopOnly,
    saveRemoteSchedules: (text, revision) => rpc('schedules:save', text, revision),
    scheduleState: () => rpc('schedules:state'),
    runScheduleNow: (id) => rpc('schedules:run-now', id),
    onSchedulesChanged: subscribe,
    windowSettings: async () => ({ closeToTray: true }),
    setWindowSettings: desktopOnly,
    notify: noop,
    onNotifyClicked: subscribe,
    zoom: noop,
    quit: async () => {
      await fetch('/api/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      location.reload();
    },
    version: async () => info.version,
    releaseNotes: (version) => rpc('release:notes', version),
    device: async () => info.device,
    installUpdate: desktopOnly,
    onUpdateProgress: subscribe,
    upgradeService: desktopOnly,
    onServiceUpgrade: subscribe,
    connectProxy: async () => ({
      url: `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/control`,
    }),
    disconnectProxy: noop,
    onProxyClosed: subscribe,
  };
}
