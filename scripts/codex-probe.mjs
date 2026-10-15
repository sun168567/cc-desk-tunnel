#!/usr/bin/env node
// Isolated Codex app-server probe. Not part of the product, the test suite, or the server image.
// Run it only on a Linux host that is not the user's machine:
//   node scripts/codex-probe.mjs --ssh-config /path/to/session-ssh/<id>.conf
// Raw traffic and the capability record go to artifacts/codex-probe/. Secrets are redacted there.

import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const CANDIDATES = [
  'initialize',
  'initialized',
  'account/read',
  'account/login/start',
  'account/login/completed',
  'account/login/cancel',
  'model/list',
  'thread/start',
  'thread/resume',
  'thread/read',
  'turn/start',
  'turn/interrupt',
  'turn/completed',
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/tool/requestUserInput',
  'command/exec',
];

const options = parseArgs(process.argv.slice(2));
const trafficPath = join(options.out, 'traffic.jsonl');
const stderrPath = join(options.out, 'stderr.log');
const report = {
  probedAt: new Date().toISOString(),
  platform: `${process.platform}/${process.arch}`,
  passed: false,
  stop: true,
  reason: '',
  phases: {},
};

mkdirSync(options.out, { recursive: true });

try {
  if (process.platform !== 'linux') {
    report.reason =
      '探针只在隔离的 Linux 上运行。当前平台没有执行登录、会话、审批、SSH 和沙箱。P0 停在这里，不进入产品代码。';
    report.phases.schema = {
      version: { status: null, error: null, stdout: '未在 Linux 上读取。', stderr: '' },
      methods: Object.fromEntries(
        CANDIDATES.map((name) => [name, { stable: false, experimental: false, checked: false }]),
      ),
      sandbox: {
        measured: false,
        portAllowlist: null,
        note: '没有在 Linux 上导出 schema，不能判断沙箱能否只放行一个回环端口。',
      },
      handshake: { clean: false, skipped: true },
    };
    report.phases.login = { signedIn: false, skipped: '平台不是 Linux。' };
    report.phases.session = { resumed: false, missingFailed: false, skipped: '平台不是 Linux。' };
    report.phases.approval = { distinguished: false, skipped: '平台不是 Linux。' };
    report.phases.ssh = { deviceHasNonce: false, skipped: '平台不是 Linux。' };
    report.phases.sandbox = {
      gate: 'unmeasured',
      note: '没有在 Linux 上对照回环 SSH、其他地址和目录外写入。不能把关掉限制当作通过。',
    };
    report.phases.isolation = { isolated: false, skipped: '平台不是 Linux。' };
    finish(2);
  } else {
    finish(await run());
  }
} catch (error) {
  report.reason = error instanceof Error ? error.message : String(error);
  report.phases.crashed = true;
  finish(1);
}

function finish(code) {
  writeFileSync(join(options.out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  writeFileSync(join(options.out, 'report.md'), renderReport());
  console.log(`Capability record: ${join(options.out, 'report.md')}`);
  process.exitCode = code;
}

async function run() {
  const before = stampHomes();
  const schema = await phaseSchema();
  const schemaText = schema.schemaText;
  delete schema.schemaText;
  report.phases.schema = schema;
  const missing = CANDIDATES.filter((name) => !schema.methods?.[name]?.stable);
  if (missing.length) {
    report.reason = '稳定 schema 缺少探针要用的方法：' + missing.join('、') + '。';
    report.phases.isolation = compareHomes(before, stampHomes());
    return 1;
  }

  mkdirSync(options.home, { recursive: true });
  const work = join(options.out, 'work');
  mkdirSync(work, { recursive: true });
  report.phases.login = await phaseLogin(schemaText);
  if (report.phases.login.signedIn) {
    report.phases.session = await phaseSession(schemaText, work);
    report.phases.approval = await phaseApproval(schemaText, work);
    report.phases.ssh = options.sshConfig
      ? await phaseSsh(schemaText, work)
      : { skipped: '没有 --ssh-config，线程里的 device-script 没有执行。' };
  } else {
    report.phases.session = { skipped: '未登录。' };
    report.phases.approval = { skipped: '未登录。' };
    report.phases.ssh = { skipped: '未登录。' };
  }
  report.phases.sandbox = await phaseSandbox(schemaText, work);
  report.phases.isolation = compareHomes(before, stampHomes());

  const sessionOk =
    report.phases.session?.resumed === true && report.phases.session?.missingFailed === true;
  const ready =
    report.phases.sandbox.gate === 'pass' &&
    sessionOk &&
    report.phases.isolation?.isolated === true &&
    report.phases.approval?.distinguished === true &&
    report.phases.ssh?.deviceHasNonce === true;
  if (ready) {
    report.passed = true;
    report.stop = false;
    report.reason = '登录、恢复、审批、取消和只放行回环 SSH 都有记录。可以另开 P2。';
    return 0;
  }
  report.reason = stopReason();
  return report.phases.sandbox.gate === 'fail' ? 1 : 2;
}

async function phaseSchema() {
  const version = capture(options.codex, ['--version']);
  const schemaDir = join(options.out, 'schema');
  const experimentalDir = join(options.out, 'schema-experimental');
  mkdirSync(schemaDir, { recursive: true });
  mkdirSync(experimentalDir, { recursive: true });
  const stable = capture(options.codex, ['app-server', 'generate-json-schema', '--out', schemaDir]);
  const experimental = capture(options.codex, [
    'app-server',
    'generate-json-schema',
    '--experimental',
    '--out',
    experimentalDir,
  ]);
  const stableText = readTree(schemaDir);
  const experimentalText = readTree(experimentalDir);
  const methods = {};
  for (const name of CANDIDATES) {
    methods[name] = {
      checked: true,
      stable: includesMethod(stableText, name),
      experimental: includesMethod(experimentalText, name),
    };
  }
  return {
    version: trimOutput(version),
    schema: trimOutput(stable),
    schemaExperimental: trimOutput(experimental),
    schemaFiles: listFiles(schemaDir).map((path) => path.slice(schemaDir.length + 1)),
    methods,
    sandbox: describeSandbox(stableText),
    handshake: await handshakeExit(),
    schemaText: stableText,
  };
}

async function handshakeExit() {
  const session = startServer(join(options.out, 'work'));
  let initError = null;
  try {
    await session.initialize();
  } catch (error) {
    initError = error instanceof Error ? error.message : String(error);
  }
  const exitCode = await session.close();
  return { initError, exitCode, clean: exitCode === 0 && !initError };
}

async function phaseLogin(schemaText) {
  const session = startServer(join(options.out, 'work'));
  try {
    await session.initialize();
    const readParams = schemaText.includes('"refreshToken"') ? { refreshToken: false } : {};
    const status = await session.request('account/read', readParams, 30_000);
    if (status?.account) {
      return { signedIn: true, accountType: status.account.type ?? null, reusedHome: true };
    }
    if (!includesMethod(schemaText, 'chatgptDeviceCode')) {
      return { signedIn: false, error: 'schema 里没有 chatgptDeviceCode。' };
    }
    const started = await session.request(
      'account/login/start',
      { type: 'chatgptDeviceCode' },
      30_000,
    );
    const url = started.verificationUrl ?? started.authUrl ?? null;
    const code = started.userCode ?? null;
    console.log('在浏览器打开验证页并输入用户码。凭据只会写入这次探针的 CODEX_HOME。');
    if (url) console.log(url);
    if (code) console.log(code);
    const completed = await session.waitFor(
      (message) => message.method === 'account/login/completed',
      options.loginTimeoutMs,
    );
    const after = await session.request('account/read', readParams, 30_000);
    return {
      signedIn: completed?.params?.success === true && Boolean(after?.account),
      accountType: after?.account?.type ?? null,
      loginError: completed?.params?.error ?? null,
    };
  } catch (error) {
    return { signedIn: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    await session.close();
  }
}

async function phaseSession(schemaText, work) {
  const model = await listedModel(schemaText, work);
  const first = startServer(work);
  let threadId = null;
  try {
    await first.initialize();
    const started = await first.request('thread/start', model ? { model } : {}, 60_000);
    threadId = threadIdOf(started);
    if (!threadId)
      return {
        model,
        resumed: false,
        missingFailed: false,
        error: 'thread/start 没有返回线程编号。',
      };
    await first.request(
      'turn/start',
      {
        threadId,
        input: [
          {
            type: 'text',
            text: 'Reply with the single word pong. Do not use tools, commands, or files.',
          },
        ],
      },
      30_000,
    );
    const done = await first.waitFor((message) => message.method === 'turn/completed', 120_000);
    const itemEvents = [
      ...new Set(
        first.notifications
          .filter((message) => message.method.startsWith('item/'))
          .map((message) => message.method),
      ),
    ];
    writeFileSync(join(options.out, 'thread.json'), JSON.stringify({ threadId }) + '\n');
    await first.close();
    const second = startServer(work);
    try {
      await second.initialize();
      const resumed = await second.request('thread/resume', { threadId }, 60_000);
      let missingFailed = false;
      let missingError = null;
      try {
        await second.request('thread/resume', { threadId: 'thr_missing_probe' }, 30_000);
      } catch (error) {
        missingFailed = true;
        missingError = error instanceof Error ? error.message : String(error);
      }
      return {
        threadId,
        model,
        itemEvents,
        completedStatus: turnStatus(done),
        resumed: threadIdOf(resumed) === threadId,
        missingFailed,
        missingError,
      };
    } finally {
      await second.close();
    }
  } catch (error) {
    return {
      threadId,
      model,
      error: error instanceof Error ? error.message : String(error),
      resumed: false,
      missingFailed: false,
    };
  } finally {
    await first.close();
  }
}

async function listedModel(schemaText, work) {
  const session = startServer(work);
  try {
    await session.initialize();
    const params = {};
    if (schemaText.includes('"includeHidden"')) params.includeHidden = false;
    if (schemaText.includes('"limit"')) params.limit = 20;
    const listed = await session.request('model/list', params, 30_000);
    const models = listed?.models ?? listed?.data ?? listed?.items ?? [];
    const first = Array.isArray(models) ? models[0] : null;
    if (typeof first?.id === 'string') return first.id;
    if (typeof first?.model === 'string') return first.model;
    return null;
  } catch {
    return null;
  } finally {
    await session.close();
  }
}

async function phaseApproval(schemaText, work) {
  const policy = approvalPolicy(schemaText);
  if (!policy) return { distinguished: false, error: 'schema 里没有会询问的 approvalPolicy。' };
  if (!schemaText.includes('"decision"')) {
    return {
      distinguished: false,
      error: 'schema 里没有审批结果的 decision 字段，探针不猜测回复形状。',
    };
  }
  const session = startServer(work);
  try {
    await session.initialize();
    const started = await session.request('thread/start', { approvalPolicy: policy }, 60_000);
    const threadId = threadIdOf(started);
    const denied = await oneCommand(session, threadId, 'echo probe-deny', 'decline');
    const allowed = await oneCommand(session, threadId, 'echo probe-allow', 'accept');
    const interrupted = await interruptWait(session, threadId);
    return {
      approvalPolicy: policy,
      denied,
      allowed,
      interrupted,
      distinguished: interrupted.status === 'interrupted',
    };
  } catch (error) {
    return { distinguished: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    await session.close();
  }
}

async function oneCommand(session, threadId, command, decision) {
  const turn = await session.request(
    'turn/start',
    {
      threadId,
      input: [{ type: 'text', text: `Run exactly this command and nothing else: ${command}` }],
    },
    30_000,
  );
  const asked = await session.waitFor(
    (message) => isApproval(message) || message.method === 'turn/completed',
    90_000,
  );
  if (!asked || !isApproval(asked)) {
    return { asked: false, turnId: turnIdOf(turn), status: turnStatus(asked) };
  }
  session.respond(asked.id, { decision });
  const done = await session.waitFor((message) => message.method === 'turn/completed', 90_000);
  return { asked: true, method: asked.method, decision, status: turnStatus(done) };
}

async function interruptWait(session, threadId) {
  const turn = await session.request(
    'turn/start',
    {
      threadId,
      input: [{ type: 'text', text: 'Run exactly this command and nothing else: sleep 60' }],
    },
    30_000,
  );
  const turnId = turnIdOf(turn);
  const asked = await session.waitFor((message) => isApproval(message), 20_000);
  if (asked) session.respond(asked.id, { decision: 'accept' });
  let interruptError = null;
  if (!turnId) interruptError = 'turn/start 没有返回轮次编号。';
  else {
    try {
      await session.request('turn/interrupt', { threadId, turnId }, 15_000);
    } catch (error) {
      interruptError = error instanceof Error ? error.message : String(error);
    }
  }
  const done = await session.waitFor((message) => message.method === 'turn/completed', 20_000);
  return { turnId, interruptError, status: done ? turnStatus(done) : null, unknown: !done };
}

async function phaseSsh(schemaText, work) {
  const facts = sshFacts(options.sshConfig);
  const nonce = randomBytes(8).toString('hex');
  const marker = `cc-desk-codex-probe-${nonce}`;
  const script = facts.windows
    ? `$path = Join-Path $env:TEMP '${marker}.txt'; Set-Content -LiteralPath $path -Value '${nonce}' -NoNewline -Encoding ascii; Write-Output (Get-Content -LiteralPath $path -Raw)`
    : `path="/tmp/${marker}.txt"; printf %s '${nonce}' > "$path"; printf %s "$(cat "$path")"`;
  const prompt = [
    'Use ssh exactly once. Do not use any other host, port, or network.',
    `The config path is ${JSON.stringify(options.sshConfig)}.`,
    'Send the script on standard input as a quoted heredoc:',
    `ssh -F ${JSON.stringify(options.sshConfig)} device-script`,
    'Do not create or modify any file in the current Linux directory.',
    script,
  ].join('\n');
  const session = startServer(work);
  try {
    await session.initialize();
    const started = await session.request('thread/start', threadSandbox(schemaText), 60_000);
    const threadId = threadIdOf(started);
    await session.request(
      'turn/start',
      { threadId, input: [{ type: 'text', text: prompt }] },
      30_000,
    );
    const done = await settleTurn(session, 'accept', 180_000);
    const readback = spawnSync(
      'ssh',
      ['-F', options.sshConfig, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', 'device-script'],
      {
        input: facts.windows
          ? `Get-Content -LiteralPath (Join-Path $env:TEMP '${marker}.txt') -Raw`
          : `printf %s "$(cat /tmp/${marker}.txt)"`,
        encoding: 'utf8',
        timeout: 20_000,
      },
    );
    return {
      facts: { loopback: facts.loopback, port: facts.port, windows: facts.windows },
      completedStatus: turnStatus(done),
      deviceHasNonce: readback.stdout?.includes(nonce) === true,
      linuxWorkHasMarker: existsSync(join(work, `${marker}.txt`)),
      readbackStatus: readback.status,
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), deviceHasNonce: false };
  } finally {
    await session.close();
  }
}

async function settleTurn(session, decision, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const asked = session.requests.find((message) => isApproval(message) && !message.consumed);
    if (asked) {
      asked.consumed = true;
      session.respond(asked.id, { decision });
    }
    const done = session.notifications.find(
      (message) => message.method === 'turn/completed' && !message.consumed,
    );
    if (done) {
      done.consumed = true;
      return done;
    }
    await delay(100);
  }
  return null;
}

async function phaseSandbox(schemaText, work) {
  const described = describeSandbox(schemaText);
  const field = commandField(schemaText);
  if (!field) {
    return {
      gate: 'unmeasured',
      described,
      error: 'schema 没有给出 command/exec 的命令数组字段，沙箱对照没有执行。',
    };
  }
  const cases = [];
  for (const networkAccess of [false, true]) {
    const sandboxPolicy = { type: 'workspaceWrite', networkAccess };
    if (!schemaAllowsPolicy(schemaText, sandboxPolicy)) continue;
    cases.push({
      sandboxPolicy,
      outbound: await execCase(schemaText, work, field, sandboxPolicy, networkCommand()),
      outsideWrite: await execCase(schemaText, work, field, sandboxPolicy, outsideCommand()),
      ssh: options.sshConfig
        ? await execCase(schemaText, work, field, sandboxPolicy, sshCommand(options.sshConfig))
        : { skipped: true },
    });
  }
  const restricted = cases.find((item) => item.sandboxPolicy.networkAccess === false);
  const open = cases.find((item) => item.sandboxPolicy.networkAccess === true);
  const gate = sandboxGate(restricted, open);
  return {
    gate,
    described,
    cases: cases.map((item) => ({
      networkAccess: item.sandboxPolicy.networkAccess,
      outbound: item.outbound.opened ?? item.outbound.error ?? null,
      outsideWrite: item.outsideWrite.wrote ?? item.outsideWrite.error ?? null,
      ssh: item.ssh.connected ?? item.ssh.skipped ?? item.ssh.error ?? null,
    })),
    note: described.portAllowlist
      ? 'schema 里有主机或端口范围字段。'
      : 'workspaceWrite.networkAccess 是布尔值，schema 里没有只放行一个回环端口的沙箱字段。externalSandbox 表示 Codex 自己不再限制，不能当作通过。',
  };
}

async function execCase(schemaText, work, field, sandboxPolicy, command) {
  rmSync(join(options.out, 'escape-attempt'), { force: true });
  const session = startServer(work);
  try {
    await session.initialize();
    const params = { cwd: work, sandboxPolicy };
    params[field] = command;
    if (schemaText.includes('"timeoutMs"')) params.timeoutMs = 12_000;
    const result = await session.request('command/exec', params, 20_000);
    const text = `${result?.stdout ?? ''}\n${result?.stderr ?? ''}`;
    return {
      exitCode: result?.exitCode ?? null,
      opened: text.includes('probe-net-open'),
      wrote: existsSync(join(options.out, 'escape-attempt')),
      connected: text.includes('probe-ssh-open'),
      output: text.trim().slice(0, 300),
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  } finally {
    await session.close();
  }
}

function networkCommand() {
  return [
    'node',
    '-e',
    "const n=require('net');const s=n.connect(443,'1.1.1.1');s.setTimeout(3000);s.on('connect',()=>{console.log('probe-net-open');process.exit(0)});s.on('timeout',()=>process.exit(2));s.on('error',()=>process.exit(3))",
  ];
}

function outsideCommand() {
  const target = join(options.out, 'escape-attempt');
  return ['/bin/sh', '-c', `printf x > ${shellQuote(target)}`];
}

function sshCommand(configPath) {
  return [
    '/bin/sh',
    '-c',
    'printf "%s\\n" "echo probe-ssh-open" | ssh -F "$1" -o BatchMode=yes -o ConnectTimeout=8 device-script',
    'sh',
    configPath,
  ];
}

function startServer(work) {
  mkdirSync(options.home, { recursive: true });
  mkdirSync(work, { recursive: true });
  const child = spawn(options.codex, ['app-server', '--listen', 'stdio://'], {
    cwd: work,
    env: childEnv(options.home),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const session = {
    child,
    nextId: 1,
    pending: new Map(),
    notifications: [],
    requests: [],
    waiters: [],
    closed: false,
    seq: 0,
  };
  child.on('error', () => {});
  child.stderr.on('data', (chunk) => appendFileSync(stderrPath, chunk));
  child.stdin.on('error', () => {});
  createInterface({ input: child.stdout }).on('line', (line) => onLine(session, line));
  session.initialize = async () => {
    await session.request(
      'initialize',
      {
        clientInfo: {
          name: 'cc-desk-tunnel-probe',
          title: 'CC Desk Tunnel P0 probe',
          version: '0',
        },
      },
      20_000,
    );
    session.notify('initialized', {});
  };
  session.request = (method, params, timeoutMs) => rpc(session, method, params, timeoutMs);
  session.notify = (method, params) => send(session, { method, params: params ?? {} });
  session.respond = (id, result) => send(session, { id, result });
  session.waitFor = (predicate, timeoutMs) => waitFor(session, predicate, timeoutMs);
  session.close = () => closeServer(session);
  return session;
}

function onLine(session, line) {
  appendFileSync(
    trafficPath,
    JSON.stringify({ at: Date.now(), direction: 'server', line: redactLine(line) }) + '\n',
  );
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const safe = redact(message);
  safe.seq = session.seq++;
  if (
    message.id !== undefined &&
    session.pending.has(message.id) &&
    (message.result !== undefined || message.error)
  ) {
    const pending = session.pending.get(message.id);
    session.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(message.error.message ?? 'rpc error'));
    else pending.resolve(safe.result);
    return;
  }
  if (message.method && message.id !== undefined) session.requests.push(safe);
  else if (message.method) session.notifications.push(safe);
  for (const wake of session.waiters) wake();
}

function rpc(session, method, params, timeoutMs) {
  const id = session.nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      session.pending.delete(id);
      reject(new Error('timeout ' + method));
    }, timeoutMs);
    session.pending.set(id, { resolve, reject, timer });
    send(session, { method, id, params: params ?? {} });
  });
}

function waitFor(session, predicate, timeoutMs) {
  const existing = unread(session).find(predicate);
  if (existing) {
    existing.consumed = true;
    return Promise.resolve(existing);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      session.waiters = session.waiters.filter((waiter) => waiter !== wake);
      resolve(null);
    }, timeoutMs);
    const wake = () => {
      const found = unread(session).find(predicate);
      if (!found) return;
      clearTimeout(timer);
      found.consumed = true;
      session.waiters = session.waiters.filter((waiter) => waiter !== wake);
      resolve(found);
    };
    session.waiters.push(wake);
  });
}

function unread(session) {
  return [...session.notifications, ...session.requests]
    .filter((message) => !message.consumed)
    .sort((left, right) => left.seq - right.seq);
}

function send(session, message) {
  appendFileSync(
    trafficPath,
    JSON.stringify({ at: Date.now(), direction: 'client', line: JSON.stringify(redact(message)) }) +
      '\n',
  );
  session.child.stdin.write(JSON.stringify(message) + '\n');
}

function sandboxGate(restricted, open) {
  if (!options.sshConfig || !restricted) return 'unmeasured';
  const tooBroad = restricted.ssh.connected === true && restricted.outbound.opened === true;
  const onlyWhenOpen =
    restricted.ssh.connected !== true &&
    open?.ssh.connected === true &&
    open?.outbound.opened === true;
  const pass =
    restricted.ssh.connected === true &&
    restricted.outbound.opened === false &&
    restricted.outsideWrite.wrote === false &&
    open?.outbound.opened === true;
  if (pass) return 'pass';
  if (tooBroad || onlyWhenOpen) return 'fail';
  return 'unmeasured';
}

async function closeServer(session) {
  if (session.closed) return session.child.exitCode;
  session.closed = true;
  for (const pending of session.pending.values()) {
    clearTimeout(pending.timer);
    pending.reject(new Error('server closed'));
  }
  session.pending.clear();
  if (session.child.exitCode !== null) return session.child.exitCode;
  const exited = once(session.child, 'exit').then(([code]) => code);
  session.child.stdin.end();
  const exitCode = await Promise.race([exited, delay(5_000).then(() => null)]);
  if (exitCode !== null) return exitCode;
  session.child.kill('SIGTERM');
  const terminated = await Promise.race([
    once(session.child, 'exit').then(([code]) => code),
    delay(2_000).then(() => null),
  ]);
  if (terminated === null) session.child.kill('SIGKILL');
  return terminated;
}

function childEnv(home) {
  const env = { ...process.env, CODEX_HOME: home };
  for (const key of Object.keys(env)) {
    if (/^(?:CLAUDE|ANTHROPIC)_/i.test(key)) delete env[key];
  }
  return env;
}

function capture(bin, args) {
  return spawnSync(bin, args, {
    encoding: 'utf8',
    env: childEnv(options.home),
    windowsHide: true,
    timeout: 60_000,
  });
}

function trimOutput(result) {
  return {
    status: result.status,
    error: result.error?.code ?? null,
    stdout: (result.stdout ?? '').trim().slice(0, 500),
    stderr: (result.stderr ?? '').trim().slice(0, 500),
  };
}

function readTree(dir) {
  return listFiles(dir)
    .filter((path) => path.endsWith('.json'))
    .map((path) => readFileSync(path, 'utf8'))
    .join('\n');
}

function listFiles(dir) {
  if (!existsSync(dir)) return [];
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...listFiles(path));
    else found.push(path);
  }
  return found;
}

function includesMethod(text, name) {
  return text.includes(`"${name}"`);
}

function describeSandbox(text) {
  const around = windowAround(text, 'sandboxPolicy', 2500);
  const enums = [...around.matchAll(/"enum"\s*:\s*\[(.*?)\]/gs)].flatMap((match) =>
    [...match[1].matchAll(/"([^"]+)"/g)].map((item) => item[1]),
  );
  return {
    networkAccessBoolean: /"networkAccess"\s*:\s*\{[^}]*"type"\s*:\s*"boolean"/.test(around),
    networkAccessRestricted: enums.includes('restricted') && enums.includes('enabled'),
    modes: [...new Set(enums.filter((item) => /read|write|access|workspace|sandbox/i.test(item)))],
    portAllowlist: /"(?:allowedPorts|cidr)"/.test(around),
    domainAllowlist: text.includes('"allowedDomains"'),
    externalSandboxDisablesEnforcement: text.includes('"externalSandbox"'),
  };
}

function schemaAllowsPolicy(text, policy) {
  return text.includes(`"${policy.type}"`) && text.includes('"networkAccess"');
}

function commandField(text) {
  const around = windowAround(text, '"command/exec"', 4000);
  if (around.includes('"argv"')) return 'argv';
  if (around.includes('"command"')) return 'command';
  return null;
}

function approvalPolicy(text) {
  const values = enumNear(text, 'approvalPolicy');
  for (const name of ['unlessTrusted', 'onRequest', 'on-request', 'untrusted']) {
    if (values.includes(name)) return name;
  }
  return null;
}

function threadSandbox(text) {
  if (!text.includes('"workspaceWrite"') || !text.includes('"networkAccess"')) return {};
  return { sandboxPolicy: { type: 'workspaceWrite', networkAccess: false } };
}

function enumNear(text, key) {
  return [...windowAround(text, `"${key}"`, 1200).matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

function windowAround(text, needle, size) {
  const at = text.indexOf(needle);
  if (at < 0) return '';
  return text.slice(Math.max(0, at - 200), at + size);
}

function threadIdOf(result) {
  if (typeof result?.thread?.id === 'string') return result.thread.id;
  if (typeof result?.threadId === 'string') return result.threadId;
  return null;
}

function turnIdOf(result) {
  if (typeof result?.turn?.id === 'string') return result.turn.id;
  if (typeof result?.turnId === 'string') return result.turnId;
  return null;
}

function turnStatus(message) {
  return message?.params?.turn?.status ?? message?.params?.status ?? null;
}

function isApproval(message) {
  return (
    message?.method === 'item/commandExecution/requestApproval' ||
    message?.method === 'item/fileChange/requestApproval'
  );
}

function sshFacts(configPath) {
  const own = readFileSync(configPath, 'utf8');
  const include = own.match(/^\s*Include\s+(.+)$/m)?.[1]?.replaceAll('"', '');
  const included = include ? readFileSync(resolve(dirname(configPath), include), 'utf8') : '';
  const text = `${own}\n${included}`;
  const host = text.match(/^\s*HostName\s+(\S+)\s*$/m)?.[1] ?? null;
  const port = Number(text.match(/^\s*Port\s+(\d+)\s*$/m)?.[1] ?? 0) || null;
  return {
    loopback: host === '127.0.0.1' || host === 'localhost',
    port,
    windows: /CC_DESK_TUNNEL_PWSH|pwsh/i.test(text),
  };
}

function stampHomes() {
  return {
    claude: stamp(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')),
    userCodex: stamp(join(homedir(), '.codex')),
    probe: stamp(options.home),
  };
}

function stamp(path) {
  try {
    const stat = statSync(path);
    const entries = stat.isDirectory() ? readdirSync(path).length : 0;
    return { exists: true, mtimeMs: stat.mtimeMs, entries };
  } catch {
    return { exists: false };
  }
}

function compareHomes(before, after) {
  const claudeSame = sameStamp(before.claude, after.claude);
  const userCodexSame = sameStamp(before.userCodex, after.userCodex);
  const probeSeparate = resolve(options.home) !== resolve(join(homedir(), '.codex'));
  return {
    isolated: claudeSame && userCodexSame && probeSeparate,
    claudeUnchanged: claudeSame,
    userCodexUnchanged: userCodexSame,
    probeHomeSeparate: probeSeparate,
  };
}

function sameStamp(left, right) {
  return (
    left.exists === right.exists && left.mtimeMs === right.mtimeMs && left.entries === right.entries
  );
}

function stopReason() {
  if (report.phases.sandbox?.gate === 'fail') {
    return '沙箱不能只放行该设备回环门上的 ssh。P0 停止，不把关掉限制当作默认，也不进入 P2。';
  }
  if (!options.sshConfig || report.phases.sandbox?.gate === 'unmeasured') {
    return '回环 SSH 对照没有测完。P0 停止，不进入 P2。';
  }
  if (report.phases.login?.signedIn !== true) return '登录没有完成。P0 停止，不进入 P2。';
  if (report.phases.session?.resumed !== true || report.phases.session?.missingFailed !== true) {
    return '会话恢复或缺失引用没有给出预期结果。P0 停止，不进入 P2。';
  }
  if (report.phases.approval?.distinguished !== true) {
    return '取消后不能区分已停止和结果未知。P0 停止，不进入 P2。';
  }
  if (report.phases.ssh?.deviceHasNonce !== true) {
    return '测试线程没有经 device-script 在设备上写下并读回文件。P0 停止，不进入 P2。';
  }
  if (report.phases.isolation?.isolated !== true) {
    return '探针碰到了 Claude 家目录或用户的 Codex 家目录。P0 停止，不进入 P2。';
  }
  return 'P0 还有未通过的检查，不进入 P2。';
}

function renderReport() {
  const schema = report.phases.schema;
  const lines = [
    '# Codex P0 探针记录',
    '',
    `时间：${report.probedAt}`,
    `平台：${report.platform}`,
    `结论：${report.passed ? '通过，可以另开 P2。' : '停止，不进入 P2。'}`,
    '',
    report.reason,
    '',
  ];
  if (schema?.version) {
    lines.push(
      '## 版本',
      '',
      '```',
      schema.version.stdout || schema.version.stderr || schema.version.error || '',
      '```',
      '',
      '## 方法',
      '',
    );
    for (const name of CANDIDATES) {
      const item = schema.methods?.[name];
      const state =
        !item || item.checked === false
          ? '未核对'
          : item.stable
            ? '稳定 schema 里有'
            : item.experimental
              ? '只在实验 schema'
              : '没有';
      lines.push(`- \`${name}\`：${state}`);
    }
    lines.push(
      '',
      '## 沙箱字段',
      '',
      '```json',
      JSON.stringify(schema.sandbox, null, 2),
      '```',
      '',
    );
  }
  for (const name of ['login', 'session', 'approval', 'ssh', 'sandbox', 'isolation', 'blocked']) {
    if (!report.phases[name]) continue;
    lines.push(
      `## ${name}`,
      '',
      '```json',
      JSON.stringify(report.phases[name], null, 2),
      '```',
      '',
    );
  }
  lines.push('原始往返在 `traffic.jsonl`，标准错误在 `stderr.log`。秘密字段已抹掉。', '');
  return lines.join('\n');
}

function redactLine(line) {
  try {
    return JSON.stringify(redact(JSON.parse(line)));
  } catch {
    return line.slice(0, 2000);
  }
}

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (/token|apiKey|secret|password|authorization|userCode|email|refresh/i.test(key))
      out[key] = '[redacted]';
    else if (/url$/i.test(key) && typeof item === 'string')
      out[key] = item.split('?')[0] + '?[redacted]';
    else out[key] = redact(item);
  }
  return out;
}

function shellQuote(text) {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

function parseArgs(argv) {
  const parsed = {
    codex: 'codex',
    home: join(root, 'artifacts/codex-probe/home'),
    out: join(root, 'artifacts/codex-probe'),
    sshConfig: undefined,
    loginTimeoutMs: 300_000,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error('缺少参数值：' + name);
    if (name === '--codex') parsed.codex = value;
    else if (name === '--home') parsed.home = resolve(value);
    else if (name === '--out') parsed.out = resolve(value);
    else if (name === '--ssh-config') parsed.sshConfig = resolve(value);
    else if (name === '--login-timeout-ms') {
      parsed.loginTimeoutMs = Number(value);
      if (!Number.isFinite(parsed.loginTimeoutMs) || parsed.loginTimeoutMs < 1) {
        throw new Error('登录等待时间无效。');
      }
    } else throw new Error('未知参数：' + name);
    index += 1;
  }
  return parsed;
}
