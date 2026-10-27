# Export a PowerPoint deck for video work (PowerPoint COM, PowerShell 5.1): slide-NN.png at 1920x1080 plus slides.json
# with each slide's title, body text, and speaker notes. Opens the deck read-only and only quits PowerPoint if it started it.
param(
  [Parameter(Mandatory)][string]$Pptx,
  [Parameter(Mandatory)][string]$Out,
  [int]$Width = 1920,
  [int]$Height = 1080
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force $Out | Out-Null
$wasRunning = [bool](Get-Process POWERPNT -ErrorAction SilentlyContinue)
$app = New-Object -ComObject PowerPoint.Application
try {
  $pres = $app.Presentations.Open((Resolve-Path $Pptx).Path, -1, 0, 0)
  $slides = New-Object System.Collections.ArrayList
  foreach ($s in $pres.Slides) {
    $n = '{0:D2}' -f $s.SlideIndex
    $s.Export((Join-Path $Out "slide-$n.png"), 'PNG', $Width, $Height)
    $texts = @(foreach ($sh in $s.Shapes) { if ($sh.HasTextFrame -and $sh.TextFrame.HasText) { $sh.TextFrame.TextRange.Text.Trim() } })
    $notes = ''
    try { $notes = $s.NotesPage.Shapes.Placeholders.Item(2).TextFrame.TextRange.Text.Trim() } catch { }
    [void]$slides.Add([ordered]@{ index = $s.SlideIndex; image = "slide-$n.png"; title = $(if ($texts.Count) { $texts[0] } else { '' }); text = $texts; notes = $notes })
  }
  $pres.Close()
  [IO.File]::WriteAllText((Join-Path $Out 'slides.json'), (ConvertTo-Json -InputObject @($slides) -Depth 4), (New-Object Text.UTF8Encoding $false))
  "exported $($slides.Count) slides to $Out"
} finally {
  if (-not $wasRunning) { $app.Quit() }
  [void][Runtime.InteropServices.Marshal]::ReleaseComObject($app)
}
