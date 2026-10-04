param(
    [string]$Compiler = (Join-Path $PSScriptRoot '../.runtime/tools/inno/compiler/{app}/ISCC.exe'),
    [string]$Payload = (Join-Path $PSScriptRoot '../dist/releases/AzusaHexPickApp-win-Setup.exe'),
    [string]$OutputDirectory = (Join-Path $PSScriptRoot '../dist/releases'),
    [string]$StageDirectory = (Join-Path $PSScriptRoot '../dist/windows-stage'),
    [string]$Version = '',
    [switch]$AllowUnconfiguredSite,
    [switch]$ValidateOnly
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
if ($Version -eq '') { $Version = (Get-Content -Raw -LiteralPath (Join-Path $projectRoot 'package.json') | ConvertFrom-Json).version }
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw '安装包版本必须是稳定的三段版本号。' }
if (-not (Test-Path -LiteralPath $Compiler -PathType Leaf)) { throw '未找到 Inno Setup 6.7 或更新版本的编译器，请通过 -Compiler 指定。' }
if (-not (Test-Path -LiteralPath $Payload -PathType Leaf)) { throw '请先使用 Velopack 构建内部 Setup。' }
$fullPackage = Join-Path (Split-Path -Parent ([System.IO.Path]::GetFullPath($Payload))) "AzusaHexPickApp-$Version-full.nupkg"
$stageDelivery = Join-Path $StageDirectory 'app/delivery.json'
$evidence = $null
if ((Test-Path -LiteralPath $fullPackage -PathType Leaf) -and (Test-Path -LiteralPath $stageDelivery -PathType Leaf)) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::OpenRead($fullPackage)
    $hasher = [System.Security.Cryptography.SHA256]::Create()
    try {
        $names = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
        foreach ($entry in $archive.Entries) {
            if (-not $names.Add($entry.FullName)) { throw '完整更新包存在重复路径。' }
            if ($entry.FullName -match '(^[/\\]|\\|:|(^|/)\.\.(/|$))' -or
                $entry.FullName -match '(?i)(^|/)(\.env(?:\.[^/]*)?|(?:AGENTS|CLAUDE|GEMINI)\.md|\.agents|\.codex|\.claude|\.git|\.impeccable|user-data|userdata|temp|config\.local\.json|deepseek\.key|launcher\.json|app-settings\.json|desktop-display-\d+\.json|appearance\.json|song-(?:blacklist|greylist)\.json|ai-(?:key|settings)\.json)(/|$)' -or
                $entry.FullName -match '(?i)^lib/app/app/(data/backgrounds/|docs/plan\.md$)') { throw '完整更新包包含不安全路径或本机私人文件。' }
        }
        function Read-PackageJson([string]$Name) {
            $entry = $archive.GetEntry($Name)
            if ($null -eq $entry) { throw "完整更新包缺少 $Name。" }
            $reader = [System.IO.StreamReader]::new($entry.Open())
            try { return ($reader.ReadToEnd() | ConvertFrom-Json) } finally { $reader.Dispose() }
        }
        $manifest = Read-PackageJson 'lib/app/package-manifest.json'
        if ($manifest.version -ne $Version -or $manifest.platform -ne 'win-x64' -or $manifest.personalDataIncluded -ne $false -or $manifest.selfContained -ne $true -or @($manifest.files).Count -lt 10) { throw '完整更新包的版本或交付类型不符。' }
        $declared = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
        foreach ($file in $manifest.files) {
            if ($file.path -match '(^[/\\]|\\|:|(^|/)\.\.(/|$))' -or $file.sha256 -notmatch '^[a-fA-F0-9]{64}$') { throw '完整更新包的清单路径或哈希不合法。' }
            if (-not $declared.Add('lib/app/' + $file.path)) { throw '完整更新包的清单重复声明了文件。' }
            $entry = $archive.GetEntry('lib/app/' + $file.path)
            if ($null -eq $entry) { throw '完整更新包缺少清单中的文件。' }
            $stream = $entry.Open()
            try { $actual = [Convert]::ToHexString($hasher.ComputeHash($stream)).ToLower() } finally { $stream.Dispose() }
            if ($actual -ne $file.sha256.ToLower()) { throw '完整更新包内容与清单不一致。' }
        }
        foreach ($required in @('梓有妙选.exe','Velopack.dll','runtime/node.exe','runtime/desktop/AzusaPanel.exe','app/server.mjs','app/package.json','app/delivery.json','app/public/index.html','app/public/app.js','app/public/guide.html')) {
            if (-not $declared.Contains('lib/app/' + $required)) { throw "完整更新包缺少核心文件 $required。" }
        }
        $generated = @('lib/app/package-manifest.json','lib/app/sq.version','lib/app/Squirrel.exe','lib/app/梓有妙选_ExecutionStub.exe')
        foreach ($entry in $archive.Entries) {
            if ($entry.Name -ne '' -and $entry.FullName.StartsWith('lib/app/', [StringComparison]::OrdinalIgnoreCase) -and -not $declared.Contains($entry.FullName) -and $entry.FullName -notin $generated) { throw '完整更新包存在清单之外的应用文件。' }
        }
        $versionEntry = $archive.GetEntry('lib/app/sq.version')
        if ($null -eq $versionEntry) { throw '完整更新包缺少 Velopack 安装登记。' }
        $settings = [System.Xml.XmlReaderSettings]::new(); $settings.DtdProcessing = [System.Xml.DtdProcessing]::Prohibit
        $versionStream = $versionEntry.Open(); $xmlReader = [System.Xml.XmlReader]::Create($versionStream, $settings)
        try {
            $xml = [System.Xml.XmlDocument]::new(); $xml.XmlResolver = $null; $xml.Load($xmlReader)
            foreach ($expected in @{id='AzusaHexPickApp';version=$Version;channel='win';mainExe='梓有妙选.exe'}.GetEnumerator()) {
                $node = $xml.SelectSingleNode('//*[local-name()="metadata"]/*[local-name()="' + $expected.Key + '"]')
                if ($null -eq $node -or $node.InnerText -ne $expected.Value) { throw '完整更新包的 Velopack 身份登记不符。' }
            }
        } finally { $xmlReader.Dispose(); $versionStream.Dispose() }
        $deliveryEntry = $archive.GetEntry('lib/app/app/delivery.json')
        if ($null -eq $deliveryEntry) { throw '完整更新包缺少发布地址配置。' }
        $stream = $deliveryEntry.Open()
        try { $packedDeliverySha = [Convert]::ToHexString($hasher.ComputeHash($stream)).ToLower() } finally { $stream.Dispose() }
        if ($packedDeliverySha -ne (Get-FileHash -LiteralPath $stageDelivery -Algorithm SHA256).Hash.ToLower()) { throw '构建目录与完整更新包的发布地址配置不一致。' }
        $packedDelivery = Read-PackageJson 'lib/app/app/delivery.json'
    } finally { $hasher.Dispose(); $archive.Dispose() }
    $fullHash = (Get-FileHash -LiteralPath $fullPackage -Algorithm SHA256).Hash.ToLower()
    # 固定版本的 Velopack Setup 将完整更新包附加于文件末尾；核对载荷，避免绑定同名旧包。
    $payloadStream = [System.IO.File]::OpenRead([System.IO.Path]::GetFullPath($Payload))
    $hasher = [System.Security.Cryptography.SHA256]::Create()
    try {
        $size = (Get-Item -LiteralPath $fullPackage).Length
        if ($payloadStream.Length -le $size) { throw '内部 Setup 载荷不完整。' }
        $payloadStream.Seek(-$size, [System.IO.SeekOrigin]::End) | Out-Null
        if ([Convert]::ToHexString($hasher.ComputeHash($payloadStream)).ToLower() -ne $fullHash) { throw '内部 Setup 与完整更新包的内容不一致。' }
    } finally { $hasher.Dispose(); $payloadStream.Dispose() }
    $evidence = [ordered]@{
        version = $Version
        preview = [bool]$AllowUnconfiguredSite
        payloadSha256 = (Get-FileHash -LiteralPath $Payload -Algorithm SHA256).Hash.ToLower()
        fullPackageFileName = [System.IO.Path]::GetFileName($fullPackage)
        fullPackageSha256 = $fullHash
        delivery = $packedDelivery
    }
} elseif (-not $AllowUnconfiguredSite) { throw '正式安装向导必须绑定同一构建的完整更新包和发布地址配置。' }
if (-not $AllowUnconfiguredSite) {
    $delivery = Get-Content -Raw -LiteralPath (Join-Path $projectRoot 'delivery.json') | ConvertFrom-Json
    foreach ($name in @('updateBaseUrl','introductionUrl')) {
        $value = [string]$delivery.$name
        $uri = $null
        if (-not [Uri]::TryCreate($value, [UriKind]::Absolute, [ref]$uri) -or $uri.Scheme -ne 'https' -or $uri.IsLoopback -or
            $uri.UserInfo -ne '' -or $uri.Query -ne '' -or $uri.Fragment -ne '' -or $uri.Port -ne 443) {
            throw "正式发布前需要配置真实的 HTTPS $name，不能使用占位地址。"
        }
        if ([string]$evidence.delivery.$name -ne $value) { throw '内部更新包地址与当前正式发布配置不一致。' }
    }
}
if ($ValidateOnly) {
    if ($null -eq $evidence) { throw '验证需要同一构建的完整更新包和资源目录。' }
    Write-Output "完整更新载荷已通过检查：$Version"
    return
}
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$artDirectory = Join-Path $projectRoot '.runtime/installer-assets'
New-Item -ItemType Directory -Force -Path $artDirectory | Out-Null
$artPath = Join-Path $artDirectory 'welcome.bmp'
Add-Type -AssemblyName System.Drawing
$canvas = [System.Drawing.Bitmap]::new(196,430)
$graphics = [System.Drawing.Graphics]::FromImage($canvas)
$hero = [System.Drawing.Image]::FromFile((Join-Path $projectRoot 'launcher/Assets/hero.png'))
$signature = [System.Drawing.Image]::FromFile((Join-Path $projectRoot 'launcher/Assets/signature.png'))
try {
    $graphics.Clear([System.Drawing.ColorTranslator]::FromHtml('#F4F6FC'))
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.DrawImage($signature, [System.Drawing.Rectangle]::new(12,64,172,98), 90,85,475,270,[System.Drawing.GraphicsUnit]::Pixel)
    $graphics.DrawImage($hero, [System.Drawing.Rectangle]::new(10,200,176,176))
    $canvas.Save($artPath,[System.Drawing.Imaging.ImageFormat]::Bmp)
} finally { $graphics.Dispose(); $canvas.Dispose(); $hero.Dispose(); $signature.Dispose() }
& $Compiler "/DAppVersion=$Version" "/DPayload=$([System.IO.Path]::GetFullPath($Payload))" "/DOutputDirectory=$([System.IO.Path]::GetFullPath($OutputDirectory))" "/DWizardArtwork=$artPath" (Join-Path $PSScriptRoot 'installer.iss')
if ($LASTEXITCODE -ne 0) { throw '安装向导构建失败。' }
$installer = Join-Path $OutputDirectory "AzusaHexPick-$Version-Setup.exe"
$hash = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLower()
[System.IO.File]::WriteAllText($installer + '.sha256', $hash + '  ' + [System.IO.Path]::GetFileName($installer) + "`n")
if ($null -ne $evidence) {
    $evidence.installerSha256 = $hash
    [System.IO.File]::WriteAllText($installer + '.manifest.json', ($evidence | ConvertTo-Json -Depth 6) + "`n")
} elseif (Test-Path -LiteralPath ($installer + '.manifest.json')) { Remove-Item -LiteralPath ($installer + '.manifest.json') }
Write-Output "安装向导已构建：AzusaHexPick-$Version-Setup.exe"
