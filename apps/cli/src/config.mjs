import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Connection details follow the XDG layout. The service token goes to the Secret Service (GNOME Keyring, KWallet)
// through secret-tool when one answers, and only otherwise into the config file, which only the user can read.
export function configDirectory(env = process.env) {
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'cc-desk-tunnel');
}
const configPath = (env) => join(configDirectory(env), 'cli.json');
const attributes = (url) => ['service', 'cc-desk-tunnel', 'url', url];

// Runs secret-tool; null when it is missing or the keyring refuses, so callers fall back to the file.
export function secretTool(args, input, env = process.env) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('secret-tool', args, { env, stdio: ['pipe', 'pipe', 'ignore'] });
    } catch {
      return resolve(null);
    }
    let output = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => (output += chunk));
    child.once('error', () => resolve(null));
    child.once('close', (code) => resolve(code === 0 ? output : null));
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}

export async function loadConfig(env = process.env, secrets = secretTool) {
  let saved;
  try {
    saved = JSON.parse(await readFile(configPath(env), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`配置文件无法读取：${configPath(env)}`);
  }
  if (typeof saved?.url !== 'string') return null;
  const token =
    env.CCDT_TOKEN?.trim() ||
    (typeof saved.token === 'string' && saved.token) ||
    (await secrets(['lookup', ...attributes(saved.url)], '', env))?.trim() ||
    '';
  return { url: saved.url, fingerprint: String(saved.fingerprint ?? ''), token };
}

// Returns where the token ended up: 'keyring' or 'file'.
export async function saveConfig(
  { url, fingerprint, token },
  env = process.env,
  secrets = secretTool,
) {
  const stored =
    (await secrets(
      ['store', '--label', `CC Desk Tunnel (${url})`, ...attributes(url)],
      token,
      env,
    )) !== null;
  const directory = configDirectory(env);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${configPath(env)}.tmp`;
  await writeFile(
    temporary,
    JSON.stringify({ url, fingerprint, ...(!stored && { token }) }, null, 2) + '\n',
    { mode: 0o600 },
  );
  await rename(temporary, configPath(env));
  return stored ? 'keyring' : 'file';
}

export async function clearConfig(env = process.env, secrets = secretTool) {
  const saved = await loadConfig({ ...env, CCDT_TOKEN: '' }, async () => '').catch(() => null);
  if (saved) await secrets(['clear', ...attributes(saved.url)], '', env);
  await rm(configPath(env), { force: true });
  return !!saved;
}

// The desktop client's saved address and pin, offered as defaults. Its token is encrypted for Electron and stays there.
export async function desktopLogin(env = process.env) {
  try {
    const { login } = JSON.parse(
      await readFile(
        join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'CC Desk Tunnel/settings.json'),
        'utf8',
      ),
    );
    return { url: String(login?.url ?? ''), fingerprint: String(login?.fingerprint ?? '') };
  } catch {
    return { url: '', fingerprint: '' };
  }
}
