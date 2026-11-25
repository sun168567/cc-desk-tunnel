import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

// How large a plugin's log grows before it is put aside.
const LIMIT = 1024 * 1024;

export class PluginLog {
  private directory: string;
  constructor(directory: string) {
    this.directory = join(directory, 'plugin-logs');
  }
  private file(id: string, old = '') {
    return join(this.directory, `${id}${old}.log`);
  }
  write(id: string, text: string) {
    const file = this.file(id);
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      if (existsSync(file) && statSync(file).size > LIMIT) renameSync(file, this.file(id, '.1'));
      appendFileSync(file, `${new Date().toISOString()} ${text}\n`, { mode: 0o600 });
    } catch {
      // A log that cannot be written is gone without.
    }
  }
}
