import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Where ccdt runs from. A package (scripts/package-cli.mjs) holds ccdt.mjs with `vendor/` beside it: on Windows the
// OpenSSH and PowerShell that the SSH service for Claude's commands is made of, as the desktop installer bundles
// them. From the source tree they are the ones prepared for the desktop client.
const here = fileURLToPath(new URL('.', import.meta.url));
const packaged = existsSync(join(here, 'vendor'));
const vendor = packaged
  ? join(here, 'vendor')
  : fileURLToPath(new URL('../../desktop/vendor/', import.meta.url));

export const components = (env = process.env) => ({
  openssh: env.CCDT_OPENSSH_DIR ?? join(vendor, 'openssh'),
  powershell:
    env.CCDT_POWERSHELL ??
    (existsSync(join(vendor, 'pwsh', 'pwsh.exe')) ? join(vendor, 'pwsh', 'pwsh.exe') : 'pwsh.exe'),
});

// The release ccdt belongs to, which is the one of the service it speaks to: the package writes it in.
export const version =
  typeof __CCDT_VERSION__ === 'string'
    ? __CCDT_VERSION__
    : JSON.parse(readFileSync(new URL('../../desktop/package.json', import.meta.url), 'utf8'))
        .version;

// ccdt runs from a package (scripts/package-cli.mjs), which it can replace with another release's, rather than from
// the source tree.
export const bundled = typeof __CCDT_VERSION__ === 'string';

// The name of the ccdt package of a release for a system, as the release page has it; undefined for a system there
// is none for.
const SYSTEMS = {
  'win32-x64': 'windows-x64',
  'darwin-arm64': 'mac-arm64',
  'darwin-x64': 'mac-x64',
  'linux-x64': 'linux-x64',
  'linux-arm64': 'linux-arm64',
};
export const packageName = (release, system = `${process.platform}-${process.arch}`) => {
  const name = SYSTEMS[system];
  return name && `ccdt-${release}-${name}.${name.startsWith('windows') ? 'zip' : 'tar.gz'}`;
};

export const releasePage = (release) =>
  `https://github.com/sun168567/cc-desk-tunnel/releases/tag/v${release}`;
