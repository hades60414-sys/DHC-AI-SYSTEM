param([ValidateSet('rag1','rag1r')][string]$Config = 'rag1')
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
# RAG1 build (2026-10-01): frozen v3.1 sources in .\src (asset names follow agentId) + config-<Config>\release.json.
# Reuses the existing workstation public certificates (outer signer from ..\release, recipient from resume-probe); never creates keys.
# Output: release-<Config>\ only. rag1r is the local rehearsal deployment bound to this workstation's address.
$here = $PSScriptRoot
$v1 = Join-Path (Split-Path $here -Parent) 'release'
$recipientPath = Join-Path (Split-Path (Split-Path $here -Parent) -Parent) 'resume-probe\recipient.cer'
$configPath = Join-Path $here "config-$Config\release.json"
foreach ($p in @($configPath,(Join-Path $v1 'outer-signer.cer'),$recipientPath)) { if (-not (Test-Path -LiteralPath $p)) { throw "STOP: missing $p" } }
$out = Join-Path $here "release-$Config"
New-Item -ItemType Directory -Force -Path $out | Out-Null
$exePath = Join-Path $out 'dbclone-agent-v1.exe'
$src = Join-Path $here 'src'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
& $compiler /nologo /target:exe /optimize+ /r:System.Security.dll /r:System.Web.Extensions.dll /r:System.IO.Compression.dll /r:System.IO.Compression.FileSystem.dll ('/out:'+$exePath) ('/resource:'+$configPath+',release.json') ('/resource:'+(Join-Path $v1 'outer-signer.cer')+',outer-signer.cer') ('/resource:'+$recipientPath+',recipient.cer') (Join-Path $src 'Channel.cs') (Join-Path $src 'DocQa.cs') (Join-Path $src 'Grounding.cs') (Join-Path $src 'FixtureActions.cs')
if ($LASTEXITCODE -ne 0) { throw 'C# build failed.' }
$exeHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $exePath).Hash
$manifest = [ordered]@{ built_utc=(Get-Date).ToUniversalTime().ToString('o'); config=$Config; exe_sha256=$exeHash; config_sha256=(Get-FileHash -Algorithm SHA256 -LiteralPath $configPath).Hash }
[IO.File]::WriteAllText((Join-Path $out 'manifest.json'),($manifest | ConvertTo-Json),[Text.UTF8Encoding]::new($false))
Write-Host "Build $Config complete; nothing published. EXE_SHA256=$exeHash"
