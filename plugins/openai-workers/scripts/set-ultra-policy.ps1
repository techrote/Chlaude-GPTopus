param(
    [ValidateSet('show', 'init', 'validate', 'set', 'project-add')][string]$Command = 'show',
    [string]$Field,
    [string]$Value,
    [string]$Surface
)
$ErrorActionPreference = 'Stop'
$entry = Join-Path $PSScriptRoot '..\ultra\cli.mjs'
$arguments = @($entry, $Command)
if ($Field) { $arguments += $Field }
if ($Value) { $arguments += $Value }
if ($Surface) { $arguments += @('--surface', $Surface) }
& node @arguments
if ($LASTEXITCODE -ne 0) { throw "ULTRA configuration command failed ($LASTEXITCODE)." }
