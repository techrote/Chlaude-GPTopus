# Creates the owner key that authenticates the ULTRA native mod to the local bridge,
# then restricts its file ACL to the current Windows user. The key is never printed.
# ULTRA itself stays disabled until owner policy and OPENAI_ULTRA_ENABLED=1 enable it.
param([switch]$Rotate)
$ErrorActionPreference = 'Stop'
$entry = Join-Path $PSScriptRoot 'provision-ultra-channel.mjs'
$arguments = @($entry)
if ($Rotate) { $arguments += '--rotate' }
& node @arguments
if ($LASTEXITCODE -ne 0) { throw "ULTRA channel key provisioning failed ($LASTEXITCODE)." }
$path = ((& node $entry '--print-path') | Out-String).Trim()
if (-not (Test-Path -LiteralPath $path)) { throw 'The channel key was not found where it was expected.' }
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
& icacls $path /inheritance:r /grant:r "*${sid}:(R,W)" | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not restrict the channel key ACL; keep the state directory private and retry.' }
Write-Host 'Channel key ACL restricted to the current user. Restart Claude Code to apply.'
