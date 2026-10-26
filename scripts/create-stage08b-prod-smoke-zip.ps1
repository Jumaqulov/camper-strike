param([string]$Name = 'stickman-strike-stage08b-prod-smoke')

# Clean project ZIP: exactly the files git would see (tracked + untracked-but-not-ignored),
# so node_modules, dist, logs ignored by .gitignore and *.zip never get in. Debug runs are excluded.
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$sourceDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$zipPath = Join-Path $sourceDir "$Name.zip"

Write-Host "Creating clean Stage 08B-PRODUCTION-SMOKE ZIP at $zipPath..."
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }

Push-Location $sourceDir
$list = git -c core.quotepath=off ls-files --cached --others --exclude-standard
Pop-Location

# QA evidence is always shipped, including *.log files that .gitignore hides from git
$evidence = Get-ChildItem -Path (Join-Path $sourceDir 'docs/stage08b-prod-smoke') -Recurse -File |
    ForEach-Object { $_.FullName.Substring($sourceDir.Length + 1).Replace('\', '/') }
$files = @($list) + @($evidence) | Where-Object { $_ -and $_ -notmatch '\.zip$' } | Sort-Object -Unique

$zipFile = [System.IO.Compression.ZipFile]::Open($zipPath, [System.IO.Compression.ZipArchiveMode]::Create)
$count = 0
foreach ($rel in $files) {
    $full = Join-Path $sourceDir $rel
    if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { continue }
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zipFile, $full, $rel.Replace('\', '/'), [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
    $count++
}
$zipFile.Dispose()

$sizeMB = (Get-Item $zipPath).Length / 1MB
Write-Host ("Created ZIP with {0} entries at {1} ({2:N2} MB)" -f $count, $zipPath, $sizeMB)
