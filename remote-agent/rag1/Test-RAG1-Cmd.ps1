$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
# rag1o (2026-10-06): cmd-run tests for the RAG1 srcD build (CmdTestsRAG1.cs). Runs real cmd.exe locally; no network, no certificates.
$testDir = Join-Path (Split-Path $PSScriptRoot -Parent) 'test-work-rag1d'
New-Item -ItemType Directory -Force -Path $testDir | Out-Null
$testExe = Join-Path $testDir 'CmdTestsRAG1.exe'
$src = Join-Path $PSScriptRoot 'srcD'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
& $compiler /nologo /target:exe /main:DbAgent.CmdTests /r:System.Security.dll /r:System.Web.Extensions.dll /r:System.IO.Compression.dll /r:System.IO.Compression.FileSystem.dll ('/out:'+$testExe) (Join-Path $src 'Channel.cs') (Join-Path $src 'DocQa.cs') (Join-Path $src 'Grounding.cs') (Join-Path $src 'FixtureActions.cs') (Join-Path $src 'Updater.cs') (Join-Path $src 'CmdActions.cs') (Join-Path $PSScriptRoot 'CmdTestsRAG1.cs')
if ($LASTEXITCODE -ne 0) { throw 'Test compilation failed.' }
& $testExe
if ($LASTEXITCODE -ne 0) { throw 'One or more cmd-run tests failed.' }
