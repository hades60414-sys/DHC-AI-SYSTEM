param([ValidateSet('rag1','rag1r','pcmgr','pcmain','userD','userF','userB','userC','userE','userA')][string]$Config = 'rag1', [string]$OutDir, [string]$KeyDir)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
# RAG1 D build (2026-10-01): same as Build-RAG1.ps1 but sources from .srcD, output release-rag1d-<Config>. RAG1 build (2026-10-01): frozen v3.1 sources in .\src (asset names follow agentId) + config-<Config>\release.json.
# Reuses the existing workstation public certificates (outer signer from ..\release, recipient from resume-probe); never creates keys.
# Output: release-<Config>\ only. rag1r is the local rehearsal deployment bound to this workstation's address.
$here = $PSScriptRoot
$v1 = Join-Path (Split-Path $here -Parent) 'release'
$recipientPath = Join-Path (Split-Path (Split-Path $here -Parent) -Parent) 'resume-probe\recipient.cer'
$configPath = Join-Path $here "config-$Config\release.json"
$signerPath = Join-Path $v1 'outer-signer.cer'
# KeyDir (srv-main, 2026-10-21): folder with signer.cer + recipient.cer (the 10-20 migration key pair); live srv-main configs need it.
if ($KeyDir) { $signerPath = Join-Path $KeyDir 'signer.cer'; $recipientPath = Join-Path $KeyDir 'recipient.cer' }
foreach ($p in @($configPath,$signerPath,$recipientPath)) { if (-not (Test-Path -LiteralPath $p)) { throw "STOP: missing $p" } }
$out = if ($OutDir) { $OutDir } else { Join-Path $here "release-rag1d-$Config" }   # OutDir: experiment builds beside a running copy
New-Item -ItemType Directory -Force -Path $out | Out-Null
$exePath = Join-Path $out 'dbclone-agent-v1.exe'
$src = Join-Path $here 'srcD'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
& $compiler /nologo /target:exe /optimize+ /r:System.Security.dll /r:System.Web.Extensions.dll /r:System.IO.Compression.dll /r:System.IO.Compression.FileSystem.dll ('/out:'+$exePath) ('/resource:'+$configPath+',release.json') ('/resource:'+$signerPath+',outer-signer.cer') ('/resource:'+$recipientPath+',recipient.cer') (Join-Path $src 'Channel.cs') (Join-Path $src 'DocQa.cs') (Join-Path $src 'Grounding.cs') (Join-Path $src 'FixtureActions.cs') (Join-Path $src 'Updater.cs') (Join-Path $src 'CmdActions.cs')
if ($LASTEXITCODE -ne 0) { throw 'C# build failed.' }
$exeHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $exePath).Hash
$manifest = [ordered]@{ built_utc=(Get-Date).ToUniversalTime().ToString('o'); config=$Config; exe_sha256=$exeHash; config_sha256=(Get-FileHash -Algorithm SHA256 -LiteralPath $configPath).Hash }
[IO.File]::WriteAllText((Join-Path $out 'manifest.json'),($manifest | ConvertTo-Json),[Text.UTF8Encoding]::new($false))
Write-Host "Build $Config complete; nothing published. EXE_SHA256=$exeHash"
