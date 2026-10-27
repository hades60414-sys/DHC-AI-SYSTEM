$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$fixture = Join-Path $PSScriptRoot 'test-work\publish-assets'
New-Item -ItemType Directory -Force -Path $fixture | Out-Null
foreach ($attempt in 1..2) {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'Controller.ps1') -Command publish-release -AssetsDirectory $fixture
    if ($LASTEXITCODE -ne 0) { throw 'Initial or repeated publication failed.' }
}
$manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'release\manifest.json') -Raw | ConvertFrom-Json
foreach ($entry in $manifest) {
    $actual = (Get-FileHash -LiteralPath (Join-Path $fixture $entry.name) -Algorithm SHA256).Hash
    if ($actual -ne $entry.sha256) { throw "Publication hash mismatch: $($entry.name)" }
}
Write-Host 'PUBLISH_REPLACE_REGRESSION_PASS: initial and repeat publication under Windows PowerShell 5.1; all manifest hashes match.'
