import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

// Whether a plugin is enabled, kept apart from the plugin's own directory so that replacing the plugin keeps it. A file
// that cannot be read is a plugin's that was never set.
const configSchema = z.object({
  enabled: z.boolean().default(true),
  // The user enabled it knowing that it is not confined.
  agreed: z.boolean().default(false),
});
export type PluginConfig = z.infer<typeof configSchema>;

const file = (directory: string, id: string) => join(directory, 'plugin-config', `${id}.json`);

export function readPluginConfig(directory: string, id: string): PluginConfig {
  try {
    return configSchema.parse(JSON.parse(readFileSync(file(directory, id), 'utf8')));
  } catch {
    return configSchema.parse({});
  }
}
export function writePluginConfig(directory: string, id: string, config: PluginConfig) {
  mkdirSync(join(directory, 'plugin-config'), { recursive: true, mode: 0o700 });
  const path = file(directory, id);
  writeFileSync(`${path}.new`, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  renameSync(`${path}.new`, path);
}
