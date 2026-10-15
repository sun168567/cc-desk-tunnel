// How many messages one Codex worker may deliver in a second before its run is stopped.
export const IPC_PER_SECOND = 200;
// How much of that worker's own output is kept on disk. Past this, further output is discarded.
export const LOG_BYTES = 1024 * 1024;

export function takeIpc(
  state: { window: number; count: number },
  now: number,
  perSec = IPC_PER_SECOND,
): 'ok' | 'limit' | 'drop' {
  if (now - state.window >= 1000) {
    state.window = now;
    state.count = 0;
  }
  state.count += 1;
  if (state.count <= perSec) return 'ok';
  if (state.count === perSec + 1) return 'limit';
  return 'drop';
}

export function takeLog(used: number, chunk: Buffer, max = LOG_BYTES) {
  if (used >= max) return { used, slice: undefined as Buffer | undefined };
  const slice = chunk.subarray(0, max - used);
  return { used: used + slice.length, slice };
}
