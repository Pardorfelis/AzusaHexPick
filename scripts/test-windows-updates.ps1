param([string[]]$Versions = @('0.7.901','0.7.902'))
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$env:DOTNET_ROOT = Join-Path $projectRoot '.runtime/tools/dotnet'
$env:DOTNET_CLI_HOME = Join-Path $projectRoot '.runtime/tools/dotnet-home'
$env:NUGET_PACKAGES = Join-Path $projectRoot '.runtime/tools/nuget'
$dotnet = Join-Path $env:DOTNET_ROOT 'dotnet.exe'
$vpk = Join-Path $projectRoot '.runtime/tools/vpk/vpk.exe'
$stage = Join-Path $projectRoot '.runtime/update-test-stage'
$feed = Join-Path $projectRoot '.runtime/update-test-feed'
New-Item -ItemType Directory -Force $stage,$feed | Out-Null
Copy-Item -Path (Join-Path $projectRoot 'dist/windows-stage/*') -Destination $stage -Recurse -Force
foreach ($version in $Versions) {
    & $dotnet publish (Join-Path $projectRoot 'launcher/AzusaHexPick.Launcher.csproj') -c Release -r win-x64 --self-contained true -o $stage "-p:Version=$version" '-p:DefineConstants=UPDATE_TESTING'
    if ($LASTEXITCODE -ne 0) { throw 'Test launcher build failed.' }
    & $vpk pack --packId AzusaHexPickTest --packVersion $version --packDir $stage --mainExe '梓有妙选.exe' --packTitle 'Azusa HexPick isolated update test' --runtime win-x64 --outputDir $feed --channel win --icon (Join-Path $projectRoot 'launcher/Assets/app.ico')
    if ($LASTEXITCODE -ne 0) { throw 'Test package build failed.' }
    Copy-Item -LiteralPath (Join-Path $feed 'AzusaHexPickTest-win-Portable.zip') -Destination (Join-Path $feed "portable-$version.zip") -Force
}
Write-Output "Isolated update feed ready: $($Versions -join ', ')"
