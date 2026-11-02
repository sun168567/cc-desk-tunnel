import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packageName } from './runtime.mjs';

const RELEASES = 'https://github.com/sun168567/cc-desk-tunnel/releases/download';
// The first release whose install script replaces a ccdt while it runs; an earlier one's would leave it half removed.
export const FIRST_UPGRADABLE = '0.3.9';

// The ccdt package of a release for this system, checked against the release's SHA256SUMS as the server bundle is.
export async function download(release, { system, get = fetch } = {}) {
  const name = packageName(release, system);
  if (!name)
    throw new Error(
      `没有这个系统（${system ?? `${process.platform}-${process.arch}`}）的 ccdt 包。`,
    );
  const fetched = async (file) => {
    let response;
    try {
      response = await get(`${RELEASES}/v${release}/${file}`, {
        signal: AbortSignal.timeout(300_000),
      });
    } catch (error) {
      throw new Error(
        `下载 ${file} 失败：${error.cause?.message ?? error.message}。需要代理时，设置 HTTPS_PROXY 和 NODE_USE_ENV_PROXY=1 再试。`,
      );
    }
    if (!response.ok) throw new Error(`下载 ${file} 失败（HTTP ${response.status}）。`);
    return Buffer.from(await response.arrayBuffer());
  };
  const sums = (await fetched('SHA256SUMS')).toString('utf8');
  const expected = sums
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .find(([, file]) => file === name)?.[0];
  if (!expected) throw new Error(`${release} 的校验清单里没有 ${name}。`);
  const body = await fetched(name);
  if (createHash('sha256').update(body).digest('hex') !== expected)
    throw new Error(`下载的 ${name} 校验不符，没有安装。`);
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
      throw new Error(`新版本没有装上：${String(error.stderr ?? error.message).trim()}`);
    }
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}
