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
$acl = Get-Acl -LiteralPath $Runtime
$acl.SetAccessRuleProtection($true, $false)
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
Set-Acl -LiteralPath $Runtime -AclObject $acl
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
$allowed = if ($account.StartsWith($env:COMPUTERNAME.ToLowerInvariant() + '\')) { $username } else { "$account $username" }
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
"@ | Set-Content -LiteralPath (Join-Path $Runtime 'sshd_config') -Encoding utf8NoBOM
@{
  username = $username
  hostPublicKey = ((Get-Content -LiteralPath (Join-Path $Runtime 'host.pub') -Raw -Encoding utf8).Trim() -split ' ')[0..1] -join ' '
  privateKey = Get-Content -LiteralPath (Join-Path $Runtime 'identity') -Raw -Encoding utf8
} | ConvertTo-Json -Compress
