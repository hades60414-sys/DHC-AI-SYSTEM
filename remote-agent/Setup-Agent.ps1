param([string]$Root = 'C:\dbclone\dhc-agent-v1')
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$targetAddress = '10.255.0.12'
if (-not ([Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() | ForEach-Object { $_.GetIPProperties().UnicastAddresses } | Where-Object { $_.Address.IPAddressToString -eq $targetAddress })) { throw "STOP: setup is restricted to $targetAddress" }
foreach ($key in @('SRC_PWD','DST_PWD','MktData_PWD','SQLCMDPASSWORD')) { [Environment]::SetEnvironmentVariable($key,$null,'Process') }
$channelExe = Join-Path $Root 'dbclone-agent-v1.exe'
if (-not (Test-Path -LiteralPath $channelExe)) { throw 'Run the hash-verified bootstrap first.' }
$thumbFile = Join-Path $Root 'device-thumbprint.txt'
$journalFile = Join-Path $Root 'agent-state.json'
$existingDevice = Test-Path -LiteralPath $thumbFile
if ((Test-Path -LiteralPath $thumbFile) -ne (Test-Path -LiteralPath $journalFile)) { throw 'STOP: partial local state; do not reset or delete the journal. Ask ASTRA to inspect.' }
if (Test-Path -LiteralPath $thumbFile) {
    $deviceThumb = [IO.File]::ReadAllText($thumbFile).Trim()
    $deviceCert = Get-Item -LiteralPath "Cert:\CurrentUser\My\$deviceThumb"
    if (-not $deviceCert.HasPrivateKey) { throw 'STOP: device private key is missing.' }
} else {
    $deviceCert = New-SelfSignedCertificate -Type Custom -Subject 'CN=RAGENT Local Agent V1' -CertStoreLocation 'Cert:\CurrentUser\My' -Provider 'Microsoft Enhanced RSA and AES Cryptographic Provider' -KeyAlgorithm RSA -KeyLength 3072 -KeySpec KeyExchange -KeyExportPolicy NonExportable -KeyUsage DigitalSignature,KeyEncipherment -HashAlgorithm SHA256 -NotAfter (Get-Date).AddYears(3)
    $deviceThumb = $deviceCert.Thumbprint
}
& $channelExe init $Root $deviceThumb
if ($LASTEXITCODE -ne 0) { throw 'Agent state initialization failed; no runner started.' }
& $channelExe enroll $Root
if ($LASTEXITCODE -ne 0) { throw 'Encrypted enrollment upload failed. Re-run Setup-Agent.ps1; the existing certificate and sequence will be retained.' }
if ($existingDevice) { Write-Host 'Existing device certificate and task journal retained. No new pairing is required.' }
else { Write-Host 'Send PAIRING_SHA256 from THIS VM console to ASTRA once. Never take the fingerprint from an uploaded enrollment file.' }
Write-Host 'Starting the foreground agent. No Windows startup task is installed. Ctrl+C stops it locally.'
& $channelExe run $Root
exit $LASTEXITCODE
