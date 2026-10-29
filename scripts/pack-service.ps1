$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$packageText = [System.IO.File]::ReadAllText((Join-Path $root 'package.json'), [System.Text.Encoding]::UTF8)
$package = ConvertFrom-Json -InputObject $packageText -ErrorAction Stop
$outputDirectory = Join-Path $root 'artifacts'
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
$archive = Join-Path $outputDirectory "tiktok-auto-catch-service-v$($package.version).zip"
$items = @('service', 'extension', 'scripts', 'docs', 'tests', 'package.json', 'package-lock.json', 'README.md', 'service.config.example.json') | ForEach-Object { Join-Path $root $_ }
$items += @(Get-ChildItem -LiteralPath $root -Filter '*.cmd' -File | ForEach-Object { $_.FullName })
$items += @(Get-ChildItem -LiteralPath $root -Filter '*.vbs' -File | ForEach-Object { $_.FullName })
Compress-Archive -LiteralPath $items -DestinationPath $archive -CompressionLevel Optimal -Force
Write-Output "Background service package created: $archive"
