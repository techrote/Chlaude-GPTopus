# Securely stores one of the worker API keys (two OpenAI keys, plus the NVIDIA Build key) under this Windows user's DPAPI.
# Legacy standard-key path is retained for upgrades from v0.1-v0.3.
param([ValidateSet('standard', 'free', 'nvidia')][string]$Profile = 'standard')
$ErrorActionPreference = 'Stop'
if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA must be available.' }
$folder = Join-Path $env:LOCALAPPDATA 'ClaudeOpenAIWorkers'
New-Item -ItemType Directory -Force -Path $folder | Out-Null
$file = if ($Profile -eq 'free') { 'openai-free-key.dpapi' } elseif ($Profile -eq 'nvidia') { 'nvidia-key.dpapi' } else { 'openai-key.dpapi' }
$path = Join-Path $folder $file
$label = if ($Profile -eq 'free') { 'Astra/Terra complimentary OpenAI' } elseif ($Profile -eq 'nvidia') { 'NVIDIA Build (nvapi-...)' } else { 'straight OpenAI' }
$key = Read-Host "Paste your $label API key (hidden)" -AsSecureString
if ($key.Length -lt 20) { throw 'The API key is unusually short; nothing saved.' }
$blob = ConvertFrom-SecureString -SecureString $key
[System.IO.File]::WriteAllText($path, $blob, [System.Text.Encoding]::ASCII)
Write-Host "$label API key stored with Windows DPAPI. Restart Claude Code to apply."
