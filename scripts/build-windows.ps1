param(
    [string]$Dotnet = (Join-Path $PSScriptRoot '../.runtime/tools/dotnet/dotnet.exe'),
    [string]$Python = (Join-Path $PSScriptRoot '../.runtime/tools/py-build/Scripts/python.exe'),
    [string]$Vpk = (Join-Path $PSScriptRoot '../.runtime/tools/vpk/vpk.exe'),
    [string]$Node = (Get-Command node).Source,
    [switch]$SkipPack
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$stage = Join-Path $projectRoot 'dist/windows-stage'
$release = Join-Path $projectRoot 'dist/releases'
$appVersion = (Get-Content -Raw (Join-Path $projectRoot 'package.json') | ConvertFrom-Json).version
$env:DOTNET_ROOT = Split-Path -Parent ([System.IO.Path]::GetFullPath($Dotnet))
$env:DOTNET_CLI_HOME = Join-Path $projectRoot '.runtime/tools/dotnet-home'
$env:NUGET_PACKAGES = Join-Path $projectRoot '.runtime/tools/nuget'
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
if (Test-Path -LiteralPath $stage) {
    $resolved = (Resolve-Path -LiteralPath $stage).Path
    if ($resolved -ne ([System.IO.Path]::GetFullPath((Join-Path $projectRoot 'dist/windows-stage')))) { throw '构建目录不符合预期。' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
& $Dotnet publish (Join-Path $projectRoot 'launcher/AzusaHexPick.Launcher.csproj') -c Release -r win-x64 --self-contained true -o $stage "-p:Version=$appVersion"
if ($LASTEXITCODE -ne 0) { throw '启动器构建失败。' }
& $Python -m PyInstaller --noconfirm --clean --windowed --onedir --name AzusaPanel --icon (Join-Path $projectRoot 'launcher/Assets/app.ico') --distpath (Join-Path $projectRoot '.runtime/desktop-build/dist') --workpath (Join-Path $projectRoot '.runtime/desktop-build/work') --specpath (Join-Path $projectRoot '.runtime/desktop-build') --paths (Join-Path $projectRoot 'scripts') (Join-Path $projectRoot 'scripts/desktop-panel.py')
if ($LASTEXITCODE -ne 0) { throw '桌面副屏构建失败。' }
New-Item -ItemType Directory -Force (Join-Path $stage 'runtime') | Out-Null
Copy-Item -LiteralPath $Node -Destination (Join-Path $stage 'runtime/node.exe')
Copy-Item -LiteralPath (Join-Path $projectRoot '.runtime/desktop-build/dist/AzusaPanel') -Destination (Join-Path $stage 'runtime/desktop') -Recurse
& $Python (Join-Path $projectRoot 'scripts/stage-windows.py') $stage
if ($LASTEXITCODE -ne 0) { throw '应用资源校验失败。' }
if (-not $SkipPack) {
    New-Item -ItemType Directory -Force $release | Out-Null
    & $Vpk pack --packId AzusaHexPickApp --packVersion $appVersion --packDir $stage --mainExe '梓有妙选.exe' --packTitle '梓有妙选' --runtime win-x64 --icon (Join-Path $projectRoot 'launcher/Assets/app.ico') --outputDir $release --channel win --releaseNotes (Join-Path $projectRoot 'docs/release-v0.7.0.md')
    if ($LASTEXITCODE -ne 0) { throw '应用更新包构建失败。' }
    Get-ChildItem -LiteralPath $release -File | Where-Object Extension -In '.zip','.nupkg','.exe','.json' | ForEach-Object {
        $hash = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLower()
        [System.IO.File]::WriteAllText($_.FullName + '.sha256', $hash + '  ' + $_.Name + "`n")
    }
}
Write-Output "Windows 应用构建完成：$appVersion"
