$ErrorActionPreference = 'Stop'
try {
    $serviceHealth = Invoke-RestMethod -Uri 'http://127.0.0.1:5178/api/health' -TimeoutSec 2
    if ($serviceHealth.app -ne 'azusa-validation') { throw '目标不是本项目服务。' }
    $body = @{action='shutdown'} | ConvertTo-Json -Compress
    Invoke-RestMethod -Uri 'http://127.0.0.1:5178/api/control' -Method Post -Headers @{'X-Panel-Control'='1'} -ContentType 'application/json' -Body $body -TimeoutSec 3 | Out-Null
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        Start-Sleep -Milliseconds 100
        try { Invoke-RestMethod -Uri 'http://127.0.0.1:5178/api/health' -TimeoutSec 1 | Out-Null }
        catch { break }
    }
    Write-Output '已请求停止服务。桌面助手会在持续失联约 10 秒后退出。'
} catch { Write-Output '服务未运行，或当前无法连接。' }
