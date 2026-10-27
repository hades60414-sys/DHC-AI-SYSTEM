# ASCII-only: Windows PowerShell 5.1 safe.
# Backward-compatible Claude-only entry point. The shared sync engine is authoritative.
param(
    [switch]$SkipSkills
)

$ErrorActionPreference = "Stop"
$sync = Join-Path $PSScriptRoot "sync-harness.ps1"
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $sync -Target Claude -SkipSkills:$SkipSkills
exit $LASTEXITCODE
