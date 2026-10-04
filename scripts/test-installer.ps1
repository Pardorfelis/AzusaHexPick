param(
    [Parameter(Mandatory=$true)][string]$Installer,
    [string]$Version = '0.7.1',
    [string]$PreviousInstaller = '',
    [string]$PreviousVersion = '0.7.0',
    [string]$TestDirectory = (Join-Path $PSScriptRoot '../.runtime/installer-test')
)
$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$testRoot = [System.IO.Path]::GetFullPath($TestDirectory)
if (-not $testRoot.StartsWith((Join-Path $projectRoot '.runtime') + [System.IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw '安装验证目录必须位于本项目的 .runtime 内。' }
$registry = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\AzusaHexPickApp'
if (Test-Path -LiteralPath $registry) { throw '已存在安装版。为避免影响正在使用的程序，请在独立 Windows 账号或测试环境运行。' }
$installerPath = [System.IO.Path]::GetFullPath($Installer)
New-Item -ItemType Directory -Force -Path $testRoot | Out-Null
$previousUserData = $env:AZUSA_USER_DATA
$env:AZUSA_USER_DATA = Join-Path $testRoot 'user-data'
New-Item -ItemType Directory -Force -Path $env:AZUSA_USER_DATA | Out-Null
$personal = Join-Path $env:AZUSA_USER_DATA 'personal-sentinel.txt'
[System.IO.File]::WriteAllText($personal, 'synthetic-personal-settings-keep')
$personalHash = (Get-FileHash -LiteralPath $personal -Algorithm SHA256).Hash
Add-Type -AssemblyName System.Security.Cryptography.ProtectedData
$syntheticKey = 'synthetic-only-not-a-working-key'
$secretPath = Join-Path $env:AZUSA_USER_DATA 'deepseek.key'
[System.IO.File]::WriteAllBytes($secretPath, [System.Security.Cryptography.ProtectedData]::Protect([System.Text.Encoding]::UTF8.GetBytes($syntheticKey), $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser))
[System.IO.File]::WriteAllText((Join-Path $env:AZUSA_USER_DATA 'launcher.json'), '{"PhoneMode":false,"OnboardingComplete":true}')
New-Item -ItemType Directory -Force -Path (Join-Path $env:AZUSA_USER_DATA 'data') | Out-Null
[System.IO.File]::WriteAllText((Join-Path $env:AZUSA_USER_DATA 'data/appearance.json'), '{"syntheticTest":"keep-theme"}')
[System.IO.File]::WriteAllText((Join-Path $env:AZUSA_USER_DATA 'data/song-blacklist.json'), '{"syntheticTest":"keep-list"}')
$savedHashes = @{}
foreach ($file in Get-ChildItem -LiteralPath $env:AZUSA_USER_DATA -Recurse -File) { $savedHashes[$file.FullName] = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash }
$shortcutPaths = @(
    (Join-Path ([Environment]::GetFolderPath('Desktop')) '梓有妙选.lnk'),
    (Join-Path ([Environment]::GetFolderPath('Programs')) '梓有妙选.lnk')
)
$shortcutBackup = @{}
foreach ($path in $shortcutPaths) { if (Test-Path -LiteralPath $path) { $shortcutBackup[$path] = [System.IO.File]::ReadAllBytes($path) } }
$results = [System.Collections.Generic.List[object]]::new()

function Invoke-Installer([string]$Name, [string]$Directory, [bool]$Desktop, [string]$Executable = $installerPath) {
    $info = [System.Diagnostics.ProcessStartInfo]::new([System.IO.Path]::GetFullPath($Executable))
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    foreach ($argument in @('/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/SP-',"/DIR=$Directory","/LOG=$(Join-Path $testRoot ($Name + '.log'))")) { $info.ArgumentList.Add($argument) }
    $info.ArgumentList.Add($(if ($Desktop) { '/TASKS=desktopicon' } else { '/TASKS=' }))
    $process = [System.Diagnostics.Process]::Start($info)
    if (-not $process.WaitForExit(180000)) { throw "安装测试 $Name 未在限定时间结束，请检查测试进程。" }
    return $process.ExitCode
}
function Assert-True([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Add-Result([string]$Name, [object]$Details) { $results.Add(@{scenario=$Name;success=$true;details=$Details}); Write-Output "PASS $Name" }

$target = Join-Path $testRoot '安装测试 空格'
try {
    $occupied = Join-Path $testRoot 'unrelated-files'
    New-Item -ItemType Directory -Force -Path $occupied | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $occupied 'keep.txt'), 'keep')
    Assert-True ((Invoke-Installer 'nonempty' $occupied $false) -ne 0) '错误地覆盖了无关非空目录。'
    Assert-True ((Get-Content -Raw -LiteralPath (Join-Path $occupied 'keep.txt')) -eq 'keep') '无关文件被改动。'
    Add-Result 'nonempty-directory-refused' '无关文件原样保留。'

    $portable = Join-Path $testRoot 'portable'
    New-Item -ItemType Directory -Force -Path $portable | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $portable '.portable'), '')
    Assert-True ((Invoke-Installer 'portable' (Join-Path $portable 'child') $false) -ne 0) '错误地覆盖了便携版目录。'
    Add-Result 'portable-ancestor-refused' '便携目录及其子目录被拒绝。'

    foreach ($case in @(
        @{name='disk-root';path=[System.IO.Path]::GetPathRoot($target)},
        @{name='windows';path=$env:SystemRoot},
        @{name='personal-data';path=(Join-Path $env:LOCALAPPDATA 'AzusaHexPick/UserData')},
        @{name='isolated-personal-data';path=$env:AZUSA_USER_DATA},
        @{name='user-home';path=[Environment]::GetFolderPath('UserProfile')}
    )) {
        Assert-True ((Invoke-Installer $case.name $case.path $false) -ne 0) "危险位置 $($case.name) 未被拒绝。"
        Add-Result ($case.name + '-refused') '没有安装或删除该位置的文件。'
    }

    $mutex = [System.Threading.Mutex]::new($true, 'Local\AzusaHexPick.Launcher')
    try {
        Assert-True ((Invoke-Installer 'running' $target $false) -ne 0) '运行中的项目未阻止安装。'
        Assert-True (-not (Test-Path -LiteralPath (Join-Path $target 'current'))) '运行检查之前就安装了程序。'
    } finally { $mutex.ReleaseMutex(); $mutex.Dispose() }
    Add-Result 'running-project-refused' '仅提示先退出，不停止进程或收集。'

    if ($PreviousInstaller -ne '') {
        Assert-True ((Invoke-Installer 'install-previous' $target $false $PreviousInstaller) -eq 0) '旧版安装失败。'
        Assert-True ((Get-ItemProperty -LiteralPath $registry).DisplayVersion -eq $PreviousVersion) '旧版登记版本不符。'
        Add-Result 'previous-version-installed' '旧版测试载荷安装到同一个隔离目录。'
    }
    $code = Invoke-Installer 'install-no-desktop' $target $false
    Assert-True ($code -eq 0) "安装失败，返回码 $code。"
    $registration = Get-ItemProperty -LiteralPath $registry
    Assert-True ([System.IO.Path]::GetFullPath($registration.InstallLocation).TrimEnd('\') -eq $target.TrimEnd('\')) '安装目录登记不符。'
    Assert-True ($registration.DisplayVersion -eq $Version) '安装版本登记不符。'
    Assert-True (Test-Path -LiteralPath (Join-Path $target '梓有妙选.exe')) '根目录启动入口缺失。'
    Assert-True (-not (Test-Path -LiteralPath ($registry.Replace('AzusaHexPickApp','AzusaHexPickInstallWizard_is1')))) '出现了第二个卸载入口。'
    if (-not $shortcutBackup.ContainsKey($shortcutPaths[0])) { Assert-True (-not (Test-Path -LiteralPath $shortcutPaths[0])) '取消勾选后仍创建桌面快捷方式。' }
    Assert-True (@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($target + '\', [StringComparison]::OrdinalIgnoreCase) }).Count -eq 0) '静默内部安装意外启动了程序。'
    Add-Result 'chinese-space-install-no-desktop' '稳定入口、版本、单一卸载登记通过，未自动启动。'
    if ($PreviousInstaller -ne '') {
        foreach ($entry in $savedHashes.GetEnumerator()) { Assert-True ((Get-FileHash -LiteralPath $entry.Key -Algorithm SHA256).Hash -eq $entry.Value) '升级更改了独立个人配置。' }
        $decrypted = [System.Security.Cryptography.ProtectedData]::Unprotect([System.IO.File]::ReadAllBytes($secretPath), $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
        Assert-True ([System.Text.Encoding]::UTF8.GetString($decrypted) -eq $syntheticKey) '升级后用户级加密密钥无法读取。'
        Add-Result 'previous-to-current-preserves-config-key' '版本推进，独立配置与加密测试密钥保持原样。'
    }

    $other = Join-Path $testRoot 'attempted-relocation'
    Assert-True ((Invoke-Installer 'reinstall-with-desktop' $other $true) -eq 0) '同版本再次安装失败。'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $other 'current'))) '再次安装意外移动目录。'
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($shortcutPaths[0])
    Assert-True ($shortcut.TargetPath -eq (Join-Path $target '梓有妙选.exe')) '桌面快捷方式未指向稳定入口。'
    Assert-True ($shortcut.WorkingDirectory -eq $target) '桌面快捷方式工作目录不符。'
    Add-Result 'reinstall-keeps-directory-desktop-link' '再次安装沿用原目录，勾选后链接指向根目录入口。'

    $updateInfo = [System.Diagnostics.ProcessStartInfo]::new((Join-Path $target 'Update.exe'))
    $updateInfo.UseShellExecute = $false
    $updateInfo.CreateNoWindow = $true
    $updateInfo.ArgumentList.Add('--uninstall'); $updateInfo.ArgumentList.Add('--silent')
    $uninstall = [System.Diagnostics.Process]::Start($updateInfo)
    Assert-True ($uninstall.WaitForExit(180000) -and $uninstall.ExitCode -eq 0) 'Velopack 卸载失败。'
    Assert-True (-not (Test-Path -LiteralPath $registry)) '卸载登记仍存在。'
    Assert-True ((Get-FileHash -LiteralPath $personal -Algorithm SHA256).Hash -eq $personalHash) '个人数据未被保留。'
    foreach ($entry in $savedHashes.GetEnumerator()) { Assert-True ((Get-FileHash -LiteralPath $entry.Key -Algorithm SHA256).Hash -eq $entry.Value) '卸载更改了独立个人配置。' }
    Add-Result 'single-uninstall-preserves-personal-data' 'Velopack 卸载入口移除，独立个人数据原样保留。'
} finally {
    # 失败时也只卸载本次隔离目录内的安装，避免留下占用后续验证的测试登记。
    if (Test-Path -LiteralPath $registry) {
        $remaining = Get-ItemProperty -LiteralPath $registry
        if ([System.IO.Path]::GetFullPath($remaining.InstallLocation).TrimEnd('\') -eq $target.TrimEnd('\') -and
            (Test-Path -LiteralPath (Join-Path $target 'Update.exe'))) {
            $cleanup = [System.Diagnostics.ProcessStartInfo]::new((Join-Path $target 'Update.exe'))
            $cleanup.UseShellExecute = $false; $cleanup.CreateNoWindow = $true
            $cleanup.ArgumentList.Add('--uninstall'); $cleanup.ArgumentList.Add('--silent')
            $cleanupProcess = [System.Diagnostics.Process]::Start($cleanup)
            if (-not $cleanupProcess.WaitForExit(180000) -or $cleanupProcess.ExitCode -ne 0) { Write-Warning '隔离安装卸载未完成，请检查本次测试目录。' }
        }
    }
    foreach ($path in $shortcutPaths) {
        if ($shortcutBackup.ContainsKey($path)) { [System.IO.File]::WriteAllBytes($path, $shortcutBackup[$path]) }
        elseif (Test-Path -LiteralPath $path) {
            $shell = New-Object -ComObject WScript.Shell
            $link = $shell.CreateShortcut($path)
            if ($link.TargetPath -and $link.TargetPath.StartsWith($target + '\', [StringComparison]::OrdinalIgnoreCase)) { Remove-Item -LiteralPath $path -Force }
        }
    }
    $report = @{version=$Version;testInstallOnly=$true;paidApiCalls=0;results=$results;personalDataPreserved=((Get-FileHash -LiteralPath $personal -Algorithm SHA256).Hash -eq $personalHash)}
    [System.IO.File]::WriteAllText((Join-Path $testRoot 'result.json'), ($report | ConvertTo-Json -Depth 6))
    $env:AZUSA_USER_DATA = $previousUserData
}
