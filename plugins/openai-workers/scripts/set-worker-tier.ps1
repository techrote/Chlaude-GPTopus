# Persist an OpenAI tier/model for all workers or one named worker.
# Example: .\set-worker-tier.ps1 -Agent sol6-1flex -Tier flex
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('all', 'sol6-2', 'astra6-2', 'luna6', 'luna6fast', 'luna6flex', 'sol6-1flex', 'astra6free', 'terra5-6free')]
  [string]$Agent,

  [Parameter(Mandatory = $true)]
  [ValidateSet('auto', 'default', 'flex', 'fast', 'priority', 'inherit')]
  [string]$Tier,

  [string]$Model
)
$ErrorActionPreference = 'Stop'
if ($Agent -eq 'all' -and $Model) {
  throw 'Use -Model with a specific agent, not all.'
}
if ($Model -and $Model -notmatch '^gpt-[A-Za-z0-9_.-]{1,80}$') {
  throw 'Invalid OpenAI model identifier.'
}
$defaults = @{
  'sol6-2' = 'gpt-6.2-sol'
  'astra6-2' = 'gpt-6.2-astra'
  'luna6' = 'gpt-6-luna'
  'luna6fast' = 'gpt-6-luna'
  'luna6flex' = 'gpt-6-luna'
  'sol6-1flex' = 'gpt-6.1-sol'
  'astra6free' = 'gpt-6-astra'
  'terra5-6free' = 'gpt-5.6-terra'
}
$envSuffix = $Agent.ToUpperInvariant() -replace '[^A-Z0-9]', '_'
if ($Agent -eq 'all') {
  $tierVariable = 'OPENAI_WORKER_SERVICE_TIER'
} else {
  $tierVariable = 'OPENAI_WORKER_' + $envSuffix + '_SERVICE_TIER'
}

if ($Agent -ne 'all') {
  $modelVariable = 'OPENAI_WORKER_' + $envSuffix + '_MODEL'
  $currentModel = [Environment]::GetEnvironmentVariable($modelVariable, 'User')
  if (-not $currentModel) { $currentModel = $defaults[$Agent] }
  $chosenModel = if ($Model) { $Model } else { $currentModel }
  if ($Tier -eq 'flex' -and $chosenModel -match '^gpt-6\.2-(sol|astra)(-|$)') {
    throw "Flex is unavailable for $chosenModel. Specify -Model gpt-6.1-sol or use -Tier default/fast."
  }
  if ($Agent -eq 'astra6free' -and $chosenModel -ne 'gpt-6-astra') {
    Write-Warning 'The Astra daily worker always uses the free-programme key. Verify that your chosen model is eligible.'
  }
  if ($Agent -eq 'terra5-6free' -and $chosenModel -ne 'gpt-5.6-terra') {
    Write-Warning 'The Terra daily worker always uses the free-programme key. Verify that your chosen model is eligible.'
  }
}

if ($Agent -ne 'all' -and $Model) {
  [Environment]::SetEnvironmentVariable($modelVariable, $Model, 'User')
  Write-Host "$modelVariable = $Model"
}
if ($Tier -eq 'inherit') {
  [Environment]::SetEnvironmentVariable($tierVariable, $null, 'User')
  Write-Host "$tierVariable cleared; worker uses its built-in tier preset, or global/project tier for original workers."
} else {
  [Environment]::SetEnvironmentVariable($tierVariable, $Tier, 'User')
  Write-Host "$tierVariable = $Tier"
}
if ($Tier -eq 'flex' -and $Agent -eq 'all') {
  Write-Warning 'Global Flex applies to original workers unless overridden. GPT-6.2 Sol/Astra do not support Flex; new named presets retain their own default tiers.'
}
Write-Host 'Restart your terminal and Claude Code to apply user-level settings. Run /oai to inspect them.'
