# ASCII-only: Windows PowerShell 5.1 safe.
# Undo sync-harness.ps1 -Target Claude without deleting anything:
#   1. move every rule, skill and agent this package installed into ~/.claude/backups/harness-uninstall-<time>/
#   2. put back the files the FIRST sync overwrote (the oldest backups/harness-sync-* folder holds your originals)
# -Check lists what would happen and changes nothing. Hooks and settings.json are not touched here: run  node ops\install-hooks.cjs --remove
param([switch]$Check)

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$manifest = Get-Content -LiteralPath (Join-Path $root "sync-manifest.json") -Raw | ConvertFrom-Json
$claudeDir = Join-Path $env:USERPROFILE ".claude"
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$parking = Join-Path $claudeDir "backups\harness-uninstall-$stamp"

$items = @()
foreach ($rule in $manifest.rules.claude) { $items += $rule.target }
foreach ($name in @($manifest.skills.shared) + @($manifest.skills.claudeOnly)) { $items += "skills\$name" }
foreach ($agent in (Get-ChildItem -LiteralPath (Join-Path $root $manifest.agents.claudeSource) -Filter "*.md" -File)) { $items += "agents\$($agent.Name)" }

$moved = 0
foreach ($rel in $items) {
    $path = Join-Path $claudeDir $rel
    if (-not (Test-Path -LiteralPath $path)) { continue }
    Write-Host "MOVE  $rel"
    if (-not $Check) {
        $dest = Join-Path $parking $rel
        New-Item -ItemType Directory -Force -Path (Split-Path $dest -Parent) | Out-Null
        Move-Item -LiteralPath $path -Destination $dest
    }
    $moved++
}

$first = Get-ChildItem -LiteralPath (Join-Path $claudeDir "backups") -Directory -Filter "harness-sync-*" -ErrorAction SilentlyContinue | Sort-Object Name | Select-Object -First 1
$restored = 0
if ($first) {
    foreach ($rel in $items) {
        $original = Join-Path $first.FullName $rel
        if (-not (Test-Path -LiteralPath $original)) { continue }
        Write-Host "RESTORE  $rel  (from $($first.Name))"
        if (-not $Check) {
            $target = Join-Path $claudeDir $rel
            New-Item -ItemType Directory -Force -Path (Split-Path $target -Parent) | Out-Null
            Copy-Item -LiteralPath $original -Destination $target -Recurse -Force
        }
        $restored++
    }
}

if ($Check) { Write-Host "CHECK only: $moved item(s) would move, $restored original(s) would come back. Nothing changed." }
else { Write-Host "DONE: moved $moved item(s) to $parking ; restored $restored original(s). Open a new Claude Code session." }
