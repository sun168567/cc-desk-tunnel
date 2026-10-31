import { spawn, execFile } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { constants } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { pathKey } from '@cc-desk-tunnel/protocol';
import { nativeDirectory, prepareNativeDirectory, remotePrompt } from './claude.ts';
import { clearServiceVariables } from './config.ts';
import { terminalEnvironment } from './native-terminal.ts';
import { UsageLog, createUsageReceiver, telemetryEnvironment } from './usage.ts';

export type ExternalCliArguments = {
  dataDir: string;
  executable: string;
  settingsPath?: string;
  deviceId: string;
  projectPath: string;
  continueSession: boolean;
  check: boolean;
};

export const externalCliHelp = `Usage: external-cli --device-id <UUID> --project-base64 <UTF-8 Base64> [options]
  --data-dir <directory>       Server state directory (default: /data/state)
  --executable <program>       Official Claude Code executable (default: claude)
  --settings-path <file>       Existing provider settings, if the service uses them
  --continue                  Continue this project's last native CLI conversation
  --check                     Check existing state and the device channel without starting Claude
  --help                      Show this help
Keep the desktop client connected: it supplies the Windows execution channel.
`;

export function parseExternalCliArguments(values: string[]): ExternalCliArguments {
  const argumentsOf: Record<string, string> = {};
  let check = false,
    continueSession = false;
  for (let i = 0; i < values.length; i++) {
    const flag = values[i];
    if (flag === '--check') check = true;
    else if (flag === '--continue') continueSession = true;
    else if (
      ['--data-dir', '--executable', '--settings-path', '--device-id', '--project-base64'].includes(
        flag,
      )
    ) {
      const value = values[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}.`);
      argumentsOf[flag] = value;
    } else throw new Error(`Unknown argument: ${flag}.`);
  }
  const deviceId = argumentsOf['--device-id']?.toLowerCase();
  if (!deviceId || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(deviceId))
    throw new Error('--device-id must name a connected CC Desk device UUID.');
  const encoded = argumentsOf['--project-base64'];
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))
    throw new Error('--project-base64 must be a UTF-8 Windows project path.');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) throw new Error('Non-canonical project Base64.');
  const projectPath = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (
    !/^(?:[a-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$))/i.test(projectPath) ||
    /[\x00-\x1f]/.test(projectPath)
  )
    throw new Error('Choose a drive-qualified or UNC-share Windows project path.');
  return {
    dataDir: resolve(argumentsOf['--data-dir'] ?? '/data/state'),
    executable: argumentsOf['--executable'] ?? 'claude',
    ...(argumentsOf['--settings-path']
      ? { settingsPath: resolve(argumentsOf['--settings-path']) }
      : {}),
    deviceId,
    projectPath,
    check,
    continueSession,
  };
}

export function externalCliRoot(deviceId: string, projectPath: string) {
  return (
    'cli-' +
    createHash('sha256')
      .update(deviceId.toLowerCase() + '\0' + pathKey(projectPath))
      .digest('hex')
      .slice(0, 32)
  );
}

export function externalCliEnvironment(
  options: ExternalCliArguments,
  inherited: NodeJS.ProcessEnv = process.env,
) {
  const environment = { ...inherited };
  clearServiceVariables(environment);
  const result = terminalEnvironment(options, environment);
  clearServiceVariables(result);
  return result;
}

function probeSsh(configPath: string, environment: NodeJS.ProcessEnv, timeout: number) {
  return new Promise<void>((resolveProbe, reject) => {
    const child = execFile(
      'ssh',
      ['-F', configPath, 'device-script'],
      { env: environment, timeout, maxBuffer: 65536 },
      (error, stdout) => {
        if (error || !stdout.includes('CC_DESK_TUNNEL_SSH_READY'))
          reject(new Error('The Windows execution channel did not answer its SSH probe.'));
        else resolveProbe();
      },
    );
    child.stdin?.on('error', () => {});
    child.stdin?.end('echo CC_DESK_TUNNEL_SSH_READY\n');
  });
}

type Probe = typeof probeSsh;
export async function waitForExternalDevice(
  configPath: string,
  environment: NodeJS.ProcessEnv,
  {
    timeoutMs = 30000,
    retryMs = 500,
    probe = probeSsh,
  }: {
    timeoutMs?: number;
    retryMs?: number;
    probe?: Probe;
  } = {},
) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (existsSync(configPath)) {
      try {
        await probe(configPath, environment, Math.max(1, Math.min(20000, deadline - Date.now())));
        return;
      } catch {
        // A newly launched client may still be registering its temporary execution channel.
      }
    }
    if (Date.now() >= deadline) break;
    await delay(Math.min(retryMs, deadline - Date.now()));
  } while (Date.now() <= deadline);
  throw new Error('The Windows execution channel was not ready before the SSH probe timed out.');
}

export function externalCliCommand(options: ExternalCliArguments) {
  const root = externalCliRoot(options.deviceId, options.projectPath);
  const ssh = { configPath: join(options.dataDir, 'devices', options.deviceId, 'ssh_config') };
  const prompt =
    remotePrompt(options.projectPath, ssh, 'external-' + root, 'win32') +
    '\nThis is an external CLI conversation. Desktop scheduling and desktop session IDs do not apply. ' +
    'Native CLI history stays on this Linux host; use /resume to select its earlier conversations.';
  return {
    root,
    ssh,
    cwd: nativeDirectory(options.dataDir, root),
    args: [
      '--permission-mode',
      'manual',
      '--append-system-prompt',
      prompt,
      ...(options.settingsPath ? ['--settings', options.settingsPath] : []),
      ...(options.continueSession ? ['--continue'] : []),
    ],
  };
}

type SpawnCli = (program: string, argumentsOf: string[], options: SpawnOptions) => ChildProcess;
export async function runExternalProcess(
  executable: string,
  argumentsOf: string[],
  cwd: string,
  environment: Record<string, string>,
  spawnCli: SpawnCli = spawn,
) {
  // A separate POSIX group lets SSH hangup end the CLI and its Linux-side command children.
  const separateGroup = process.platform !== 'win32';
  const child = spawnCli(executable, argumentsOf, {
    cwd,
    env: environment,
    stdio: 'inherit',
    detached: separateGroup,
  });
  const kill = (signal: NodeJS.Signals) => {
    if (!child.pid) return;
    try {
      if (separateGroup) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  };
  let force: ReturnType<typeof setTimeout> | undefined;
  const interrupt = () => {
    // The child is in a different group; a terminal-generated SIGINT reaches the parent only.
    if (separateGroup) kill('SIGINT');
  };
  const terminate = (signal: NodeJS.Signals) => {
    kill(signal);
    force ??= setTimeout(() => kill('SIGKILL'), 5000);
    force.unref();
  };
  const hangup = () => terminate('SIGHUP');
  const shutdown = () => terminate('SIGTERM');
  process.on('SIGINT', interrupt);
  process.on('SIGHUP', hangup);
  process.on('SIGTERM', shutdown);
  try {
    return await new Promise<number>((resolveExit, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) =>
        resolveExit(code ?? 128 + (signal ? constants.signals[signal] : 1)),
      );
    });
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGHUP', hangup);
    process.off('SIGTERM', shutdown);
    if (force) clearTimeout(force);
    if (separateGroup) kill('SIGKILL');
  }
}

export async function runExternalCli(
  options: ExternalCliArguments,
  dependencies: {
    inherited?: NodeJS.ProcessEnv;
    probe?: Probe;
    spawnCli?: SpawnCli;
    probeTimeoutMs?: number;
  } = {},
) {
  const databasePath = join(options.dataDir, 'sessions.sqlite');
  if (!existsSync(databasePath) || !statSync(databasePath).isFile())
    throw new Error('The server state must already contain sessions.sqlite; check --data-dir.');
  const command = externalCliCommand(options);
  const environment = externalCliEnvironment(options, dependencies.inherited);
  await waitForExternalDevice(command.ssh.configPath, environment, {
    probe: dependencies.probe,
    timeoutMs: dependencies.probeTimeoutMs,
  });
  if (options.check) return 0;
  prepareNativeDirectory(options, options.dataDir, command.root);
  const database = new DatabaseSync(databasePath);
  let receiver: ReturnType<typeof createUsageReceiver> | undefined;
  try {
    database.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL');
    receiver = createUsageReceiver(new UsageLog(database));
    Object.assign(environment, telemetryEnvironment(await receiver.listen()));
    return await runExternalProcess(
      options.executable,
      command.args,
      command.cwd,
      environment,
      dependencies.spawnCli,
    );
  } finally {
    try {
      await receiver?.close();
    } finally {
      database.close();
    }
  }
}

export async function externalCliMain(values: string[]) {
  if (values.includes('--help')) {
    process.stdout.write(externalCliHelp);
    return 0;
  }
  const options = parseExternalCliArguments(values);
  const result = await runExternalCli(options);
  if (options.check)
    process.stdout.write('Existing server state and Windows execution channel: ready.\n');
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await externalCliMain(process.argv.slice(2));
  } catch (error) {
    console.error('CC Desk external CLI: ' + (error as Error).message);
    process.exitCode = 1;
  }
}
