import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { limitReport, planLaunch, writeCgroup } from '../src/limits.ts';

test('Codex is limited only on Linux, and a cgroup replaces the address-space cap', () => {
  const limits = { memoryMb: 2048, pids: 64 };
  assert.deepEqual(
    planLaunch({ executable: 'codex', args: ['app-server'], limits, platform: 'win32', prlimit: true }),
    { command: 'codex', args: ['app-server'], wrapped: false },
  );
  assert.deepEqual(
    planLaunch({
      executable: 'app-server.mjs',
      args: ['app-server'],
      limits,
      platform: 'linux',
      prlimit: true,
    }),
    { command: 'app-server.mjs', args: ['app-server'], wrapped: false },
  );
  const capped = planLaunch({
    executable: 'codex',
    args: ['app-server'],
    limits,
    platform: 'linux',
    prlimit: true,
  });
  assert.equal(capped.command, 'prlimit');
  assert.deepEqual(capped.args, ['--nproc=64', '--as=2147483648', '--', 'codex', 'app-server']);
  const grouped = planLaunch({
    executable: 'codex',
    args: ['app-server'],
    limits,
    platform: 'linux',
    prlimit: true,
    cgroup: true,
  });
  assert.deepEqual(grouped.args, ['--nproc=64', '--', 'codex', 'app-server']);
  assert.equal(limitReport({ limits, wrapped: true, cgroup: true }).kind, 'cgroup');
  assert.equal(limitReport({ limits, wrapped: true, cgroup: false }).kind, 'rlimit');
  assert.equal(limitReport({ wrapped: false, cgroup: false }).kind, 'none');
});

test('a cgroup leaf records the memory cap, the process cap, and the process id', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cc-desk-cgroup-'));
  try {
    writeCgroup(directory, 4242, { memoryMb: 512, pids: 16, cpuMillis: 1000 });
    assert.equal(readFileSync(join(directory, 'memory.max'), 'utf8'), String(512 * 1024 * 1024));
    assert.equal(readFileSync(join(directory, 'pids.max'), 'utf8'), '16');
    assert.equal(readFileSync(join(directory, 'cpu.max'), 'utf8'), '100000 100000');
    assert.equal(readFileSync(join(directory, 'cgroup.procs'), 'utf8'), '4242');
    assert.equal(
      limitReport({ limits: { memoryMb: 512, pids: 16, cpuMillis: 1000 }, wrapped: false, cgroup: true })
        .cpu,
      true,
    );
    assert.equal(limitReport({ limits: { memoryMb: 512, pids: 16, cpuMillis: 1000 }, wrapped: true, cgroup: false }).cpu, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
