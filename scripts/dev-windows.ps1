#Requires -Version 5.1
[CmdletBinding()]
param(
  # Load env and verify tools, then exit without starting Tauri. Useful for
  # smoke-testing this script and diagnosing a broken Windows toolchain.
  [switch]$Check,
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$TauriArgs
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false

# Launches `tauri dev` with the toolchain env that the Rust build needs:
#   - clang on PATH (ring's build script requires it on aarch64-pc-windows-msvc)
#   - the Visual Studio Developer Shell loaded (cl.exe, link.exe, Windows SDK)
# Safe to run from any shell - re-entrant if the dev env is already loaded.

$ScriptDir  = $PSScriptRoot
$ProjectDir = Split-Path -Parent $ScriptDir

# 1. Put clang on PATH.
$llvmBin = 'C:\Program Files\LLVM\bin'
if (Test-Path $llvmBin) {
  if (($env:Path -split ';') -notcontains $llvmBin) {
    $env:Path = "$llvmBin;$env:Path"
  }
} else {
  Write-Host "[X] LLVM not found at $llvmBin"
  Write-Host '    Install with: winget install --id LLVM.LLVM'
  exit 1
}

# 2. Load the VS Developer Shell if not already loaded. VCINSTALLDIR is set by
#    Launch-VsDevShell.ps1 and is the cheapest "are we already in one?" probe.
if (-not $env:VCINSTALLDIR) {
  $vswhere = 'C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe'
  if (-not (Test-Path $vswhere)) {
    Write-Host '[X] vswhere.exe not found.'
    Write-Host '    Install Visual Studio (Community is fine) with the "Desktop development with C++" workload.'
    exit 1
  }
  $vsInstall = & $vswhere -latest -prerelease -property installationPath
  if (-not $vsInstall) {
    Write-Host '[X] No Visual Studio installation found via vswhere.'
    exit 1
  }
  $launchScript = Join-Path $vsInstall 'Common7\Tools\Launch-VsDevShell.ps1'
  if (-not (Test-Path $launchScript)) {
    Write-Host "[X] Launch-VsDevShell.ps1 missing at $launchScript"
    exit 1
  }
  # ARM64 detection: PROCESSOR_ARCHITECTURE and .NET's RuntimeInformation both
  # report the *process* arch and lie under emulation. C:\Windows\SysArm32 is
  # the 32-bit-ARM emulation layer that ships only on ARM64 Windows hosts -
  # a deterministic on-disk signal that survives x64 emulation.
  # -HostArch must be x86 or amd64 (Launch-VsDevShell.ps1 doesn't accept arm64
  # there); on ARM64 we cross-compile to arm64 using the amd64-hosted toolchain.
  $targetArch = if (Test-Path 'C:\Windows\SysArm32') { 'arm64' } else { 'amd64' }
  Write-Host "[*] Loading VS Developer Shell (host: amd64, target: $targetArch)..."
  & $launchScript -Arch $targetArch -HostArch amd64 -SkipAutomaticLocation | Out-Null
  if (-not $env:VCINSTALLDIR) {
    Write-Host '[X] Launch-VsDevShell.ps1 ran but VCINSTALLDIR is still unset.'
    exit 1
  }
}

# 3. Sanity check the tools the Rust build needs.
foreach ($tool in 'clang','cl','link','cargo','npm') {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
    Write-Host "[X] required tool not on PATH after env load: $tool"
    exit 1
  }
}

if ($Check) {
  Write-Host '[OK] toolchain ready (clang, cl, link, cargo, npm)'
  exit 0
}

Set-Location $ProjectDir
& npx tauri dev @TauriArgs
exit $LASTEXITCODE
