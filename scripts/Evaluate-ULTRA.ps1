#requires -Version 5.1
<#
.SYNOPSIS
Runs the deterministic ULTRA-001 owner evaluator without API keys or live projects.
.EXAMPLE
.\scripts\Evaluate-ULTRA.ps1
.EXAMPLE
.\scripts\Evaluate-ULTRA.ps1 -NonInteractive -OutputDirectory C:\Temp\ULTRA-Report
#>
[CmdletBinding()]
param(
    [string]$OutputDirectory,
    [ValidatePattern('^[a-fA-F0-9]{40}$')]
    [string]$ExpectedSha,
    [switch]$NonInteractive
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

try {
    $nodeCommand = Get-Command node -ErrorAction Stop
} catch {
    [Console]::Error.WriteLine('Node.js was not found. Install Node.js 20.11 or newer from the official Node.js distribution, then reopen PowerShell. This evaluator does not download or install software.')
    exit 2
}

try {
    $nodeInfoText = & $nodeCommand.Source -p 'JSON.stringify({version:process.versions.node,platform:process.platform,arch:process.arch})'
    if ($LASTEXITCODE -ne 0) { throw 'Node version check failed.' }
    $nodeInfo = $nodeInfoText | ConvertFrom-Json
    $version = [Version]$nodeInfo.version
    if ($version -lt [Version]'20.11.0') { throw 'Node.js 20.11 or newer is required.' }
    if ($nodeInfo.platform -ne 'win32') {
        throw 'This PowerShell evaluator expects native Windows Node.js. For WSL/Linux use node scripts/ultra-evaluate.mjs in that environment.'
    }
    $repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
    $evaluator = Join-Path $PSScriptRoot 'ultra-evaluate.mjs'
    if (-not (Test-Path -LiteralPath $evaluator -PathType Leaf)) { throw 'The evaluator source is missing. Extract or clone the complete ULTRA candidate.' }
    if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
        $suffix = (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
        $OutputDirectory = Join-Path ([IO.Path]::GetTempPath()) ('ULTRA-Acceptance-' + $suffix)
    }
    $OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
    if (Test-Path -LiteralPath (Join-Path $OutputDirectory 'report.json')) { throw 'The report directory already contains report.json. Choose a new directory to preserve earlier evidence.' }

    Write-Host ''
    Write-Host 'ULTRA-001 - deterministic offline owner acceptance'
    Write-Host ('Node: ' + $nodeInfo.version + ' (' + $nodeInfo.arch + ')')
    Write-Host ('Candidate: ' + $repository)
    Write-Host ('Report: ' + $OutputDirectory)
    Write-Host 'No API keys are required. No network, live project editing, deployment, merge or user-file cleanup is performed.'
    Write-Host 'Model calls and authority votes are synthetic test fixtures. Desktop UI and live API acceptance remain separate.'
    Write-Host ''

    $arguments = @($evaluator, '--output', $OutputDirectory)
    if (-not [string]::IsNullOrWhiteSpace($ExpectedSha)) { $arguments += @('--expect-sha', $ExpectedSha.ToLowerInvariant()) }
    & $nodeCommand.Source @arguments
    $evaluationExit = $LASTEXITCODE
    $reportPath = Join-Path $OutputDirectory 'report.json'
    if (-not (Test-Path -LiteralPath $reportPath -PathType Leaf)) { throw 'No complete acceptance report was produced.' }
    $report = Get-Content -LiteralPath $reportPath -Raw | ConvertFrom-Json
    Write-Host ''
    Write-Host ('Offline result: ' + $report.status)
    Write-Host ('Summary: ' + (Join-Path $OutputDirectory 'summary.txt'))
    Write-Host 'Review report.json for source identity, activity.jsonl for the decision trace, and budgets.json for fixture usage.'

    if (-not $NonInteractive) {
        function Read-Result([string]$Question) {
            while ($true) {
                $answer = (Read-Host ($Question + ' [P=PASS, F=FAIL, S=not run; Enter=S]')).Trim().ToUpperInvariant()
                if ($answer -eq 'P') { return 'PASS' }
                if ($answer -eq 'F') { return 'FAIL' }
                if (($answer -eq 'S') -or ($answer -eq '')) { return 'NOT RUN' }
                Write-Host 'Enter P, F or S.'
            }
        }
        $responses = [ordered]@{
            offlineReportReviewed = (Read-Result 'Did you inspect the six offline scenario results and source identity?')
            activityAndBudgetsReviewed = (Read-Result 'Did the activity tree, protected Review capacity and budget trace match the expected behavior?')
            windowsDesktopChatThinkOnly = (Read-Result 'Have you separately tested this exact MCPB in the actual Windows Claude Desktop Chat UI in think-only mode?')
            windowsDesktopReadOnly = (Read-Result 'Have you separately tested the actual Desktop read-only profile and rejected out-of-scope source access?')
            windowsDesktopCode = (Read-Result 'Have you separately tested native Claude Code/Desktop Code integration on this exact source?')
        }
        $ownerRecord = [ordered]@{
            programme = 'ULTRA-001'
            recordedAtUtc = [DateTime]::UtcNow.ToString('o')
            source = $report.source
            offlineStatus = $report.status
            answers = $responses
            liveApiApprovalGranted = $false
            consequentialExecutionApprovalGranted = $false
            note = 'These observations do not enable live API use, editing, test execution, deployment or merging.'
        }
        $ownerRecord | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $OutputDirectory 'owner-observations.json') -Encoding UTF8
        Write-Host ('Owner observations: ' + (Join-Path $OutputDirectory 'owner-observations.json'))
    }
    if ($evaluationExit -ne 0 -or $report.status -ne 'PASS') {
        Write-Host 'Offline qualification failed. Preserve the report and keep the candidate on HOLD.'
        exit 1
    }
    Write-Host 'Offline qualification passed. Live host, Desktop and API acceptance are still separate gates.'
    exit 0
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 2
}
