# Securely stores the NVIDIA Build API key (for the NVIDIA provider workers) under this Windows user's DPAPI.
# Equivalent to: set-openai-key.ps1 -Profile nvidia. The key is read hidden and never printed.
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'set-openai-key.ps1') -Profile nvidia
