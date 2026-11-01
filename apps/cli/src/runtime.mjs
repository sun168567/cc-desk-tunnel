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

export const releasePage = (release) =>
  `https://github.com/sun168567/cc-desk-tunnel/releases/tag/v${release}`;
