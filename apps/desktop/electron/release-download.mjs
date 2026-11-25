import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, rm } from 'node:fs/promises';
import { join } from 'node:path';

// Where this client's releases are published. The service normally hands out the installer; this is the other
// way to get it, for when the service has not fetched it or cannot.
export const releasePage = 'https://github.com/sun168567/cc-desk-tunnel/releases/download';
// A connection to the release host can start fast and then slow to a crawl, or stop without closing. The file
// is fetched in stretches: each connection is used for `stretch` milliseconds at most and the next continues
// where it ended; one that delivers nothing for `stall` is given up at once, and after `attempts` connections
// in a row that added nothing the download fails.
const defaultPace = { stretch: 20_000, stall: 15_000, attempts: 5 };

// What a download stopped by its caller rejects with.
export const cancelled = () => Object.assign(new Error('已取消。'), { cancelled: true });
const megabytes = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;

// Downloads the installer of `version` from the release page into `directory` and resolves to its path. It is
// kept only if its hash is the one the release's manifest states, and, when the service announced an installer
// of that version too, only if both name the same file. `fetch` is the caller's, so that the system's proxy
// settings apply. `progress` hears the bytes received; `report` hears the steps that bring none, so that a window
// can tell a connection being tried again, or the file being checked, from one that hangs. `signal` stops it.
export async function downloadRelease(
  fetch,
  version,
  directory,
  {
    announced,
    progress = () => {},
    report = () => {},
    signal,
    pace = defaultPace,
    page = releasePage,
  } = {},
) {
  if (!/^\d+\.\d+\.\d+$/.test(String(version))) throw new Error('版本号不正确。');
  const name = `CC-Desk-Tunnel-Setup-${version}-x64.exe`;
  let manifest;
  try {
    const response = await fetch(`${page}/v${version}/release.json`, {
      signal: AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    manifest = await response.json();
  } catch (error) {
    if (signal?.aborted) throw cancelled();
    throw new Error(
      `读取不到 ${version} 的发布信息（${error.name === 'TimeoutError' ? '30 秒没有响应' : error.message}）。\n请检查这台电脑能否访问 github.com，或改从服务端获取安装包。`,
    );
  }
  const file = manifest?.files?.find?.((item) => item?.name === name);
  if (
    manifest?.version !== version ||
    !file ||
    !/^[0-9a-f]{64}$/.test(file.sha256) ||
    !(file.size > 0)
  )
    throw new Error('发布信息里没有这个版本的安装包。');
  if (announced?.version === version && announced.sha256 !== file.sha256)
    throw new Error('发布页的安装包与服务端提供的不是同一个文件，已放弃升级。');
  const target = join(directory, name);
  const output = await open(target, 'w');
  try {
    let received = 0;
    let last;
    for (let idle = 0; received < file.size;) {
      if (idle >= pace.attempts)
        throw new Error(
          `从 GitHub 下载安装包中断（${last ?? '连接没有数据'}），已下载 ${megabytes(received)} / ${megabytes(file.size)}。\n请检查网络后重试，或改从服务端获取安装包。`,
        );
      if (signal?.aborted) throw cancelled();
      const before = received;
      const controller = new AbortController();
      // Why the connection was given up: at the end of its stretch, which is no failure, or for its silence.
      let ended = false;
      let silent = false;
      const end = setTimeout(() => {
        ended = true;
        controller.abort();
      }, pace.stretch);
      const hush = () => {
        silent = true;
        controller.abort();
      };
      let quiet = setTimeout(hush, pace.stall);
      const stop = () => controller.abort();
      signal?.addEventListener('abort', stop);
      let failed = false;
      try {
        const response = await fetch(`${page}/v${version}/${name}`, {
          headers: received ? { Range: `bytes=${received}-` } : {},
          signal: controller.signal,
        });
        if (!response.ok)
          throw Object.assign(new Error(`安装包下载失败（${response.status}）。`), { fatal: true });
        // A host that does not continue a file sends all of it again.
        if (received && response.status !== 206) {
          received = 0;
          await output.truncate(0);
        }
        for await (const chunk of response.body) {
          clearTimeout(quiet);
          quiet = setTimeout(hush, pace.stall);
          await output.write(chunk, 0, chunk.length, received);
          received += chunk.length;
          if (received > file.size)
            throw Object.assign(new Error('安装包比发布信息里的大，已放弃升级。'), { fatal: true });
          progress(received, file.size);
        }
      } catch (error) {
        if (signal?.aborted) throw cancelled();
        if (error?.fatal) throw error;
        failed = !ended || silent;
        last = silent ? `${Math.round(pace.stall / 1000)} 秒没有收到数据` : error.message;
      } finally {
        clearTimeout(end);
        clearTimeout(quiet);
        signal?.removeEventListener('abort', stop);
      }
      idle = received > before ? 0 : idle + 1;
      if (failed && received < file.size)
        report({ phase: 'retrying', attempt: idle, attempts: pace.attempts, reason: last });
    }
    await output.close();
    report({ phase: 'verifying' });
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(target)) hash.update(chunk);
    if (hash.digest('hex') !== file.sha256) throw new Error('安装包校验失败，已放弃升级。');
    return target;
  } catch (error) {
    await output.close().catch(() => {});
    await rm(target, { force: true });
    throw error;
  }
}
