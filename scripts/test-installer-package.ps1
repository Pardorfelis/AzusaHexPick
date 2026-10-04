param(
    [Parameter(Mandatory=$true)][string]$ReleaseDirectory,
    [string]$StageDirectory = (Join-Path $PSScriptRoot '../dist/windows-stage'),
    [string]$Version = '0.7.1',
    [string]$TestDirectory = (Join-Path $PSScriptRoot '../.runtime/installer-package-test')
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$testRoot = [System.IO.Path]::GetFullPath($TestDirectory)
if (-not $testRoot.StartsWith((Join-Path $projectRoot '.runtime') + [System.IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw '安装包校验目录必须位于本项目的 .runtime 内。' }
New-Item -ItemType Directory -Force -Path $testRoot | Out-Null
$originalFull = Join-Path $ReleaseDirectory "AzusaHexPickApp-$Version-full.nupkg"
$originalPayload = Join-Path $ReleaseDirectory 'AzusaHexPickApp-win-Setup.exe'
$full = Join-Path $testRoot "AzusaHexPickApp-$Version-full.nupkg"
$payload = Join-Path $testRoot 'AzusaHexPickApp-win-Setup.exe'
[System.IO.File]::WriteAllText($payload, 'synthetic-invalid-setup-for-negative-tests')
Add-Type -AssemblyName System.IO.Compression.FileSystem
$results = [System.Collections.Generic.List[object]]::new()

function Add-ZipText($archive, [string]$Name, [string]$Text) {
    $existing = $archive.GetEntry($Name)
    if ($null -ne $existing) { $existing.Delete() }
    $entry = $archive.CreateEntry($Name, [System.IO.Compression.CompressionLevel]::Fastest)
    $writer = [System.IO.StreamWriter]::new($entry.Open(), [System.Text.UTF8Encoding]::new($false))
    try { $writer.Write($Text) } finally { $writer.Dispose() }
}
function Read-ZipText($archive, [string]$Name) {
    $reader = [System.IO.StreamReader]::new($archive.GetEntry($Name).Open())
    try { return $reader.ReadToEnd() } finally { $reader.Dispose() }
}
function Assert-Rejected([string]$Name, [string]$Expected, [scriptblock]$Mutation) {
    Copy-Item -LiteralPath $originalFull -Destination $full -Force
    $archive = [System.IO.Compression.ZipFile]::Open($full, [System.IO.Compression.ZipArchiveMode]::Update)
    try { & $Mutation $archive } finally { $archive.Dispose() }
    $message = ''
    try { & (Join-Path $PSScriptRoot 'build-installer.ps1') -Version $Version -Payload $payload -StageDirectory $StageDirectory -OutputDirectory $testRoot -AllowUnconfiguredSite -ValidateOnly | Out-Null }
    catch { $message = $_.Exception.Message }
    if (-not $message.Contains($Expected)) { throw "场景 $Name 未按预期拒绝：$message" }
    $results.Add(@{scenario=$Name;success=$true})
    Write-Output "PASS $Name"
}

& (Join-Path $PSScriptRoot 'build-installer.ps1') -Version $Version -Payload $originalPayload -StageDirectory $StageDirectory -OutputDirectory $testRoot -AllowUnconfiguredSite -ValidateOnly | Out-Null
$results.Add(@{scenario='real-payload-verified';success=$true})
Write-Output 'PASS real-payload-verified'

Assert-Rejected 'private-file-unlisted' '私人文件' { param($archive) Add-ZipText $archive 'lib/app/app/.env.local' 'SYNTHETIC_NO_SECRET' }
Assert-Rejected 'encrypted-key-unlisted' '私人文件' { param($archive) Add-ZipText $archive 'lib/app/deepseek.key' 'SYNTHETIC_NO_SECRET' }
Assert-Rejected 'private-file-declared' '私人文件' {
    param($archive)
    $text = 'SYNTHETIC_NO_SECRET'
    Add-ZipText $archive 'lib/app/app/.env.local' $text
    $manifest = Read-ZipText $archive 'lib/app/package-manifest.json' | ConvertFrom-Json
    $hash = [Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData([System.Text.Encoding]::UTF8.GetBytes($text))).ToLower()
    $manifest.files = @($manifest.files) + @{path='app/.env.local';sha256=$hash}
    Add-ZipText $archive 'lib/app/package-manifest.json' ($manifest | ConvertTo-Json -Depth 8)
}
Assert-Rejected 'empty-manifest' '交付类型不符' {
    param($archive)
    $manifest = Read-ZipText $archive 'lib/app/package-manifest.json' | ConvertFrom-Json
    $manifest.files = @()
    Add-ZipText $archive 'lib/app/package-manifest.json' ($manifest | ConvertTo-Json -Depth 8)
}
Assert-Rejected 'unlisted-application-file' '清单之外' { param($archive) Add-ZipText $archive 'lib/app/app/unknown.txt' 'synthetic-test' }
Assert-Rejected 'case-duplicate-path' '重复路径' { param($archive) Add-ZipText $archive 'lib/app/APP/DELIVERY.JSON' '{}' }
Assert-Rejected 'modified-content' '内容与清单不一致' { param($archive) Add-ZipText $archive 'lib/app/app/delivery.json' '{}' }
Assert-Rejected 'missing-core-file' '核心文件' {
    param($archive)
    $manifest = Read-ZipText $archive 'lib/app/package-manifest.json' | ConvertFrom-Json
    $manifest.files = @($manifest.files | Where-Object path -ne 'runtime/node.exe')
    $archive.GetEntry('lib/app/runtime/node.exe').Delete()
    Add-ZipText $archive 'lib/app/package-manifest.json' ($manifest | ConvertTo-Json -Depth 8)
}
Assert-Rejected 'wrong-package-identity' '身份登记不符' {
    param($archive)
    $xml = Read-ZipText $archive 'lib/app/sq.version'
    Add-ZipText $archive 'lib/app/sq.version' ($xml.Replace('<id>AzusaHexPickApp</id>','<id>UnrelatedApplication</id>'))
}
Assert-Rejected 'unrelated-setup-payload' '载荷不完整' { param($archive) }
[System.IO.File]::WriteAllText((Join-Path $testRoot 'result.json'), (@{version=$Version;testInstallOnly=$true;results=$results} | ConvertTo-Json -Depth 6))
