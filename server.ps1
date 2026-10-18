# Локальный сервер и прокси для обхода CORS серверов HEMIS (.uz)
$port = 8080
$root = $PSScriptRoot
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://127.0.0.1:$port/")
$listener.Prefixes.Add("http://localhost:$port/")
$listener.Start()

Write-Host "=====================================================" -ForegroundColor Cyan
Write-Host " HEMIS Planner запущен: http://localhost:$port" -ForegroundColor Green
Write-Host " Локальный мост к серверам HEMIS (.uz) активен!" -ForegroundColor Green
Write-Host "=====================================================" -ForegroundColor Cyan

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

while ($listener.IsListening) {
  try {
    $context = $listener.GetContext()
    $req = $context.Request
    $res = $context.Response

    # Разрешаем CORS для любых вкладок (включая file:// и github.io)
    $res.Headers.Add("Access-Control-Allow-Origin", "*")
    $res.Headers.Add("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
    $res.Headers.Add("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept, X-Target-Url")

    if ($req.HttpMethod -eq "OPTIONS") {
      $res.StatusCode = 204
      $res.Close()
      continue
    }

    $path = $req.Url.LocalPath

    # Прокси-маршрут к серверам HEMIS (.uz) напрямую с компьютера пользователя
    if ($path -eq "/hemis-proxy") {
      $targetUrl = $req.QueryString["url"]
      if (-not $targetUrl) {
        $targetUrl = $req.Headers["X-Target-Url"]
      }

      if (-not $targetUrl) {
        $res.StatusCode = 400
        $errBytes = [System.Text.Encoding]::UTF8.GetBytes('{"success":false,"error":"Missing url parameter"}')
        $res.OutputStream.Write($errBytes, 0, $errBytes.Length)
        $res.Close()
        continue
      }

      $bodyStr = $null
      if ($req.HasEntityBody) {
        $reader = New-Object System.IO.StreamReader($req.InputStream, [System.Text.Encoding]::UTF8)
        $bodyStr = $reader.ReadToEnd()
        $reader.Close()
      }

      $webReq = [System.Net.HttpWebRequest]::Create($targetUrl)
      $webReq.Method = $req.HttpMethod
      $webReq.Accept = "application/json"
      $webReq.UserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) HemisPlanner/1.0"

      $authHeader = $req.Headers["Authorization"]
      if ($authHeader) {
        $webReq.Headers.Add("Authorization", $authHeader)
      }

      if ($bodyStr -and ($req.HttpMethod -eq "POST" -or $req.HttpMethod -eq "PUT" -or $req.HttpMethod -eq "PATCH")) {
        $webReq.ContentType = "application/json; charset=utf-8"
        $bodyBytes = [System.Text.Encoding]::UTF8.GetBytes($bodyStr)
        $webReq.ContentLength = $bodyBytes.Length
        $reqStream = $webReq.GetRequestStream()
        $reqStream.Write($bodyBytes, 0, $bodyBytes.Length)
        $reqStream.Close()
      }

      try {
        $webRes = $webReq.GetResponse()
        $res.StatusCode = [int]$webRes.StatusCode
        $res.ContentType = "application/json; charset=utf-8"
        $resStream = $webRes.GetResponseStream()
        $resStream.CopyTo($res.OutputStream)
        $webRes.Close()
      } catch [System.Net.WebException] {
        if ($_.Exception.Response) {
          $errResp = $_.Exception.Response
          $res.StatusCode = [int]$errResp.StatusCode
          $res.ContentType = "application/json; charset=utf-8"
          $errStream = $errResp.GetResponseStream()
          $errStream.CopyTo($res.OutputStream)
          $errResp.Close()
        } else {
          $res.StatusCode = 502
          $msg = $_.Exception.Message -replace '"', '\"'
          $errBytes = [System.Text.Encoding]::UTF8.GetBytes("{`"success`":false,`"error`":`"$msg`"}")
          $res.OutputStream.Write($errBytes, 0, $errBytes.Length)
        }
      }

      $res.Close()
      continue
    }

    # Раздача статических файлов сайта
    $relPath = if ($path -eq "/" -or $path -eq "") { "index.html" } else { $path.TrimStart('/') }
    $filePath = Join-Path $root ($relPath -replace '/', '\')

    if (Test-Path $filePath -PathType Leaf) {
      $ext = [System.IO.Path]::GetExtension($filePath).ToLower()
      $mime = switch ($ext) {
        ".html" { "text/html; charset=utf-8" }
        ".css"  { "text/css; charset=utf-8" }
        ".js"   { "application/javascript; charset=utf-8" }
        ".json" { "application/json; charset=utf-8" }
        ".svg"  { "image/svg+xml" }
        default { "application/octet-stream" }
      }
      $res.ContentType = $mime
      $bytes = [System.IO.File]::ReadAllBytes($filePath)
      $res.ContentLength64 = $bytes.Length
      $res.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
      $res.StatusCode = 404
    }
    $res.Close()
  } catch {
    # Продолжаем работу при единичной ошибке соединения
  }
}
