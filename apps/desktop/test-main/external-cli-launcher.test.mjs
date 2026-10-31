import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const launcher = fileURLToPath(new URL('../../../scripts/open-external-cli.ps1', import.meta.url));
const deviceId = '11111111-1111-4111-8111-111111111111';
const literal = (value) => `'${value.replaceAll("'", "''")}'`;
const powershells = process.platform === 'win32' ? ['powershell.exe', 'pwsh.exe'] : [];

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

  function evaluate(body) {
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
      { encoding: 'utf8', windowsHide: true, timeout: 20_000 },
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
$plan = New-ExternalCliConnection -SshTarget test-server -ProjectPath ${literal(project)} -DeviceId ${literal(deviceId)} -ContinueSession -Sudo -Container custom-container -ContainerUser app:app -RemoteNodePath "/opt/node path/node" -RemoteEntryPath "/app/entry 'quote'.ts" -DataDir /state -SettingsPath /config/provider.json -Executable /runtime/claude
@{ plan = $plan; quoted = (ConvertTo-ExternalCliShellArgument "a'b") } | ConvertTo-Json -Depth 5 -Compress
`);
      assert.equal(plan.plan.ProjectPath, project);
      assert.equal(plan.plan.DeviceId, deviceId);
      assert.equal(plan.plan.SshArguments[0], '-tt');
      assert.ok(plan.plan.SshArguments.includes('StrictHostKeyChecking=yes'));
      assert.ok(plan.plan.SshArguments.includes('BatchMode=yes'));
      assert.deepEqual(plan.plan.SshArguments.slice(-3, -1), ['--', 'test-server']);
      assert.equal(plan.plan.SshArguments.at(-1), plan.plan.RemoteCommand);
      assert.match(
        plan.plan.RemoteCommand,
        /^'sudo' '-n' 'docker' 'exec' '-it' '--user' 'app:app' 'custom-container'/,
      );
      assert.ok(plan.plan.RemoteCommand.includes("'/opt/node path/node'"));
      assert.ok(plan.plan.RemoteCommand.includes("'--data-dir' '/state'"));
      assert.ok(plan.plan.RemoteCommand.endsWith("'--continue'"));
      const base64 = plan.plan.RemoteCommand.match(/'--project-base64' '([^']+)'/)?.[1];
      assert.equal(Buffer.from(base64, 'base64').toString('utf8'), project);
      assert.equal(plan.quoted, "'a'\\''b'");
      assert.ok(plan.plan.RemoteCommand.includes("'/app/entry '\\''quote'\\''.ts'"));
    },
  );

  test(`${shell}: settings supply only the device ID and check mode has no PTY`, { skip }, (t) => {
    const root = mkdtempSync(join(tmpdir(), 'ccdesk-cli-settings-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const settings = join(root, 'settings.json');
    writeFileSync(
      settings,
      JSON.stringify({ deviceId, serviceCredential: 'synthetic-field-not-for-launcher-output' }),
    );
    const plan = evaluate(`
New-ExternalCliConnection -SshTarget test-server -ProjectPath ${literal(root)} -ClientSettingsPath ${literal(settings)} -Check | ConvertTo-Json -Depth 5 -Compress
`);
    assert.equal(plan.DeviceId, deviceId);
    assert.equal(plan.SshArguments[0], '-T');
    assert.match(plan.RemoteCommand, /^'docker' 'exec' '-i'/);
    assert.ok(plan.RemoteCommand.includes("'--data-dir' '/data/state'"));
    assert.ok(plan.RemoteCommand.endsWith("'--check'"));
    assert.ok(!JSON.stringify(plan).includes('synthetic-field-not-for-launcher-output'));
    assert.ok(!plan.RemoteCommand.includes('sudo'));
  });

  test(`${shell}: native argument passing preserves the remote command`, { skip }, (t) => {
    const root = mkdtempSync(join(tmpdir(), 'ccdesk-cli-native-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const capture = join(root, 'capture-argv.mjs');
    writeFileSync(
      capture,
      "if (process.argv[2] === '--exit-23') process.exit(23);\nconsole.log(JSON.stringify(process.argv.slice(2)));\n",
    );
    const settingsPath = '/config/backslash\\" and "double" quote/provider.json';
    const result = evaluate(`
$connection = New-ExternalCliConnection -SshTarget test-server -ProjectPath ${literal(root)} -DeviceId ${literal(deviceId)} -RemoteNodePath '/opt/node path/node' -RemoteEntryPath "/app/entry 'quote'.ts" -SettingsPath ${literal(settingsPath)}
$received = Invoke-ExternalCliNativeCommand -FilePath ${literal(process.execPath)} -Arguments (@(${literal(capture)}) + $connection.SshArguments) | ConvertFrom-Json
$legacyReceived = @($received)
if (Get-Variable -Name PSNativeCommandArgumentPassing -ErrorAction SilentlyContinue) {
  $PSNativeCommandArgumentPassing = 'Legacy'
  $legacyReceived = @(Invoke-ExternalCliNativeCommand -FilePath ${literal(process.execPath)} -Arguments (@(${literal(capture)}) + $connection.SshArguments) | ConvertFrom-Json)
}
Invoke-ExternalCliNativeCommand -FilePath ${literal(process.execPath)} -Arguments @(${literal(capture)}, '--exit-23') | Out-Null
@{ expected = $connection.SshArguments; received = @($received); legacyReceived = $legacyReceived; exitCode = $LASTEXITCODE } | ConvertTo-Json -Depth 5 -Compress
`);
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
    const result = evaluate(`
$base = @{ SshTarget = 'test-server'; ProjectPath = ${literal(root)}; DeviceId = ${literal(deviceId)} }
$cases = @(
  @{ SshTarget = '-oProxyCommand=unexpected' },
  @{ Container = 'container;unexpected' },
  @{ ContainerUser = 'user;unexpected' },
  @{ DeviceId = 'not-a-uuid' },
  @{ ProjectPath = ${literal(file)} },
  @{ RemoteEntryPath = 'relative/entry.ts' },
  @{ RemoteNodePath = "/runtime/node\ninvalid" },
  @{ ClientSettingsPath = ${literal(invalidSettings)} },
  @{ DeviceId = ''; ClientSettingsPath = ${literal(invalidSettings)} },
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
`);
    assert.equal(result.length, 11);
    assert.ok(result.every((item) => item.rejected));
    assert.ok(!JSON.stringify(result).includes('synthetic-private-field'));
  });
}

if (process.platform !== 'win32') {
  test('external CLI PowerShell behavior', { skip: 'Windows is required' }, () => {});
}
