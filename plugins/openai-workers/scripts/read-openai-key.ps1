# Called by the Node bridge. Decrypt a Windows DPAPI key without logging it.
param([ValidateSet('standard', 'free', 'nvidia')][string]$Profile = 'standard')
$ErrorActionPreference = 'Stop'
if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA unavailable' }
$file = if ($Profile -eq 'free') { 'openai-free-key.dpapi' } elseif ($Profile -eq 'nvidia') { 'nvidia-key.dpapi' } else { 'openai-key.dpapi' }
$path = Join-Path (Join-Path $env:LOCALAPPDATA 'ClaudeOpenAIWorkers') $file
if (-not (Test-Path -LiteralPath $path)) { throw "Missing $Profile DPAPI key. Run set-openai-key.ps1 -Profile $Profile." }
$secure = (Get-Content -LiteralPath $path -Raw).Trim() | ConvertTo-SecureString
$ptr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  [Console]::Out.Write([System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr))
} finally {
  [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
}
