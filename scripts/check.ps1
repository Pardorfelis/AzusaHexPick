param()
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Push-Location -LiteralPath $projectRoot
try {
    $testFiles = @(Get-ChildItem -LiteralPath 'tests' -Filter '*.test.mjs' | ForEach-Object { $_.FullName })
    & node --test @testFiles
    if ($LASTEXITCODE -ne 0) { throw 'Node.js 检查未通过。' }
    & python -X utf8 -m unittest discover -s tests -p 'test_*.py'
    if ($LASTEXITCODE -ne 0) { throw 'Python 检查未通过。' }
    Write-Output '全部自动检查通过。这些检查不会调用付费 AI 接口。'
} finally { Pop-Location }
