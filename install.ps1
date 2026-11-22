# Install this local plugin marketplace for Claude Code (Windows PowerShell).
# Run from an extracted zip with: powershell -ExecutionPolicy Bypass -File .\install.ps1
param([switch]$NoKeyPrompt, [switch]$ProvisionUltraChannel)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$plugin = Join-Path $root 'plugins\openai-workers'
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
  throw 'Claude Code CLI was not found in PATH. Install/update Claude Code first.'
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw 'Node.js was not found in PATH. Install Node.js 20.11 or later.'
}
$version = (& node --version).TrimStart('v')
if ([version]$version.Split('-')[0] -lt [version]'20.11.0') {
  throw ('Node.js 20.11 or later is required, got ' + $version)
}
Write-Host 'Validating Claude Code plugin and marketplace...'
& claude plugin validate $plugin
if ($LASTEXITCODE -ne 0) { throw 'Claude Code plugin validation failed.' }
& claude plugin validate $root
if ($LASTEXITCODE -ne 0) { throw 'Marketplace validation failed.' }

if (-not $NoKeyPrompt) {
  $profiles = @(
    @{ Name = 'standard'; Variable = 'OPENAI_API_KEY'; File = 'openai-key.dpapi' },
    @{ Name = 'free'; Variable = 'OPENAI_FREE_API_KEY'; File = 'openai-free-key.dpapi' }
  )
  foreach ($profile in $profiles) {
    $stored = if ($env:LOCALAPPDATA) {
      Join-Path (Join-Path $env:LOCALAPPDATA 'ClaudeOpenAIWorkers') $profile.File
    } else { $null }
    $provided = [Environment]::GetEnvironmentVariable($profile.Variable, 'Process')
    if ($provided -or ($stored -and (Test-Path -LiteralPath $stored))) {
      Write-Host "Existing $($profile.Name) API key found; not replacing it."
    } else {
      & (Join-Path $plugin 'scripts\set-openai-key.ps1') -Profile $profile.Name
      if (-not $?) { throw "$($profile.Name) API key setup did not complete." }
    }
  }
}
if ($ProvisionUltraChannel) {
  # Opt-in owner setup for native ULTRA only. This enables nothing; without the key the bridge refuses every private request.
  $channelKey = ((& node (Join-Path $plugin 'scripts\provision-ultra-channel.mjs') '--print-path') | Out-String).Trim()
  if (Test-Path -LiteralPath $channelKey) {
    Write-Host 'Existing ULTRA channel key found; not replacing it.'
  } else {
    & (Join-Path $plugin 'scripts\set-ultra-channel.ps1')
    if (-not $?) { throw 'ULTRA channel key setup did not complete.' }
  }
}
Write-Host 'Registering local marketplace...'
& claude plugin marketplace add $root
if ($LASTEXITCODE -ne 0) { throw 'Marketplace registration failed.' }
# The plugin was renamed from openai-workers to oai: remove an old install so two copies never run side by side.
try { & claude plugin uninstall 'openai-workers@openai-worker-local' --scope user *> $null } catch { }
Write-Host 'Installing oai (OpenAI workers) at user scope...'
& claude plugin install 'oai@openai-worker-local' --scope user
if ($LASTEXITCODE -ne 0) { throw 'Plugin installation failed.' }
Write-Host 'Installed. Restart Claude Code, then run /oai (status) or /oai:a <worker> <task>.'
