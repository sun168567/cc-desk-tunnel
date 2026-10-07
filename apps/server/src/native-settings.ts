import { readFileSync, renameSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { nativeSettingsSchema } from '@cc-desk-tunnel/protocol';
import type { NativeSettings } from '@cc-desk-tunnel/protocol';

// The official CLI's user settings file. The proxy edits only the keys in the protocol schema and keeps every
// other key as it found it; a new CLI process reads the file when it starts, so changes apply from the next run.
export function settingsPath(configDirectory = process.env.CLAUDE_CONFIG_DIR) {
  return join(configDirectory ?? join(homedir(), '.claude'), 'settings.json');
}

function readFile(path: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  const value = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Settings file is not an object');
  return value;
}

export function readNativeSettings(path = settingsPath()): NativeSettings {
  const file = readFile(path);
  // A value the schema does not accept was written by hand; it is shown as unset and left alone until changed here.
  return Object.fromEntries(
    Object.entries(nativeSettingsSchema.shape).map(([key, schema]) => {
      const parsed = schema.safeParse(file[key] ?? null);
      return [key, parsed.success ? parsed.data : null];
    }),
  ) as NativeSettings;
}

export function updateNativeSettings(values: Partial<NativeSettings>, path = settingsPath()) {
  const file = readFile(path);
  for (const [key, value] of Object.entries(values)) {
    if (value === null) delete file[key];
    else if (value !== undefined) file[key] = value;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(`${path}.proxy`, JSON.stringify(file, null, 2) + '\n', { mode: 0o600 });
  renameSync(`${path}.proxy`, path);
  return readNativeSettings(path);
}
