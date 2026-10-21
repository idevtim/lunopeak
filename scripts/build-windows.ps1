#Requires -Version 5.1
$ErrorActionPreference = 'Stop'
# Native commands (gh, npx, cargo, git) signal failure via $LASTEXITCODE.
# Without this opt-out, PowerShell 7.4+ promotes their stderr writes into
# terminating errors even when the exit code is fine - which masks
# expected non-zero cases like `gh release view` on a missing tag.
$PSNativeCommandUseErrorActionPreference = $false

# --- Configuration -----------------------------------------------------------
$ScriptDir     = $PSScriptRoot
$ProjectDir    = Split-Path -Parent $ScriptDir
$AppName       = 'LunoPeak'
$ReleaseRepo   = 'idevtim/lunopeak'        # public distribution repo
$ReleaseTarget = 'main'                    # branch on $ReleaseRepo to tag

# Targets to build. RustArch is the Rust-style arch used in Tauri's update
# manifest platform keys (windows-x86_64, windows-aarch64). VcvarsArg is the
# host_target pair passed to vcvarsall.bat - the host half must match the
# arch of *this* PowerShell process, not the underlying CPU. On Windows-on-ARM
# running an x64 PowerShell (via Prism), the host is amd64.
$hostArch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'amd64' }
$Targets = @(
  [pscustomobject]@{ Triple = 'aarch64-pc-windows-msvc'; Arch = 'arm64'; RustArch = 'aarch64'; Machine = 0xAA64; VcvarsArg = "${hostArch}_arm64" },
  [pscustomobject]@{ Triple = 'x86_64-pc-windows-msvc';  Arch = 'x64';   RustArch = 'x86_64';  Machine = 0x8664; VcvarsArg = if ($hostArch -eq 'amd64') { 'amd64' } else { 'arm64_amd64' } }
)

# Source vcvarsall.bat for a given host_target arch and pull the resulting
# env vars into this PowerShell session. Required so cc-rs/clang can find
# the MSVC CRT and Windows SDK headers (assert.h etc.) when building `ring`.
function Import-VsDevEnv {
  param([Parameter(Mandatory)][string]$Arch)
  $vswhere = 'C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe'
  if (-not (Test-Path $vswhere)) { throw "vswhere.exe not found at $vswhere" }
  $vsRoot = & $vswhere -latest -property installationPath
  if (-not $vsRoot) { throw 'Visual Studio installation not found via vswhere' }
  $vcvars = Join-Path $vsRoot 'VC\Auxiliary\Build\vcvarsall.bat'
  if (-not (Test-Path $vcvars)) { throw "vcvarsall.bat not found at $vcvars" }
  $output = & cmd /c "`"$vcvars`" $Arch >nul && set"
  if ($LASTEXITCODE -ne 0) { throw "vcvarsall.bat $Arch failed (exit $LASTEXITCODE)" }
  foreach ($line in $output) {
    if ($line -match '^([^=]+)=(.*)$') {
      [Environment]::SetEnvironmentVariable($matches[1], $matches[2])
    }
  }
}

# Refresh PATH from registry and prepend LLVM if present (clang is needed to
# build `ring` on aarch64-pc-windows-msvc).
$llvmBin = 'C:\Program Files\LLVM\bin'
$paths = @()
if (Test-Path $llvmBin) { $paths += $llvmBin }
$paths += [Environment]::GetEnvironmentVariable('Path', 'Machine')
$paths += [Environment]::GetEnvironmentVariable('Path', 'User')
$env:Path = ($paths -join ';')

# Optional .env (mac flow uses this for Apple creds; here we may pull
# TAURI_SIGNING_PRIVATE_KEY_PASSWORD). GitHub auth comes from `gh auth login`.
$envFile = Join-Path $ProjectDir '.env'
if (Test-Path $envFile) {
  Get-Content $envFile | ForEach-Object {
    if ($_ -match '^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$') {
      [Environment]::SetEnvironmentVariable($matches[1], ($matches[2] -replace '^"(.*)"$', '$1'))
    }
  }
}

# Updater signing key. Tauri reads TAURI_SIGNING_PRIVATE_KEY (raw key bytes)
# and TAURI_SIGNING_PRIVATE_KEY_PASSWORD; without BOTH set it silently skips
# signing and no .sig sibling is emitted (the build still "succeeds").
# Set both - inlining the key content sidesteps the _PATH variant entirely.
$keyPath = Join-Path $env:USERPROFILE '.tauri\lunopeak.key'
$signingEnabled = Test-Path $keyPath
if ($signingEnabled) {
  $env:TAURI_SIGNING_PRIVATE_KEY = (Get-Content -Path $keyPath -Raw)
  $env:TAURI_SIGNING_PRIVATE_KEY_PATH = $keyPath
  if (-not $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD) {
    # Tauri requires _PASSWORD to be set even for passwordless keys.
    $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ''
  }
  Write-Host "[OK] updater key: $keyPath"
} else {
  Write-Host "[!] updater key missing at $keyPath - bundles will be UNSIGNED"
  Write-Host "    Generate with: npx @tauri-apps/cli signer generate -w $keyPath --ci"
}

# --- Pre-flight: version sync ------------------------------------------------
$pkgVersion   = (Get-Content (Join-Path $ProjectDir 'package.json') -Raw | ConvertFrom-Json).version
$tauriVersion = (Get-Content (Join-Path $ProjectDir 'src-tauri\tauri.conf.json') -Raw | ConvertFrom-Json).version
$cargoLine    = (Select-String -Path (Join-Path $ProjectDir 'src-tauri\Cargo.toml') -Pattern '^version\s*=' | Select-Object -First 1).Line
$cargoVersion = ($cargoLine -replace '^version\s*=\s*"([^"]+)".*', '$1').Trim()

if ($pkgVersion -ne $tauriVersion -or $pkgVersion -ne $cargoVersion) {
  Write-Host "[X] Version mismatch:"
  Write-Host "    package.json:    $pkgVersion"
  Write-Host "    tauri.conf.json: $tauriVersion"
  Write-Host "    Cargo.toml:      $cargoVersion"
  exit 1
}
Write-Host "[OK] versions match: v$pkgVersion"

# --- Pre-flight: release notes -----------------------------------------------
$releaseNotes = Join-Path $ProjectDir "release-notes\v$pkgVersion.md"
if (-not (Test-Path $releaseNotes)) {
  Write-Host "[X] Missing release notes: release-notes\v$pkgVersion.md"
  Write-Host "    Create this file before releasing."
  exit 1
}
Write-Host "[OK] release notes found for v$pkgVersion"

# --- Pre-flight: toolchain ---------------------------------------------------
foreach ($tool in 'rustc','cargo','npm','clang') {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
    Write-Host "[X] required tool not on PATH: $tool"
    if ($tool -eq 'clang') {
      Write-Host "    Install LLVM: winget install --id LLVM.LLVM"
    }
    exit 1
  }
}
Write-Host "[OK] toolchain present (rustc, cargo, npm, clang)"

# --- Pre-flight: rust targets installed --------------------------------------
$installedTargets = & rustup target list --installed
foreach ($t in $Targets) {
  if ($installedTargets -notcontains $t.Triple) {
    Write-Host "[*] Installing missing Rust target: $($t.Triple)"
    & rustup target add $t.Triple
    if ($LASTEXITCODE -ne 0) { Write-Host "[X] failed to install target $($t.Triple)"; exit 1 }
  }
}
Write-Host "[OK] Rust targets installed"

# --- Build each target -------------------------------------------------------
# `tauri build --target <triple>` puts artifacts under target/<triple>/release/.
# Tauri's NSIS template hardcodes "_x64-" in the filename regardless of arch,
# so we rename .exe AND its .sig sibling based on the PE machine type read
# from the wrapped binary.
Set-Location $ProjectDir
$bundles = @()
foreach ($t in $Targets) {
  Write-Host ""
  Write-Host "[*] Building $AppName v$pkgVersion for $($t.Triple)..."

  # Wipe any prior bundle artifacts for this target. tauri build does not
  # always overwrite cleanly when nothing changes upstream, and the rename
  # logic below would silently relabel a stale .exe (e.g. from the prior
  # version) as the current one - shipping a binary whose embedded
  # ProductVersion no longer matches its filename.
  $bundleDir = Join-Path $ProjectDir "src-tauri\target\$($t.Triple)\release\bundle"
  $nsisDir   = Join-Path $bundleDir 'nsis'
  if (Test-Path $bundleDir) {
    Write-Host "[*] Clearing previous bundle output: $bundleDir"
    Remove-Item -Recurse -Force -Path $bundleDir
  }

  # Source the VS developer environment for this target's host/cross combo.
  # Without this, INCLUDE/LIB are empty and cc-rs invocations of clang for
  # `ring` fail with "'assert.h' file not found".
  Write-Host "[*] Importing VS dev env: vcvarsall.bat $($t.VcvarsArg)"
  Import-VsDevEnv -Arch $t.VcvarsArg

  # Direct npx invocation - PowerShell strips `--` before npm sees it, which
  # caused `npm run tauri:build -- --bundles nsis` to fail in earlier versions.
  & npx tauri build --verbose --bundles nsis --target $t.Triple
  if ($LASTEXITCODE -ne 0) {
    Write-Host "[X] tauri build failed for $($t.Triple) (exit $LASTEXITCODE)"
    exit $LASTEXITCODE
  }

  $exe = Get-ChildItem -Path $nsisDir -Filter '*-setup.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $exe) {
    Write-Host "[X] No NSIS installer found in $nsisDir"
    exit 1
  }

  # Sanity-check Tauri stamped the bundle with the expected version. Tauri
  # bakes tauri.conf.json's version into both the filename and the inner
  # exe's ProductVersion; if the filename's version segment doesn't match
  # $pkgVersion, the bundle is from a stale build and must not ship.
  if ($exe.Name -notlike "${AppName}_${pkgVersion}_*-setup.exe") {
    Write-Host "[X] Bundle '$($exe.Name)' doesn't match expected version $pkgVersion"
    Write-Host "    Tauri produced a bundle for a different version - aborting to avoid mislabeling."
    exit 1
  }

  # Sanity-check the wrapped binary's PE machine type matches the requested target.
  $appExe = Join-Path $ProjectDir "src-tauri\target\$($t.Triple)\release\$AppName.exe"
  $bytes = [System.IO.File]::ReadAllBytes($appExe)
  $peOffset = [BitConverter]::ToInt32($bytes, 0x3C)
  $machine  = [BitConverter]::ToUInt16($bytes, $peOffset + 4)
  if ($machine -ne $t.Machine) {
    Write-Host ("[X] PE machine 0x{0:X4} doesn't match expected 0x{1:X4} for {2}" -f $machine, $t.Machine, $t.Triple)
    exit 1
  }

  # Cross-check the inner exe's embedded FileVersion (set by tauri-build via
  # rcedit from Cargo.toml). Catches the case where the bundle filename is
  # right but the wrapped binary is stale.
  $appFileVersion = (Get-Item $appExe).VersionInfo.FileVersion
  if ($appFileVersion -and $appFileVersion -notlike "$pkgVersion*") {
    Write-Host "[X] $AppName.exe FileVersion '$appFileVersion' doesn't match $pkgVersion"
    exit 1
  }

  $properName = "${AppName}_${pkgVersion}_$($t.Arch)-setup.exe"
  if ($exe.Name -ne $properName) {
    $newPath = Join-Path $exe.DirectoryName $properName
    Move-Item -Path $exe.FullName -Destination $newPath -Force
    $exe = Get-Item $newPath
  }

  # Locate the .sig sibling (Tauri writes <bundle>.sig next to each artifact
  # when signing keys are present). If signing was disabled, $sig is $null.
  $sig = $null
  if ($signingEnabled) {
    $expectedSigPath = "$($exe.FullName).sig"
    # If renamed above, the original .sig (with the broken Tauri name) needs
    # to be moved alongside the new exe path.
    $rawSig = Get-ChildItem -Path $nsisDir -Filter '*-setup.exe.sig' -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $rawSig) {
      Write-Host "[X] Signing was enabled but no .sig file produced for $($t.Triple)"
      exit 1
    }
    if ($rawSig.FullName -ne $expectedSigPath) {
      Move-Item -Path $rawSig.FullName -Destination $expectedSigPath -Force
    }
    $sig = Get-Item $expectedSigPath
  }

  $sizeMB = [math]::Round($exe.Length / 1MB, 2)
  Write-Host "[OK] $($exe.Name) ($sizeMB MB)$(if ($sig) { ' + signed' } else { ' (unsigned)' })"
  $bundles += [pscustomobject]@{
    Exe      = $exe
    Sig      = $sig
    Arch     = $t.Arch
    RustArch = $t.RustArch
  }
}

# --- GitHub release (draft) --------------------------------------------------
$gh = Get-Command gh -ErrorAction SilentlyContinue
if (-not $gh) {
  Write-Host ""
  Write-Host "[!] gh CLI not found - skipping draft release upload"
  Write-Host "    Bundles to upload manually:"
  foreach ($b in $bundles) {
    Write-Host "      $($b.Exe.FullName)"
    if ($b.Sig) { Write-Host "      $($b.Sig.FullName)" }
  }
  exit 0
}

# Auth check — gh CLI must be logged in via `gh auth login`. Wrapped in
# try/catch because gh writes its status banner to stderr even on success,
# which $ErrorActionPreference=Stop turns into a terminating error.
try {
  & gh auth status *> $null
} catch {
  $LASTEXITCODE = 1
}
if ($LASTEXITCODE -ne 0) {
  Write-Host "[X] gh CLI is not authenticated. Run 'gh auth login'"
  exit 1
}

# Tag the source commit on origin (lunopeak-app) for code traceability.
$existingTag = & git -C $ProjectDir tag -l "v$pkgVersion"
if (-not $existingTag) {
  Write-Host ""
  Write-Host "[*] Tagging v$pkgVersion on origin"
  & git -C $ProjectDir tag "v$pkgVersion"
  $null = & git -C $ProjectDir push origin "v$pkgVersion" 2>&1
  if ($LASTEXITCODE -ne 0) {
    Write-Host "    (tag push failed - tag may already exist on remote, continuing)"
  }
}

# Detect existing draft on $ReleaseRepo. Wrapped in try/catch because
# $ErrorActionPreference=Stop turns gh's "release not found" stderr write into
# a terminating NativeCommandError.
$releaseExists = $false
try {
  & gh release view "v$pkgVersion" --repo $ReleaseRepo *> $null
  if ($LASTEXITCODE -eq 0) { $releaseExists = $true }
} catch {
  $releaseExists = $false
}

# --- Build / merge latest.json -----------------------------------------------
# This script is platform-specific; we only emit Windows entries. If a mac
# flow has already uploaded latest.json with darwin entries, merge ours in
# without clobbering theirs.
$manifest = $null
if ($signingEnabled -and $releaseExists) {
  $tempDir = Join-Path $env:TEMP ("lunopeak-rel-" + [guid]::NewGuid().ToString('N').Substring(0,8))
  New-Item -ItemType Directory -Path $tempDir | Out-Null
  try {
    & gh release download "v$pkgVersion" --repo $ReleaseRepo --pattern 'latest.json' --dir $tempDir *> $null
    $existingPath = Join-Path $tempDir 'latest.json'
    if ((Test-Path $existingPath) -and ($LASTEXITCODE -eq 0)) {
      $manifest = Get-Content $existingPath -Raw | ConvertFrom-Json
      Write-Host ""
      Write-Host "[*] Merging into existing latest.json from release"
    }
  } catch {} finally {
    if (Test-Path $tempDir) { Remove-Item -Recurse -Force $tempDir }
  }
}

if ($signingEnabled) {
  $notesText = (Get-Content $releaseNotes -Raw).TrimEnd()
  $pubDate   = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")

  if (-not $manifest) {
    $manifest = [pscustomobject]@{
      version   = $pkgVersion
      notes     = $notesText
      pub_date  = $pubDate
      platforms = [pscustomobject]@{}
    }
  } else {
    # Refresh top-level fields from this build.
    $manifest.version  = $pkgVersion
    $manifest.notes    = $notesText
    $manifest.pub_date = $pubDate
    if (-not $manifest.platforms) {
      $manifest | Add-Member -MemberType NoteProperty -Name platforms -Value ([pscustomobject]@{}) -Force
    }
  }

  foreach ($b in $bundles) {
    $platformKey = "windows-$($b.RustArch)"
    $sigContent  = (Get-Content $b.Sig.FullName -Raw).Trim()
    $url         = "https://github.com/$ReleaseRepo/releases/download/v$pkgVersion/$($b.Exe.Name)"
    $entry = [pscustomobject]@{ signature = $sigContent; url = $url }
    $manifest.platforms | Add-Member -MemberType NoteProperty -Name $platformKey -Value $entry -Force
  }

  $latestJsonPath = Join-Path $env:TEMP 'latest.json'
  # Write BOM-less UTF-8. Windows PowerShell 5.x's `-Encoding UTF8` adds a BOM,
  # which breaks tauri-plugin-updater (serde_json refuses leading EF BB BF).
  $json = $manifest | ConvertTo-Json -Depth 6
  [System.IO.File]::WriteAllText($latestJsonPath, $json, (New-Object System.Text.UTF8Encoding $false))
}

# --- Upload ------------------------------------------------------------------
# Build the full asset list: every .exe, every .sig, plus latest.json.
$assets = @()
foreach ($b in $bundles) {
  $assets += $b.Exe.FullName
  if ($b.Sig) { $assets += $b.Sig.FullName }
}
if ($signingEnabled) { $assets += $latestJsonPath }

if (-not $releaseExists) {
  $first, $rest = $assets
  Write-Host ""
  Write-Host "[*] Creating draft release v$pkgVersion on $ReleaseRepo with $((Split-Path -Leaf $first))..."
  & gh release create "v$pkgVersion" $first `
    --repo $ReleaseRepo `
    --target $ReleaseTarget `
    --title "v$pkgVersion" `
    --notes-file $releaseNotes `
    --draft
  if ($LASTEXITCODE -ne 0) { Write-Host "[X] gh release create failed"; exit 1 }
  $remaining = $rest
} else {
  Write-Host ""
  Write-Host "[*] Release v$pkgVersion exists on $ReleaseRepo - uploading $($assets.Count) asset(s)..."
  $remaining = $assets
}

foreach ($a in $remaining) {
  $name = Split-Path -Leaf $a
  Write-Host "    uploading $name"
  & gh release upload "v$pkgVersion" $a --repo $ReleaseRepo --clobber
  if ($LASTEXITCODE -ne 0) { Write-Host "[X] gh release upload failed for $name"; exit 1 }
}

# Verify every asset landed.
$assetNames = & gh release view "v$pkgVersion" --repo $ReleaseRepo --json assets --jq '.assets[].name'
$expected = $assets | ForEach-Object { Split-Path -Leaf $_ }
$missing = @()
foreach ($e in $expected) {
  if ($assetNames -notcontains $e) { $missing += $e }
}
if ($missing.Count -gt 0) {
  Write-Host "[X] Upload reported success but these assets are missing from the release:"
  foreach ($m in $missing) { Write-Host "      $m" }
  Write-Host "    Present: $assetNames"
  exit 1
}

Write-Host ""
Write-Host "[OK] Drafted v$pkgVersion on $ReleaseRepo"
foreach ($b in $bundles) {
  Write-Host "     - $($b.Exe.Name)"
  if ($b.Sig) { Write-Host "       $($b.Sig.Name)" }
}
if ($signingEnabled) { Write-Host "     - latest.json" }
Write-Host "     https://github.com/$ReleaseRepo/releases/tag/v$pkgVersion"
