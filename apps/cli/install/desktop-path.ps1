# The ccdt the desktop client carries, put on the current user's PATH by the client's installer and taken off it by
# its uninstaller (scripts/windows-installer.nsh). The PATH is edited as the registry holds it, with the variables it
# names left unexpanded, and the programs that are running are told of the change. A ccdt installed on its own keeps
# its place ahead of this one.
param([Parameter(Mandatory)][string]$Directory, [switch]$Remove)
$ErrorActionPreference = 'Stop'
$key = 'HKCU:\Environment'
$written = (Get-Item $key).GetValue('Path', '', 'DoNotExpandEnvironmentNames')
$entries = @($written -split ';' | Where-Object { $_ -and $_.TrimEnd('\') -ne $Directory.TrimEnd('\') })
if (-not $Remove) { $entries += $Directory }
$path = $entries -join ';'
if ($path -ne $written) {
  # Of the kind it was, or the kind Windows gives it.
  $kind = try { (Get-Item $key).GetValueKind('Path') } catch { 'ExpandString' }
  Set-ItemProperty $key Path $path -Type $kind
  # A variable set through .NET is announced to the programs that are running, and with it the new PATH.
  [Environment]::SetEnvironmentVariable('CCDT_PATH_CHANGED', '1', 'User')
  [Environment]::SetEnvironmentVariable('CCDT_PATH_CHANGED', $null, 'User')
}
