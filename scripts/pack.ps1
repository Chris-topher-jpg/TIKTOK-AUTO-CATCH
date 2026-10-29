$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$manifestPath = Join-Path $root 'extension\manifest.json'
$manifestText = [System.IO.File]::ReadAllText($manifestPath, [System.Text.Encoding]::UTF8)
$manifest = ConvertFrom-Json -InputObject $manifestText -ErrorAction Stop
$artifactDirectory = Join-Path $root 'artifacts'
$archive = Join-Path $artifactDirectory "tiktok-auto-catch-v$($manifest.version).zip"

New-Item -ItemType Directory -Path $artifactDirectory -Force | Out-Null
if (Test-Path -LiteralPath $archive) {
  Remove-Item -LiteralPath $archive -Force
}
Compress-Archive -Path (Join-Path $root 'extension\*') -DestinationPath $archive -CompressionLevel Optimal
Write-Output "Extension package created: $archive"
