import { isNewer } from './paths.ts';

type VersionSource = 'cachedInstaller' | 'serverVersion';

// The client follows its service: it is offered the service's own version, never one ahead of it, whose
// service might not be able to follow (a release that needs the server's image updated). `confirm` asks
// before an install that quits and reopens the app; every platform waits for sessions at work first.
type ClientUpdatePolicy = {
  sources: readonly VersionSource[];
  confirm: boolean;
  description:
    | 'settings:about.updatesFromService'
    | 'settings:about.updatesFromGithub'
    | 'settings:about.updatesManual';
};

export const policies: Record<'win32' | 'darwin' | 'linux', ClientUpdatePolicy> = {
  win32: {
    sources: ['cachedInstaller', 'serverVersion'],
    confirm: false,
    description: 'settings:about.updatesFromService',
  },
  // The service holds the Windows installer only: a Mac takes the service's version from the release page.
  darwin: {
    sources: ['serverVersion'],
    confirm: true,
    description: 'settings:about.updatesFromGithub',
  },
  linux: {
    sources: [],
    confirm: false,
    description: 'settings:about.updatesManual',
  },
};

// The browser development workbench simulates the Windows client.
const platform =
  typeof window === 'undefined' || !window.desktop ? 'win32' : window.desktop.platform;
export const updatePolicy = policies[platform] ?? policies.linux;
// Whether this system's client installs its upgrades itself.
export const selfUpdating = updatePolicy.sources.length > 0;

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
