# Follow the OAI live trace of OpenAI traffic (enable with: setx OAI_TRACE 1, then restart Claude Code).
# Examples:
#   .\oai-trace.ps1                 # follow new records live
#   .\oai-trace.ps1 -All            # print today's history, then follow
#   .\oai-trace.ps1 -Date 2026-11-22 -NoFollow
param(
  [switch]$All,
  [string]$Date,
  [switch]$Full,
  [switch]$NoFollow,
  [switch]$NoColor
)
$ErrorActionPreference = 'Stop'
$arguments = @(Join-Path $PSScriptRoot 'oai-trace.mjs')
if ($All) { $arguments += '--all' }
if ($Date) { $arguments += @('--date', $Date) }
if ($Full) { $arguments += '--full' }
if ($NoFollow) { $arguments += '--no-follow' }
if ($NoColor) { $arguments += '--no-color' }
& node @arguments
exit $LASTEXITCODE
