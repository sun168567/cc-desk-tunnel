import { createHash } from 'node:crypto';
import { createReadStream, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

export type ClientRelease = { version: string; size: number; sha256: string; path: string };
const installer = /^CC-Desk-Tunnel-Setup-(\d+)\.(\d+)\.(\d+)-x64\.exe$/;

// The Windows installers in the data directory, placed by an administrator or fetched with a release. Connected
// clients are told the newest one's version and hash, and may download it with the service token. Only the
// newest three are kept.
const KEPT = 3;
export class ClientReleases {
  current: ClientRelease | null = null;
  private directory: string;
  private key = '';
  private pending: Promise<void> | undefined;
  constructor(directory: string) {
    this.directory = directory;
  }
  // Cheap unless the newest installer changed; the hash of a large file is computed once.
  refresh() {
    this.pending ??= this.scan()
      .catch(() => {
        this.current = null;
        this.key = '';
      })
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }
  private async scan() {
    let names: string[];
    try {
      names = readdirSync(this.directory);
    } catch {
      names = [];
    }
    const installers = names
      .map((name) => ({ name, parts: installer.exec(name)?.slice(1).map(Number) }))
      .filter((item): item is { name: string; parts: number[] } => !!item.parts)
      .sort(
        (a, b) => b.parts[0] - a.parts[0] || b.parts[1] - a.parts[1] || b.parts[2] - a.parts[2],
      );
    for (const old of installers.slice(KEPT))
      rmSync(join(this.directory, old.name), { force: true });
    const newest = installers[0];
    if (!newest) {
      this.current = null;
      this.key = '';
      return;
    }
    const path = join(this.directory, newest.name);
    const stat = statSync(path);
    const key = `${path}:${stat.size}:${stat.mtimeMs}`;
    if (key === this.key) return;
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    this.current = {
      version: newest.parts.join('.'),
      size: stat.size,
      sha256: hash.digest('hex'),
      path,
    };
    this.key = key;
  }
}
