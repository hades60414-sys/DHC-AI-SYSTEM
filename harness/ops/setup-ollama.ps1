# ASCII-only: Windows PowerShell 5.1 safe
# Install/start Ollama and pull a model suitable for RTX 4080 class GPUs.
param(
    [string]$Model = "qwen2.5-coder:14b"
)

$ErrorActionPreference = "Stop"
Write-Host "== agent-harness: setup-ollama =="
Write-Host "Model: $Model"

function Test-Ollama {
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:11434/api/tags" -UseBasicParsing -TimeoutSec 5
        return $r.StatusCode -eq 200
    } catch { return $false }
}

$ollama = Get-Command ollama -ErrorAction SilentlyContinue
if (-not $ollama) {
    Write-Host "Ollama not in PATH. Trying winget install..."
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if ($winget) {
        winget install -e --id Ollama.Ollama --accept-package-agreements --accept-source-agreements
    } else {
        Write-Host "Install Ollama manually from https://ollama.com/download then re-run this script."
        exit 1
    }
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
    $ollama = Get-Command ollama -ErrorAction SilentlyContinue
    if (-not $ollama) {
        Write-Host "Still no ollama in PATH. Open a NEW PowerShell after install, then re-run."
        exit 1
    }
}

if (-not (Test-Ollama)) {
    Write-Host "Starting Ollama serve in background..."
    Start-Process -FilePath "ollama" -ArgumentList "serve" -WindowStyle Hidden
    Start-Sleep -Seconds 3
}

if (-not (Test-Ollama)) {
    Write-Host "FAIL: cannot reach http://127.0.0.1:11434 - start Ollama app from Start Menu and retry."
    exit 1
}

Write-Host "Pulling model (first time can take a while)..."
& ollama pull $Model
if ($LASTEXITCODE -ne 0) { Write-Host "pull failed"; exit 1 }

Write-Host "Quick generate test..."
& ollama run $Model "Reply with exactly: HARNESS_OK" | Out-Host

Write-Host ""
Write-Host "DONE. Next: .\ops\healthcheck.ps1"
Write-Host "Chat API: POST http://127.0.0.1:11434/api/chat"
Write-Host "OpenAI-compatible: http://127.0.0.1:11434/v1  (if your client supports it)"
