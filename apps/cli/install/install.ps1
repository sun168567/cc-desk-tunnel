# Installs ccdt from this folder for the current user: copies it to %LOCALAPPDATA%\Programs\ccdt and adds that
# folder to the user's PATH. Running it again updates ccdt in place. Nothing is installed for other users or
# registered as a service. `ccdt upgrade` runs the script of the release it installs.
$ErrorActionPreference = 'Stop'
$target = Join-Path $env:LOCALAPPDATA 'Programs\ccdt'
if ((Resolve-Path $PSScriptRoot).Path -ne $target) {
  # A ccdt still running keeps its files in use, the one that runs this script among them, but Windows lets their
  # folder be moved aside: the new one takes its place, and what is left of the old goes the next time if not now.
  Get-Item "$target.old-*" -ErrorAction SilentlyContinue |
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
  $old = $null
  if (Test-Path $target) {
    $old = "$target.old-$(Get-Random)"
    Rename-Item $target (Split-Path $old -Leaf)
  }
  New-Item -ItemType Directory -Force (Split-Path $target) | Out-Null
  Copy-Item -Recurse $PSScriptRoot $target
  if ($old) { Remove-Item -Recurse -Force $old -ErrorAction SilentlyContinue }
}
$path = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not (($path -split ';') -contains $target)) {
  [Environment]::SetEnvironmentVariable('Path', ((@($path, $target) | Where-Object { $_ }) -join ';'), 'User')
  Write-Output "已把 $target 加入当前用户的 PATH。"
}
Write-Output "ccdt 已安装到 $target。打开一个新的终端窗口，运行 ccdt login 登录服务端。"
