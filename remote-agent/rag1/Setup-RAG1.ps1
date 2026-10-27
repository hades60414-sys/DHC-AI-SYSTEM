param([string]$Root = 'C:\dbclone\rag1-agent', [string]$TargetAddress = '@@TARGET@@')
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
# RAG1 agent setup (2026-10-01): same steps as Setup-Agent.ps1 (device certificate, init, encrypted enrollment, foreground run),
# bound to this PC's address. Re-running reuses the existing certificate and journal.
if (-not ([Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() | ForEach-Object { $_.GetIPProperties().UnicastAddresses } | Where-Object { $_.Address.IPAddressToString -eq $TargetAddress })) { throw "STOP: setup is restricted to $TargetAddress" }
foreach ($key in @('SRC_PWD','DST_PWD','MktData_PWD','SQLCMDPASSWORD')) { [Environment]::SetEnvironmentVariable($key,$null,'Process') }
$channelExe = Join-Path $Root 'dbclone-agent-v1.exe'
if (-not (Test-Path -LiteralPath $channelExe)) { throw "STOP: $channelExe not found; run install-rag1.cmd first." }
$thumbFile = Join-Path $Root 'device-thumbprint.txt'
$journalFile = Join-Path $Root 'agent-state.json'
$existingDevice = Test-Path -LiteralPath $thumbFile
if ((Test-Path -LiteralPath $thumbFile) -ne (Test-Path -LiteralPath $journalFile)) { throw 'STOP: partial local state; do not reset or delete the journal.' }
if ($existingDevice) {
    $deviceThumb = [IO.File]::ReadAllText($thumbFile).Trim()
    $deviceCert = Get-Item -LiteralPath "Cert:\CurrentUser\My\$deviceThumb"
    if (-not $deviceCert.HasPrivateKey) { throw 'STOP: device private key is missing.' }
} else {
    $deviceCert = New-SelfSignedCertificate -Type Custom -Subject 'CN=RAG1 Local Agent' -CertStoreLocation 'Cert:\CurrentUser\My' -Provider 'Microsoft Enhanced RSA and AES Cryptographic Provider' -KeyAlgorithm RSA -KeyLength 3072 -KeySpec KeyExchange -KeyExportPolicy NonExportable -KeyUsage DigitalSignature,KeyEncipherment -HashAlgorithm SHA256 -NotAfter (Get-Date).AddYears(3)
    $deviceThumb = $deviceCert.Thumbprint
}
& $channelExe init $Root $deviceThumb
if ($LASTEXITCODE -ne 0) { throw 'Agent state initialization failed; no runner started.' }
& $channelExe enroll $Root
if ($LASTEXITCODE -ne 0) { throw 'Encrypted enrollment upload failed. Re-run this script; the existing certificate and journal are kept.' }
if ($existingDevice) { Write-Host 'Existing device certificate and journal retained. No new pairing is required.' }
else { Write-Host 'Send the PAIRING_SHA256 line above to Claude (DHC CLI) once.' }
Write-Host 'Starting the agent. Keep this window open. Ctrl+C stops it.'
& $channelExe run $Root
exit $LASTEXITCODE
