param(
    [Parameter(Mandatory=$true)][ValidateSet('init','pair','submit','receive','status','publish-inbox','heartbeat')][string]$Command,
    [ValidateSet('rag1','rag1r','pcmgr','pcmain','userD','userF','userB','userC','userE','userA')][string]$Config = 'rag1',
    [string]$File,
    [string]$Fingerprint,
    [ValidateSet('health','model-info','gemma-smoke','reason','reason-json','fixture-roundtrip','fixture-break','file-info','list-dir','file-hash','doc-qa','doc-retrieve','doc-index','doc-list','doc-export','self-update','cmd-run','stop')][string]$Action,
    [string]$ReleaseDir,
    [string]$PromptFile,
    [string]$AssetsDirectory = 'C:\Users\demo\.cloudcli\assets'
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
# RAG1 controller (2026-10-01): same commands as Controller-V31.ps1, but its own release-<Config>\ executable,
# controller-state-<Config>\ journal and inbox asset name. 'init' creates the controller journal once (before pairing).
$releaseDir = if ($ReleaseDir) { Join-Path $PSScriptRoot $ReleaseDir } else { Join-Path $PSScriptRoot "release-$Config" }
$stateDir = Join-Path $PSScriptRoot "controller-state-$Config"
$channelExe = Join-Path $releaseDir 'dbclone-agent-v1.exe'
$inboxName = "$Config-agent-inbox.cms.b64.txt"
function Invoke-Channel([string[]]$Arguments) { & $channelExe @Arguments; if ($LASTEXITCODE -ne 0) { throw "Channel operation failed: $($Arguments[0])" } }
function Publish-File([string]$Source,[string]$Name) {
    if (-not (Test-Path -LiteralPath $AssetsDirectory -PathType Container)) { throw 'Existing CloudCLI assets directory required.' }
    $destination = Join-Path $AssetsDirectory $Name
    $temporary = $destination + '.tmp'
    Copy-Item -LiteralPath $Source -Destination $temporary -Force
    if (Test-Path -LiteralPath $destination) { [IO.File]::Replace($temporary,$destination,[System.Management.Automation.Language.NullString]::Value) } else { [IO.File]::Move($temporary,$destination) }
}
switch ($Command) {
    'init' { Invoke-Channel @('controller-init',$stateDir) }
    'pair' { if (-not $File -or -not $Fingerprint) { throw 'Pair requires encrypted enrollment -File and console -Fingerprint.' }; Invoke-Channel @('pair',$stateDir,$File,$Fingerprint) }
    'submit' { if (-not $Action) { throw 'Submit requires -Action.' }; $commandArgs = @('submit',$stateDir,$Action); if ($PromptFile) { $commandArgs += $PromptFile }; Invoke-Channel $commandArgs }
    'receive' { if (-not $File) { throw 'Receive requires the encrypted report -File.' }; Invoke-Channel @('receive',$stateDir,$File) }
    'status' { Invoke-Channel @('status',$stateDir) }
    'heartbeat' { if (-not $File) { throw 'Heartbeat requires the encrypted heartbeat -File.' }; Invoke-Channel @('heartbeat',$stateDir,$File) }
    'publish-inbox' { $pending = Join-Path $stateDir 'pending-inbox.cms.b64.txt'; Invoke-Channel @('export-inbox',$stateDir,$pending); Publish-File $pending $inboxName; Write-Host 'Encrypted inbox published; execution/acceptance is not yet verified.' }
}
