param(
    [switch]$Publish,
    [string]$Bucket = 'azusa510-1500305922',
    [string]$Python
)

$ErrorActionPreference = 'Stop'
$publishRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$publishScript = Join-Path $PSScriptRoot 'deploy-cos.py'
if (-not $Python) {
    $publishBundledPython = Join-Path $publishRoot '.runtime/tools/py-build/Scripts/python.exe'
    if (Test-Path -LiteralPath $publishBundledPython -PathType Leaf) {
        $Python = $publishBundledPython
    } else {
        $publishPythonCommand = Get-Command python -ErrorAction SilentlyContinue
        if (-not $publishPythonCommand) { throw '找不到 Python，请按 docs/hosting-cos.md 准备维护环境。' }
        $Python = $publishPythonCommand.Source
    }
}

$publishVariableNames = @('PYTHONPATH', 'COS_BUCKET', 'COS_SECRET_ID', 'COS_SECRET_KEY', 'COS_SESSION_TOKEN')
$publishPreviousEnvironment = @{}
foreach ($publishVariableName in $publishVariableNames) {
    $publishPreviousEnvironment[$publishVariableName] = [Environment]::GetEnvironmentVariable($publishVariableName, 'Process')
}

function Set-PublishSessionSecret([string]$Name, [string]$Prompt) {
    $publishSecureValue = Read-Host $Prompt -AsSecureString
    if ($publishSecureValue.Length -eq 0) { throw '没有输入部署凭据，已停止上传。' }
    $publishSecretPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($publishSecureValue)
    try {
        [Environment]::SetEnvironmentVariable($Name,
            [Runtime.InteropServices.Marshal]::PtrToStringBSTR($publishSecretPointer), 'Process')
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($publishSecretPointer)
        $publishSecureValue.Dispose()
    }
}

try {
    $publishLocalSdk = Join-Path $publishRoot '.runtime/tools/cos-sdk'
    if (Test-Path -LiteralPath $publishLocalSdk -PathType Container) {
        $publishPythonPath = $publishLocalSdk
        if ($publishPreviousEnvironment['PYTHONPATH']) {
            $publishPythonPath += [IO.Path]::PathSeparator + $publishPreviousEnvironment['PYTHONPATH']
        }
        [Environment]::SetEnvironmentVariable('PYTHONPATH', $publishPythonPath, 'Process')
    }

    # 先检查本地文件，再请求凭据。默认运行不连接云端。
    & $Python $publishScript
    if ($LASTEXITCODE -ne 0) { throw '本地发布预检未通过，未请求凭据、未上传文件。' }
    if ($Publish) {
        $publishManifestPath = Join-Path $publishRoot 'dist/site/site-manifest.json'
        $publishManifest = Get-Content -LiteralPath $publishManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($publishManifest.formal -ne $true) { throw '当前是预览网站，请先完成正式构建；未请求凭据、未上传文件。' }
        & $Python -c "import importlib.metadata; import qcloud_cos; assert importlib.metadata.version('cos-python-sdk-v5') == '1.9.44', 'SDK version mismatch'"
        if ($LASTEXITCODE -ne 0) { throw '需要已验证的 COS SDK 1.9.44，请参考 docs/hosting-cos.md。' }
        if ($Bucket -notmatch '^[a-z0-9][a-z0-9-]*-[0-9]+$') { throw '请填写带 APPID 后缀的完整存储桶名称。' }
        [Environment]::SetEnvironmentVariable('COS_BUCKET', $Bucket, 'Process')
        [Environment]::SetEnvironmentVariable('COS_SESSION_TOKEN', $null, 'Process')
        Set-PublishSessionSecret 'COS_SECRET_ID' '输入部署子账号的 SecretId（仅在本机使用）'
        Set-PublishSessionSecret 'COS_SECRET_KEY' '输入部署子账号的 SecretKey（仅在本机使用）'
        & $Python $publishScript --publish
        if ($LASTEXITCODE -ne 0) { throw '上传或云端核验未完成，可按提示处理后重试。' }
    }
} finally {
    foreach ($publishVariableName in $publishVariableNames) {
        [Environment]::SetEnvironmentVariable($publishVariableName,
            $publishPreviousEnvironment[$publishVariableName], 'Process')
    }
}
