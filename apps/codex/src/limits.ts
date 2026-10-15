import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CodexLimits } from '@cc-desk-tunnel/agent-ipc';

export type LimitBudget = { memoryMb: number; pids: number; cpuMillis?: number };

// cgroup v2 cpu.max is a quota and a period, both in microseconds. 1000 millicores is one CPU.
export function cpuMaxLine(millis: number) {
  return `${Math.round((millis / 1000) * 100_000)} 100000`;
}

function writeLimits(directory: string, limits: LimitBudget) {
  writeFileSync(join(directory, 'memory.max'), String(limits.memoryMb * 1024 * 1024));
  writeFileSync(join(directory, 'pids.max'), String(limits.pids));
  if (limits.cpuMillis && limits.cpuMillis > 0)
    writeFileSync(join(directory, 'cpu.max'), cpuMaxLine(limits.cpuMillis));
}

// What a launch should exec. A script double is the test app-server, not Codex, so it is not wrapped.
export function planLaunch(options: {
  executable: string;
  args: string[];
  limits?: LimitBudget;
  platform?: NodeJS.Platform;
  prlimit?: boolean;
  // When a cgroup will cap resident memory, the address-space cap is left off. Some allocators
  // reserve more virtual memory than they use, and that cap would stop a normal Codex.
  cgroup?: boolean;
}): { command: string; args: string[]; wrapped: boolean } {
  const platform = options.platform ?? process.platform;
  const script = options.executable.endsWith('.mjs') || options.executable.endsWith('.js');
  if (platform !== 'linux' || script || !options.limits || !options.prlimit)
    return { command: options.executable, args: options.args, wrapped: false };
  const flags = [`--nproc=${options.limits.pids}`];
  if (!options.cgroup) flags.push(`--as=${options.limits.memoryMb * 1024 * 1024}`);
  return {
    command: 'prlimit',
    args: [...flags, '--', options.executable, ...options.args],
    wrapped: true,
  };
}

export function limitReport(options: {
  limits?: LimitBudget;
  wrapped: boolean;
  cgroup: boolean;
}): CodexLimits {
  const memoryMb = options.limits?.memoryMb ?? 0;
  const pids = options.limits?.pids ?? 0;
  const cpuMillis = options.limits?.cpuMillis ?? 0;
  // Address-space caps do not limit CPU, and they do not include the worker process.
  const cpu = Boolean(options.cgroup && cpuMillis > 0);
  if (options.cgroup && options.limits)
    return { kind: 'cgroup', memory: true, memoryMb, pids, cpu, cpuMillis };
  if (options.wrapped && options.limits)
    return { kind: 'rlimit', memory: true, memoryMb, pids, cpu: false, cpuMillis: 0 };
  return { kind: 'none', memory: false, memoryMb, pids, cpu: false, cpuMillis: 0 };
}

let prlimitOk: boolean | undefined;

export function prlimitAvailable() {
  if (prlimitOk !== undefined) return prlimitOk;
  if (process.platform !== 'linux') return (prlimitOk = false);
  const result = spawnSync('prlimit', ['--version'], { timeout: 2000, windowsHide: true });
  return (prlimitOk = result.status === 0);
}

// The leaf under this process's cgroup, or nothing when the system has no cgroup v2 file.
export function cgroupLeaf() {
  if (process.platform !== 'linux') return undefined;
  try {
    const text = readFileSync('/proc/self/cgroup', 'utf8');
    const line = text.split('\n').find((item) => item.startsWith('0::'));
    if (!line) return undefined;
    const relative = line.slice('0::'.length).replace(/^\/+/, '');
    return join('/sys/fs/cgroup', relative, 'codex');
  } catch {
    return undefined;
  }
}

export function writeCgroup(directory: string, pid: number, limits: LimitBudget) {
  mkdirSync(directory, { recursive: true });
  writeLimits(directory, limits);
  writeFileSync(join(directory, 'cgroup.procs'), String(pid));
}

// Prepares the leaf. False when this user cannot create one; the caller then uses prlimit only.
export function prepareCgroup(limits: LimitBudget) {
  const leaf = cgroupLeaf();
  if (!leaf) return undefined;
  try {
    mkdirSync(leaf, { recursive: true });
    writeLimits(leaf, limits);
    return leaf;
  } catch {
    return undefined;
  }
}

export function moveToCgroup(directory: string, pid: number) {
  try {
    writeFileSync(join(directory, 'cgroup.procs'), String(pid));
    return true;
  } catch {
    return false;
  }
}
