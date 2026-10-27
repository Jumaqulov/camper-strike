# Loyihani (node_modules, dist, .git va h.k. siz) zip arxivga yig'adi.
# Foydalanish: powershell -File scripts/create-zip.ps1 [-ZipPath D:\camper-strike.zip]
param(
    [string]$ZipPath = ""
)
$ErrorActionPreference = "Stop"

$rootDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if (-not $ZipPath) {
    $ZipPath = Join-Path (Split-Path $rootDir -Parent) ("camper-strike-" + (Get-Date -Format "yyyyMMdd-HHmm") + ".zip")
}
$zipPath = $ZipPath
if (Test-Path $zipPath) {
    Remove-Item $zipPath -Force
}

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$zip = [System.IO.Compression.ZipFile]::Open($zipPath, [System.IO.Compression.ZipArchiveMode]::Create)

$excludeDirs = @("node_modules", "dist", ".git", ".gemini", ".claude", ".system_generated", "logs", "coverage", "out", "tmp-grass")

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
