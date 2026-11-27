import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { pluginRunSchema } from '@cc-desk-tunnel/protocol';
import type { PluginRun } from '@cc-desk-tunnel/protocol';

// How large a plugin's log grows before it is put aside, and how many of its runs are shown.
const LIMIT = 1024 * 1024;
const SHOWN = 200;

// A plugin's secrets are not shown as they are; in another form, as signed or encoded, they cannot be told.
export const masked = (text: string, secrets: string[]) =>
  secrets
    .filter((secret) => secret.length >= 4)
    .sort((a, b) => b.length - a.length)
    .reduce((result, secret) => result.replaceAll(secret, '***'), text);

// Each plugin's runs, a line of JSON each, in <data>/plugin-logs/<id>.log, with the one before it as <id>.1.log. The
// clients show them in their own language.
export class PluginLog {
  private directory: string;
  constructor(directory: string) {
    this.directory = join(directory, 'plugin-logs');
  }
  private file(id: string, old = '') {
    return join(this.directory, `${id}${old}.log`);
  }
  write(id: string, run: PluginRun) {
    const file = this.file(id);
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      if (existsSync(file) && statSync(file).size > LIMIT) renameSync(file, this.file(id, '.1'));
      appendFileSync(file, JSON.stringify(run) + '\n', { mode: 0o600 });
    } catch {
      // A log that cannot be written is gone without.
    }
  }
  read(id: string): PluginRun[] {
    const runs = ['.1', '']
      .map((old) => this.file(id, old))
      .filter((file) => existsSync(file))
      .flatMap((file) => readFileSync(file, 'utf8').split('\n'))
      .flatMap((line) => {
        try {
          return [pluginRunSchema.parse(JSON.parse(line))];
        } catch {
          return [];
        }
      });
    return runs.slice(-SHOWN);
  }
  clear(id: string) {
    for (const old of ['.1', '']) rmSync(this.file(id, old), { force: true });
  }
}
