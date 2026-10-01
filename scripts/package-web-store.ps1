param(
  [Parameter(Mandatory = $true)]
  [string]$OutputPath
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$outputFullPath = [System.IO.Path]::GetFullPath($OutputPath)
$outputDirectory = [System.IO.Path]::GetDirectoryName($outputFullPath)
if (-not (Test-Path -LiteralPath $outputDirectory)) {
  New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
}

$manifest = Get-Content -LiteralPath (Join-Path $repoRoot "manifest.json") -Raw | ConvertFrom-Json
$package = Get-Content -LiteralPath (Join-Path $repoRoot "package.json") -Raw | ConvertFrom-Json
if ($manifest.version -ne $package.version) {
  throw "Manifest and package versions do not match."
}
if ($package.author -ne "TeamBotics Inc.") {
  throw "package.json author must be TeamBotics Inc."
}

$files = @(
  "manifest.json",
  "background.js",
  "capacity-monitor.js",
  "chat-badge.js",
  "content-script.js",
  "offscreen.html",
  "offscreen.js",
  "popup.html",
  "popup.js",
  "providers.js",
  "usage-model.js",
  "LICENSE",
  "icons/icon-16.png",
  "icons/icon-32.png",
  "icons/icon-48.png",
  "icons/icon-128.png"
)

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$fileStream = [System.IO.File]::Open($outputFullPath, [System.IO.FileMode]::CreateNew)
try {
  $archive = [System.IO.Compression.ZipArchive]::new($fileStream, [System.IO.Compression.ZipArchiveMode]::Create, $false)
  try {
    foreach ($relativePath in $files) {
      $sourcePath = Join-Path $repoRoot $relativePath
      if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
        throw "Required package file is missing: $relativePath"
      }
      [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
        $archive,
        $sourcePath,
        $relativePath.Replace("\", "/"),
        [System.IO.Compression.CompressionLevel]::Optimal
      ) | Out-Null
    }
  }
  finally {
    $archive.Dispose()
  }
}
finally {
  $fileStream.Dispose()
}

Write-Output "Created Web Store upload package for version $($manifest.version): $outputFullPath"
