# Configure best-effort local UTC quota guardrails for the FREE key and an informational credit figure.
# These do not modify OpenAI billing, opt-in to data sharing, or cap actual API charges.
# Example: .\set-daily-budgets.ps1 -OverrunPercent 10 -MonthlyAllowanceUsd 88
param(
  [ValidateRange(1,100000000)] [int]$AstraDailyTokens = 250000,
  [ValidateRange(1,100000000)] [int]$TerraDailyTokens = 2500000,
  [ValidateRange(0,100)] [int]$OverrunPercent = 10,
  [ValidateRange(0,100000)] [int]$ReserveTokens = 12000,
  [ValidateRange(1,128)] [int]$MaxInFlight = 16,
  [ValidateRange(0,10000)] [decimal]$MonthlyAllowanceUsd = 88
)
$ErrorActionPreference = 'Stop'
$settings = @{
  'OPENAI_WORKER_PREMIUM_DAILY_TOKENS' = [string]$AstraDailyTokens
  'OPENAI_WORKER_TERRA_DAILY_TOKENS' = [string]$TerraDailyTokens
  'OPENAI_WORKER_DAILY_OVERRUN_PERCENT' = [string]$OverrunPercent
  'OPENAI_WORKER_DAILY_RESERVE_TOKENS' = [string]$ReserveTokens
  'OPENAI_WORKER_DAILY_MAX_INFLIGHT' = [string]$MaxInFlight
}
if ($MonthlyAllowanceUsd -gt 0) {
  $settings['OPENAI_WORKER_MONTHLY_ALLOWANCE_USD'] = $MonthlyAllowanceUsd.ToString('0.##', [Globalization.CultureInfo]::InvariantCulture)
}
foreach ($name in $settings.Keys) {
  [Environment]::SetEnvironmentVariable($name, $settings[$name], 'User')
  Write-Host "$name = $($settings[$name])"
}
Write-Warning 'Monthly allowance is informational, not an API billing cap. Only workers on the free key are locally tracked. Tokens from other clients are not visible. Actual complimentary eligibility and charges are determined by OpenAI.'
Write-Host 'Restart Claude Code and its terminal, then run /openai-workers to inspect current UTC usage.'
