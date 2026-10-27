$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
# v3.5 build (2026-10-05): v3.4 + cmd-run (CmdActions.cs). v3.4 notes: v3.3 + self-update (Updater.cs, ported from rag1/srcD). Reuses the EXISTING deployment config and public
# certificates from release\ (same source paths as Build-V2.ps1); never creates keys, never touches
# release\, release-v2\ or release-v3\ (the deployed v3 stays reproducible). Output: release-v35\ only.
$v1 = Join-Path $PSScriptRoot 'release'
$v35 = Join-Path $PSScriptRoot 'release-v35'
$recipientPath = Join-Path (Split-Path $PSScriptRoot -Parent) 'resume-probe\recipient.cer'
foreach ($p in @((Join-Path $v1 'release.json'),(Join-Path $v1 'outer-signer.cer'),$recipientPath)) { if (-not (Test-Path -LiteralPath $p)) { throw "STOP: existing deployment file missing: $p (refusing to create a new deployment)" } }
New-Item -ItemType Directory -Force -Path $v35 | Out-Null
$exePath = Join-Path $v35 'dbclone-agent-v1.exe'   # installed file name on the VM is unchanged; content is v3.4
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
& $compiler /nologo /target:exe /optimize+ /r:System.Security.dll /r:System.Web.Extensions.dll /r:System.IO.Compression.dll /r:System.IO.Compression.FileSystem.dll /r:System.Data.dll /r:Microsoft.CSharp.dll ('/out:'+$exePath) ('/resource:'+(Join-Path $v1 'release.json')+',release.json') ('/resource:'+(Join-Path $v1 'outer-signer.cer')+',outer-signer.cer') ('/resource:'+$recipientPath+',recipient.cer') (Join-Path $PSScriptRoot 'Channel.cs') (Join-Path $PSScriptRoot 'DocQa.cs') (Join-Path $PSScriptRoot 'Grounding.cs') (Join-Path $PSScriptRoot 'FixtureActions.cs') (Join-Path $PSScriptRoot 'SqlActions.cs') (Join-Path $PSScriptRoot 'HostActions.cs') (Join-Path $PSScriptRoot 'SandboxActions.cs') (Join-Path $PSScriptRoot 'Updater.cs') (Join-Path $PSScriptRoot 'CmdActions.cs')
if ($LASTEXITCODE -ne 0) { throw 'C# build failed.' }
$b64Path = Join-Path $v35 'dbclone-agent-v35.exe.b64.txt'
[IO.File]::WriteAllText($b64Path,[Convert]::ToBase64String([IO.File]::ReadAllBytes($exePath)),[Text.UTF8Encoding]::new($false))
$exeHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $exePath).Hash
$manifest = [ordered]@{ built_utc=(Get-Date).ToUniversalTime().ToString('o'); agent_version='v3.5-20261005'; exe_sha256=$exeHash; b64_sha256=(Get-FileHash -Algorithm SHA256 -LiteralPath $b64Path).Hash; deployment_config_sha256=(Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $v1 'release.json')).Hash; v1_exe_sha256=(Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $v1 'dbclone-agent-v1.exe')).Hash }
[IO.File]::WriteAllText((Join-Path $v35 'manifest.json'),($manifest | ConvertTo-Json),[Text.UTF8Encoding]::new($false))
Write-Host "v3.5 build complete; nothing published. EXE_SHA256=$exeHash"
