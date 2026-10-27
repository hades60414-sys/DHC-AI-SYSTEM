# Image helper for the de-identification proxy (imgocr.cjs). Windows PowerShell 5.1, built-in parts only:
# Windows.Media.Ocr for text, System.Drawing for scaling and masking. No third-party code.
#   ocr  <image> <out.json>              words with boxes in original-image pixels, one engine per language
#   mask <image> <boxes.json> <out.img>  fills each box [x,y,w,h] with black, saves in the input's format
param([string]$Mode, [string]$In, [string]$A, [string]$B)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Save-Like($img, $path, $fmt) {
  if ($fmt.Guid -eq [System.Drawing.Imaging.ImageFormat]::Jpeg.Guid) {
    $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.FormatID -eq $fmt.Guid }
    $ep = New-Object System.Drawing.Imaging.EncoderParameters(1)
    $ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]90)
    $img.Save($path, $codec, $ep)
  } else { $img.Save($path, [System.Drawing.Imaging.ImageFormat]::Png) }
}

if ($Mode -eq 'mask') {
  $src = [System.Drawing.Image]::FromFile($In)
  $fmt = $src.RawFormat
  $bmp = New-Object System.Drawing.Bitmap($src.Width, $src.Height)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.DrawImage($src, 0, 0, $src.Width, $src.Height)
  $src.Dispose()
  foreach ($r in (ConvertFrom-Json ([IO.File]::ReadAllText($A, $utf8)))) { $g.FillRectangle([System.Drawing.Brushes]::Black, [int]$r[0], [int]$r[1], [int]$r[2], [int]$r[3]) }
  $g.Dispose()
  Save-Like $bmp $B $fmt
  $bmp.Dispose()
  exit 0
}

# ocr: small screenshots are scaled up first; Windows OCR misses text much under ~20 px tall.
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]
$null = [Windows.Media.FaceAnalysis.FaceDetector, Windows.Media.FaceAnalysis, ContentType = WindowsRuntime]
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } | Select-Object -First 1
function Await($op, [type]$t) { $task = $asTask.MakeGenericMethod($t).Invoke($null, @($op)); $null = $task.Wait(-1); $task.Result }

$src = [System.Drawing.Image]::FromFile($In)
$w0 = $src.Width; $h0 = $src.Height
$scale = 1
if ([Math]::Max($w0, $h0) * 2 -le [Windows.Media.Ocr.OcrEngine]::MaxImageDimension -and $w0 -lt 2000) { $scale = 2 }
$work = [IO.Path]::ChangeExtension($A, '.ocr.png')
$bmp = New-Object System.Drawing.Bitmap(($w0 * $scale), ($h0 * $scale))
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.Clear([System.Drawing.Color]::White)
$g.DrawImage($src, 0, 0, ($w0 * $scale), ($h0 * $scale))
$g.Dispose(); $src.Dispose()
$bmp.Save($work, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()

try {
  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($work)) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $dec = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $sb = Await ($dec.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $out = @()
  foreach ($tag in @('zh-Hant-TW', 'en-US')) {
    $eng = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage((New-Object Windows.Globalization.Language($tag)))
    if (-not $eng) { continue }
    $res = Await ($eng.RecognizeAsync($sb)) ([Windows.Media.Ocr.OcrResult])
    $lines = @()
    foreach ($ln in $res.Lines) {
      $lines += , @($ln.Words | ForEach-Object { $r = $_.BoundingRect; @{ t = $_.Text; b = @([int][Math]::Floor($r.X / $scale), [int][Math]::Floor($r.Y / $scale), [int][Math]::Ceiling($r.Width / $scale), [int][Math]::Ceiling($r.Height / $scale)) } })
    }
    $out += @{ lang = $tag; lines = $lines }
  }
  # Faces at least 40 px tall in the original image (smaller ones are chat avatars and icons).
  $fd = Await ([Windows.Media.FaceAnalysis.FaceDetector]::CreateAsync()) ([Windows.Media.FaceAnalysis.FaceDetector])
  $fd.MinDetectableFaceSize = New-Object Windows.Graphics.Imaging.BitmapSize -Property @{ Width = [uint32](40 * $scale); Height = [uint32](40 * $scale) }
  $gray = [Windows.Graphics.Imaging.SoftwareBitmap]::Convert($sb, [Windows.Graphics.Imaging.BitmapPixelFormat]::Gray8)
  $faces = @(Await ($fd.DetectFacesAsync($gray)) ([System.Collections.Generic.IList[Windows.Media.FaceAnalysis.DetectedFace]])).Count
  $stream.Dispose()
} finally { Remove-Item $work -ErrorAction SilentlyContinue }
[IO.File]::WriteAllText($A, (ConvertTo-Json @{ w = $w0; h = $h0; faces = $faces; engines = $out } -Depth 8 -Compress), $utf8)
