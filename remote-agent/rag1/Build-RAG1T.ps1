# TAS build (2026-10-20): Build-RAG1D.ps1 with the srv-main controller public certs and the rag1t sources.
param([ValidateSet('rag1','rag1r','pcmgr','pcmain','userD','userF','userB','userC')][string]$Config = 'rag1', [string]$OutDir, [string]$Src)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
# RAG1 D build (2026-10-01): same as Build-RAG1.ps1 but sources from .srcD, output release-rag1d-<Config>. RAG1 build (2026-10-01): frozen v3.1 sources in .\src (asset names follow agentId) + config-<Config>\release.json.
# Reuses the existing workstation public certificates (outer signer from ..\release, recipient from resume-probe); never creates keys.
# Output: release-<Config>\ only. rag1r is the local rehearsal deployment bound to this workstation's address.
$here = $PSScriptRoot
$v1 = 'D:/TAS/Claude Code專案/Harness優化/TAS遷移/newkeys'   # TAS keys: signer.cer + recipient.cer
$recipientPath = Join-Path $v1 'recipient.cer'
$configPath = Join-Path $here "config-$Config\release.json"
foreach ($p in @($configPath,(Join-Path $v1 'signer.cer'),$recipientPath)) { if (-not (Test-Path -LiteralPath $p)) { throw "STOP: missing $p" } }
$out = if ($OutDir) { $OutDir } else { Join-Path $here "release-rag1d-$Config" }   # OutDir: experiment builds beside a running copy
New-Item -ItemType Directory -Force -Path $out | Out-Null
$exePath = Join-Path $out 'dbclone-agent-v1.exe'
$src = if ($Src) { $Src } else { 'D:/TAS/Claude Code專案/Harness優化/TAS遷移/kits/pcmain/srcD' }   # 2026-10-25: -Src rag1\srcD for rag1u
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
& $compiler /nologo /target:exe /optimize+ /r:System.Security.dll /r:System.Web.Extensions.dll /r:System.IO.Compression.dll /r:System.IO.Compression.FileSystem.dll ('/out:'+$exePath) ('/resource:'+$configPath+',release.json') ('/resource:'+(Join-Path $v1 'signer.cer')+',outer-signer.cer') ('/resource:'+$recipientPath+',recipient.cer') (Join-Path $src 'Channel.cs') (Join-Path $src 'DocQa.cs') (Join-Path $src 'Grounding.cs') (Join-Path $src 'FixtureActions.cs') (Join-Path $src 'Updater.cs') (Join-Path $src 'CmdActions.cs')
if ($LASTEXITCODE -ne 0) { throw 'C# build failed.' }
$exeHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $exePath).Hash
$manifest = [ordered]@{ built_utc=(Get-Date).ToUniversalTime().ToString('o'); config=$Config; exe_sha256=$exeHash; config_sha256=(Get-FileHash -Algorithm SHA256 -LiteralPath $configPath).Hash }
[IO.File]::WriteAllText((Join-Path $out 'manifest.json'),($manifest | ConvertTo-Json),[Text.UTF8Encoding]::new($false))
Write-Host "Build $Config complete; nothing published. EXE_SHA256=$exeHash"
