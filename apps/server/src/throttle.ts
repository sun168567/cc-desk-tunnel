const FREE_FAILURES = 5;
const MAX_PENDING = 64;
const MAX_PENDING_PER_ADDRESS = 4;
const HOUR = 3_600_000;

// Slows down guessing of the service token and floods of connections that never sign in, per client address.
// The sixth wrong token in a row makes an address wait a minute, each further one twice as long, up to an hour.
export class Throttle {
  private failures = new Map<string, { count: number; until: number }>();
  private pending = new Map<string, number>();
  private waiting = 0;

  // Seconds the address still has to wait, 0 when it may try.
  blocked(address: string, now = Date.now()) {
    const entry = this.failures.get(address);
    return entry && entry.until > now ? Math.ceil((entry.until - now) / 1000) : 0;
  }
  fail(address: string, now = Date.now()) {
    if (this.failures.size > 10_000)
      for (const [key, entry] of this.failures)
        if (entry.until + HOUR < now) this.failures.delete(key);
    const count = (this.failures.get(address)?.count ?? 0) + 1;
    const wait =
      count > FREE_FAILURES ? Math.min(60_000 * 2 ** (count - FREE_FAILURES - 1), HOUR) : 0;
    this.failures.set(address, { count, until: now + wait });
    return count;
  }
  succeed(address: string) {
    this.failures.delete(address);
  }
  // A connection that has not signed in yet takes one of a limited number of places.
  enter(address: string) {
    const own = this.pending.get(address) ?? 0;
    if (this.waiting >= MAX_PENDING || own >= MAX_PENDING_PER_ADDRESS) return false;
    this.pending.set(address, own + 1);
    this.waiting++;
    return true;
  }
  leave(address: string) {
    const own = this.pending.get(address) ?? 0;
    if (!own) return;
    if (own === 1) this.pending.delete(address);
    else this.pending.set(address, own - 1);
    this.waiting--;
  }
}
