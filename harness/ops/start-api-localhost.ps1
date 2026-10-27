# Remind / verify Ollama is localhost-only. Does not open firewall ports.
$ErrorActionPreference = "Continue"
Write-Host "== localhost-only reminder =="
Write-Host "Preferred: leave Ollama default (127.0.0.1:11434)."
Write-Host "Do NOT set OLLAMA_HOST=0.0.0.0:11434 for a free public AI."
Write-Host "Remote access: Tailscale first, then http://<tailscale-ip>:11434"

if (Get-Command ollama -ErrorAction SilentlyContinue) {
    if (-not (Get-NetTCPConnection -LocalPort 11434 -ErrorAction SilentlyContinue)) {
        Write-Host "Starting ollama serve..."
        Start-Process ollama -ArgumentList "serve" -WindowStyle Hidden
        Start-Sleep 2
    }
}

try {
    $r = Invoke-WebRequest "http://127.0.0.1:11434/api/tags" -UseBasicParsing -TimeoutSec 5
    Write-Host "OK localhost API status=$($r.StatusCode)"
} catch {
    Write-Host "FAIL: cannot hit localhost API - open Ollama app"
    exit 1
}
