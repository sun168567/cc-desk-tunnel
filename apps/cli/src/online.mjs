import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { t } from './i18n.mjs';

// `ccdt online`: this computer stays online for Claude's commands without a terminal, as it is while a terminal of
// ccdt is open; on a server without a screen it runs in the background. A lost connection is signed in again, at
// growing intervals up to a minute, until `stop` resolves; a refused token or another release ends it, as they
// would end any other connection of ccdt. Each change is said on a line of its own, with the time, for a log.
// While it is online it says so by `mark` (see `markOnline`).
export async function stayOnline({
  connect,
  say,
  stop,
  mark = () => {},
  wait = (ms) => delay(ms),
  now = () => new Date(),
}) {
  const stamp = () => now().toLocaleString();
  let stopping = false;
  let service = await connect(false);
  void stop.then(() => {
    stopping = true;
    void service.close().catch(() => {});
  });
  for (;;) {
    try {
      await service.channel();
      mark(true);
      say(`${stamp()} ${t('cli:online.online', { host: hostname() })}`);
    } catch (error) {
      // A connection that ended before its channel was ready is signed in again below.
      if (!service.ended) {
        await service.close().catch(() => {});
        throw error;
      }
    }
    await service.closed;
    mark(false);
    if (stopping) return 0;
    say(`${stamp()} ${t('cli:online.reconnecting')}`);
    for (let ms = 1000; ; ms = Math.min(ms * 2, 60000)) {
      await Promise.race([wait(ms), stop]);
      if (stopping) return 0;
      try {
        service = await connect(true);
        break;
      } catch (error) {
        if (error.code === 'unauthorized' || error.code === 'version_mismatch') throw error;
      }
    }
    if (stopping) {
      await service.close().catch(() => {});
      return 0;
    }
  }
}

// Where `ccdt online` says it is online for the service at `url`: a file with its process and the service. Another
// ccdt of this computer for that service then opens no execution channel of its own (see `onlineAt`).
export function markOnline(path, url, pid = process.pid) {
  return (on) => {
    if (on) writeFileSync(path, JSON.stringify({ pid, url }), { mode: 0o600 });
    else {
      // Only its own: another `ccdt online` may have written it since.
      try {
        if (JSON.parse(readFileSync(path, 'utf8')).pid !== pid) return;
      } catch {
        return;
      }
      rmSync(path, { force: true });
    }
  };
}
// Whether a `ccdt online` that is still running said it is online for the service at `url`.
export function onlineAt(path, url) {
  try {
    const said = JSON.parse(readFileSync(path, 'utf8'));
    if (said.url !== url || !Number.isInteger(said.pid)) return false;
    process.kill(said.pid, 0);
    return true;
  } catch {
    return false;
  }
}
