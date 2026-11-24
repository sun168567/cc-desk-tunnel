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
# A desktop client that carries ccdt puts its own ahead of this one on the PATH (desktop-path.ps1): that is the ccdt
# the terminal runs, updated with the client.
$desktop = [Environment]::GetEnvironmentVariable('Path', 'User') -split ';' | Where-Object { $_ } |
  ForEach-Object { [Environment]::ExpandEnvironmentVariables($_).TrimEnd('\') } |
  Where-Object { $_ -like '*\resources\ccdt' -and (Test-Path (Join-Path $_ 'ccdt.cmd')) } | Select-Object -First 1
if ($desktop) {
  Write-Output "ccdt 已安装到 $target。图形客户端自带的 ccdt（$desktop）在 PATH 中排在前面，终端里用的是它，随图形客户端升级。"
} else {
  Write-Output "ccdt 已安装到 $target。打开一个新的终端窗口，运行 ccdt login 登录服务端。"
}
