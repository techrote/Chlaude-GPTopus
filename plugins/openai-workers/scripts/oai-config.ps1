# Open the local OAI configuration panel (127.0.0.1, random port, per-launch token).
# Values are written to your Windows USER environment; restart Claude Code to apply them.
# Examples:
#   .\oai-config.ps1                  # start and open the browser
#   .\oai-config.ps1 -NoOpen          # print the URL only
#   .\oai-config.ps1 -IdleMinutes 60
param(
  [switch]$NoOpen,
  [int]$IdleMinutes = 30
)
$ErrorActionPreference = 'Stop'
$arguments = @((Join-Path $PSScriptRoot 'oai-config.mjs'), '--idle-minutes', $IdleMinutes)
if ($NoOpen) { $arguments += '--no-open' }
& node @arguments
exit $LASTEXITCODE
