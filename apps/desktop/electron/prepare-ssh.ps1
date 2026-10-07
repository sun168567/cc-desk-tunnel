param(
  [Parameter(Mandatory)][string]$Runtime,
  [Parameter(Mandatory)][string]$OpenSshDirectory,
  [Parameter(Mandatory)][int]$Port
)
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'PowerShell 7 is required.' }
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
$username = [Security.Principal.WindowsIdentity]::GetCurrent().Name.ToLowerInvariant() -replace '^.*\\', ''
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
AllowUsers $username
AllowTcpForwarding no
PermitTunnel no
X11Forwarding no
Subsystem sftp "$bin/sftp-server.exe"
LogLevel ERROR
"@ | Set-Content -LiteralPath (Join-Path $Runtime 'sshd_config') -Encoding utf8NoBOM
@{
  username = $username
  powershellPath = [Environment]::ProcessPath
  hostPublicKey = ((Get-Content -LiteralPath (Join-Path $Runtime 'host.pub') -Raw -Encoding utf8).Trim() -split ' ')[0..1] -join ' '
  privateKey = Get-Content -LiteralPath (Join-Path $Runtime 'identity') -Raw -Encoding utf8
} | ConvertTo-Json -Compress
