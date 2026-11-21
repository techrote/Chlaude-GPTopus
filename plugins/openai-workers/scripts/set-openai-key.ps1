# Securely stores one of the two OpenAI API keys under this Windows user's DPAPI.
# Legacy standard-key path is retained for upgrades from v0.1-v0.3.
param([ValidateSet('standard', 'free')][string]$Profile = 'standard')
$ErrorActionPreference = 'Stop'
if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA must be available.' }
$folder = Join-Path $env:LOCALAPPDATA 'ClaudeOpenAIWorkers'
New-Item -ItemType Directory -Force -Path $folder | Out-Null
$file = if ($Profile -eq 'free') { 'openai-free-key.dpapi' } else { 'openai-key.dpapi' }
$path = Join-Path $folder $file
$label = if ($Profile -eq 'free') { 'Astra/Terra complimentary' } else { 'straight API' }
$key = Read-Host "Paste your $label OpenAI API key (hidden)" -AsSecureString
if ($key.Length -lt 20) { throw 'The API key is unusually short; nothing saved.' }
$blob = ConvertFrom-SecureString -SecureString $key
[System.IO.File]::WriteAllText($path, $blob, [System.Text.Encoding]::ASCII)
Write-Host "$label API key stored with Windows DPAPI. Restart Claude Code to apply."
