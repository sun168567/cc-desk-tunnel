import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { failure, phrase } from './failure.cjs';

// Where the desktop releases are published. The service also distributes the Windows installer.
export const releasePage = 'https://github.com/sun168567/cc-desk-tunnel/releases/download';
// A connection to the release host can start fast and then slow to a crawl, or stop without closing. The file
// is fetched in stretches: each connection is used for `stretch` milliseconds at most and the next continues
// where it ended; one that delivers nothing for `stall` is given up at once, and after `attempts` connections
// in a row that added nothing the download fails.
const defaultPace = { stretch: 20_000, stall: 15_000, attempts: 5 };
// The asset name is used as both a URL segment and a local filename on any supported filesystem.
const assetName =
  /^(?!(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$))[a-z0-9][a-z0-9_-]*(?:\.[a-z0-9_-]+)*$/i;

// What a download stopped by its caller rejects with.
export const cancelled = () =>
  failure('desktop:download.cancelled', undefined, { cancelled: true });
const megabytes = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;

// Downloads the installer of `version` from the release page into `directory` and resolves to its path. It is
// kept only if its hash matches the manifest. The caller may also supply an announcement for this asset
// to check against the manifest. `fetch` is the caller's, so that the system's proxy
// settings apply. `progress` hears the bytes received; `report` hears the steps that bring none, so that a window
// can tell a connection being tried again, or the file being checked, from one that hangs. `signal` stops it.
export async function downloadRelease(
  fetch,
  version,
  directory,
  {
    name = `CC-Desk-Tunnel-Setup-${version}-x64.exe`,
    announced,
    progress = () => {},
    report = () => {},
    signal,
    pace = defaultPace,
    page = releasePage,
  } = {},
) {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version))
    throw failure('desktop:download.badVersion');
  if (typeof name !== 'string' || name.length > 255 || !assetName.test(name))
    throw failure('desktop:download.notInManifest');
  let manifest;
  try {
    const response = await fetch(`${page}/v${version}/release.json`, {
      signal: AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    manifest = await response.json();
  } catch (error) {
    if (signal?.aborted) throw cancelled();
    throw failure('desktop:download.noManifest', {
      version,
      reason:
        error.name === 'TimeoutError'
          ? phrase('desktop:download.noResponse', { seconds: 30 })
          : error.message,
    });
  }
  const file = Array.isArray(manifest?.files)
    ? manifest.files.find((item) => item?.name === name)
    : null;
  if (
    manifest?.version !== version ||
    !file ||
    !/^[0-9a-f]{64}$/.test(file.sha256) ||
    !Number.isSafeInteger(file.size) ||
    file.size <= 0
  )
    throw failure('desktop:download.notInManifest');
  if (announced?.version === version && announced.sha256 !== file.sha256)
    throw failure('desktop:download.otherFile');
  const target = join(directory, name);
  const output = await open(target, 'w');
  try {
    let received = 0;
    let last;
    for (let idle = 0; received < file.size;) {
      if (idle >= pace.attempts)
        throw failure('desktop:download.interrupted', {
          reason: last ?? phrase('desktop:download.nothing'),
          received: megabytes(received),
          size: megabytes(file.size),
        });
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
          throw failure(
            'desktop:download.httpFailed',
            { status: response.status },
            { fatal: true },
          );
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
            throw failure('desktop:download.tooLarge', undefined, { fatal: true });
          progress(received, file.size);
        }
      } catch (error) {
        if (signal?.aborted) throw cancelled();
        if (error?.fatal) throw error;
        failed = !ended || silent;
        last = silent
          ? phrase('desktop:download.noData', { seconds: Math.round(pace.stall / 1000) })
          : error.message;
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
    for await (const chunk of createReadStream(target, { signal })) hash.update(chunk);
    if (hash.digest('hex') !== file.sha256) throw failure('desktop:download.badHash');
    return target;
  } catch (error) {
    await output.close().catch(() => {});
    await rm(target, { force: true });
    throw signal?.aborted ? cancelled() : error;
  }
}
