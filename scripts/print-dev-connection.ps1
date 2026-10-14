# Waits until the dev server writes a fresh connection file, then prints the address and token.
$ErrorActionPreference = 'Stop'
$path = Join-Path (Get-Location) '.local\dev-connection.json'
$deadline = (Get-Date).AddSeconds(90)
while ((Get-Date) -lt $deadline -and -not (Test-Path -LiteralPath $path)) {
  Start-Sleep -Milliseconds 200
}
if (-not (Test-Path -LiteralPath $path)) {
  Write-Host 'Timed out waiting for .local\dev-connection.json'
  exit 1
}
$json = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch {}
function L([int[]]$codes) { -join ($codes | ForEach-Object { [char]$_ }) }
Write-Host ''
Write-Host ((L 0x670D,0x52A1,0x5730,0x5740) + ': ' + $json.serverUrl)
Write-Host ((L 0x670D,0x52A1,0x51ED,0x636E) + ': ' + $json.token)
Write-Host ((L 0x754C,0x9762) + ': ' + $json.uiUrl)
Write-Host ''
