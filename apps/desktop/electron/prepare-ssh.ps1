param(
  [Parameter(Mandatory)][string]$Runtime,
  [Parameter(Mandatory)][string]$OpenSshDirectory,
  [Parameter(Mandatory)][int]$Port
)
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'PowerShell 7 is required.' }
# The parent reads stdout as UTF-8, including executable paths in the connection JSON.
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
# Only this user may reach the keys: a new list with that one entry replaces whatever the directory had, entries of
# its own included. Written this way only the DACL is set. Set-Acl would also write the audit list where the
# directory already keeps its entries from being inherited, and a standard user lacks the privilege for that.
$security = [Security.AccessControl.DirectorySecurity]::new()
$security.SetAccessRuleProtection($true, $false)
$security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
[IO.FileSystemAclExtensions]::SetAccessControl([IO.DirectoryInfo]::new($Runtime), $security)
$keygen = Join-Path $OpenSshDirectory 'ssh-keygen.exe'
foreach ($name in @('host', 'identity')) {
  & $keygen -q -t ed25519 -N '' -f (Join-Path $Runtime $name)
  if ($LASTEXITCODE -ne 0) { throw 'ssh-keygen failed.' }
}
$publicKey = (Get-Content -LiteralPath (Join-Path $Runtime 'identity.pub') -Raw -Encoding utf8).Trim()
Set-Content -LiteralPath (Join-Path $Runtime 'authorized_keys') -Value $publicKey -Encoding utf8NoBOM
# sshd knows a local account by its bare name and a domain account as domain\user, both in lower case. A login
# by the bare name still finds the domain account, so that is what the service is given.
$account = [Security.Principal.WindowsIdentity]::GetCurrent().Name.ToLowerInvariant()
$username = $account -replace '^.*\\', ''
$names = if ($account.StartsWith($env:COMPUTERNAME.ToLowerInvariant() + '\')) { @($username) } else { @($account, $username) }
$allowed = ($names | ForEach-Object { '"' + $_.Replace('\', '\\').Replace('"', '\"') + '"' }) -join ' '
# The bundled sshd, like the computer's own, runs each command through the shell named in the registry, cmd.exe
# where none is (Win32-OpenSSH reads HKLM\SOFTWARE\OpenSSH\DefaultShell itself; no option of sshd_config changes
# it). The service writes its commands for cmd.exe, so where another shell is set the command it sent is run by
# cmd.exe all the same: the shell is given a forced command, written in its own language, that starts cmd.exe on
# the command OpenSSH keeps in SSH_ORIGINAL_COMMAND, the SFTP server included, with the same standard streams,
# and leaves with its exit code. sshd tells the shells apart by these parts of their paths.
$setting = Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\OpenSSH' -ErrorAction SilentlyContinue
$shellPath = "$($setting.DefaultShell)"
$shellOption = "$($setting.DefaultShellCommandOption)".ToLowerInvariant()
$shell = 'cmd'
if ($shellPath) {
  $lower = $shellPath.Replace('/', '\').ToLowerInvariant()
  $shell = if ($lower.Contains('system32\cmd')) { 'cmd' }
    elseif ($lower.Contains('powershell')) { 'powershell' }
    # WSL's bash.exe, in System32, runs a Linux shell that cannot start a Windows program by its Windows path.
    elseif ($lower.Contains('\bash') -and -not $lower.Contains('\system32\')) { 'bash' }
    else { 'other' }
  $options = if ($shell -eq 'cmd') { @('', '/c') } else { @('', '-c', '-command') }
  if ($options -notcontains $shellOption) { $shell = 'other' }
}
# No double quotes, which sshd would have to escape for the shell; the same in Windows PowerShell and PowerShell 7.
$runCmd = "`$i=[Diagnostics.ProcessStartInfo]::new([IO.Path]::Combine([Environment]::SystemDirectory,'cmd.exe'),'/d /s /c '+[char]34+`$env:SSH_ORIGINAL_COMMAND+[char]34);`$i.UseShellExecute=`$false;`$p=[Diagnostics.Process]::Start(`$i);`$p.WaitForExit();exit `$p.ExitCode"
$forced = switch ($shell) {
  'powershell' { "ForceCommand $runCmd" }
  # Git Bash would quote the command for cmd.exe in a way cmd.exe does not read, so the bundled PowerShell starts it.
  'bash' { "ForceCommand MSYS2_ARG_CONV_EXCL='*' exec `"`$CC_DESK_TUNNEL_PWSH`" -NoLogo -NoProfile -NonInteractive -EncodedCommand $([Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($runCmd)))" }
  default { '' }
}
$path = $Runtime.Replace('\', '/')
$bin = $OpenSshDirectory.Replace('\', '/')
@"
Port $Port
ListenAddress 127.0.0.1
HostKey "$path/host"
AuthorizedKeysFile "$path/authorized_keys"
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
AllowUsers $allowed
# Commands started together each open a connection of their own; the default would drop some of them at random
# once ten are signing in at the same time.
MaxStartups 64
# A service that shares one connection between its commands runs each as a session of that connection; the
# default would refuse the eleventh running at the same time.
MaxSessions 128
AllowTcpForwarding no
PermitTunnel no
X11Forwarding no
Subsystem sftp "$bin/sftp-server.exe"
LogLevel ERROR
$forced
"@ | Set-Content -LiteralPath (Join-Path $Runtime 'sshd_config') -Encoding utf8NoBOM
@{
  username = $username
  # A shell no forced command is written for: the client says so instead of starting the service.
  unsupportedShell = if ($shell -eq 'other') { $shellPath } else { $null }
  hostPublicKey = ((Get-Content -LiteralPath (Join-Path $Runtime 'host.pub') -Raw -Encoding utf8).Trim() -split ' ')[0..1] -join ' '
  privateKey = Get-Content -LiteralPath (Join-Path $Runtime 'identity') -Raw -Encoding utf8
} | ConvertTo-Json -Compress
