#!/usr/bin/env node
// Notarizes one file (DMG or zip) with a live status line instead of
// notarytool's "Current status: In Progress......." dots:
//
//   ⠹ Apple is checking Sift_2.0.0_universal.dmg — In Progress · 2:14 (usually 1–5 min)
//
// Submits with --no-wait, then polls `notarytool info` every 15s. Apple doesn't
// report a percentage while it checks, so the line shows the live status and
// the time spent. If Apple rejects the file, the notary log is printed and the
// script exits 1. Without a TTY it prints one line every 30s.
//
// Usage: node scripts/notarize.mjs <file>
// Reads APPLE_ID, APPLE_PASSWORD and APPLE_TEAM_ID from the environment.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const POLL_MS = 15_000;
const TIMEOUT_MS = 60 * 60_000;
const MAX_POLL_ERRORS = 5;

const file = process.argv[2];
if (!file || !fs.existsSync(file)) {
  console.error(`Usage: node scripts/notarize.mjs <file>${file ? ` (missing: ${file})` : ""}`);
  process.exit(2);
}
const { APPLE_ID, APPLE_PASSWORD, APPLE_TEAM_ID } = process.env;
if (!APPLE_ID || !APPLE_PASSWORD || !APPLE_TEAM_ID) {
  console.error("❌ APPLE_ID, APPLE_PASSWORD and APPLE_TEAM_ID must be set.");
  process.exit(2);
}
const auth = ["--apple-id", APPLE_ID, "--password", APPLE_PASSWORD, "--team-id", APPLE_TEAM_ID];
const name = path.basename(file);

function formatBytes(n) {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024).toFixed(0)} KB`;
}

function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function notarytool(args) {
  return new Promise((resolve, reject) => {
    execFile("xcrun", ["notarytool", ...args], { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) =>
      err ? reject(new Error((stderr || stdout).trim() || err.message)) : resolve(stdout)
    );
  });
}

// notarytool can print warnings around its JSON; take the outermost object.
function parseJson(out) {
  const start = out.indexOf("{");
  const end = out.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error(`Unexpected notarytool output: ${out.trim().slice(0, 300)}`);
  return JSON.parse(out.slice(start, end + 1));
}

// A single status line redrawn in place, with a spinner and the elapsed time.
class StatusLine {
  constructor() {
    this.isTTY = process.stdout.isTTY;
    this.frames = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
    this.frame = 0;
    this.text = () => "";
    this.lastPlain = 0;
    this.timer = setInterval(() => this.tick(), this.isTTY ? 100 : 1000);
  }

  set(text) {
    this.text = text;
    this.tick();
  }

  tick() {
    if (this.isTTY) {
      const cols = process.stdout.columns || 120;
      let line = `   ${this.frames[this.frame++ % this.frames.length]} ${this.text()}`;
      if (line.length >= cols) line = line.slice(0, cols - 1);
      process.stdout.write(`\r\x1b[2K${line}`);
    } else if (Date.now() - this.lastPlain >= 30_000) {
      this.lastPlain = Date.now();
      console.log(`   ${this.text()}`);
    }
  }

  done(message) {
    clearInterval(this.timer);
    if (this.isTTY) process.stdout.write("\r\x1b[2K");
    if (message) console.log(message);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const started = Date.now();
  const size = fs.statSync(file).size;
  const status = new StatusLine();

  // 1. Upload. notarytool doesn't report upload progress, so show time spent.
  status.set(() => `Uploading ${name} (${formatBytes(size)}) to Apple · ${formatDuration(Date.now() - started)}`);
  let id;
  try {
    id = parseJson(await notarytool(["submit", file, ...auth, "--no-wait", "--output-format", "json"])).id;
  } catch (err) {
    status.done(`❌ Couldn't submit ${name} to Apple: ${err.message}`);
    process.exit(1);
  }
  if (!id) {
    status.done(`❌ notarytool didn't return a submission id for ${name}.`);
    process.exit(1);
  }
  status.done(`   ✓ Uploaded ${name} (${formatBytes(size)}) in ${formatDuration(Date.now() - started)} — submission ${id}`);

  // 2. Wait for Apple's verdict.
  const checking = Date.now();
  const status2 = new StatusLine();
  let state = "In Progress";
  let pollErrors = 0;
  let note = "";
  status2.set(
    () =>
      `Apple is checking ${name} — ${state} · ${formatDuration(Date.now() - checking)} (usually 1–5 min)${note}`
  );

  while (state === "In Progress") {
    if (Date.now() - checking > TIMEOUT_MS) {
      status2.done(`❌ Still in progress after ${formatDuration(TIMEOUT_MS)}. Check later with:`);
      console.log(`   xcrun notarytool info ${id} --apple-id … --team-id ${APPLE_TEAM_ID}`);
      process.exit(1);
    }
    await sleep(POLL_MS);
    try {
      state = parseJson(await notarytool(["info", id, ...auth, "--output-format", "json"])).status || state;
      pollErrors = 0;
      note = "";
    } catch (err) {
      // Apple's service drops the odd request; only give up if it keeps failing.
      if (++pollErrors >= MAX_POLL_ERRORS) {
        status2.done(`❌ Couldn't get the notarization status: ${err.message}`);
        process.exit(1);
      }
      note = ` · status check failed, retrying (${pollErrors}/${MAX_POLL_ERRORS})`;
    }
  }

  if (state === "Accepted") {
    status2.done(`   ✓ Notarized ${name} in ${formatDuration(Date.now() - checking)} (total ${formatDuration(Date.now() - started)})`);
    return;
  }

  status2.done(`❌ Notarization of ${name} finished with status: ${state}`);
  try {
    console.log(await notarytool(["log", id, ...auth]));
  } catch (err) {
    console.log(`   (couldn't fetch the notary log: ${err.message})`);
  }
  process.exit(1);
}

main();
