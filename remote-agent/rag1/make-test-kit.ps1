param([Parameter(Mandatory=$true)][string]$Version, [ValidateSet('rag1','rag1r','pcmgr','pcmain','userD','userF','userB','userC','userE','userA')][string]$Config = 'rag1r', [string]$AssetName)
$ErrorActionPreference = 'Stop'
# Rehearsal helper: build srcD with a temporary AgentVersion, pack the kit, optionally publish the raw zip, then restore the version.
$j = $PSScriptRoot; $file = Join-Path $j 'srcD\Channel.cs'
$orig = [IO.File]::ReadAllText($file)
$m = [regex]::Match($orig, 'AgentVersion = "([^"]+)"'); if (-not $m.Success) { throw 'AgentVersion not found' }
try {
    [IO.File]::WriteAllText($file, $orig.Replace($m.Value, "AgentVersion = `"$Version`""), [Text.UTF8Encoding]::new($false))
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $j 'Build-RAG1D.ps1') -Config $Config | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'build failed' }
    Push-Location $j; try { $p = node pack-rag1.cjs $Config "release-rag1d-$Config" | ConvertFrom-Json } finally { Pop-Location }
    if ($AssetName) { Copy-Item $p.zip (Join-Path $env:USERPROFILE ".cloudcli\assets\$AssetName") -Force }
    [pscustomobject]@{ version = $Version; zip = $p.zip; sha256 = $p.zip_sha256; asset = $AssetName } | ConvertTo-Json -Compress
} finally { [IO.File]::WriteAllText($file, $orig, [Text.UTF8Encoding]::new($false)) }
