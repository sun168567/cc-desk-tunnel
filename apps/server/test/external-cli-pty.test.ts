import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import type { IPty, IDisposable } from 'node-pty';

type Scenario = 'input' | 'interrupt' | 'hangup';
type RecordedProcesses = { cli: number; child?: number };

// These are Linux process/session tests. Windows and macOS have different terminal and signal semantics.
const linuxOnly = { skip: process.platform !== 'linux', timeout: 20000 };
const modulePath = fileURLToPath(new URL('../src/external-cli.ts', import.meta.url));
const moduleUrl = pathToFileURL(modulePath);

function running(pid: number) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const state = stat.slice(stat.lastIndexOf(') ') + 2, stat.lastIndexOf(') ') + 3);
    return state !== 'Z' && state !== 'X';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function stopped(pids: number[]) {
  const deadline = Date.now() + 2000;
  let survivors = pids.filter(running);
  while (survivors.length && Date.now() < deadline) {
    await delay(25);
    survivors = pids.filter(running);
  }
  return survivors;
}

async function exercisePty(scenario: Scenario) {
  const { spawn } = await import('node-pty');
  const directory = mkdtempSync(join(tmpdir(), 'ccdesk-external-pty-'));
  const pidfile = join(directory, 'synthetic-processes.json');
  let terminal: IPty | undefined;
  let dataListener: IDisposable | undefined, exitListener: IDisposable | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let exited = false,
    acted = false,
    output = '';
  let recorded: RecordedProcesses | undefined;
  const fake = `
    const fs = require('node:fs');
    const {spawn} = require('node:child_process');
    const scenario = process.env.CCDESK_PTY_SCENARIO;
    let child;
    if (scenario === 'hangup')
      child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio:'ignore'});
    fs.writeFileSync(process.env.CCDESK_PTY_PIDFILE, JSON.stringify({cli:process.pid, child:child?.pid}));
    if (scenario === 'input') {
      process.stdin.setRawMode(true);
      process.stdin.on('data', bytes => {
        if (bytes.toString().includes('hello-pty')) {
          console.log('CCDESK_INPUT_OK');
          process.exit(0);
        }
      });
    } else if (scenario === 'interrupt') {
      process.on('SIGINT', () => { console.log('CCDESK_INTERRUPT_OK'); process.exit(130); });
      process.stdin.resume();
    } else {
      process.on('SIGHUP', () => process.exit(129));
      process.stdin.resume();
    }
    console.log('CCDESK_PTY_READY', JSON.stringify({stdin:process.stdin.isTTY, stdout:process.stdout.isTTY}));
  `;
  const driver = `
    import {runExternalProcess} from ${JSON.stringify(moduleUrl.href)};
    process.exitCode = await runExternalProcess(
      process.execPath, ['-e', process.env.CCDESK_PTY_FAKE], process.cwd(), process.env
    );
  `;
  try {
    terminal = spawn(process.execPath, ['--input-type=module', '-e', driver], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: directory,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: directory,
        TERM: 'xterm-256color',
        CCDESK_PTY_SCENARIO: scenario,
        CCDESK_PTY_PIDFILE: pidfile,
        CCDESK_PTY_FAKE: fake,
      },
    });
    const processPty = terminal;
    const result = await new Promise<{ exitCode: number; signal?: number }>(
      (resolveExit, reject) => {
        timer = setTimeout(() => reject(new Error(`PTY ${scenario} timed out: ${output}`)), 12000);
        dataListener = processPty.onData((chunk) => {
          output += chunk;
          const ready = /CCDESK_PTY_READY (\{[^\r\n]+\})/.exec(output);
          if (!ready || acted) return;
          acted = true;
          try {
            assert.deepEqual(JSON.parse(ready[1]), { stdin: true, stdout: true });
            recorded = JSON.parse(readFileSync(pidfile, 'utf8')) as RecordedProcesses;
            if (scenario === 'input') processPty.write('hello-pty\r');
            else if (scenario === 'interrupt') processPty.write('\x03');
            else process.kill(processPty.pid, 'SIGHUP');
          } catch (error) {
            reject(error);
          }
        });
        exitListener = processPty.onExit((event) => {
          exited = true;
          resolveExit(event);
        });
      },
    );
    assert.equal(acted, true, `CLI did not become ready: ${output}`);
    assert.equal(result.exitCode, { input: 0, interrupt: 130, hangup: 129 }[scenario], output);
    if (scenario === 'input') assert.ok(output.includes('CCDESK_INPUT_OK'), output);
    if (scenario === 'interrupt') assert.ok(output.includes('CCDESK_INTERRUPT_OK'), output);
    const pids = [recorded!.cli, ...(recorded!.child ? [recorded!.child] : [])];
    assert.deepEqual(
      await stopped(pids),
      [],
      'The test CLI or its Linux child survived the wrapper.',
    );
  } finally {
    if (timer) clearTimeout(timer);
    if (terminal && !exited) terminal.kill('SIGKILL');
    recorded ??= existsSync(pidfile)
      ? (JSON.parse(readFileSync(pidfile, 'utf8')) as RecordedProcesses)
      : undefined;
    for (const pid of [recorded?.child, recorded?.cli]) {
      if (pid && running(pid)) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      }
    }
    dataListener?.dispose();
    exitListener?.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
}

test('external CLI retains a real Linux TTY and reads terminal input', linuxOnly, async () => {
  await exercisePty('input');
});

test('terminal Ctrl+C reaches the external CLI once', linuxOnly, async () => {
  await exercisePty('interrupt');
});

test(
  'SSH-style wrapper hangup ends the external CLI and its Linux command child',
  linuxOnly,
  async () => {
    await exercisePty('hangup');
  },
);
