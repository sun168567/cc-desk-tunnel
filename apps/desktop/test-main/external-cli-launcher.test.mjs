import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const launcher = fileURLToPath(new URL('../../../scripts/open-external-cli.ps1', import.meta.url));
const deviceId = '11111111-1111-4111-8111-111111111111';
const literal = (value) => `'${value.replaceAll("'", "''")}'`;
const powershells = process.platform === 'win32' ? ['powershell.exe', 'pwsh.exe'] : [];
// What a temporary directory is called once its 8.3 short names are expanded, as Get-Item reports it.
const longPath = (path) => realpathSync.native(path);

test('external CLI Windows launcher remains ASCII with CRLF line endings', () => {
  const bytes = readFileSync(launcher);
  assert.ok(bytes.every((value) => value <= 0x7f));
  assert.doesNotMatch(bytes.toString(), /(?<!\r)\n/);
});

for (const shell of powershells) {
  const available = spawnSync(
    shell,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'exit 0'],
    {
      windowsHide: true,
    },
  );
  const skip = available.error?.code === 'ENOENT' ? `${shell} is not installed` : false;

  function evaluate(body, environment = {}) {
    const script = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
function global:ssh.exe { throw 'A launcher unit test must never connect to SSH.' }
. ${literal(launcher)}
${body}
`;
    const result = spawnSync(
      shell,
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
      {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 20_000,
        env: { ...process.env, ...environment },
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout.replace(/^\uFEFF/, ''));
  }

  test(
    `${shell}: external CLI preserves project paths and uses the existing strict SSH channel`,
    { skip },
    (t) => {
      const root = mkdtempSync(join(tmpdir(), 'ccdesk-cli-launcher-'));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const project = join(root, "中文 project 'quote' & dollar$ `backtick");
      mkdirSync(project);
      const plan = evaluate(`
$plan = New-ExternalCliConnection -SshTarget test-server -ProjectPath ${literal(project)} -DeviceId ${literal(deviceId)} -ContinueSession -Sudo -Container custom-container
@{ plan = $plan; quoted = (ConvertTo-ExternalCliShellArgument "a'b") } | ConvertTo-Json -Depth 5 -Compress
`);
      assert.equal(plan.plan.ProjectPath, longPath(project));
      assert.equal(plan.plan.DeviceId, deviceId);
      assert.equal(plan.plan.SshArguments[0], '-tt');
      assert.ok(plan.plan.SshArguments.includes('StrictHostKeyChecking=yes'));
      assert.ok(plan.plan.SshArguments.includes('BatchMode=yes'));
      assert.deepEqual(plan.plan.SshArguments.slice(-3, -1), ['--', 'test-server']);
      assert.equal(plan.plan.SshArguments.at(-1), plan.plan.RemoteCommand);
      assert.match(plan.plan.RemoteCommand, /^'sh' '-c' '/);
      assert.ok(plan.plan.RemoteCommand.includes("'sh' 'sudo' 'custom-container' '"));
      assert.ok(plan.plan.RemoteCommand.endsWith("'--continue'"));
      const base64 = plan.plan.RemoteCommand.match(/'--project-base64' '([^']+)'/)?.[1];
      assert.equal(Buffer.from(base64, 'base64').toString('utf8'), longPath(project));
      assert.equal(plan.quoted, "'a'\\''b'");
      assert.ok(!plan.plan.RemoteCommand.includes('\r'));
    },
  );

  test(
    `${shell}: the device ID comes from the client's settings and check mode has no PTY`,
    { skip },
    (t) => {
      const root = mkdtempSync(join(tmpdir(), 'ccdesk-cli-settings-'));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const settings = join(root, 'CC Desk Tunnel', 'settings.json');
      mkdirSync(join(root, 'CC Desk Tunnel'));
      writeFileSync(
        settings,
        JSON.stringify({ deviceId, serviceCredential: 'synthetic-field-not-for-launcher-output' }),
      );
      const plans = evaluate(
        `
$explicit = New-ExternalCliConnection -SshTarget test-server -ProjectPath ${literal(root)} -ClientSettingsPath ${literal(settings)} -Check
Set-Location -LiteralPath ${literal(root)}
$installed = New-ExternalCliConnection -SshTarget user@test-server
@{ explicit = $explicit; installed = $installed } | ConvertTo-Json -Depth 5 -Compress
`,
        { APPDATA: root },
      );
      const plan = plans.explicit;
      assert.equal(plan.DeviceId, deviceId);
      assert.equal(plan.SshArguments[0], '-T');
      assert.ok(plan.RemoteCommand.includes("'sh' 'none' '' '"));
      assert.ok(plan.RemoteCommand.endsWith("'--check'"));
      assert.ok(!JSON.stringify(plans).includes('synthetic-field-not-for-launcher-output'));
      // Without either, the installed client's settings name the device, and the project is where one is.
      assert.equal(plans.installed.DeviceId, deviceId);
      assert.equal(plans.installed.ProjectPath, longPath(root));
    },
  );

  test(`${shell}: native argument passing preserves the remote command`, { skip }, (t) => {
    const root = mkdtempSync(join(tmpdir(), 'ccdesk-cli-native-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const capture = join(root, 'capture-argv.mjs');
    writeFileSync(
      capture,
      "if (process.argv[2] === '--exit-23') process.exit(23);\nconsole.log(JSON.stringify(process.argv.slice(2)));\n",
    );
    const result = evaluate(`
$connection = New-ExternalCliConnection -SshTarget test-server -ProjectPath ${literal(root)} -DeviceId ${literal(deviceId)}
$received = Invoke-ExternalCliNativeCommand -FilePath ${literal(process.execPath)} -Arguments (@(${literal(capture)}) + $connection.SshArguments) | ConvertFrom-Json
$legacyReceived = @($received)
if (Get-Variable -Name PSNativeCommandArgumentPassing -ErrorAction SilentlyContinue) {
  $PSNativeCommandArgumentPassing = 'Legacy'
  $legacyReceived = @(Invoke-ExternalCliNativeCommand -FilePath ${literal(process.execPath)} -Arguments (@(${literal(capture)}) + $connection.SshArguments) | ConvertFrom-Json)
}
Invoke-ExternalCliNativeCommand -FilePath ${literal(process.execPath)} -Arguments @(${literal(capture)}, '--exit-23') | Out-Null
@{ expected = $connection.SshArguments; received = @($received); legacyReceived = $legacyReceived; exitCode = $LASTEXITCODE } | ConvertTo-Json -Depth 5 -Compress
`);
    // The remote command holds double quotes of its own: the scripts run on the server and in the container.
    assert.ok(result.expected.at(-1).includes('"'));
    assert.deepEqual(result.received, result.expected);
    assert.deepEqual(result.legacyReceived, result.expected);
    assert.equal(result.exitCode, 23);
  });

  test(`${shell}: invalid launcher inputs fail before any SSH connection`, { skip }, (t) => {
    const root = mkdtempSync(join(tmpdir(), 'ccdesk-cli-invalid-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const file = join(root, 'not-a-directory.txt');
    writeFileSync(file, 'fixture');
    const invalidSettings = join(root, 'invalid-settings.json');
    writeFileSync(invalidSettings, '{ synthetic-private-field');
    const result = evaluate(
      `
$base = @{ SshTarget = 'test-server'; ProjectPath = ${literal(root)}; DeviceId = ${literal(deviceId)} }
$cases = @(
  @{ SshTarget = '-oProxyCommand=unexpected' },
  @{ SshTarget = 'host;unexpected' },
  @{ Container = 'container;unexpected' },
  @{ DeviceId = 'not-a-uuid' },
  @{ ProjectPath = ${literal(file)} },
  @{ DeviceId = ''; ClientSettingsPath = ${literal(invalidSettings)} },
  @{ ClientSettingsPath = ${literal(invalidSettings)} },
  @{ DeviceId = '' },
  @{ ContinueSession = $true; Check = $true }
)
$results = foreach ($case in $cases) {
  $values = $base.Clone()
  foreach ($key in $case.Keys) { $values[$key] = $case[$key] }
  try { New-ExternalCliConnection @values | Out-Null; @{ rejected = $false } }
  catch { @{ rejected = $true; message = $_.Exception.Message } }
}
ConvertTo-Json -InputObject @($results) -Compress
`,
      // No installed client to fall back on.
      { APPDATA: root },
    );
    assert.equal(result.length, 9);
    assert.ok(result.every((item) => item.rejected));
    assert.ok(!JSON.stringify(result).includes('synthetic-private-field'));
  });
}

// What the launcher sends runs under the server's POSIX shell; this runs it there with a stand-in `docker`.
test(
  'the remote command finds the one service container and passes the arguments into it',
  { skip: process.platform === 'win32' ? 'a POSIX shell is required' : false },
  (t) => {
    const root = mkdtempSync(join(tmpdir(), 'ccdesk-cli-remote-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const source = readFileSync(launcher, 'utf8').replaceAll('\r', '');
    const script = (name) =>
      new RegExp(`\\$${name} = @'\\n([\\s\\S]*?)\\n'@`).exec(source)?.[1] ?? assert.fail(name);
    const host = script('ExternalCliHostScript');
    const inner = script('ExternalCliContainerScript');
    mkdirSync(join(root, 'bin'));
    // `ps` lists what NAMES holds; `exec` reports what it would run and runs the container script itself.
    writeFileSync(
      join(root, 'bin', 'docker'),
      `#!/bin/sh
if [ "$1" = ps ]; then printf '%s' "$NAMES"; exit 0; fi
shift
printf '%s\\n' "$2" > "$ROOT/mark"; shift 2
printf 'tty=%s container=%s\\n' "$1" "$2"; shift 2
[ "$1" = sh ] && [ "$2" = -c ] || exit 9
printf '%s\\n' "$3" > "$ROOT/inner"; shift 4
printf 'arg=%s\\n' "$@"
`,
      { mode: 0o755 },
    );
    const run = (names, container = '') =>
      spawnSync(
        'sh',
        ['-c', host, 'sh', 'none', container, inner, '--device-id', 'a b', '--check'],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${join(root, 'bin')}:${process.env.PATH}`,
            NAMES: names,
            ROOT: root,
          },
          input: '',
        },
      );
    const one = run('cc-desk-tunnel-1a2b3c4d-proxy-1\nother-proxy\n');
    assert.equal(one.status, 0, one.stderr);
    assert.equal(
      one.stdout,
      'tty=-i container=cc-desk-tunnel-1a2b3c4d-proxy-1\narg=--device-id\narg=a b\narg=--check\n',
    );
    assert.equal(readFileSync(join(root, 'inner'), 'utf8'), `${inner}\n`);
    assert.match(run('').stderr, /No running CC Desk Tunnel container/);
    assert.match(
      run('cc-desk-tunnel-1-proxy-1\ncc-desk-tunnel-2-proxy-1\n').stderr,
      /Several CC Desk Tunnel containers/,
    );
    assert.match(run('', 'named').stdout, /container=named/);
    assert.match(readFileSync(join(root, 'mark'), 'utf8'), /^CC_DESK_EXTERNAL_RUN=[0-9a-f]{32}\n$/);
  },
);

test(
  'a hangup of the SSH session is passed on to the processes of the run in the container',
  { skip: process.platform === 'win32' ? 'a POSIX shell is required' : false },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'ccdesk-cli-hangup-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const source = readFileSync(launcher, 'utf8').replaceAll('\r', '');
    const host = /\$ExternalCliHostScript = @'\n([\s\S]*?)\n'@/.exec(source)[1];
    mkdirSync(join(root, 'bin'));
    // The run waits in `docker exec -e MARK`; what the hangup sends in is any other `docker exec`.
    writeFileSync(
      join(root, 'bin', 'docker'),
      `#!/bin/sh
shift
if [ "$1" != -e ]; then printf '%s\\n' "$@" > "$ROOT/hangup"; exit 0; fi
printf '%s\\n' "$2" > "$ROOT/mark"
sleep 30 & wait
`,
      { mode: 0o755 },
    );
    // A session that ends hangs up its whole process group, the waiting \`docker exec\` with it.
    const child = spawn('sh', ['-c', host, 'sh', 'none', 'named', 'inner', '--check'], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, ROOT: root },
    });
    const closed = new Promise((done) =>
      child.once('close', (code, signal) => done({ code, signal })),
    );
    for (let i = 0; i < 100 && !existsSync(join(root, 'mark')); i++) await delay(50);
    process.kill(-child.pid, 'SIGHUP');
    assert.deepEqual(await closed, { code: 129, signal: null });
    const mark = readFileSync(join(root, 'mark'), 'utf8').trim().split('=')[1];
    const hangup = readFileSync(join(root, 'hangup'), 'utf8').trim().split('\n');
    assert.equal(hangup[0], 'named');
    assert.equal(hangup.at(-1), mark);
  },
);
