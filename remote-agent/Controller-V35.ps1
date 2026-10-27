param(
    [Parameter(Mandatory=$true)][ValidateSet('pair','submit','receive','status','publish-inbox','heartbeat','sb-pack')][string]$Command,
    [string]$File,
    [string]$Fingerprint,
    [ValidateSet('health','model-info','gemma-smoke','reason','reason-json','fixture-roundtrip','fixture-break','file-info','list-dir','file-hash','doc-qa','doc-index','doc-list','sql-ping','sql-tables','sql-columns','sql-select','sql-agg','sql-date-gaps','task-list','file-tail','sql-fingerprint','sb-list','sb-fetch','sb-load','sb-backup','sb-restore','sb-drop','self-update','cmd-run','stop')][string]$Action,
    [string]$PromptFile,
    [string]$Package,
    [string]$OutDir,
    [string]$AssetsDirectory = 'C:\Users\demo\.cloudcli\assets'
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
# v3.5 controller (2026-10-05): Controller-V34.ps1 plus cmd-run. v3.4 notes: Controller-V33.ps1 plus self-update. v3.3 notes: Controller-V32.ps1 plus sql-fingerprint, the sandbox sb-* actions and sb-pack (encrypt a
# package zip into chunks for the srv-db device and write the signed manifest to -OutDir). Same controller-state.
$releaseDir = Join-Path $PSScriptRoot 'release-v35'
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
    'sb-pack' { if (-not $File -or -not $Package -or -not $OutDir) { throw 'sb-pack requires -File <zip> -Package <name> -OutDir <folder>.' }; Invoke-Channel @('sb-pack',$stateDir,$File,$Package,$OutDir) }
    'publish-inbox' { $pending = Join-Path $stateDir 'pending-inbox.cms.b64.txt'; Invoke-Channel @('export-inbox',$stateDir,$pending); Publish-File $pending 'dbclone-agent-v1-inbox.cms.b64.txt'; Write-Host 'Encrypted inbox published; execution/acceptance is not yet verified.' }
}
