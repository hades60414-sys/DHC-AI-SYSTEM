# ASCII-only: Windows PowerShell 5.1 safe
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("scout", "worker", "verifier", "pm")]
    [string]$Role,

    [Parameter(Mandatory = $true)]
    [string]$Prompt,

    [Parameter(Mandatory = $true)]
    [string]$Cwd,

    [ValidateSet("low", "medium", "high", "xhigh", "max", "ultra")]
    [string]$Effort,

    [ValidateSet("default", "priority")]
    [string]$ServiceTier = "default",

    [ValidateRange(30, 1800)]
    [int]$TimeoutSeconds = 600,

    [string]$Model,

    [switch]$ResolveOnly
)

$ErrorActionPreference = "Stop"

function Resolve-CodexCli {
    if ($env:CODEX_CLI_PATH -and (Test-Path -LiteralPath $env:CODEX_CLI_PATH -PathType Leaf)) {
        return (Get-Item -LiteralPath $env:CODEX_CLI_PATH).FullName
    }

    if ($env:LOCALAPPDATA) {
        $binRoot = Join-Path $env:LOCALAPPDATA "OpenAI\Codex\bin"
        if (Test-Path -LiteralPath $binRoot -PathType Container) {
            $candidate = Get-ChildItem -LiteralPath $binRoot -Filter "codex.exe" -File -Recurse -ErrorAction SilentlyContinue |
                Sort-Object LastWriteTimeUtc -Descending |
                Select-Object -First 1
            if ($candidate) { return $candidate.FullName }
        }
    }

    $pathCommand = Get-Command "codex.exe" -ErrorAction SilentlyContinue
    if ($pathCommand -and $pathCommand.Source -notmatch "\\WindowsApps\\") {
        return $pathCommand.Source
    }

    throw "No executable Codex CLI found. CODEX_CLI_PATH is unset, the desktop bin directory is empty, and PATH only exposes the unusable WindowsApps alias."
}

$resolvedCwd = (Resolve-Path -LiteralPath $Cwd).Path
$cli = Resolve-CodexCli

$roleConfig = @{
    scout = @{
        model = "gpt-5.6-luna"
        effort = "medium"
        sandbox = "danger-full-access"
        context = "Read-only scout. Locate and trace the requested behavior. Return concise conclusions with file:line evidence. Do not edit, delegate, or broaden scope."
    }
    worker = @{
        model = "gpt-5.6-terra"
        effort = "high"
        sandbox = "danger-full-access"
        context = "Scoped implementation worker. Own only the assigned files or surface. Make the smallest complete change, run focused checks, and report the diff and evidence. Do not delegate or expand scope."
    }
    verifier = @{
        model = "gpt-6-astra"
        effort = "high"
        sandbox = "danger-full-access"
        context = "Adversarial verifier. Assume the claim is unproven. Try to refute it with concrete evidence, rank material findings, and state what remains unverified. Do not edit or delegate."
    }
    pm = @{
        model = "gpt-5.6-sol"
        effort = "high"
        sandbox = "danger-full-access"
        context = "Standing planning lead for a non-FABLE Claude session. Return a decision-ready plan in at most eight bullets: goal, material assumptions, ordered steps with acceptance checks, risks, and a stop condition. Prefer the smallest plan that satisfies the goal. Do not edit files, delegate, or request a second planning round."
    }
}

$cfg = $roleConfig[$Role]
# Explicit -Model wins over the role default (e.g. gpt-6-astra for cross-vendor review seats).
if ($Model) { $cfg = $cfg.Clone(); $cfg.model = $Model }

# Effective reasoning effort: explicit -Effort wins over the role default.
$effectiveEffort = if ($Effort) { $Effort } else { $cfg.effort }
# Luna does not support "ultra"; fail loudly instead of silently downgrading.
if ($cfg.model -eq "gpt-5.6-luna" -and $effectiveEffort -eq "ultra") {
    [ordered]@{
        status = "error"
        role = $Role
        model = $cfg.model
        result = ""
        exit_code = 2
        error = "gpt-5.6-luna does not support effort 'ultra' (max is 'max'). Choose a lower effort or a different role."
    } | ConvertTo-Json -Compress
    exit 2
}

if ($ResolveOnly) {
    [ordered]@{
        status = "ready"
        role = $Role
        cli = $cli
        model = $cfg.model
        effort = $effectiveEffort
        service_tier = $ServiceTier
        sandbox = $cfg.sandbox
        cwd = $resolvedCwd
    } | ConvertTo-Json -Compress
    exit 0
}

# Every Codex request goes through the local de-identification proxy (D:\TAS\ai-tools\codex-deid), same as Claude Code.
# Windows sandboxes cannot start from the session-0 host, so the proxy, not the sandbox, is the boundary. No proxy, no run.
$deidDir = "D:\TAS\ai-tools\codex-deid"
$deidUrl = "http://127.0.0.1:3004"
function Test-Deid { try { (Invoke-RestMethod -Uri "$deidUrl/_deid/health" -TimeoutSec 3).ok -eq $true } catch { $false } }
if (-not (Test-Deid)) {
    Start-Process -FilePath "node" -ArgumentList "server.cjs" -WorkingDirectory $deidDir -WindowStyle Hidden | Out-Null
    for ($i = 0; $i -lt 10 -and -not (Test-Deid); $i++) { Start-Sleep -Milliseconds 500 }
}
if (-not (Test-Deid)) {
    [ordered]@{
        status = "error"
        role = $Role
        model = $cfg.model
        result = ""
        exit_code = 3
        error = "De-identification proxy at $deidUrl is not answering; Codex was not started. Check $deidDir."
    } | ConvertTo-Json -Compress
    exit 3
}

$fullPrompt = "[Role]`n$($cfg.context)`n`n[Task]`n$Prompt`n`nReturn one concise, self-contained result for the orchestrator."
$argumentParts = @(
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--ephemeral",
    "-m", $cfg.model,
    "-c", "model_reasoning_effort=$effectiveEffort",
    "-c", "service_tier=$ServiceTier",
    "-s", $cfg.sandbox,
    "-c", "model_provider=deid",
    "-c", "model_providers.deid={name=\`"deid\`",base_url=\`"$deidUrl/backend-api/codex\`",wire_api=\`"responses\`",requires_openai_auth=true}"
)
# New Codex CLI treats --approve-for-me and -s as mutually exclusive (exit 2); use approval_policy=never instead.
if ($Role -eq "worker") { $argumentParts += @("-c", "approval_policy=never") }
$argumentParts += "-"

$startInfo = New-Object System.Diagnostics.ProcessStartInfo
$startInfo.FileName = $cli
$startInfo.Arguments = ($argumentParts -join " ")
$startInfo.WorkingDirectory = $resolvedCwd
$startInfo.UseShellExecute = $false
$startInfo.RedirectStandardInput = $true
$startInfo.RedirectStandardOutput = $true
$startInfo.RedirectStandardError = $true
$startInfo.CreateNoWindow = $true
if (-not $env:HOME -and $env:USERPROFILE) {
    $startInfo.EnvironmentVariables["HOME"] = $env:USERPROFILE
}
if (-not $env:CODEX_HOME -and $env:USERPROFILE) {
    $startInfo.EnvironmentVariables["CODEX_HOME"] = Join-Path $env:USERPROFILE ".codex"
}

$process = New-Object System.Diagnostics.Process
$process.StartInfo = $startInfo
$null = $process.Start()
$stdoutTask = $process.StandardOutput.ReadToEndAsync()
$stderrTask = $process.StandardError.ReadToEndAsync()
$process.StandardInput.Write($fullPrompt)
$process.StandardInput.Close()

if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
    try { $process.Kill() } catch {}
    $process.WaitForExit()
    [ordered]@{
        status = "timeout"
        role = $Role
        model = $cfg.model
        effort = $effectiveEffort
        service_tier = $ServiceTier
        result = ""
        error = "Codex timed out after $TimeoutSeconds seconds."
    } | ConvertTo-Json -Compress
    exit 124
}

$stdout = $stdoutTask.Result
$stderr = $stderrTask.Result
$messages = New-Object System.Collections.Generic.List[string]
$sawTurnCompleted = $false
$usage = $null
$streamError = $null

foreach ($line in ($stdout -split "`r?`n")) {
    if (-not $line.Trim()) { continue }
    try { $event = $line | ConvertFrom-Json } catch { continue }
    if ($event.type -eq "item.completed" -and $event.item.type -eq "agent_message" -and $event.item.text) {
        $messages.Add([string]$event.item.text)
    } elseif ($event.type -eq "turn.completed") {
        $sawTurnCompleted = $true
        if ($event.usage) { $usage = $event.usage }
    } elseif ($event.type -match "(error|failed)$") {
        if ($event.message) { $streamError = [string]$event.message }
        elseif ($event.error) { $streamError = [string]$event.error }
    }
}

# Token usage per run for the DHC AI System sidebar split meter (Claude / Codex / Gemini). Best effort, never fails the run.
if ($usage) {
    try {
        $rec = [ordered]@{ t = (Get-Date).ToUniversalTime().ToString("o"); vendor = "codex"; via = "bridge"; role = $Role; model = $cfg.model; input = [int64]$usage.input_tokens; cached = [int64]$usage.cached_input_tokens; output = [int64]$usage.output_tokens } | ConvertTo-Json -Compress
        [System.IO.File]::AppendAllText("D:\TAS\cc-web\offload-usage.jsonl", $rec + "`n")
    } catch {}
}

if ($process.ExitCode -eq 0 -and $sawTurnCompleted -and $messages.Count -gt 0) {
    [ordered]@{
        status = "success"
        role = $Role
        model = $cfg.model
        effort = $effectiveEffort
        service_tier = $ServiceTier
        result = ($messages -join "`n")
        exit_code = 0
    } | ConvertTo-Json -Compress -Depth 6
    exit 0
}

$errorText = if ($streamError) { $streamError } elseif ($stderr.Trim()) { $stderr.Trim() } else { "Codex exited without a completed agent message." }
[ordered]@{
    status = "error"
    role = $Role
    model = $cfg.model
    effort = $effectiveEffort
    service_tier = $ServiceTier
    result = ($messages -join "`n")
    exit_code = $process.ExitCode
    error = $errorText
} | ConvertTo-Json -Compress -Depth 6
exit 1
