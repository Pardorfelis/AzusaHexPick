param(
    [string[]]$Versions = @('0.7.911','0.7.912','0.7.913'),
    [string]$TestDirectory = (Join-Path $PSScriptRoot '../.runtime/update-v071-test'),
    [string]$BaseStageDirectory = (Join-Path $PSScriptRoot '../dist/windows-stage')
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$env:DOTNET_ROOT = Join-Path $projectRoot '.runtime/tools/dotnet'
$env:DOTNET_CLI_HOME = Join-Path $projectRoot '.runtime/tools/dotnet-home'
$env:NUGET_PACKAGES = Join-Path $projectRoot '.runtime/tools/nuget'
$dotnet = Join-Path $env:DOTNET_ROOT 'dotnet.exe'
$vpk = Join-Path $projectRoot '.runtime/tools/vpk/vpk.exe'
$testRoot = [System.IO.Path]::GetFullPath($TestDirectory)
if (-not $testRoot.StartsWith((Join-Path $projectRoot '.runtime') + [System.IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw '更新测试目录必须位于本项目的 .runtime 内。' }
$stage = Join-Path $testRoot 'stage'
$feed = Join-Path $testRoot 'feed'
foreach ($required in @('app/server.mjs','runtime/node.exe','runtime/desktop/AzusaPanel.exe')) {
    if (-not (Test-Path -LiteralPath (Join-Path $BaseStageDirectory $required) -PathType Leaf)) { throw "隔离测试基础目录缺少 $required，请传入已完整构建的目录。" }
}
New-Item -ItemType Directory -Force $stage,$feed | Out-Null
Copy-Item -Path (Join-Path $BaseStageDirectory '*') -Destination $stage -Recurse -Force
foreach ($version in $Versions) {
    & $dotnet publish (Join-Path $projectRoot 'launcher/AzusaHexPick.Launcher.csproj') -c Release -r win-x64 --self-contained true -o $stage "-p:Version=$version" '-p:DefineConstants=UPDATE_TESTING'
    if ($LASTEXITCODE -ne 0) { throw 'Test launcher build failed.' }
    # 与正式 staging 一致，Velopack 会剔除崩溃转储工具，清单生成前同步移除。
    $crashDump = Join-Path $stage 'createdump.exe'
    if (Test-Path -LiteralPath $crashDump -PathType Leaf) { Remove-Item -LiteralPath $crashDump }
    $manifestFiles = @(Get-ChildItem -LiteralPath $stage -Recurse -File | Where-Object {
        $relative = [System.IO.Path]::GetRelativePath($stage, $_.FullName).Replace('\','/')
        $relative -notin @('package-manifest.json','sq.version','Squirrel.exe') -and $relative -notmatch '^[^/]+_ExecutionStub\.exe$'
    } | ForEach-Object { [ordered]@{ path = [System.IO.Path]::GetRelativePath($stage, $_.FullName).Replace('\','/'); sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLower() } })
    [ordered]@{version=$version;platform='win-x64';selfContained=$true;personalDataIncluded=$false;files=$manifestFiles} |
        ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $stage 'package-manifest.json') -Encoding utf8NoBOM
    & $vpk pack --packId AzusaHexPickTest --packVersion $version --packDir $stage --mainExe '梓有妙选.exe' --packTitle 'Azusa HexPick isolated update test' --runtime win-x64 --outputDir $feed --channel win --icon (Join-Path $projectRoot 'launcher/Assets/app.ico')
    if ($LASTEXITCODE -ne 0) { throw 'Test package build failed.' }
    Copy-Item -LiteralPath (Join-Path $feed 'AzusaHexPickTest-win-Portable.zip') -Destination (Join-Path $feed "portable-$version.zip") -Force
}
Write-Output "Isolated update feed ready: $($Versions -join ', ')"
