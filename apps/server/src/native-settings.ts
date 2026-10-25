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

// Settings the CLI takes as environment variables, which the file holds under `env` as text.
const variables: Partial<Record<keyof NativeSettings, string>> = {
  toolSearch: 'ENABLE_TOOL_SEARCH',
};
const environment = (file: Record<string, unknown>) =>
  file.env && typeof file.env === 'object' && !Array.isArray(file.env)
    ? (file.env as Record<string, unknown>)
    : {};

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

// The variables the file gives the CLI; a file that cannot be read gives none.
export function settingsEnvironment(path = settingsPath()): Record<string, string> {
  try {
    return Object.fromEntries(
      Object.entries(environment(readFile(path))).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );
  } catch {
    return {};
  }
}

export function readNativeSettings(path = settingsPath()): NativeSettings {
  const file = readFile(path);
  // A value the schema does not accept was written by hand; it is shown as unset and left alone until changed here.
  return Object.fromEntries(
    Object.entries(nativeSettingsSchema.shape).map(([key, schema]) => {
      const variable = variables[key as keyof NativeSettings];
      if (variable) {
        const text = environment(file)[variable];
        return [key, text === 'true' ? true : text === 'false' ? false : null];
      }
      const parsed = schema.safeParse(file[key] ?? null);
      return [key, parsed.success ? parsed.data : null];
    }),
  ) as NativeSettings;
}

export function updateNativeSettings(values: Partial<NativeSettings>, path = settingsPath()) {
  const file = readFile(path);
  for (const [key, value] of Object.entries(values)) {
    const variable = variables[key as keyof NativeSettings];
    if (variable) {
      if (value === undefined) continue;
      const env = { ...environment(file) };
      if (value === null) delete env[variable];
      else env[variable] = String(value);
      if (Object.keys(env).length) file.env = env;
      else delete file.env;
      continue;
    }
    if (value === null) delete file[key];
    else if (value !== undefined) file[key] = value;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(`${path}.proxy`, JSON.stringify(file, null, 2) + '\n', { mode: 0o600 });
  renameSync(`${path}.proxy`, path);
  return readNativeSettings(path);
}
