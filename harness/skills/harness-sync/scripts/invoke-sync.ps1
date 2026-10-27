param(
    [ValidateSet("All", "Claude", "Codex")]
    [string]$Target = "All",
    [switch]$Check,
    [switch]$SkipSkills
)

$ErrorActionPreference = "Stop"
$homeDir = $env:USERPROFILE
if (-not $homeDir) { throw "USERPROFILE is not set" }
$pointer = Join-Path $homeDir ".agent-harness\source.txt"
if (-not (Test-Path -LiteralPath $pointer)) {
    throw "Harness source pointer missing: $pointer. Run ops\sync-harness.ps1 once from the source package."
}
$root = (Get-Content -LiteralPath $pointer -Raw).Trim()
$sync = Join-Path $root "ops\sync-harness.ps1"
if (-not (Test-Path -LiteralPath $sync)) { throw "Harness sync script missing: $sync" }

$arguments = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $sync, "-Target", $Target)
if ($Check) { $arguments += "-Check" }
if ($SkipSkills) { $arguments += "-SkipSkills" }

& powershell.exe @arguments
exit $LASTEXITCODE
