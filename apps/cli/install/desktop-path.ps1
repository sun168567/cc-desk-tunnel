# The ccdt the desktop client carries, put on the current user's PATH by the client's installer and taken off it by
# its uninstaller (scripts/windows-installer.nsh). The client is the whole of what ccdt is part of, so its ccdt goes
# ahead of one installed on its own (apps/cli/install/install.ps1), which is left in place; elsewhere it goes last.
# The PATH is edited as the registry holds it, with the variables it names left unexpanded, and the programs that
# are running are told of the change. `Key`: where the PATH is, for a test.
param(
  [Parameter(Mandatory)][string]$Directory,
  [switch]$Remove,
  [string]$Key = 'HKCU:\Environment',
  [string]$Alone = (Join-Path $env:LOCALAPPDATA 'Programs\ccdt')
)
$ErrorActionPreference = 'Stop'
$same = { param($entry, $folder) [Environment]::ExpandEnvironmentVariables($entry).TrimEnd('\') -eq $folder.TrimEnd('\') }
$written = (Get-Item $Key).GetValue('Path', '', 'DoNotExpandEnvironmentNames')
$entries = @($written -split ';' | Where-Object { $_ -and -not (& $same $_ $Directory) })
if (-not $Remove) {
  $at = [array]::FindIndex([string[]]$entries, [Predicate[string]] { param($entry) & $same $entry $Alone })
  $entries = if ($at -lt 0) { $entries + $Directory } else {
    @(if ($at -gt 0) { $entries[0..($at - 1)] }) + $Directory + $entries[$at..($entries.Count - 1)]
  }
}
$path = $entries -join ';'
if ($path -ne $written) {
  # Of the kind it was, or the kind Windows gives it.
  $kind = try { (Get-Item $Key).GetValueKind('Path') } catch { 'ExpandString' }
  Set-ItemProperty $Key Path $path -Type $kind
  # A variable set through .NET is announced to the programs that are running, and with it the new PATH.
  if ($Key -eq 'HKCU:\Environment') {
    [Environment]::SetEnvironmentVariable('CCDT_PATH_CHANGED', '1', 'User')
    [Environment]::SetEnvironmentVariable('CCDT_PATH_CHANGED', $null, 'User')
  }
}
