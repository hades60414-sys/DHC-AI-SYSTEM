# ASCII-only: Windows PowerShell 5.1 safe.
# Sync one harness source into Claude Code and Codex with backups and drift checks.
param(
    [ValidateSet("All", "Claude", "Codex")]
    [string]$Target = "All",
    [switch]$Check,
    [switch]$SkipSkills
)

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$manifestPath = Join-Path $root "sync-manifest.json"
if (-not (Test-Path -LiteralPath $manifestPath)) { throw "Missing manifest: $manifestPath" }
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json

$homeDir = $env:USERPROFILE
if (-not $homeDir) { throw "USERPROFILE is not set" }
$claudeDir = Join-Path $homeDir ".claude"
$claudeSkills = Join-Path $claudeDir "skills"
$codexDir = Join-Path $homeDir ".codex"
$codexLegacySkills = Join-Path $codexDir "skills"
$codexModernDir = Join-Path $homeDir ".agents"
$codexModernSkills = Join-Path $codexModernDir "skills"
$pointerDir = Join-Path $homeDir ".agent-harness"
$pointerPath = Join-Path $pointerDir "source.txt"
$managedStatePath = Join-Path $pointerDir "managed-skills.json"
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$script:ok = $true

$previousManaged = [ordered]@{ claude = @(); codex = @() }
if (Test-Path -LiteralPath $managedStatePath -PathType Leaf) {
    $saved = Get-Content -LiteralPath $managedStatePath -Raw | ConvertFrom-Json
    $previousManaged.claude = @($saved.claude)
    $previousManaged.codex = @($saved.codex)
}
$currentClaudeManaged = @(@($manifest.skills.shared) + @($manifest.skills.claudeOnly) | Sort-Object -Unique)
$currentCodexManaged = @(@($manifest.skills.shared) + @($manifest.skills.codexOnly) | Sort-Object -Unique)
$retiredManaged = @($manifest.skills.retired)

function Ensure-Directory([string]$path) {
    if (-not (Test-Path -LiteralPath $path)) {
        New-Item -ItemType Directory -Force -Path $path | Out-Null
    }
}

function Get-NormalPath([string]$path) {
    return [IO.Path]::GetFullPath($path).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
}

function Assert-ChildPath([string]$path, [string]$allowedRoot) {
    $candidate = Get-NormalPath $path
    $allowed = (Get-NormalPath $allowedRoot) + [IO.Path]::DirectorySeparatorChar
    if (-not $candidate.StartsWith($allowed, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing target outside managed root: $candidate (root: $allowedRoot)"
    }
}

function Get-RelativePath([string]$base, [string]$path) {
    $baseFull = (Get-NormalPath $base) + [IO.Path]::DirectorySeparatorChar
    $pathFull = Get-NormalPath $path
    if (-not $pathFull.StartsWith($baseFull, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Cannot make relative path: $pathFull is not under $baseFull"
    }
    return $pathFull.Substring($baseFull.Length)
}

function Test-FileEqual([string]$source, [string]$targetPath) {
    if (-not (Test-Path -LiteralPath $targetPath -PathType Leaf)) { return $false }
    return (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -eq
        (Get-FileHash -LiteralPath $targetPath -Algorithm SHA256).Hash
}

function Get-TreeMap([string]$path) {
    $map = @{}
    if (-not (Test-Path -LiteralPath $path -PathType Container)) { return $map }
    foreach ($file in (Get-ChildItem -LiteralPath $path -Recurse -File | Sort-Object FullName)) {
        $relative = Get-RelativePath $path $file.FullName
        $map[$relative] = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
    }
    return $map
}

function Test-TreeEqual([string]$source, [string]$targetPath) {
    if (-not (Test-Path -LiteralPath $targetPath -PathType Container)) { return $false }
    $left = Get-TreeMap $source
    $right = Get-TreeMap $targetPath
    if ($left.Count -ne $right.Count) { return $false }
    foreach ($key in $left.Keys) {
        if (-not $right.ContainsKey($key) -or $right[$key] -ne $left[$key]) { return $false }
    }
    return $true
}

function Backup-Path([string]$path, [string]$managedRoot, [string]$backupRoot) {
    if (-not (Test-Path -LiteralPath $path)) { return }
    $relative = Get-RelativePath $managedRoot $path
    $destination = Join-Path $backupRoot $relative
    Ensure-Directory (Split-Path $destination -Parent)
    Copy-Item -LiteralPath $path -Destination $destination -Recurse -Force
    Write-Host "  backup: $path -> $destination"
}

function Sync-File([string]$source, [string]$targetPath, [string]$managedRoot, [string]$backupRoot) {
    if (Test-FileEqual $source $targetPath) {
        Write-Host "OK file: $targetPath"
        return
    }
    if ($Check) {
        Write-Host "DRIFT file: $targetPath"
        $script:ok = $false
        return
    }
    Assert-ChildPath $targetPath $managedRoot
    Backup-Path $targetPath $managedRoot $backupRoot
    Ensure-Directory (Split-Path $targetPath -Parent)
    Copy-Item -LiteralPath $source -Destination $targetPath -Force
    Write-Host "SYNC file: $targetPath"
}

function Sync-Tree([string]$source, [string]$targetPath, [string]$managedRoot, [string]$backupRoot) {
    if (Test-TreeEqual $source $targetPath) {
        Write-Host "OK tree: $targetPath"
        return
    }
    if ($Check) {
        Write-Host "DRIFT tree: $targetPath"
        $script:ok = $false
        return
    }
    Assert-ChildPath $targetPath $managedRoot
    Backup-Path $targetPath $managedRoot $backupRoot
    Ensure-Directory (Split-Path $targetPath -Parent)
    if (Test-Path -LiteralPath $targetPath) {
        Remove-Item -LiteralPath $targetPath -Recurse -Force
    }
    Copy-Item -LiteralPath $source -Destination $targetPath -Recurse
    Write-Host "SYNC tree: $targetPath"
}

function Remove-ManagedTree([string]$targetPath, [string]$managedRoot, [string]$backupRoot, [string]$reason) {
    if (-not (Test-Path -LiteralPath $targetPath)) { return }
    if ($Check) {
        Write-Host "DRIFT $reason`: $targetPath"
        $script:ok = $false
        return
    }
    Assert-ChildPath $targetPath $managedRoot
    Backup-Path $targetPath $managedRoot $backupRoot
    Remove-Item -LiteralPath $targetPath -Recurse -Force
    Write-Host "REMOVE $reason`: $targetPath"
}

function Test-StringSetEqual($left, $right) {
    return @(Compare-Object -ReferenceObject @($left | Sort-Object -Unique) -DifferenceObject @($right | Sort-Object -Unique)).Count -eq 0
}

function Validate-ManifestSkills {
    $sourceSkills = @(Get-ChildItem -LiteralPath (Join-Path $root "skills") -Directory |
        Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName "SKILL.md") } |
        ForEach-Object { $_.Name } | Sort-Object -Unique)
    $declared = @($manifest.skills.shared) + @($manifest.skills.claudeOnly) + @($manifest.skills.codexOnly) + @($manifest.skills.retired)
    $duplicates = @($declared | Group-Object | Where-Object { $_.Count -gt 1 })
    if ($duplicates.Count -gt 0) {
        throw "Duplicate skills in manifest: $($duplicates.Name -join ', ')"
    }
    $delta = @(Compare-Object -ReferenceObject @($sourceSkills) -DifferenceObject @($declared | Sort-Object -Unique))
    if ($delta.Count -gt 0) {
        throw "Manifest does not classify every source skill: $($delta | Out-String)"
    }
}

Validate-ManifestSkills

$doClaude = $Target -eq "All" -or $Target -eq "Claude"
$doCodex = $Target -eq "All" -or $Target -eq "Codex"

if (-not $Check) {
    Ensure-Directory $claudeDir
    Ensure-Directory $codexDir
    Ensure-Directory $codexModernDir
}

if ($doClaude) {
    $backup = Join-Path $claudeDir "backups\harness-sync-$stamp"
    foreach ($rule in $manifest.rules.claude) {
        Sync-File (Join-Path $root $rule.source) (Join-Path $claudeDir $rule.target) $claudeDir $backup
    }
    $localPath = Join-Path $claudeDir "CLAUDE.local.md"
    if (-not (Test-Path -LiteralPath $localPath)) {
        if ($Check) {
            Write-Host "DRIFT file: $localPath"
            $script:ok = $false
        } else {
            Copy-Item -LiteralPath (Join-Path $root "rules\CLAUDE.local.example.md") -Destination $localPath
            Write-Host "INIT local overlay: $localPath"
        }
    } else {
        Write-Host "PRESERVE local overlay: $localPath"
    }

    if (-not $SkipSkills) {
        $staleClaude = @(@($previousManaged.claude) + $retiredManaged |
            Where-Object { $currentClaudeManaged -notcontains $_ } | Sort-Object -Unique)
        foreach ($name in $staleClaude) {
            Remove-ManagedTree (Join-Path $claudeSkills $name) $claudeDir $backup "retired tree"
        }
        foreach ($name in @($manifest.skills.shared) + @($manifest.skills.claudeOnly)) {
            Sync-Tree (Join-Path $root "skills\$name") (Join-Path $claudeSkills $name) $claudeDir $backup
        }
    }

    $agentsSource = Join-Path $root $manifest.agents.claudeSource
    if (Test-Path -LiteralPath $agentsSource) {
        $agentsTarget = Join-Path $claudeDir "agents"
        foreach ($agent in (Get-ChildItem -LiteralPath $agentsSource -Filter "*.md" -File)) {
            Sync-File $agent.FullName (Join-Path $agentsTarget $agent.Name) $claudeDir $backup
        }
    }
}

if ($doCodex) {
    $backupLegacy = Join-Path $codexDir "backups\harness-sync-$stamp"
    $backupModern = Join-Path $codexModernDir "backups\harness-sync-$stamp"
    if ($manifest.agents.codexSource) {
        $agentsSource = Join-Path $root $manifest.agents.codexSource
        if (-not (Test-Path -LiteralPath $agentsSource -PathType Container)) {
            throw "Missing Codex agents source: $agentsSource"
        }
        foreach ($agent in (Get-ChildItem -LiteralPath $agentsSource -Filter "*.toml" -File)) {
            Sync-File $agent.FullName (Join-Path $codexDir "agents\$($agent.Name)") $codexDir $backupLegacy
        }
    }
    foreach ($rule in $manifest.rules.codex) {
        Sync-File (Join-Path $root $rule.source) (Join-Path $codexDir $rule.target) $codexDir $backupLegacy
    }
    if (-not $SkipSkills) {
        $staleCodex = @(@($previousManaged.codex) + $retiredManaged |
            Where-Object { $currentCodexManaged -notcontains $_ } | Sort-Object -Unique)
        foreach ($name in $staleCodex) {
            Remove-ManagedTree (Join-Path $codexModernSkills $name) $codexModernDir $backupModern "retired tree"
        }
        foreach ($name in @($currentCodexManaged) + @($previousManaged.codex) + $retiredManaged | Sort-Object -Unique) {
            Remove-ManagedTree (Join-Path $codexLegacySkills $name) $codexDir $backupLegacy "legacy duplicate"
        }
        foreach ($name in @($manifest.skills.shared) + @($manifest.skills.codexOnly)) {
            $source = Join-Path $root "skills\$name"
            Sync-Tree $source (Join-Path $codexModernSkills $name) $codexModernDir $backupModern
        }
    }
}

if ($Check) {
    if (-not (Test-Path -LiteralPath $pointerPath) -or (Get-Content -LiteralPath $pointerPath -Raw).Trim() -ne $root) {
        Write-Host "DRIFT pointer: $pointerPath"
        $script:ok = $false
    } else {
        Write-Host "OK pointer: $pointerPath"
    }
} else {
    Ensure-Directory $pointerDir
    Set-Content -LiteralPath $pointerPath -Value $root -Encoding UTF8
    Write-Host "SYNC pointer: $pointerPath"
}

if ($Check) {
    if (-not (Test-Path -LiteralPath $managedStatePath -PathType Leaf)) {
        Write-Host "DRIFT managed state: $managedStatePath"
        $script:ok = $false
    } else {
        if ($doClaude -and -not (Test-StringSetEqual $previousManaged.claude $currentClaudeManaged)) {
            Write-Host "DRIFT managed state: Claude skills"
            $script:ok = $false
        }
        if ($doCodex -and -not (Test-StringSetEqual $previousManaged.codex $currentCodexManaged)) {
            Write-Host "DRIFT managed state: Codex skills"
            $script:ok = $false
        }
    }
} else {
    $nextClaude = if ($doClaude) { $currentClaudeManaged } else { @($previousManaged.claude) }
    $nextCodex = if ($doCodex) { $currentCodexManaged } else { @($previousManaged.codex) }
    [ordered]@{
        schemaVersion = 1
        claude = @($nextClaude)
        codex = @($nextCodex)
    } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $managedStatePath -Encoding UTF8
    Write-Host "SYNC managed state: $managedStatePath"
}

if ($script:ok) {
    Write-Host "RESULT: OK"
    exit 0
}
Write-Host "RESULT: DRIFT"
exit 1
