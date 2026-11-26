# Installs ccdt from this folder for the current user: copies it to %LOCALAPPDATA%\Programs\ccdt and adds that
# folder to the user's PATH. Running it again updates ccdt in place. Nothing is installed for other users or
# registered as a service. `ccdt upgrade` runs the script of the release it installs.
$ErrorActionPreference = 'Stop'
# What it says is in the system's language, Chinese or else English, as ccdt's (apps/cli/src/i18n.mjs): a locale the
# environment sets, else the system's, the one Node reads (the culture of formats).
$locale = @($env:LC_ALL, $env:LC_MESSAGES, $env:LANG, (Get-Culture).Name) |
  Where-Object { $_ -and $_ -notmatch '^(C|POSIX)(\.|$)' } | Select-Object -First 1
$zh = $locale -like 'zh*'
function Words([string]$chinese, [string]$english) { if ($zh) { $chinese } else { $english } }
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
  Write-Output (Words "已把 $target 加入当前用户的 PATH。" "Added $target to your PATH.")
}
# A desktop client that carries ccdt puts its own ahead of this one on the PATH (desktop-path.ps1): that is the ccdt
# the terminal runs, updated with the client.
$desktop = [Environment]::GetEnvironmentVariable('Path', 'User') -split ';' | Where-Object { $_ } |
  ForEach-Object { [Environment]::ExpandEnvironmentVariables($_).TrimEnd('\') } |
  Where-Object { $_ -like '*\resources\ccdt' -and (Test-Path (Join-Path $_ 'ccdt.cmd')) } | Select-Object -First 1
if ($desktop) {
  Write-Output (Words "ccdt 已安装到 $target。图形客户端自带的 ccdt（$desktop）在 PATH 中排在前面，终端里用的是它，随图形客户端升级。" `
      "ccdt is installed in $target. The ccdt the desktop client carries ($desktop) comes first on the PATH: the terminal runs that one, and it is updated with the client.")
} else {
  Write-Output (Words "ccdt 已安装到 $target。打开一个新的终端窗口，运行 ccdt login 登录服务端。" `
      "ccdt is installed in $target. Open a new terminal window and run ccdt login to sign in to the server.")
}
