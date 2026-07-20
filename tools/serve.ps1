param(
  [int]$Port = 8765
)

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$address = [System.Net.IPAddress]::Parse("127.0.0.1")
$listener = [System.Net.Sockets.TcpListener]::new($address, $Port)
$listener.Start()
Write-Output "Serving $root at http://127.0.0.1:$Port/"

$mime = @{
  ".html" = "text/html; charset=utf-8"
  ".js" = "text/javascript; charset=utf-8"
  ".css" = "text/css; charset=utf-8"
  ".json" = "application/json; charset=utf-8"
  ".csv" = "text/csv; charset=utf-8"
}

try {
  while ($true) {
    $client = $listener.AcceptTcpClient()
    $stream = $client.GetStream()
    $reader = [IO.StreamReader]::new($stream, [Text.Encoding]::ASCII, $false, 1024, $true)
    $requestLine = $reader.ReadLine()
    while ($reader.ReadLine()) { }
    $requestTarget = ($requestLine -split " ")[1]
    $requestPath = ($requestTarget -split "\?")[0]
    $relative = [Uri]::UnescapeDataString($requestPath.TrimStart("/"))
    if ([string]::IsNullOrWhiteSpace($relative)) { $relative = "tests/index.html" }
    $candidate = [IO.Path]::GetFullPath((Join-Path $root $relative))
    if (-not $candidate.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
      $header = [Text.Encoding]::ASCII.GetBytes("HTTP/1.1 404 Not Found`r`nContent-Length: 0`r`nConnection: close`r`n`r`n")
      $stream.Write($header, 0, $header.Length)
      $client.Close()
      continue
    }
    $extension = [IO.Path]::GetExtension($candidate).ToLowerInvariant()
    $contentType = if ($mime.ContainsKey($extension)) { $mime[$extension] } else { "application/octet-stream" }
    $bytes = [IO.File]::ReadAllBytes($candidate)
    $headerText = "HTTP/1.1 200 OK`r`nContent-Type: $contentType`r`nContent-Length: $($bytes.Length)`r`nConnection: close`r`n`r`n"
    $header = [Text.Encoding]::ASCII.GetBytes($headerText)
    $stream.Write($header, 0, $header.Length)
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush()
    $client.Close()
  }
} finally {
  $listener.Stop()
}
