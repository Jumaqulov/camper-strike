param([string]$Name = 'stickman-strike-stage08b-char')

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$sourceDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$zipPath = Join-Path $sourceDir "$Name.zip"

Write-Host "Creating clean Stage 08B ZIP at $zipPath..."

if (Test-Path $zipPath) { Remove-Item $zipPath -Force }

$zipFile = [System.IO.Compression.ZipFile]::Open($zipPath, [System.IO.Compression.ZipArchiveMode]::Create)

$files = Get-ChildItem -Path $sourceDir -Recurse -File | Where-Object {
    $_.FullName -notmatch '\\node_modules(\\|$)' -and
    $_.FullName -notmatch '\\dist(\\|$)' -and
    $_.FullName -notmatch '\\\.git(\\|$)' -and
    $_.FullName -notmatch '\.zip$'
}

$count = 0
foreach ($file in $files) {
    $relativePath = $file.FullName.Substring($sourceDir.Length + 1).Replace('\', '/')
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zipFile, $file.FullName, $relativePath, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
    $count++
}

$zipFile.Dispose()

$sizeMB = (Get-Item $zipPath).Length / 1MB
Write-Host ("Created ZIP with {0} entries at {1} ({2:N2} MB)" -f $count, $zipPath, $sizeMB)
