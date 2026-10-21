#!/usr/bin/env node
// Windows release entry point.
//
// Exists only to fail with a useful message off-Windows. Invoking
// build-windows.ps1 directly from an npm script on macOS/Linux yields
// "sh: powershell: command not found", which says nothing about why.
//
// Tauri cannot cross-compile Windows bundles: NSIS bundling needs the Windows
// toolchain and WebView2 linkage is fragile under MinGW. There is no macOS- or
// Linux-hosted path to a .exe — run this on a Windows machine, or use a
// windows-latest CI runner.
//
// Usage: node scripts/dist-windows.mjs [args forwarded to build-windows.ps1]

import { spawnSync } from "node:child_process";

if (process.platform !== "win32") {
  console.error(`\n❌ Windows releases must be built on a Windows host (this is ${process.platform}).`);
  console.error("   Tauri can't cross-compile NSIS installers — no macOS/Linux path exists.");
  console.error("   Run `npm run dist:win` on a Windows machine, or use a windows-latest");
  console.error("   CI runner. See RELEASE.md.\n");
  process.exit(1);
}

const { status, error } = spawnSync(
  "powershell",
  ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "scripts/build-windows.ps1", ...process.argv.slice(2)],
  { stdio: "inherit" },
);

if (error) {
  console.error(`\n❌ Failed to launch powershell: ${error.message}\n`);
  process.exit(1);
}

process.exit(status ?? 1);
