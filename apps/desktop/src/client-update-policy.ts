import { isNewer } from './paths.ts';

type VersionSource = 'cachedInstaller' | 'serverVersion' | 'publishedVersion';

type ClientUpdatePolicy = {
  sources: readonly VersionSource[];
  controls: 'all' | 'workbench-menu' | 'manual';
  beforeInstall: 'wait-for-idle' | 'confirm';
  description:
    | 'settings:about.updatesFromService'
    | 'settings:about.updatesInMenu'
    | 'settings:about.updatesManual';
};

export const policies: Record<'win32' | 'darwin' | 'linux', ClientUpdatePolicy> = {
  win32: {
    sources: ['cachedInstaller', 'serverVersion'],
    controls: 'all',
    beforeInstall: 'wait-for-idle',
    description: 'settings:about.updatesFromService',
  },
  darwin: {
    sources: ['serverVersion', 'publishedVersion'],
    controls: 'workbench-menu',
    beforeInstall: 'confirm',
    description: 'settings:about.updatesInMenu',
  },
  linux: {
    sources: [],
    controls: 'manual',
    beforeInstall: 'wait-for-idle',
    description: 'settings:about.updatesManual',
  },
};

// The browser development workbench simulates the Windows client.
const platform =
  typeof window === 'undefined' || !window.desktop ? 'win32' : window.desktop.platform;
export const updatePolicy = policies[platform] ?? policies.linux;

type Installer = { version: string; source: 'service' | 'github' };

// The workbench offers the first match. At sign-in a supported client can also choose GitHub
// when its server already has the same installer.
export function clientInstallers(
  policy: ClientUpdatePolicy,
  installed: string,
  versions: Partial<Record<VersionSource, string | null>>,
): Installer[] {
  const offers: Installer[] = [];
  if (!installed) return offers;
  for (const source of policy.sources) {
    const version = versions[source];
    if (version && isNewer(version, installed))
      offers.push({ version, source: source === 'cachedInstaller' ? 'service' : 'github' });
  }
  return offers;
}
