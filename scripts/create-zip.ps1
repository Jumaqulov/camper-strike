$ErrorActionPreference = "Stop"

$zipPath = "D:\stickman-strike-stage08terrain.zip"
if (Test-Path $zipPath) {
    Remove-Item $zipPath -Force
}

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$zip = [System.IO.Compression.ZipFile]::Open($zipPath, [System.IO.Compression.ZipArchiveMode]::Create)
$rootDir = "D:\Stickman-strike"

$excludeDirs = @("node_modules", "dist", ".git", ".gemini", ".system_generated", "logs", "coverage")

$files = Get-ChildItem -Path $rootDir -Recurse -File | Where-Object {
    if ($_.Extension -ieq ".zip") {
        return $false
    }
    $rel = $_.FullName.Substring($rootDir.Length + 1)
    $parts = $rel.Split([System.IO.Path]::DirectorySeparatorChar)
    $exclude = $false
    foreach ($p in $parts) {
        if ($excludeDirs -contains $p) {
            $exclude = $true
            break
        }
    }
    -not $exclude
}

Write-Host "Adding $($files.Count) files to $zipPath..."
foreach ($f in $files) {
    $relPath = $f.FullName.Substring($rootDir.Length + 1)
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $f.FullName, $relPath, [System.IO.Compression.CompressionLevel]::Optimal)
}

$zip.Dispose()
$size = (Get-Item $zipPath).Length
Write-Host "Created successfully: $zipPath ($([math]::Round($size / 1MB, 2)) MB)"
