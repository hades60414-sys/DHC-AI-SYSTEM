param(
    [Parameter(Mandatory=$true)][ValidateSet('prepare','build','pair','submit','receive','status','publish-release','publish-inbox')][string]$Command,
    [string]$File,
    [string]$Fingerprint,
    [ValidateSet('health','model-info','gemma-smoke','reason','reason-json','fixture-roundtrip','fixture-break','stop')][string]$Action,
    [string]$PromptFile,
    [string]$AssetsDirectory = 'C:\Users\demo\.cloudcli\assets'
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($Command -in @('prepare','build')) { & (Join-Path $PSScriptRoot 'Build.ps1'); exit $LASTEXITCODE }
$releaseDir = Join-Path $PSScriptRoot 'release'
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
    'publish-inbox' { $pending = Join-Path $stateDir 'pending-inbox.cms.b64.txt'; Invoke-Channel @('export-inbox',$stateDir,$pending); Publish-File $pending 'dbclone-agent-v1-inbox.cms.b64.txt'; Write-Host 'Encrypted inbox published; execution/acceptance is not yet verified.' }
    'publish-release' {
        $manifest = Get-Content -LiteralPath (Join-Path $releaseDir 'manifest.json') -Raw | ConvertFrom-Json
        $allowed = @('dbclone-agent-v1.exe.b64.txt','dbclone-agent-v1-setup.ps1.txt','dbclone-agent-v1-bootstrap.cmd.txt')
        if ($manifest.Count -ne 3) { throw 'Invalid release manifest.' }
        foreach ($entry in $manifest) { if ($entry.name -notin $allowed) { throw 'Unexpected release artifact.' }; $artifact = Join-Path $releaseDir $entry.name; if ((Get-FileHash -LiteralPath $artifact -Algorithm SHA256).Hash -ne $entry.sha256) { throw "Release hash mismatch: $($entry.name)" } }
        foreach ($entry in $manifest) { Publish-File (Join-Path $releaseDir $entry.name) $entry.name }
        Write-Host 'Published only executable, setup and bootstrap. No inbox/job was submitted.'
    }
}
