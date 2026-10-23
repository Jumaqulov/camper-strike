Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$sourceDir = "D:\Stickman-strike"
$zipPath = "D:\stickman-strike-stage08fix.zip"
$docsZipPath = "D:\Stickman-strike\docs\stage08fix\stickman-strike-stage08fix.zip"

Write-Host "Creating clean Stage 08-FIX ZIP at $zipPath..."

if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
if (Test-Path $docsZipPath) { Remove-Item $docsZipPath -Force }

$zipFile = [System.IO.Compression.ZipFile]::Open($zipPath, [System.IO.Compression.ZipArchiveMode]::Create)

$files = Get-ChildItem -Path $sourceDir -Recurse -File | Where-Object {
    $_.FullName -notmatch '\\node_modules(\\|$)' -and
    $_.FullName -notmatch '\\dist(\\|$)' -and
    $_.FullName -notmatch '\\\.git(\\|$)' -and
    $_.FullName -notmatch 'stickman-strike-stage08fix\.zip$'
}

$count = 0
foreach ($file in $files) {
    $relativePath = $file.FullName.Substring($sourceDir.Length + 1).Replace('\', '/')
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zipFile, $file.FullName, $relativePath, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
    $count++
}

$zipFile.Dispose()

Write-Host "Created ZIP with $count entries at $zipPath"

Copy-Item $zipPath $docsZipPath -Force
$sizeMB = (Get-Item $zipPath).Length / 1MB
Write-Host ("Copied to {0} ({1:N2} MB)" -f $docsZipPath, $sizeMB)
