import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ServerOptions } from './server.ts';

function port(value: string | undefined, fallback: number, name: string) {
  const number = Number(value ?? fallback);
  if (!Number.isInteger(number) || number < 1 || number > 65535) throw new Error(`Invalid ${name}`);
  return number;
}

// The proxy's own settings must not leak into the native CLI or its shells: they inherit this process environment.
// FRPS_* is what deployments made before 0.2.10 still carry in their configuration; nothing reads it any more.
export function clearServiceVariables(env: NodeJS.ProcessEnv) {
  for (const name of Object.keys(env))
    if (
      /^(PROXY_|FRPS_)/.test(name) ||
      [
        'CLAUDE_PATH',
        'CLAUDE_MODEL',
        'CLAUDE_SETTINGS_PATH',
        'CLAUDE_CONTEXT_RETENTION_DAYS',
      ].includes(name)
    )
      delete env[name];
}

export function environmentConfig(env: NodeJS.ProcessEnv, defaultDataDir: string) {
  const native = env.PROXY_ADAPTER === 'claude-code';
  const reverseProxy = env.PROXY_TLS_MODE === 'reverse-proxy';
  if (env.PROXY_TLS_MODE && !['direct', 'reverse-proxy'].includes(env.PROXY_TLS_MODE))
    throw new Error('PROXY_TLS_MODE must be direct or reverse-proxy.');
  const retention = Number(env.CLAUDE_CONTEXT_RETENTION_DAYS ?? 3650);
  if (!Number.isInteger(retention) || retention < 1)
    throw new Error('Invalid CLAUDE_CONTEXT_RETENTION_DAYS');
  if (native && !reverseProxy && (!env.PROXY_TLS_CERT || !env.PROXY_TLS_KEY))
    throw new Error('Direct mode requires PROXY_TLS_CERT and PROXY_TLS_KEY.');
  const options: ServerOptions = {
    token: env.PROXY_TOKEN ?? '',
    dataDir: resolve(env.PROXY_DATA_DIR ?? defaultDataDir),
    host: env.PROXY_HOST ?? (native && !reverseProxy ? '0.0.0.0' : '127.0.0.1'),
    reverseProxy,
    tls:
      native && !reverseProxy
        ? {
            cert: readFileSync(env.PROXY_TLS_CERT!),
            key: readFileSync(env.PROXY_TLS_KEY!),
          }
        : undefined,
    tunnel: native ? {} : undefined,
    allowedOrigins: env.PROXY_ORIGINS?.split(','),
    claude: native
      ? {
          executable: env.CLAUDE_PATH ?? 'claude',
          model: env.CLAUDE_MODEL,
          settingsPath: env.CLAUDE_SETTINGS_PATH,
          contextRetentionDays: retention,
        }
      : undefined,
  };
  // Releases are followed only by a real service; the entry script of the image says where programs and runtime are.
  if (native && env.PROXY_RELEASE_REPO !== 'none')
    options.updates = {
      repository: env.PROXY_RELEASE_REPO ?? 'sun168567/cc-desk-tunnel',
      token: env.PROXY_RELEASE_TOKEN || undefined,
      programDir:
        env.PROXY_PROGRAM_DIR && env.PROXY_RUNTIME_DIR ? env.PROXY_PROGRAM_DIR : undefined,
      runtimeDir: env.PROXY_RUNTIME_DIR,
      restart: () => {
        process.kill(process.pid, 'SIGTERM');
        setTimeout(() => process.exit(0), 20_000).unref();
      },
    };
  return { options, native, port: port(env.PROXY_PORT, 8787, 'PROXY_PORT') };
}
