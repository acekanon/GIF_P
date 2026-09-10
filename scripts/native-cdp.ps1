param(
  [int]$Port = 9223,
  [string]$Expression = "({ title: document.title, url: location.href })",
  [string]$ScreenshotPath = ""
)

$ErrorActionPreference = "Stop"

$targets = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json" -TimeoutSec 5
$target = $targets | Where-Object {
  $_.type -eq "page" -and $_.url -match "localhost:1420|127\.0\.0\.1:1420|tauri\.localhost|tauri://localhost"
} | Select-Object -First 1
if (-not $target) {
  throw "No GIFP WebView target found on CDP port $Port"
}

$socket = [System.Net.WebSockets.ClientWebSocket]::new()
$cancellation = [Threading.CancellationToken]::None
$socket.ConnectAsync([Uri]$target.webSocketDebuggerUrl, $cancellation).GetAwaiter().GetResult()
$messageId = 0

function Send-CdpCommand {
  param(
    [Parameter(Mandatory = $true)][string]$Method,
    [hashtable]$Params = @{}
  )

  $script:messageId += 1
  $id = $script:messageId
  $payload = @{
    id = $id
    method = $Method
    params = $Params
  } | ConvertTo-Json -Compress -Depth 30
  $bytes = [Text.Encoding]::UTF8.GetBytes($payload)
  $segment = [ArraySegment[byte]]::new($bytes)
  $socket.SendAsync($segment, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, $cancellation).GetAwaiter().GetResult()

  while ($true) {
    $stream = [IO.MemoryStream]::new()
    try {
      do {
        $buffer = New-Object byte[] 65536
        $receiveSegment = [ArraySegment[byte]]::new($buffer)
        $receive = $socket.ReceiveAsync($receiveSegment, $cancellation).GetAwaiter().GetResult()
        if ($receive.MessageType -eq [System.Net.WebSockets.WebSocketMessageType]::Close) {
          throw "CDP socket closed before command $Method completed"
        }
        $stream.Write($buffer, 0, $receive.Count)
      } while (-not $receive.EndOfMessage)

      $text = [Text.Encoding]::UTF8.GetString($stream.ToArray())
      $message = $text | ConvertFrom-Json
      if ($message.id -ne $id) {
        continue
      }
      if ($message.error) {
        throw "CDP $Method failed: $($message.error.message)"
      }
      return $message.result
    } finally {
      $stream.Dispose()
    }
  }
}

try {
  Send-CdpCommand -Method "Runtime.enable" | Out-Null
  Send-CdpCommand -Method "Page.enable" | Out-Null
  $evaluation = Send-CdpCommand -Method "Runtime.evaluate" -Params @{
    expression = $Expression
    returnByValue = $true
    awaitPromise = $true
  }

  if ($evaluation.exceptionDetails) {
    throw "Runtime evaluation failed: $($evaluation.exceptionDetails.text)"
  }

  if ($ScreenshotPath) {
    $shot = Send-CdpCommand -Method "Page.captureScreenshot" -Params @{
      format = "png"
      fromSurface = $true
    }
    $absoluteScreenshot = [IO.Path]::GetFullPath($ScreenshotPath)
    $parent = Split-Path -Parent $absoluteScreenshot
    if ($parent) {
      New-Item -ItemType Directory -Force -Path $parent | Out-Null
    }
    [IO.File]::WriteAllBytes($absoluteScreenshot, [Convert]::FromBase64String($shot.data))
  }

  $evaluation.result.value | ConvertTo-Json -Compress -Depth 30
} finally {
  if ($socket.State -eq [System.Net.WebSockets.WebSocketState]::Open) {
    $socket.CloseAsync([System.Net.WebSockets.WebSocketCloseStatus]::NormalClosure, "done", $cancellation).GetAwaiter().GetResult()
  }
  $socket.Dispose()
}
