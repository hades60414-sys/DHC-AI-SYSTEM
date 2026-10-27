# RAG1: Test-V3.ps1 pointed at the frozen rag1\src sources and the v3.1 test file.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
# v3 tests (2026-09-30): same as Test.ps1, plus DocQa.cs and the System.IO.Compression references. Test.ps1 itself is unchanged.
$testDir = Join-Path (Split-Path $PSScriptRoot -Parent) 'test-work-rag1d'
New-Item -ItemType Directory -Force -Path $testDir | Out-Null
$testExe = Join-Path $testDir 'Channel.Tests.exe'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$testCerts = @()
try {
    foreach ($label in @('signer','recipient','device','attacker')) {
        $testCerts += New-SelfSignedCertificate -Type Custom -Subject "CN=DB Agent Isolated Test $label" -CertStoreLocation 'Cert:\CurrentUser\My' -Provider 'Microsoft Enhanced RSA and AES Cryptographic Provider' -KeyAlgorithm RSA -KeyLength 3072 -KeySpec KeyExchange -KeyExportPolicy NonExportable -KeyUsage DigitalSignature,KeyEncipherment -HashAlgorithm SHA256 -NotAfter (Get-Date).AddDays(1)
    }
    $configPath = Join-Path $testDir 'test-release.json'
    $signerPath = Join-Path $testDir 'test-signer.cer'
    $recipientPath = Join-Path $testDir 'test-recipient.cer'
    [IO.File]::WriteAllText($configPath,(@{deploymentId=[Guid]::NewGuid().ToString();agentId='ragent';target='10.255.0.12';baseUrl='https://invalid.example/api/assets/files'} | ConvertTo-Json -Compress))
    [IO.File]::WriteAllBytes($signerPath,$testCerts[0].Export([Security.Cryptography.X509Certificates.X509ContentType]::Cert))
    [IO.File]::WriteAllBytes($recipientPath,$testCerts[1].Export([Security.Cryptography.X509Certificates.X509ContentType]::Cert))
    & $compiler /nologo /target:exe /main:Tests /r:System.Security.dll /r:System.Web.Extensions.dll /r:System.IO.Compression.dll /r:System.IO.Compression.FileSystem.dll ('/out:'+$testExe) ('/resource:'+$configPath+',release.json') ('/resource:'+$signerPath+',outer-signer.cer') ('/resource:'+$recipientPath+',recipient.cer') (Join-Path (Split-Path $PSScriptRoot -Parent) 'rag1\srcD\Channel.cs') (Join-Path (Split-Path $PSScriptRoot -Parent) 'rag1\srcD\DocQa.cs') (Join-Path (Split-Path $PSScriptRoot -Parent) 'rag1\srcD\Grounding.cs') (Join-Path (Split-Path $PSScriptRoot -Parent) 'rag1\srcD\FixtureActions.cs') (Join-Path (Split-Path $PSScriptRoot -Parent) 'rag1\srcD\Updater.cs') (Join-Path (Split-Path $PSScriptRoot -Parent) 'rag1\srcD\CmdActions.cs') (Join-Path (Split-Path $PSScriptRoot -Parent) 'FixtureTests.cs') (Join-Path (Split-Path $PSScriptRoot -Parent) 'rag1\TestsD.cs')
    if ($LASTEXITCODE -ne 0) { throw 'Test compilation failed.' }
    & $testExe $testCerts[0].Thumbprint $testCerts[1].Thumbprint $testCerts[2].Thumbprint $testCerts[3].Thumbprint $testDir
    if ($LASTEXITCODE -ne 0) { throw 'One or more channel tests failed.' }
} finally {
    foreach ($cert in $testCerts) { Remove-Item -LiteralPath ('Cert:\CurrentUser\My\'+$cert.Thumbprint) -DeleteKey -ErrorAction Continue }
}
