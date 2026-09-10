param([string]$SourcePath = (Join-Path $PSScriptRoot '../src-tauri/src/commands.rs'))
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$source = Get-Content -LiteralPath $SourcePath -Raw -Encoding UTF8
function Read-Handler([string]$eventName) {
  $pattern = '(?s)\$form\.Add_' + $eventName + '\(\{\r?\n(.*?)\r?\n\}\)'
  $match = [regex]::Match($source, $pattern)
  if (!$match.Success) { throw "Missing production handler: $eventName" }
  return [scriptblock]::Create($match.Groups[1].Value)
}
$paintFunction = [regex]::Match($source, '(?s)function Get-GifPSelectionPaintBounds\(.*?\r?\n\}')
if (!$paintFunction.Success) { throw 'Missing production paint bounds function' }
. ([scriptblock]::Create($paintFunction.Value))
$down = Read-Handler 'MouseDown'
$move = Read-Handler 'MouseMove'
$up = Read-Handler 'MouseUp'
$bounds = [System.Drawing.Rectangle]::new(-1920, -200, 3840, 1280)
$form = [pscustomobject]@{ Capture = $false }
$form | Add-Member ScriptMethod Invalidate {}
$hint = [pscustomobject]@{ Text = '' }
$confirmButton = [pscustomobject]@{ Visible = $false }
$confirmButton | Add-Member ScriptMethod Focus {}
$retryButton = [pscustomobject]@{ Visible = $false }
$cancelButton = [pscustomobject]@{ Visible = $false }
$script:start = $null
$script:current = $null
$script:dragging = $false
$script:selectionReady = $false
$script:pendingPaintBounds = [System.Drawing.Rectangle]::Empty
function Mouse($handler, [int]$x, [int]$y, [string]$button = 'Left') {
  $_ = [pscustomobject]@{ X = $x; Y = $y; Button = [System.Windows.Forms.MouseButtons]::$button }
  & $handler
}
function Assert($condition, [string]$message) { if (!$condition) { throw $message } }

# Reproduce the screenshot: an invalid release followed by free pointer movement.
Mouse $down 324 293
Mouse $up 330 300
Assert (!$script:selectionReady) 'Small release must be invalid'
Mouse $move 1478 953 'None'
Assert ($script:current.X -eq 330 -and $script:current.Y -eq 300) 'Released invalid box must not grow with hover'
Assert (!$confirmButton.Visible) 'Invalid box must not expose confirmation'

# A valid release must remain exactly the box that will be returned on confirmation.
Mouse $down 324 293
Assert $form.Capture 'Dragging must capture the pointer'
Mouse $move 1478 953
Mouse $up 1478 953
Assert ($script:selectionReady -and $confirmButton.Visible) '1154 x 660 must allow confirmation'
Assert (!$form.Capture -and !$script:dragging) 'Release must end capture and dragging'
Mouse $move 325 294 'None'
Mouse $up 325 294 'Right'
Assert ($script:current.X -eq 1478 -and $script:current.Y -eq 953) 'Hover and right release must not mutate a ready box'
Assert $script:selectionReady 'Confirmation state must remain valid'

# Reverse drag, exact minimum, and a virtual desktop with negative origin.
Mouse $down 500 400
Mouse $up 380 280
Assert $script:selectionReady 'Exactly 120 x 120 must be accepted in reverse direction'
$absoluteX = [Math]::Min($script:start.X, $script:current.X) + $bounds.X
$absoluteY = [Math]::Min($script:start.Y, $script:current.Y) + $bounds.Y
Assert ($absoluteX -eq -1540 -and $absoluteY -eq 80) 'Virtual desktop origin must remain physical coordinates'
Write-Output 'PASS: production MouseDown/Move/Up handlers; invalid hover, valid frozen selection, capture lifecycle, right release, reverse drag, minimum size, negative desktop origin.'
