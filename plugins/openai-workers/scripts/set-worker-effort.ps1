# Configure one OpenAI worker's API reasoning-effort range (not host Ultra mode).
# Examples:
#   .\set-worker-effort.ps1 -Agent luna -Min max -Max max
#   .\set-worker-effort.ps1 -Agent daily-terrafree -Min high -Max max -Default xhigh -Note 'High for routine work; max for difficult debugging.'
#   .\set-worker-effort.ps1 -Agent luna -Show
param(
  [Parameter(Mandatory=$true)]
  [ValidateSet('sol', 'astra', 'luna', 'flex6-1', 'daily-astrafree', 'daily-terrafree')]
  [string]$Agent,
  [ValidateSet('none', 'low', 'medium', 'high', 'xhigh', 'max')]
  [string]$Min,
  [ValidateSet('none', 'low', 'medium', 'high', 'xhigh', 'max')]
  [string]$Max,
  [ValidateSet('none', 'low', 'medium', 'high', 'xhigh', 'max')]
  [string]$Default,
  [string]$Note,
  [switch]$Show,
  [switch]$Reset
)
$ErrorActionPreference = 'Stop'
$prefix = 'OPENAI_WORKER_' + ($Agent.ToUpperInvariant() -replace '[^A-Z0-9]', '_') + '_EFFORT_'
$levels = @('none', 'low', 'medium', 'high', 'xhigh', 'max')
$presets = @{
  'sol' = @('medium', 'max', 'high')
  'astra' = @('medium', 'max', 'high')
  'luna' = @('max', 'max', 'max')
  'flex6-1' = @('medium', 'max', 'high')
  'daily-astrafree' = @('medium', 'max', 'high')
  'daily-terrafree' = @('high', 'max', 'high')
}
if ($Reset -and ($PSBoundParameters.ContainsKey('Min') -or $PSBoundParameters.ContainsKey('Max') -or $PSBoundParameters.ContainsKey('Default') -or $PSBoundParameters.ContainsKey('Note'))) {
  throw 'Use -Reset alone (or with -Show), not with new settings.'
}
if ($Note -and $Note.Length -gt 240) { throw 'The guidance note must be 240 characters or fewer.' }
if ($Reset) {
  foreach ($field in @('MIN','MAX','DEFAULT','NOTE')) {
    [Environment]::SetEnvironmentVariable($prefix + $field, $null, 'User')
  }
  Write-Host "Cleared user effort overrides for $Agent. Built-in policy will apply after restart."
  return
}
$updates = @{}
foreach ($field in @('Min','Max','Default','Note')) {
  if ($PSBoundParameters.ContainsKey($field)) { $updates[$field.ToUpperInvariant()] = (Get-Variable $field -ValueOnly) }
}
function CurrentValue([string]$field, [string]$fallback) {
  if ($updates.ContainsKey($field)) { return [string]$updates[$field] }
  $value = [Environment]::GetEnvironmentVariable($prefix + $field, 'User')
  if ($value) { return $value.ToLowerInvariant() }
  return $fallback
}
$preset = $presets[$Agent]
$minEffort = CurrentValue 'MIN' $preset[0]
$maxEffort = CurrentValue 'MAX' $preset[1]
$defaultEffort = CurrentValue 'DEFAULT' $preset[2]
if ([array]::IndexOf($levels, $minEffort) -lt 0 -or [array]::IndexOf($levels, $maxEffort) -lt 0 -or [array]::IndexOf($levels, $defaultEffort) -lt 0) {
  throw 'Saved policy contains an invalid effort. Use -Reset to recover after inspecting it.'
}
if ([array]::IndexOf($levels, $minEffort) -gt [array]::IndexOf($levels, $maxEffort)) { throw 'Minimum effort exceeds maximum effort.' }
if ($updates.ContainsKey('DEFAULT') -or [Environment]::GetEnvironmentVariable($prefix + 'DEFAULT','User')) {
  if ([array]::IndexOf($levels, $defaultEffort) -lt [array]::IndexOf($levels, $minEffort) -or [array]::IndexOf($levels, $defaultEffort) -gt [array]::IndexOf($levels, $maxEffort)) {
    throw 'The explicitly configured default must fall within the selected effort range.'
  }
} else {
  $defaultEffort = $levels[[Math]::Min([array]::IndexOf($levels, $maxEffort), [Math]::Max([array]::IndexOf($levels, $minEffort), [array]::IndexOf($levels, $defaultEffort)))]
}
if ($updates.Count -eq 0 -and -not $Show) { $Show = $true }
foreach ($item in $updates.GetEnumerator()) {
  $value = [string]$item.Value
  if (-not $value.Trim()) { $value = $null }
  [Environment]::SetEnvironmentVariable($prefix + $item.Key, $value, 'User')
}
Write-Host "$Agent reasoning effort: $minEffort .. $maxEffort (default $defaultEffort)"
$storedNote = if ($updates.ContainsKey('NOTE')) { $updates['NOTE'] } else { [Environment]::GetEnvironmentVariable($prefix + 'NOTE','User') }
if (-not $storedNote) {
  $notes = @{
    'sol' = 'Medium for bounded coding; high for multi-file work; xhigh/max for difficult debugging or verification.'
    'astra' = 'Medium for clear reviews; high for architecture; xhigh/max for critical or ambiguous decisions.'
    'luna' = 'Always Max. Give Luna well-scoped, economical tasks; expect slower completion than lower efforts.'
    'flex6-1' = 'Medium for routine refactors; high for multi-step tasks; xhigh/max for hard, time-insensitive work.'
    'daily-astrafree' = 'Medium for bounded research; high for independent reviews; xhigh/max for demanding investigations.'
    'daily-terrafree' = 'High for everyday inspection; xhigh for multi-file reasoning; max for intricate recovery or audits.'
  }
  $storedNote = $notes[$Agent]
}
Write-Host "Selection note: $storedNote
if ($updates.Count) { Write-Host 'Restart Claude Code / Claude Desktop to load new user environment settings.' }
