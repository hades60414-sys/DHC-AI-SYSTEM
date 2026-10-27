$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
# v3.5 tests (2026-10-05): Test-V34.ps1 plus CmdActions.cs (cmd-run; its own tests are CmdTests.cs).
$testDir = Join-Path $PSScriptRoot 'test-work'
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
    & $compiler /nologo /target:exe /main:Tests /r:System.Security.dll /r:System.Web.Extensions.dll /r:System.IO.Compression.dll /r:System.IO.Compression.FileSystem.dll /r:System.Data.dll /r:Microsoft.CSharp.dll ('/out:'+$testExe) ('/resource:'+$configPath+',release.json') ('/resource:'+$signerPath+',outer-signer.cer') ('/resource:'+$recipientPath+',recipient.cer') (Join-Path $PSScriptRoot 'Channel.cs') (Join-Path $PSScriptRoot 'DocQa.cs') (Join-Path $PSScriptRoot 'Grounding.cs') (Join-Path $PSScriptRoot 'FixtureActions.cs') (Join-Path $PSScriptRoot 'SqlActions.cs') (Join-Path $PSScriptRoot 'HostActions.cs') (Join-Path $PSScriptRoot 'SandboxActions.cs') (Join-Path $PSScriptRoot 'Updater.cs') (Join-Path $PSScriptRoot 'CmdActions.cs') (Join-Path $PSScriptRoot 'FixtureTests.cs') (Join-Path $PSScriptRoot 'UpdaterTests.cs') (Join-Path $PSScriptRoot 'SqlTests.cs') (Join-Path $PSScriptRoot 'HostTests.cs') (Join-Path $PSScriptRoot 'Tests.cs')
    if ($LASTEXITCODE -ne 0) { throw 'Test compilation failed.' }
    & $testExe $testCerts[0].Thumbprint $testCerts[1].Thumbprint $testCerts[2].Thumbprint $testCerts[3].Thumbprint $testDir
    if ($LASTEXITCODE -ne 0) { throw 'One or more channel tests failed.' }
} finally {
    foreach ($cert in $testCerts) { Remove-Item -LiteralPath ('Cert:\CurrentUser\My\'+$cert.Thumbprint) -DeleteKey -ErrorAction Continue }
}
