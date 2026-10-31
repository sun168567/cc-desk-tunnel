[CmdletBinding()]
param(
  [string]$SshTarget,
  [string]$ProjectPath,
  [string]$DeviceId,
  [string]$ClientSettingsPath,
  [string]$Container = 'cc-desk-tunnel',
  [string]$ContainerUser = '1000:1000',
  [switch]$Sudo,
  [string]$RemoteNodePath = '/opt/runtime/node/bin/node',
  [string]$RemoteEntryPath = '/app/apps/server/src/external-cli.ts',
  [string]$DataDir = '/data/state',
  [string]$SettingsPath = '/data/config/provider.json',
  [string]$Executable = '/opt/runtime/cli/bin/claude',
  [switch]$ContinueSession,
  [switch]$Check
)

# Keep the launcher ASCII so Windows PowerShell 5.1 does not depend on a BOM.
# Dot-source this file to test argument construction without connecting to SSH.
function ConvertTo-ExternalCliShellArgument {
  param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Value)
  return "'" + $Value.Replace("'", "'\''") + "'"
}

function Invoke-ExternalCliNativeCommand {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string[]]$Arguments
  )
  $nativeMode = Get-Variable -Name PSNativeCommandArgumentPassing -ErrorAction SilentlyContinue
  $nativeArguments = $Arguments
  if (!$nativeMode -or $nativeMode.Value -eq 'Legacy') {
    # Legacy PowerShell strips embedded double quotes. Preserve them using the
    # Windows native argv rule: double preceding backslashes, then escape quote.
    $nativeArguments = @($Arguments | ForEach-Object { $_ -replace '(\\*)"', '$1$1\"' })
  }
  & $FilePath @nativeArguments
}

function New-ExternalCliConnection {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$SshTarget,
    [Parameter(Mandatory = $true)][string]$ProjectPath,
    [string]$DeviceId,
    [string]$ClientSettingsPath,
    [string]$Container = 'cc-desk-tunnel',
    [string]$ContainerUser = '1000:1000',
    [switch]$Sudo,
    [string]$RemoteNodePath = '/opt/runtime/node/bin/node',
    [string]$RemoteEntryPath = '/app/apps/server/src/external-cli.ts',
    [string]$DataDir = '/data/state',
    [string]$SettingsPath = '/data/config/provider.json',
    [string]$Executable = '/opt/runtime/cli/bin/claude',
    [switch]$ContinueSession,
    [switch]$Check
  )

  if ($SshTarget -notmatch '^[A-Za-z0-9][A-Za-z0-9_.-]*$') {
    throw 'SshTarget must be an SSH config alias, not a shell command or option.'
  }
  if ($Container -notmatch '^[A-Za-z0-9][A-Za-z0-9_.-]*$') {
    throw 'Container must be a Docker container name.'
  }
  if ($ContainerUser -notmatch '^[A-Za-z0-9_][A-Za-z0-9_.-]*(?::[A-Za-z0-9_][A-Za-z0-9_.-]*)?$') {
    throw 'ContainerUser must be a user or user:group name or numeric ID.'
  }
  foreach ($path in @($RemoteNodePath, $RemoteEntryPath, $DataDir, $SettingsPath, $Executable)) {
    if (!$path.StartsWith('/') -or $path -match '[\x00-\x1f\x7f]') {
      throw 'Remote paths must be absolute POSIX paths without control characters.'
    }
  }
  if ($ContinueSession -and $Check) { throw 'ContinueSession and Check are separate actions.' }
  if (([bool]$DeviceId) -eq ([bool]$ClientSettingsPath)) {
    throw 'Provide exactly one of DeviceId or ClientSettingsPath.'
  }
  if ($ClientSettingsPath) {
    try {
      $settings = [IO.File]::ReadAllText($ClientSettingsPath, [Text.Encoding]::UTF8) | ConvertFrom-Json -ErrorAction Stop
    } catch {
      throw 'ClientSettingsPath must point to readable, valid JSON settings.'
    }
    $DeviceId = [string]$settings.deviceId
  }
  $deviceGuid = [Guid]::Empty
  if (![Guid]::TryParse($DeviceId, [ref]$deviceGuid)) {
    throw 'DeviceId must be the UUID of the connected CC Desk client.'
  }
  $DeviceId = $deviceGuid.ToString()

  $project = Get-Item -LiteralPath $ProjectPath -ErrorAction Stop
  if (!$project.PSIsContainer -or $project.PSProvider.Name -ne 'FileSystem') {
    throw 'ProjectPath must be an existing Windows filesystem directory.'
  }
  $projectBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($project.FullName))
  $remoteArguments = @()
  if ($Sudo) { $remoteArguments += @('sudo', '-n') }
  $remoteArguments += @(
    'docker', 'exec', $(if ($Check) { '-i' } else { '-it' }),
    '--user', $ContainerUser, $Container, $RemoteNodePath, $RemoteEntryPath,
    '--data-dir', $DataDir, '--settings-path', $SettingsPath, '--executable', $Executable,
    '--device-id', $DeviceId, '--project-base64', $projectBase64
  )
  if ($ContinueSession) { $remoteArguments += '--continue' }
  if ($Check) { $remoteArguments += '--check' }
  $remoteCommand = ($remoteArguments | ForEach-Object { ConvertTo-ExternalCliShellArgument $_ }) -join ' '
  $sshArguments = @(
    $(if ($Check) { '-T' } else { '-tt' }),
    '-o', 'StrictHostKeyChecking=yes', '-o', 'BatchMode=yes',
    '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
    '--', $SshTarget, $remoteCommand
  )
  [pscustomobject]@{
    SshArguments = [string[]]$sshArguments
    RemoteCommand = $remoteCommand
    ProjectPath = $project.FullName
    DeviceId = $DeviceId
  }
}

if ($MyInvocation.InvocationName -ne '.') {
  $ErrorActionPreference = 'Stop'
  try {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
      throw 'Run this launcher as your ordinary Windows user, not as Administrator.'
    }
    $connection = New-ExternalCliConnection @PSBoundParameters
    [Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
    [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
    $ssh = Get-Command ssh.exe -CommandType Application -ErrorAction Stop
    Write-Host 'Keep CC Desk Tunnel connected while using this external CLI.'
    Invoke-ExternalCliNativeCommand -FilePath $ssh.Source -Arguments $connection.SshArguments
    exit $LASTEXITCODE
  } catch {
    Write-Error $_
    exit 1
  }
}
