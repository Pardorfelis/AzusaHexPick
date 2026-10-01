param([switch]$Phone, [switch]$NoBrowser, [switch]$NoDesktop)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$runtimeDirectory = Join-Path $projectRoot '.runtime'
New-Item -ItemType Directory -Force -Path $runtimeDirectory | Out-Null
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) { throw '需要 Node.js 22 或更高版本。' }
$nodeVersion = & $nodeCommand.Source -p 'process.versions.node'
if ([int]($nodeVersion.Split('.')[0]) -lt 22) { throw '需要 Node.js 22 或更高版本。' }
$serviceUrl = 'http://127.0.0.1:5178'
$serviceHealth = $null
try { $serviceHealth = Invoke-RestMethod -Uri "$serviceUrl/api/health" -TimeoutSec 2 } catch {}
if ($serviceHealth -and $serviceHealth.app -ne 'azusa-validation') { throw '端口 5178 被其他服务占用。' }
if ($serviceHealth -and $Phone -and -not $serviceHealth.lanEnabled) {
    throw '服务正在本机模式运行。请先运行停止脚本，再使用手机模式启动。'
}
if (-not $serviceHealth) {
    $serverScript = Join-Path $projectRoot 'server.mjs'
    $serverArguments = @('"' + $serverScript + '"')
    if ($Phone) { $serverArguments += '--lan' }
    Start-Process -FilePath $nodeCommand.Source -ArgumentList $serverArguments -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtimeDirectory 'server.log') -RedirectStandardError (Join-Path $runtimeDirectory 'server-error.log') | Out-Null
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        Start-Sleep -Milliseconds 200
        try {
            $serviceHealth = Invoke-RestMethod -Uri "$serviceUrl/api/health" -TimeoutSec 1
            break
        } catch {}
    }
    if (-not $serviceHealth) { throw '服务未启动，请查看 .runtime 中的日志。' }
}
if (-not $NoDesktop) {
    $pythonCommand = Get-Command pythonw -ErrorAction SilentlyContinue
    if (-not $pythonCommand) {
        $pythonConsole = Get-Command python -ErrorAction SilentlyContinue
        if ($pythonConsole) {
            $pythonCandidate = Join-Path (Split-Path -Parent $pythonConsole.Source) 'pythonw.exe'
            if (Test-Path -LiteralPath $pythonCandidate) { $pythonExecutable = $pythonCandidate }
            else { $pythonExecutable = $pythonConsole.Source }
        }
    } else { $pythonExecutable = $pythonCommand.Source }
    if (-not $pythonExecutable) { Write-Output '未找到 Python，网页仍可使用；桌面窗需要带 Tkinter 的 Python 3。' }
    else {
        $desktopScript = Join-Path $projectRoot 'scripts/desktop-panel.py'
        $state = Invoke-RestMethod -Uri "$serviceUrl/api/state" -TimeoutSec 2
        if (-not $state.helperConnected) {
            Start-Process -FilePath $pythonExecutable -ArgumentList @('-X', 'utf8', ('"' + $desktopScript + '"')) -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtimeDirectory 'desktop.log') -RedirectStandardError (Join-Path $runtimeDirectory 'desktop-error.log') | Out-Null
        }
    }
}
if (-not $NoBrowser) { Start-Process -FilePath $serviceUrl }
Write-Output '梓有妙选服务已启动。桌面助手启动情况可在操作台查看。'
