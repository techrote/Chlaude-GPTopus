# Owner-only reconciliation of the LOCAL usage ledger after a v1 -> v2 upgrade.
# Run in an interactive PowerShell window; it cannot be driven by a tool, pipe or environment variable.
# Examples:
#   .\reconcile-usage.ps1 -Command status
#   .\reconcile-usage.ps1 -Command reconcile -Month 2026-11 -Usd 12.34 -Source 'OpenAI billing dashboard'
# The amounts are the authoritative month-to-date USD you read from OpenAI. This never changes OpenAI billing.
param(
  [ValidateSet('status', 'reconcile', 'help')] [string]$Command = 'status',
  [string[]]$Month,
  [string[]]$Usd,
  [string]$Source,
  [string]$AsOf
)
$ErrorActionPreference = 'Stop'
$node = Get-Command node -ErrorAction Stop
$arguments = @((Join-Path $PSScriptRoot 'reconcile-usage.mjs'), $Command)
if ($Command -eq 'reconcile') {
  if (-not $Month -or -not $Usd -or $Month.Count -ne $Usd.Count) { throw 'Provide each -Month with its -Usd amount (same count).' }
  if (-not $Source) { throw 'Provide -Source, for example ''OpenAI billing dashboard''.' }
  for ($i = 0; $i -lt $Month.Count; $i++) { $arguments += @('--month', $Month[$i], '--usd', $Usd[$i]) }
  $arguments += @('--source', $Source)
  if ($AsOf) { $arguments += @('--as-of', $AsOf) }
}
& $node.Source @arguments
exit $LASTEXITCODE
