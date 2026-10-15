import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ServerOptions } from './server.ts';

function bounded(
  value: string | undefined,
  fallback: number,
  name: string,
  min: number,
  max: number,
) {
  if (value === undefined || value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`Invalid ${name}`);
  return number;
}

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
        'CODEX_PATH',
        'CODEX_PROFILE',
        'CODEX_MODEL',
        'CODEX_MEMORY_MB',
        'CODEX_PIDS_MAX',
        'CODEX_CPU_MILLICORES',
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
  const maxRuns = env.PROXY_MAX_RUNS ? Number(env.PROXY_MAX_RUNS) : undefined;
  if (maxRuns !== undefined && (!Number.isInteger(maxRuns) || maxRuns < 1))
    throw new Error('Invalid PROXY_MAX_RUNS');
  const grace = env.PROXY_GRACE_SECONDS ? Number(env.PROXY_GRACE_SECONDS) : undefined;
  if (grace !== undefined && (!Number.isInteger(grace) || grace < 0 || grace > 3600))
    throw new Error('Invalid PROXY_GRACE_SECONDS');
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
    maxRuns,
    graceMs: grace === undefined ? undefined : grace * 1000,
    allowedOrigins: env.PROXY_ORIGINS?.split(','),
    claude: native
      ? {
          executable: env.CLAUDE_PATH ?? 'claude',
          model: env.CLAUDE_MODEL,
          settingsPath: env.CLAUDE_SETTINGS_PATH,
          contextRetentionDays: retention,
        }
      : undefined,
    codex: env.CODEX_PATH
      ? {
          executable: env.CODEX_PATH,
          profileId: env.CODEX_PROFILE ?? 'default',
          ...(env.CODEX_MODEL ? { model: env.CODEX_MODEL } : {}),
          memoryMb: bounded(env.CODEX_MEMORY_MB, 2048, 'CODEX_MEMORY_MB', 256, 65536),
          pidsMax: bounded(env.CODEX_PIDS_MAX, 64, 'CODEX_PIDS_MAX', 8, 4096),
          cpuMillis: bounded(env.CODEX_CPU_MILLICORES, 1000, 'CODEX_CPU_MILLICORES', 50, 16000),
        }
      : undefined,
  };
  // Releases are followed only by a real service; the entry script of the image says where programs and runtime are.
  if (native && env.PROXY_RELEASE_REPO !== 'none')
    options.updates = {
      repository: env.PROXY_RELEASE_REPO ?? 'Dreamer062176/cc-desk-tunnel',
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

function codexPathFile(dataDir: string) {
  return join(dataDir, 'CODEX_PATH');
}

// Missing file: the process environment decides. An empty file turns Codex off.
export function savedCodexExecutable(dataDir: string): string | undefined {
  const file = codexPathFile(dataDir);
  if (!existsSync(file)) return undefined;
  return readFileSync(file, 'utf8').trim();
}

export function writeCodexExecutable(dataDir: string, executable: string) {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(codexPathFile(dataDir), executable, { mode: 0o600 });
}

// The settings page stores the path beside the sessions. It wins over CODEX_PATH from the environment.
export function applySavedCodexPath(options: ServerOptions) {
  const saved = savedCodexExecutable(options.dataDir);
  if (saved === undefined) return;
  if (!saved) {
    options.codex = undefined;
    return;
  }
  options.codex = {
    executable: saved,
    profileId: options.codex?.profileId ?? 'default',
    ...(options.codex?.model ? { model: options.codex.model } : {}),
    memoryMb: options.codex?.memoryMb ?? 2048,
    pidsMax: options.codex?.pidsMax ?? 64,
    cpuMillis: options.codex?.cpuMillis ?? 1000,
  };
}
