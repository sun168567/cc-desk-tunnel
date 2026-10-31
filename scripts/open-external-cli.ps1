[CmdletBinding()]
param(
  [string]$SshTarget,
  [string]$ProjectPath = (Get-Location).Path,
  [string]$DeviceId,
  [string]$ClientSettingsPath,
  [string]$Container,
  [switch]$Sudo,
  [switch]$ContinueSession,
  [switch]$Check
)

# Keep the launcher ASCII so Windows PowerShell 5.1 does not depend on a BOM.
# Dot-source this file to test argument construction without connecting to SSH.

# Runs on the server: finds the service's container unless one is named, then enters it. A terminal asks for
# a terminal in the container too; a check has none.
$ExternalCliHostScript = @'
use_sudo=$1 container=$2 inner=$3
shift 3
docker() { if [ "$use_sudo" = sudo ]; then sudo -n docker "$@"; else command docker "$@"; fi; }
if [ -z "$container" ]; then
  names=$(docker ps --filter label=com.docker.compose.service=proxy --format '{{.Names}}') || {
    echo 'Docker cannot be used by this account here; add -Sudo, or use an account that may run docker.' >&2; exit 1; }
  container=$(printf '%s\n' "$names" | grep '^cc-desk-tunnel-' || true)
  if [ -z "$container" ]; then echo 'No running CC Desk Tunnel container was found; name it with -Container.' >&2; exit 1; fi
  if [ "$(printf '%s\n' "$container" | wc -l)" -ne 1 ]; then echo 'Several CC Desk Tunnel containers are running; name one with -Container.' >&2; exit 1; fi
fi
if [ -t 0 ]; then tty=-it; else tty=-i; fi
# docker exec leaves what it started running when its client goes. The processes of this run carry its mark, and
# a hangup of this SSH session is passed on to them; the entry then ends the CLI and the commands it started.
run=$(cat /proc/sys/kernel/random/uuid)
hangup() {
  docker exec "$container" sh -c 'for environ in /proc/[0-9]*/environ; do
    if tr "\000" "\n" <"$environ" 2>/dev/null | grep -qx "CC_DESK_EXTERNAL_RUN=$1"; then
      process=${environ%/environ}; kill -HUP "${process#/proc/}" 2>/dev/null
    fi
  done' sh "$run" >/dev/null 2>&1
  exit 129
}
trap hangup HUP TERM
docker exec -e "CC_DESK_EXTERNAL_RUN=$run" "$tty" "$container" sh -c "$inner" sh "$@"
'@.Replace("`r", '')

# Runs in the container: the entry of the program the service process runs, which after an upgrade from the
# client is not the image's own, with that process's PATH and the service's settings.
$ExternalCliContainerScript = @'
program= service=
for command in /proc/[0-9]*/cmdline; do
  program=$(tr '\000' '\n' <"$command" 2>/dev/null | sed -n 's#/apps/server/src/main\.ts$##p' | head -n 1)
  if [ -n "$program" ]; then service=${command%/cmdline}; break; fi
done
if [ -z "$program" ]; then echo 'The service in this container is not running; start it and try again.' >&2; exit 1; fi
if [ ! -f "$program/apps/server/src/external-cli.ts" ]; then echo 'The running service has no external CLI entry; upgrade the service first.' >&2; exit 1; fi
PATH=$(tr '\000' '\n' <"$service/environ" | sed -n 's/^PATH=//p')
export PATH
exec node --env-file=/data/config/service.env "$program/apps/server/src/external-cli.ts" "$@"
'@.Replace("`r", '')

function ConvertTo-ExternalCliShellArgument {
  param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Value)
  return "'" + $Value.Replace("'", "'\''") + "'"
}

function Invoke-ExternalCliNativeCommand {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][AllowEmptyString()][string[]]$Arguments
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
    [string]$ProjectPath = (Get-Location).Path,
    [string]$DeviceId,
    [string]$ClientSettingsPath,
    [string]$Container,
    [switch]$Sudo,
    [switch]$ContinueSession,
    [switch]$Check
  )

  if ($SshTarget -notmatch '^[A-Za-z0-9][A-Za-z0-9_.@-]*$') {
    throw 'SshTarget must be an SSH config alias or user@host, not a shell command or option.'
  }
  if ($Container -and $Container -notmatch '^[A-Za-z0-9][A-Za-z0-9_.-]*$') {
    throw 'Container must be a Docker container name.'
  }
  if ($ContinueSession -and $Check) { throw 'ContinueSession and Check are separate actions.' }
  if ($DeviceId -and $ClientSettingsPath) { throw 'Provide DeviceId or ClientSettingsPath, not both.' }
  if (!$DeviceId) {
    # The desktop client keeps the identity of this computer in its settings.
    if (!$ClientSettingsPath) { $ClientSettingsPath = Join-Path $env:APPDATA 'CC Desk Tunnel\settings.json' }
    try {
      $settings = [IO.File]::ReadAllText($ClientSettingsPath, [Text.Encoding]::UTF8) | ConvertFrom-Json -ErrorAction Stop
    } catch {
      throw 'The client settings could not be read; connect the CC Desk Tunnel client once, or give DeviceId.'
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
  $remoteArguments = @(
    'sh', '-c', $ExternalCliHostScript, 'sh',
    $(if ($Sudo) { 'sudo' } else { 'none' }), [string]$Container, $ExternalCliContainerScript,
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
