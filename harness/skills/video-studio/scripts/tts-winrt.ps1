# Offline Windows OneCore voice (PowerShell 5.1). Writes a WAV plus word timings JSON: [{t,d,text,offset}].
param(
  [Parameter(Mandatory)][string]$TextFile,
  [Parameter(Mandatory)][string]$Voice,
  [Parameter(Mandatory)][string]$Out,
  [Parameter(Mandatory)][string]$Meta,
  [double]$Rate = 1.0
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime]
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]
function Await($op, [Type]$type) { $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(-1) | Out-Null; $t.Result }

$text = [IO.File]::ReadAllText($TextFile, [Text.Encoding]::UTF8)
$synth = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer
$synth.Voice = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices | Where-Object { $_.DisplayName -eq $Voice } | Select-Object -First 1
if (-not $synth.Voice) { throw "voice not installed: $Voice" }
$synth.Options.IncludeWordBoundaryMetadata = $true
$synth.Options.SpeakingRate = $Rate
$stream = Await ($synth.SynthesizeTextToStreamAsync($text)) ([Windows.Media.SpeechSynthesis.SpeechSynthesisStream])

$words = New-Object System.Collections.ArrayList
foreach ($track in $stream.TimedMetadataTracks) {
  foreach ($cue in $track.Cues) {
    [void]$words.Add([ordered]@{ t = $cue.StartTime.TotalSeconds; d = $cue.Duration.TotalSeconds; text = $cue.Text; offset = $cue.StartPositionInInput })
  }
}
$reader = New-Object Windows.Storage.Streams.DataReader($stream.GetInputStreamAt(0))
$n = Await ($reader.LoadAsync([uint32]$stream.Size)) ([uint32])
$bytes = New-Object byte[] $n
$reader.ReadBytes($bytes)
[IO.File]::WriteAllBytes($Out, $bytes)
[IO.File]::WriteAllText($Meta, (ConvertTo-Json -InputObject @($words) -Depth 3), (New-Object Text.UTF8Encoding $false))
