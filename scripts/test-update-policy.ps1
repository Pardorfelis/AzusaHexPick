param([string]$Dotnet = (Join-Path $PSScriptRoot '../.runtime/tools/dotnet/dotnet.exe'))
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$env:DOTNET_ROOT = Split-Path -Parent ([System.IO.Path]::GetFullPath($Dotnet))
$env:DOTNET_CLI_HOME = Join-Path $projectRoot '.runtime/tools/dotnet-home'
$env:NUGET_PACKAGES = Join-Path $projectRoot '.runtime/tools/nuget'
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
$env:AZUSA_POLICY_TEST_DIR = Join-Path $projectRoot '.runtime/update-policy-check'
New-Item -ItemType Directory -Force -Path $env:AZUSA_POLICY_TEST_DIR | Out-Null
& $Dotnet run --project (Join-Path $PSScriptRoot 'update-policy-check/PolicyCheck.csproj') -c Release
if ($LASTEXITCODE -ne 0) { throw '更新来源策略验证失败。' }
