# Installs ccdt, the terminal client of CC Desk Tunnel, for the current user, in Windows PowerShell or PowerShell 7:
#
#   irm https://raw.githubusercontent.com/sun168567/cc-desk-tunnel/main/deploy/install-ccdt.ps1 | iex
#
# It downloads the Windows package of the newest release, checks it against the release's SHA256SUMS and puts it in
# place with the install script the package carries, which adds ccdt to the user's PATH; this window can use it at
# once. No administrator rights are needed. $env:CCDT_VERSION = '0.3.9' takes that release instead, the one of the
# service; $env:CCDT_DOWNLOAD_ONLY = '1' only unpacks the checked package into the current folder.
& {
  $ErrorActionPreference = 'Stop'
  # What it says is in the system's language, Chinese or else English, as ccdt's: a locale the
  # environment sets, else the system's, the one Node reads (the culture of formats).
  $locale = @($env:LC_ALL, $env:LC_MESSAGES, $env:LANG, (Get-Culture).Name) |
    Where-Object { $_ -and $_ -notmatch '^(C|POSIX)(\.|$)' } | Select-Object -First 1
  $zh = $locale -like 'zh*'
  function Words([string]$chinese, [string]$english) { if ($zh) { $chinese } else { $english } }
  # Windows PowerShell draws a progress bar for every block it downloads, which makes a large file slow.
  $ProgressPreference = 'SilentlyContinue'
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $repository = 'sun168567/cc-desk-tunnel'
  $version = $env:CCDT_VERSION
  if (-not $version) {
    $version = (Invoke-RestMethod "https://api.github.com/repos/$repository/releases/latest").tag_name
  }
  $version = $version -replace '^v', ''
  $name = "ccdt-$version-windows-x64.zip"
  $base = "https://github.com/$repository/releases/download/v$version"
  $folder = Join-Path ([IO.Path]::GetTempPath()) "ccdt-install-$(Get-Random)"
  New-Item -ItemType Directory $folder | Out-Null
  try {
    Write-Host (Words "正在下载 ccdt $version ……" "Downloading ccdt $version…")
    $archive = Join-Path $folder $name
    $sums = Join-Path $folder 'SHA256SUMS'
    try {
      Invoke-WebRequest "$base/$name" -OutFile $archive -UseBasicParsing
      Invoke-WebRequest "$base/SHA256SUMS" -OutFile $sums -UseBasicParsing
    } catch {
      throw (Words "下载 ccdt $version 失败：$($_.Exception.Message)。请确认版本号与网络；需要代理时先设置系统代理。" `
        "Couldn’t download ccdt ${version}: $($_.Exception.Message). Check the version and the network; set the system proxy first if one is needed.")
    }
    $expected = Get-Content $sums | ForEach-Object {
      $fields = $_.Trim() -split '\s+'
      if ($fields[1] -eq $name -or $fields[1] -eq "*$name") { $fields[0] }
    } | Select-Object -First 1
    if (-not $expected) { throw (Words "$version 的校验清单里没有 $name。" "$name isn’t in the checksums of $version.") }
    if ((Get-FileHash $archive -Algorithm SHA256).Hash -ne $expected) {
      throw (Words "下载的 $name 校验不符，没有安装。" "The downloaded $name doesn’t match its checksum; nothing was installed.")
    }
    # The system's own tar, which reads .zip; another one may come first on the PATH.
    $tar = Join-Path $env:SystemRoot 'System32\tar.exe'
    if ($env:CCDT_DOWNLOAD_ONLY) {
      & $tar -xf $archive -C (Get-Location).Path
      if ($LASTEXITCODE) { throw (Words '解压失败。' "Couldn’t unpack it.") }
      Write-Host (Words "已校验并解压到 $(Join-Path (Get-Location).Path 'ccdt')，没有安装。" `
        "Checked and unpacked into $(Join-Path (Get-Location).Path 'ccdt'); not installed.")
      return
    }
    & $tar -xf $archive -C $folder
    if ($LASTEXITCODE) { throw (Words '解压失败。' "Couldn’t unpack it.") }
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $folder 'ccdt\install.ps1')
    if ($LASTEXITCODE) { throw (Words '安装脚本没有完成。' "The install script didn’t finish.") }
    # The install script added ccdt to the user's PATH, which windows opened from now on read; this one is told too.
    $target = Join-Path $env:LOCALAPPDATA 'Programs\ccdt'
    if (-not (($env:Path -split ';') -contains $target)) { $env:Path = "$env:Path;$target" }
    Write-Host (Words '这个窗口里也可以直接运行 ccdt 了。' 'This window can run ccdt now too.')
  } finally {
    Remove-Item -Recurse -Force $folder -ErrorAction SilentlyContinue
  }
}