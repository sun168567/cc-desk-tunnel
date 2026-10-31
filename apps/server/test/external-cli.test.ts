import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import {
  externalCliCommand,
  externalCliEnvironment,
  externalCliRoot,
  parseExternalCliArguments,
  runExternalCli,
  waitForExternalDevice,
} from '../src/external-cli.ts';
import { UsageLog } from '../src/usage.ts';

const deviceId = '10000000-0000-4000-8000-000000000001';
const guiSession = '20000000-0000-4000-8000-000000000001';
const cliSession = '20000000-0000-4000-8000-000000000002';
const encodedProject = Buffer.from('D:\\示例 项目\\工程').toString('base64');
const query = { limit: 20, bucketMinutes: 60, offsetMinutes: 0 };

function request(id: string, session: string, source: string) {
  const attributes = {
    'event.name': 'api_request',
    'event.timestamp': new Date().toISOString(),
    'session.id': session,
    model: 'synthetic-model',
    request_id: id,
    query_source: source,
    input_tokens: 10,
    output_tokens: 20,
    cache_read_tokens: 30,
    cache_creation_tokens: 40,
    cost_usd: 0.001,
    duration_ms: 100,
    'user.email': 'synthetic@example.invalid',
    prompt: 'SYNTHETIC_CONTENT_MUST_NOT_BE_STORED',
  };
  return {
    resourceLogs: [
      {
        scopeLogs: [
          {
            logRecords: [
              {
                body: { stringValue: 'claude_code.api_request' },
                attributes: Object.entries(attributes).map(([key, value]) => ({
                  key,
                  value:
                    typeof value === 'string' ? { stringValue: value } : { doubleValue: value },
                })),
              },
            ],
          },
        ],
      },
    ],
  };
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'ccdesk-external-cli-'));
  const databasePath = join(directory, 'sessions.sqlite');
  const database = new DatabaseSync(databasePath);
  database.exec('PRAGMA journal_mode = WAL');
  const guiLog = new UsageLog(database);
  const configPath = join(directory, 'devices', deviceId, 'ssh_config');
  mkdirSync(join(directory, 'devices', deviceId), { recursive: true });
  writeFileSync(configPath, '# Synthetic fixture; no connection credentials.\n');
  const options = parseExternalCliArguments([
    '--data-dir',
    directory,
    '--device-id',
    deviceId,
    '--project-base64',
    encodedProject,
  ]);
  return {
    directory,
    database,
    guiLog,
    options,
    configPath,
    close() {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('external CLI parses UTF-8 project paths and keeps history stable across device/path spelling', () => {
  const options = parseExternalCliArguments([
    '--device-id',
    deviceId.toUpperCase(),
    '--project-base64',
    encodedProject,
    '--continue',
  ]);
  assert.equal(options.deviceId, deviceId);
  assert.equal(options.projectPath, 'D:\\示例 项目\\工程');
  assert.equal(options.continueSession, true);
  assert.equal(options.executable, 'claude');
  const root = externalCliRoot(deviceId, options.projectPath);
  assert.equal(root, externalCliRoot(deviceId.toUpperCase(), 'd:/示例 项目/工程/'));
  assert.notEqual(
    root,
    externalCliRoot('10000000-0000-4000-8000-000000000002', options.projectPath),
  );
  const command = externalCliCommand(options);
  assert.equal(command.root, root);
  assert.ok(command.args.includes('--continue'));
  assert.ok(!command.args.includes('--session-id') && !command.args.includes('--resume'));
  assert.deepEqual(command.args.slice(0, 2), ['--permission-mode', 'manual']);
  assert.ok(command.args.some((value) => value.includes('Windows')));
  assert.ok(command.args.some((value) => value.includes('Desktop scheduling')));
});

test('external CLI rejects ambiguous Windows roots, malformed UTF-8 and unknown flags before launching', () => {
  const prefix = ['--device-id', deviceId, '--project-base64'];
  for (const path of ['/tmp/project', '\\project', 'C:project', 'D:\\bad\nname'])
    assert.throws(() =>
      parseExternalCliArguments([...prefix, Buffer.from(path).toString('base64')]),
    );
  assert.throws(() =>
    parseExternalCliArguments([...prefix, Buffer.from([0xff]).toString('base64')]),
  );
  assert.throws(() => parseExternalCliArguments([...prefix, encodedProject, '--unsupported']));
  assert.throws(() => parseExternalCliArguments([...prefix, encodedProject, '--executable']));
  assert.equal(
    parseExternalCliArguments([
      ...prefix,
      Buffer.from('\\\\server\\share\\project').toString('base64'),
    ]).projectPath,
    '\\\\server\\share\\project',
  );
});

test('external CLI preserves provider environment while removing service-only variables', () => {
  const f = fixture();
  try {
    const settingsPath = join(f.directory, 'provider.json');
    writeFileSync(
      settingsPath,
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: 'https://provider.example.invalid',
          PROXY_TOKEN: 'synthetic-settings-service-secret',
        },
      }),
    );
    const environment = externalCliEnvironment(
      { ...f.options, settingsPath },
      {
        HOME: f.directory,
        PATH: process.env.PATH,
        PROXY_TOKEN: 'synthetic-service-secret',
        FRPS_TOKEN: 'synthetic-legacy-secret',
        CLAUDE_PATH: '/synthetic/private/program',
      },
    );
    assert.equal(environment.HOME, f.directory);
    assert.equal(environment.ANTHROPIC_BASE_URL, 'https://provider.example.invalid');
    assert.equal(environment.TERM, 'xterm-256color');
    assert.equal(environment.PROXY_TOKEN, undefined);
    assert.equal(environment.FRPS_TOKEN, undefined);
    assert.equal(environment.CLAUDE_PATH, undefined);
  } finally {
    f.close();
  }
});

test('check is read-only and an invalid state directory never creates a fresh database', async () => {
  const f = fixture();
  try {
    const root = externalCliCommand(f.options).cwd;
    const before = f.guiLog.query(query, () => null).totals.requests;
    assert.equal(
      await runExternalCli(
        { ...f.options, check: true },
        {
          probe: async () => {},
          spawnCli: () => {
            throw new Error('Check must not spawn Claude.');
          },
        },
      ),
      0,
    );
    assert.equal(existsSync(root), false);
    assert.equal(f.guiLog.query(query, () => null).totals.requests, before);
    const absent = join(f.directory, 'absent');
    await assert.rejects(
      runExternalCli(
        { ...f.options, dataDir: absent },
        {
          probe: async () => {},
        },
      ),
      /sessions.sqlite/,
    );
    assert.equal(existsSync(absent), false);
  } finally {
    f.close();
  }
});

test('device-channel probe retries registration and reports a bounded failure', async () => {
  const f = fixture();
  try {
    let attempts = 0;
    await waitForExternalDevice(
      f.configPath,
      {},
      {
        timeoutMs: 200,
        retryMs: 1,
        probe: async () => {
          if (++attempts < 2) throw new Error('Synthetic registration delay.');
        },
      },
    );
    assert.equal(attempts, 2);
    await assert.rejects(
      waitForExternalDevice(
        join(f.directory, 'missing-config'),
        {},
        {
          timeoutMs: 5,
          retryMs: 1,
        },
      ),
      /timed out/,
    );
  } finally {
    f.close();
  }
});

test('a short external CLI exports its final batch into the live GUI database once and closes its collector', async () => {
  const f = fixture();
  let endpoint = '';
  try {
    f.guiLog.ingest(request('synthetic-gui-request', guiSession, 'sdk'));
    const cliBatch = request('synthetic-cli-request', cliSession, 'cli');
    const marker = join(f.directory, 'synthetic-child.json');
    const code = await runExternalCli(f.options, {
      inherited: { ...process.env, PROXY_TOKEN: 'synthetic-service-secret' },
      probe: async () => {},
      spawnCli: (_executable, argumentsOf, options) => {
        endpoint = options.env!.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT!;
        assert.match(endpoint, /^http:\/\/127\.0\.0\.1:\d+\/v1\/logs$/);
        assert.equal(options.stdio, 'inherit');
        assert.ok(argumentsOf.includes('--permission-mode'));
        const source = `
          const fs = require('node:fs');
          const batch = ${JSON.stringify(cliBatch)};
          (async () => {
            const endpoint = process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
            for (let i = 0; i < 2; i++) {
              const response = await fetch(endpoint, {method:'POST',body:JSON.stringify(batch)});
              if (!response.ok) throw new Error('Synthetic OTEL export failed');
              await response.text();
            }
            fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({
              telemetry:process.env.CLAUDE_CODE_ENABLE_TELEMETRY,
              leaked:Object.hasOwn(process.env,'PROXY_TOKEN'),
              cwd:process.cwd()
            }));
          })().catch(error => { console.error(error); process.exitCode=1; });
        `;
        return spawn(process.execPath, ['-e', source], options);
      },
    });
    assert.equal(code, 0);
    const child = JSON.parse(readFileSync(marker, 'utf8'));
    assert.equal(child.telemetry, '1');
    assert.equal(child.leaked, false);
    assert.equal(child.cwd, externalCliCommand(f.options).cwd);
    const page = f.guiLog.query(query, () => null);
    assert.equal(page.totals.requests, 2);
    assert.equal(f.guiLog.sessionStats(guiSession).requests, 1);
    assert.equal(f.guiLog.sessionStats(cliSession).requests, 1);
    assert.equal(page.rows.find((row) => row.sessionId === cliSession)?.source, 'cli');
    const rows = f.database.prepare('SELECT * FROM api_requests').all();
    assert.ok(!JSON.stringify(rows).includes('SYNTHETIC_CONTENT_MUST_NOT_BE_STORED'));
    assert.ok(!JSON.stringify(rows).includes('synthetic@example.invalid'));
    await assert.rejects(fetch(endpoint, { method: 'POST', body: '{}' }));
  } finally {
    f.close();
  }
});

test('external CLI preserves an executable exit code and cleans up a failed spawn', async () => {
  const f = fixture();
  let failedEndpoint = '';
  try {
    assert.equal(
      await runExternalCli(f.options, {
        probe: async () => {},
        spawnCli: (_program, _argumentsOf, options) =>
          spawn(process.execPath, ['-e', 'process.exit(23)'], options),
      }),
      23,
    );
    await assert.rejects(
      runExternalCli(f.options, {
        probe: async () => {},
        spawnCli: (_program, _argumentsOf, options) => {
          failedEndpoint = options.env!.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT!;
          return spawn(join(f.directory, 'nonexistent-program'), [], options);
        },
      }),
      /ENOENT/,
    );
    await assert.rejects(fetch(failedEndpoint, { method: 'POST', body: '{}' }));
    assert.equal(f.guiLog.query(query, () => null).totals.requests, 0);
  } finally {
    f.close();
  }
});

test(
  'external CLI waits for a separate GUI writer to release its SQLite transaction',
  { timeout: 15000 },
  async () => {
    const f = fixture();
    const released = join(f.directory, 'synthetic-writer-released');
    const source = `
    const { DatabaseSync } = require('node:sqlite');
    const fs = require('node:fs');
    const database = new DatabaseSync(${JSON.stringify(join(f.directory, 'sessions.sqlite'))});
    database.exec('BEGIN IMMEDIATE');
    process.stdout.write('SYNTHETIC_GUI_LOCKED\\n');
    setTimeout(() => {
      database.exec('COMMIT');
      database.close();
      fs.writeFileSync(${JSON.stringify(released)}, 'committed');
    }, 350);
  `;
    const writer = spawn(process.execPath, ['-e', source], { stdio: ['ignore', 'pipe', 'pipe'] });
    const writerExit = new Promise<number | null>((resolveExit, reject) => {
      writer.once('error', reject);
      writer.once('close', resolveExit);
    });
    try {
      await new Promise<void>((resolveReady, reject) => {
        const closed = () =>
          reject(new Error('Synthetic GUI writer exited before acquiring its lock.'));
        writer.once('error', reject);
        writer.once('close', closed);
        writer.stdout!.once('data', (output) => {
          writer.off('close', closed);
          if (String(output).includes('SYNTHETIC_GUI_LOCKED')) resolveReady();
          else reject(new Error('Synthetic GUI writer did not report its acquired lock.'));
        });
      });
      assert.equal(existsSync(released), false);
      const batch = request('synthetic-concurrent-cli-request', cliSession, 'cli');
      assert.equal(
        await runExternalCli(f.options, {
          probe: async () => {},
          spawnCli: (_program, _argumentsOf, options) =>
            spawn(
              process.execPath,
              [
                '-e',
                `
        (async () => {
          const response = await fetch(process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT, {
            method:'POST', body:JSON.stringify(${JSON.stringify(batch)})
          });
          if (!response.ok) throw new Error('Synthetic concurrent export failed');
          await response.text();
        })().catch(error => { console.error(error); process.exitCode=1; });
      `,
              ],
              options,
            ),
        }),
        0,
      );
      assert.equal(await writerExit, 0);
      assert.equal(existsSync(released), true);
      assert.equal(f.guiLog.sessionStats(cliSession).requests, 1);
    } finally {
      await writerExit;
      f.close();
    }
  },
);
