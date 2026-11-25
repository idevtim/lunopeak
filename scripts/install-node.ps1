# Install lunopeak-node on this Windows PC, keep it running in the background,
# and show a code to pair it with LunoPeak on another computer.
#
#   irm https://github.com/idevtim/lunopeak/releases/latest/download/install-node.ps1 | iex
#
# Shipped as a release asset next to the binaries it downloads, so it always
# matches the latest release. Runs as you, not as an administrator.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$repo = 'idevtim/lunopeak'
$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
$url  = "https://github.com/$repo/releases/latest/download/lunopeak-node-windows-$arch.zip"

$tmp = Join-Path $env:TEMP ("lunopeak-node-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  Write-Host "Downloading $url"
  Invoke-WebRequest -Uri $url -OutFile (Join-Path $tmp 'node.zip') -UseBasicParsing
  Expand-Archive -Path (Join-Path $tmp 'node.zip') -DestinationPath $tmp
  $node = Join-Path $tmp 'lunopeak-node.exe'

  & $node install @args
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

  # First install (nothing paired yet): show a code right away.
  if ((& $node hubs) -match 'Not shared') {
    Write-Host ''
    Write-Host 'If Windows asks whether lunopeak-node may use private networks, allow it.'
    & $node pair
  }
} finally {
  Remove-Item -Recurse -Force -Path $tmp -ErrorAction SilentlyContinue
}
