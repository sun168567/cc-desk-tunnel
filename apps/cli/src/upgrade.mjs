import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packageName } from './runtime.mjs';
import { t } from './i18n.mjs';

const RELEASES = 'https://github.com/sun168567/cc-desk-tunnel/releases/download';
// The first release whose install script replaces a ccdt while it runs; an earlier one's would leave it half removed.
export const FIRST_UPGRADABLE = '0.3.9';

// The ccdt package of a release for this system, checked against the release's SHA256SUMS as the server bundle is.
export async function download(release, { system, get = fetch } = {}) {
  const name = packageName(release, system);
  if (!name)
    throw new Error(
      t('cli:upgrade.noPackage', { system: system ?? `${process.platform}-${process.arch}` }),
    );
  const fetched = async (file) => {
    let response;
    try {
      response = await get(`${RELEASES}/v${release}/${file}`, {
        signal: AbortSignal.timeout(300_000),
      });
    } catch (error) {
      throw new Error(
        t('cli:upgrade.downloadFailed', { file, reason: error.cause?.message ?? error.message }),
      );
    }
    if (!response.ok)
      throw new Error(t('cli:upgrade.httpFailed', { file, status: response.status }));
    return Buffer.from(await response.arrayBuffer());
  };
  const sums = (await fetched('SHA256SUMS')).toString('utf8');
  const expected = sums
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .find(([, file]) => file === name)?.[0];
  if (!expected) throw new Error(t('cli:upgrade.notListed', { release, name }));
  const body = await fetched(name);
  if (createHash('sha256').update(body).digest('hex') !== expected)
    throw new Error(t('cli:upgrade.badHash', { name }));
  return { name, body };
}

// Puts the downloaded package in place with the install script it carries, as installing it by hand does. On Windows
// the script moves the folder of the running ccdt aside before copying, which Windows allows while its files are in
// use.
export function install({ name, body }, { windows = process.platform === 'win32' } = {}) {
  const folder = mkdtempSync(join(tmpdir(), 'ccdt-upgrade-'));
  try {
    const archive = join(folder, name);
    writeFileSync(archive, body);
    // The system's own tar, which reads .zip on Windows; a shell may put another one first on the PATH.
    const tar = windows
      ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
      : 'tar';
    execFileSync(tar, ['-xf', archive, '-C', folder]);
    try {
      if (windows)
        execFileSync(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            join(folder, 'ccdt', 'install.ps1'),
          ],
          { stdio: 'pipe', windowsHide: true },
        );
      else execFileSync('sh', [join(folder, 'ccdt', 'install.sh')], { stdio: 'pipe' });
    } catch (error) {
      throw new Error(
        t('cli:upgrade.installFailed', { reason: String(error.stderr ?? error.message).trim() }),
      );
    }
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}
