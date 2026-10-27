param([string]$OutDir = 'D:\TAS\agent-keys')
# TAS controller keys for the agent channel (2026-10-20). Creates, once, in this user's CurrentUser\My:
#   signer    - signs jobs (same parameters as agent-channel\Build.ps1)
#   recipient - decrypts agent reports (KeyEncipherment, like resume-probe\recipient.cer)
# Both NonExportable. Writes only the public .cer files and thumbprints to $OutDir and prints the .cer as base64.
# Rerun-safe: an existing thumbprint file whose certificate is still in the store is reused.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$csp = 'Microsoft Enhanced RSA and AES Cryptographic Provider'
$specs = @(
    @{ Name = 'signer';    Subject = 'CN=TAS Agent Channel Signing 20261020'; Usage = @('DigitalSignature') },
    @{ Name = 'recipient'; Subject = 'CN=TAS dbclone return 20261020';        Usage = @('KeyEncipherment', 'DataEncipherment') }
)
foreach ($s in $specs) {
    $thumbFile = Join-Path $OutDir ($s.Name + '-thumbprint.txt')
    $cert = $null
    if (Test-Path -LiteralPath $thumbFile) {
        $t = [IO.File]::ReadAllText($thumbFile).Trim()
        $cert = Get-Item -LiteralPath ('Cert:\CurrentUser\My\' + $t) -ErrorAction SilentlyContinue
    }
    if (-not $cert) {
        $cert = New-SelfSignedCertificate -Type Custom -Subject $s.Subject -CertStoreLocation 'Cert:\CurrentUser\My' -Provider $csp -KeyAlgorithm RSA -KeyLength 3072 -KeySpec KeyExchange -KeyExportPolicy NonExportable -KeyUsage $s.Usage -HashAlgorithm SHA256 -NotAfter (Get-Date).AddYears(3)
        [IO.File]::WriteAllText($thumbFile, $cert.Thumbprint, [Text.UTF8Encoding]::new($false))
        $state = 'created'
    } else { $state = 'reused' }
    if (-not $cert.HasPrivateKey) { throw ('STOP: ' + $s.Name + ' has no private key') }
    $der = $cert.Export([Security.Cryptography.X509Certificates.X509ContentType]::Cert)
    [IO.File]::WriteAllBytes((Join-Path $OutDir ($s.Name + '.cer')), $der)
    $exportable = $cert.PrivateKey.CspKeyContainerInfo.Exportable
    Write-Output ('{0} {1} thumb={2} notAfter={3} exportable={4}' -f $s.Name, $state, $cert.Thumbprint, $cert.NotAfter.ToString('yyyy-MM-dd'), $exportable)
    Write-Output ('CER ' + $s.Name + ' ' + [Convert]::ToBase64String($der))
}
