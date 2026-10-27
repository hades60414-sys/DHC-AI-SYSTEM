# Health check: harness files + ~/.claude install + (optional) local Ollama.
# Harness/install problems -> FAIL. Ollama missing -> WARN unless -RequireOllama.
param(
    [switch]$RequireOllama,
    [ValidateSet("All", "Claude", "Codex")][string]$Target = "Claude"
)
$ErrorActionPreference = "Continue"
$ok = $true

Write-Host "== healthcheck =="

# 1) Package files
$root = Split-Path $PSScriptRoot -Parent
foreach ($f in @(
    "rules\AGENTS.md",
    "rules\CLAUDE.md",
    "rules\CLAUDE.local.example.md",
    "rules\MIDOFFICE.md",
    "rules\pstack-models.md",
    "sync-manifest.json",
    "memory\MEMORY.md",
    "templates\BOOTSTRAP_PROMPT.md"
)) {
    $p = Join-Path $root $f
    if (Test-Path $p) { Write-Host "OK file $f" } else { Write-Host "MISS $f"; $ok = $false }
}

$manifest = Get-Content -LiteralPath (Join-Path $root "sync-manifest.json") -Raw | ConvertFrom-Json
foreach ($skillDir in (Get-ChildItem -LiteralPath (Join-Path $root "skills") -Directory -ErrorAction SilentlyContinue)) {
    $skillFile = Join-Path $skillDir.FullName "SKILL.md"
    if (-not (Test-Path -LiteralPath $skillFile -PathType Leaf)) { continue }
    $text = Get-Content -LiteralPath $skillFile -Raw
    if ($text -notmatch "(?m)^name:\s+$([regex]::Escape($skillDir.Name))\s*$") {
        Write-Host "FAIL: skill frontmatter name mismatch: $($skillDir.Name)"
        $ok = $false
    }
}

# The shared sync engine is the authoritative cross-host drift check.
$syncScript = Join-Path $root "ops\sync-harness.ps1"
if (Test-Path -LiteralPath $syncScript) {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $syncScript -Target $Target -Check
    if ($LASTEXITCODE -ne 0) {
        Write-Host "FAIL: Claude/Codex harness drift detected - run .\ops\sync-harness.ps1 -Target $Target"
        $ok = $false
    }
} else {
    Write-Host "FAIL: ops/sync-harness.ps1 missing"
    $ok = $false
}

# 2) ~/.claude install state (Claude Code auto-loads these)
$claudeDir = Join-Path $env:USERPROFILE ".claude"
if (Test-Path (Join-Path $claudeDir "CLAUDE.md")) {
    Write-Host "OK installed ~/.claude/CLAUDE.md"
    foreach ($imp in @("AGENTS.md", "MIDOFFICE.md", "pstack-models.md")) {
        if (-not (Test-Path (Join-Path $claudeDir $imp))) {
            Write-Host "FAIL: ~/.claude/$imp missing - re-run install-harness.ps1"
            $ok = $false
        }
    }
} else {
    Write-Host "FAIL: not installed to ~/.claude - run .\ops\install-harness.ps1"
    $ok = $false
}
# Installed counts must cover active managed items, not archived source skills.
$expectedClaudeSkills = @(@($manifest.skills.shared) + @($manifest.skills.claudeOnly) | Sort-Object -Unique)
$pkgSkills = $expectedClaudeSkills.Count
$pkgAgents = @(Get-ChildItem (Join-Path $root "agents") -Filter "*.md" -ErrorAction SilentlyContinue).Count
$skillCount = @($expectedClaudeSkills | Where-Object { Test-Path -LiteralPath (Join-Path $claudeDir "skills\$_") -PathType Container }).Count
$agentCount = 0
if (Test-Path (Join-Path $claudeDir "agents")) {
    $agentCount = @(Get-ChildItem (Join-Path $claudeDir "agents") -Filter "*.md" -ErrorAction SilentlyContinue).Count
}
if ($skillCount -ne $pkgSkills) { Write-Host "FAIL: managed Claude skills installed $skillCount != expected $pkgSkills - re-run install-harness.ps1"; $ok = $false }
else { Write-Host "OK managed Claude skills installed: $skillCount" }
if ($agentCount -lt $pkgAgents) { Write-Host "FAIL: agents installed $agentCount < package $pkgAgents - re-run install-harness.ps1"; $ok = $false }
else { Write-Host "OK agents installed: $agentCount (package: $pkgAgents)" }

# Installed Codex PM bridge must resolve the real desktop CLI and its routing contract without network access.
$codexBridge = Join-Path $claudeDir "skills\codex-bridge\scripts\run_codex_subagent.ps1"
if ($Target -eq "Claude") {
    Write-Host "SKIP Codex PM bridge (Claude-only install; use -Target All to check Codex)"
} elseif (Test-Path -LiteralPath $codexBridge) {
    $bridgeResult = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $codexBridge -Role pm -Prompt "healthcheck" -Cwd $root -ResolveOnly 2>&1
    $bridgeText = $bridgeResult -join "`n"
    if ($LASTEXITCODE -eq 0 -and $bridgeText -match '"status":"ready"' -and
        $bridgeText -match '"model":"gpt-5\.6-sol"' -and $bridgeText -match '"effort":"high"' -and
        $bridgeText -match '"sandbox":"read-only"') {
        Write-Host "OK Codex PM bridge: gpt-5.6-sol/high/read-only"
    } else {
        Write-Host "FAIL: Codex PM bridge contract failed: $bridgeText"
        $ok = $false
    }
} else {
    Write-Host "FAIL: installed Codex bridge missing - re-run install-harness.ps1"
    $ok = $false
}

# 3) Local Ollama (optional backend)
$ollamaUp = $false
try {
    $tags = Invoke-RestMethod -Uri "http://127.0.0.1:11434/api/tags" -TimeoutSec 8
    $names = @($tags.models | ForEach-Object { $_.name })
    $ollamaUp = $true
    Write-Host "OLLAMA_UP models=$($names -join ', ')"
    if ($names.Count -eq 0) {
        Write-Host "WARN: no models pulled yet - run setup-ollama.ps1"
        if ($RequireOllama) { $ok = $false }
    }
} catch {
    Write-Host "$(if ($RequireOllama) {'FAIL'} else {'INFO'}): Ollama not reachable on 127.0.0.1:11434 (run setup-ollama.ps1 if this machine should serve local models)"
    if ($RequireOllama) { $ok = $false }
}

# 4) Refuse obvious public bind (process, user, machine scope)
$hostEnv = $env:OLLAMA_HOST
if (-not $hostEnv) { $hostEnv = [Environment]::GetEnvironmentVariable("OLLAMA_HOST", "User") }
if (-not $hostEnv) { $hostEnv = [Environment]::GetEnvironmentVariable("OLLAMA_HOST", "Machine") }
if ($hostEnv -and $hostEnv -match "0\.0\.0\.0") {
    Write-Host "WARN: OLLAMA_HOST=$hostEnv  (public bind - use Tailscale/Tunnel + auth instead)"
}

if ($ok) {
    Write-Host "RESULT: OK"
    exit 0
} else {
    Write-Host "RESULT: FAIL"
    exit 1
}
