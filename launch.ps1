param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$healthUrl = 'http://127.0.0.1:8080/health'
function Get-BridgeHealth {
    try { return Invoke-RestMethod -Uri $healthUrl -TimeoutSec 1 } catch { return $null }
}
try {
    $health = Get-BridgeHealth
    if ($health -and ($health.service -ne 'hemis-planner-bridge' -or $health.version -ne '2026.10.20.5')) {
        throw 'An older or different server is running on port 8080. Run stop.bat, then start.bat from the updated folder.'
    }
    if (!$health) {
        $serverScript = Join-Path $PSScriptRoot 'server.ps1'
        $arguments = '-NoProfile -ExecutionPolicy Bypass -File ' + [char]34 + $serverScript + [char]34
        $process = Start-Process -FilePath powershell.exe -WindowStyle Hidden -ArgumentList $arguments -PassThru
        $deadline = [DateTime]::UtcNow.AddSeconds(10)
        do {
            Start-Sleep -Milliseconds 250
            $health = Get-BridgeHealth
        } while (!$health -and !$process.HasExited -and [DateTime]::UtcNow -lt $deadline)
    }
    if (!$health -or $health.service -ne 'hemis-planner-bridge' -or $health.version -ne '2026.10.20.5') {
        throw 'The bridge did not start. Port 8080 may be occupied. Run stop.bat and try start.bat again.'
    }
    Write-Output 'HEMIS Planner bridge is ready: http://127.0.0.1:8080/'
    if (!$NoBrowser) { Start-Process 'http://127.0.0.1:8080/#connection' }
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
