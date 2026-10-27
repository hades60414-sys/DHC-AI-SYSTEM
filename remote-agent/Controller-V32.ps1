param(
    [Parameter(Mandatory=$true)][ValidateSet('pair','submit','receive','status','publish-inbox','heartbeat')][string]$Command,
    [string]$File,
    [string]$Fingerprint,
    [ValidateSet('health','model-info','gemma-smoke','reason','reason-json','fixture-roundtrip','fixture-break','file-info','list-dir','file-hash','doc-qa','doc-index','doc-list','sql-ping','sql-tables','sql-columns','sql-select','sql-agg','sql-date-gaps','task-list','file-tail','stop')][string]$Action,
    [string]$PromptFile,
    [string]$AssetsDirectory = 'C:\Users\demo\.cloudcli\assets'
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
# v3.2 controller (2026-10-01): same as Controller-V31.ps1 but uses the release-v32 executable and also allows the read-only sql-* actions.
# Same controller-state as v1-v3.1. Use it once srv-db runs agent v3.2; Controller-V31.ps1 stays unchanged for rollback.
$releaseDir = Join-Path $PSScriptRoot 'release-v32'
$stateDir = Join-Path $PSScriptRoot 'controller-state'
$channelExe = Join-Path $releaseDir 'dbclone-agent-v1.exe'
function Invoke-Channel([string[]]$Arguments) { & $channelExe @Arguments; if ($LASTEXITCODE -ne 0) { throw "Channel operation failed: $($Arguments[0])" } }
function Publish-File([string]$Source,[string]$Name) {
    if (-not (Test-Path -LiteralPath $AssetsDirectory -PathType Container)) { throw 'Existing CloudCLI assets directory required.' }
    $destination = Join-Path $AssetsDirectory $Name
    $temporary = $destination + '.tmp'
    Copy-Item -LiteralPath $Source -Destination $temporary -Force
    if (Test-Path -LiteralPath $destination) { [IO.File]::Replace($temporary,$destination,[System.Management.Automation.Language.NullString]::Value) } else { [IO.File]::Move($temporary,$destination) }
}
switch ($Command) {
    'pair' { if (-not $File -or -not $Fingerprint) { throw 'Pair requires encrypted enrollment -File and VM-console -Fingerprint.' }; Invoke-Channel @('pair',$stateDir,$File,$Fingerprint) }
    'submit' { if (-not $Action) { throw 'Submit requires -Action.' }; $commandArgs = @('submit',$stateDir,$Action); if ($PromptFile) { $commandArgs += $PromptFile }; Invoke-Channel $commandArgs }
    'receive' { if (-not $File) { throw 'Receive requires the encrypted report -File.' }; Invoke-Channel @('receive',$stateDir,$File) }
    'status' { Invoke-Channel @('status',$stateDir) }
    'heartbeat' { if (-not $File) { throw 'Heartbeat requires the encrypted heartbeat -File.' }; Invoke-Channel @('heartbeat',$stateDir,$File) }
    'publish-inbox' { $pending = Join-Path $stateDir 'pending-inbox.cms.b64.txt'; Invoke-Channel @('export-inbox',$stateDir,$pending); Publish-File $pending 'dbclone-agent-v1-inbox.cms.b64.txt'; Write-Host 'Encrypted inbox published; execution/acceptance is not yet verified.' }
}
