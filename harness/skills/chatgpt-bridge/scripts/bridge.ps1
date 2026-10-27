# Claude Code adapter for the upstream codex-chatgpt-bridge skill.
# Forwards lifecycle actions to the unmodified upstream scripts and adds Await
# (block until a ChatGPT-written manifest file exists and is stable).
# Windows PowerShell 5.1 compatible. Never prints secrets.
[CmdletBinding()]
param(
  [ValidateSet("Configure", "On", "Off", "Restart", "Reboot", "Status", "Doctor", "LowDoctor", "Rotate", "Await", "Where")]
  [string]$Action = "Status",

  # Configure passthrough
  [string]$ProjectRoot,
  [string]$AllowedRoots,
  [ValidateSet("none", "cloudflare", "external", "cloudflare-worker")]
  [string]$Tunnel,
  [int]$Port,
  [string]$PublicBaseUrl,
  [switch]$InstallCloudflared,

  # Await
  [string]$Path,
  [int]$TimeoutSec = 600,
  [int]$StableSec = 3,

  [string]$UpstreamSkill = (Join-Path $env:USERPROFILE ".codex\skills\codex-chatgpt-bridge")
)

$ErrorActionPreference = "Stop"
$controller = Join-Path $UpstreamSkill "scripts\bridge_controller.ps1"
$runtime = Join-Path $UpstreamSkill "scripts\local_bridge.ps1"
$ps = (Get-Command powershell.exe -ErrorAction Stop).Source

function Assert-Upstream {
  if (-not (Test-Path -LiteralPath $controller) -or -not (Test-Path -LiteralPath $runtime)) {
    throw "Upstream skill not found under $UpstreamSkill. Run install.ps1 from the codex-chatgpt-bridge repo."
  }
}

switch ($Action) {
  "Where" {
    [pscustomobject]@{
      upstreamSkill = $UpstreamSkill
      controller = $controller
      runtime = $runtime
      stateDir = (Join-Path $env:LOCALAPPDATA "devspace-bridge")
      upstreamPresent = ((Test-Path -LiteralPath $controller) -and (Test-Path -LiteralPath $runtime))
    } | ConvertTo-Json
    break
  }
  "Configure" {
    Assert-Upstream
    $args = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $controller, "-Action", "Configure")
    if ($ProjectRoot) { $args += @("-ProjectRoot", $ProjectRoot) }
    if ($AllowedRoots) { $args += @("-AllowedRoots", $AllowedRoots) }
    if ($Tunnel) { $args += @("-Tunnel", $Tunnel) }
    if ($Port) { $args += @("-Port", $Port) }
    if ($PublicBaseUrl) { $args += @("-PublicBaseUrl", $PublicBaseUrl) }
    if ($InstallCloudflared) { $args += "-InstallCloudflared" }
    & $ps @args
    exit $LASTEXITCODE
  }
  { $_ -in @("On", "Off", "Restart", "Reboot", "Status", "Doctor") } {
    Assert-Upstream
    & $ps -NoProfile -ExecutionPolicy Bypass -File $controller -Action $Action
    exit $LASTEXITCODE
  }
  "LowDoctor" {
    Assert-Upstream
    & $ps -NoProfile -ExecutionPolicy Bypass -File $runtime -Action Doctor
    exit $LASTEXITCODE
  }
  "Rotate" {
    Assert-Upstream
    & $ps -NoProfile -ExecutionPolicy Bypass -File $runtime -Action Rotate
    exit $LASTEXITCODE
  }
  "Await" {
    if (-not $Path) { throw "-Path is required for Await." }
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    $lastLen = -1
    $stableSince = $null
    while ((Get-Date) -lt $deadline) {
      if (Test-Path -LiteralPath $Path) {
        $len = (Get-Item -LiteralPath $Path).Length
        if ($len -gt 0 -and $len -eq $lastLen) {
          if (-not $stableSince) { $stableSince = Get-Date }
          if (((Get-Date) - $stableSince).TotalSeconds -ge $StableSec) {
            [pscustomobject]@{ status = "ready"; path = $Path; bytes = $len } | ConvertTo-Json
            exit 0
          }
        } else {
          $stableSince = $null
          $lastLen = $len
        }
      }
      Start-Sleep -Seconds 2
    }
    [pscustomobject]@{ status = "timeout"; path = $Path; timeoutSec = $TimeoutSec } | ConvertTo-Json
    exit 1
  }
}
