#!/usr/bin/env node
// Uploads release assets to an existing GitHub release with a live progress
// board: one line per file in flight (bar, %, size, speed, ETA) plus a total,
// redrawn in place. Without a TTY (CI, piped logs) it prints the total every 5s.
//
// Usage: node scripts/upload-release.mjs --repo owner/name --tag vX.Y.Z file...
//
// Same as `gh release upload --clobber`: an asset with the same name is
// replaced. Uses `gh` for the release lookup and the token, so `gh auth login`
// is the only setup.
import { execFile } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import path from "node:path";

const CONCURRENCY = 3;
const MAX_ATTEMPTS = 3;

const args = process.argv.slice(2);
let repo = "";
let tag = "";
const files = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--repo") repo = args[++i];
  else if (args[i] === "--tag") tag = args[++i];
  else files.push(args[i]);
}
if (!repo || !tag || files.length === 0) {
  console.error("Usage: node scripts/upload-release.mjs --repo owner/name --tag vX.Y.Z file...");
  process.exit(2);
}
for (const file of files) {
  if (!fs.existsSync(file)) {
    console.error(`Missing asset: ${file}`);
    process.exit(1);
  }
}

const MIME_TYPES = {
  ".dmg": "application/x-apple-diskimage",
  ".gz": "application/gzip",
  ".json": "application/json",
  ".sig": "text/plain",
  ".exe": "application/vnd.microsoft.portable-executable",
  ".msi": "application/x-msi",
  ".zip": "application/zip",
  ".deb": "application/vnd.debian.binary-package",
  ".rpm": "application/x-rpm",
  ".AppImage": "application/octet-stream",
};

function formatBytes(n) {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${Math.round(n)} B`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return "--:--";
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function bar(fraction, width = 20) {
  const filled = Math.round(Math.min(1, fraction) * width);
  return `[${"#".repeat(filled)}${"-".repeat(width - filled)}]`;
}

// Keep the distinguishing tail if a name ever outgrows the column.
function fitName(name, width = 34) {
  return name.length > width ? `…${name.slice(-(width - 1))}` : name.padEnd(width);
}

function progressLine(label, sent, size, started) {
  const elapsed = (Date.now() - started) / 1000;
  const rate = elapsed > 0 ? sent / elapsed : 0;
  const pct = size > 0 ? sent / size : 1;
  return (
    `${label} ${bar(pct)} ${String(Math.floor(pct * 100)).padStart(3)}%  ` +
    `${formatBytes(sent)}/${formatBytes(size)}  ${formatBytes(rate)}/s  ETA ${formatDuration((size - sent) / rate)}`
  );
}

// One line per in-flight upload plus a total line, redrawn in place. Messages
// (finished, retrying) print above the block so they scroll normally.
class ProgressBoard {
  constructor(totalSize, fileCount) {
    this.isTTY = process.stdout.isTTY;
    this.active = new Set();
    this.totalSize = totalSize;
    this.fileCount = fileCount;
    this.doneBytes = 0;
    this.doneCount = 0;
    this.started = Date.now();
    this.drawnLines = 0;
    this.timer = setInterval(() => this.tick(), this.isTTY ? 150 : 5000);
  }

  sentBytes() {
    let sent = this.doneBytes;
    for (const task of this.active) sent += task.sent;
    return sent;
  }

  totalLine() {
    return (
      progressLine(fitName("Total"), this.sentBytes(), this.totalSize, this.started) +
      `  (${this.doneCount}/${this.fileCount} files)`
    );
  }

  clip(line) {
    const cols = process.stdout.columns || 120;
    return line.length >= cols ? line.slice(0, cols - 1) : line;
  }

  clear() {
    if (this.drawnLines > 0) process.stdout.write(`\x1b[${this.drawnLines}F\x1b[0J`);
    this.drawnLines = 0;
  }

  draw() {
    const lines = [...this.active].map((t) => progressLine(fitName(t.name), t.sent, t.size, t.started));
    lines.push(this.totalLine());
    process.stdout.write(lines.map((l) => `${this.clip(l)}\n`).join(""));
    this.drawnLines = lines.length;
  }

  tick() {
    if (this.isTTY) {
      this.clear();
      this.draw();
    } else {
      console.log(this.totalLine());
    }
  }

  log(message) {
    if (this.isTTY) this.clear();
    console.log(message);
    if (this.isTTY) this.draw();
  }

  stop() {
    clearInterval(this.timer);
    if (this.isTTY) this.clear();
  }
}

function gh(ghArgs) {
  return new Promise((resolve, reject) => {
    execFile("gh", ghArgs, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) =>
      err ? reject(new Error(stderr.trim() || err.message)) : resolve(stdout)
    );
  });
}

async function viewRelease() {
  return JSON.parse(await gh(["release", "view", tag, "--repo", repo, "--json", "uploadUrl,assets"]));
}

function uploadAsset(uploadUrl, token, task) {
  const url = new URL(uploadUrl.replace(/\{.*\}$/, ""));
  url.searchParams.set("name", task.name);

  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(task.file);
    let settled = false;
    // A dead request must also stop its read stream, or the stale stream keeps
    // adding to task.sent while the retry runs.
    const fail = (err) => {
      if (settled) return;
      settled = true;
      stream.destroy();
      req.destroy();
      reject(err);
    };

    const ext = task.name.endsWith(".AppImage") ? ".AppImage" : path.extname(task.name).toLowerCase();
    const req = https.request(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
        "Content-Length": task.size,
        "User-Agent": "release-upload-script",
      },
    });

    req.on("response", (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return fail(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 300)}`));
        }
        settled = true;
        resolve();
      });
    });
    req.on("error", fail);

    stream.on("data", (chunk) => {
      if (!settled) task.sent += chunk.length;
    });
    stream.on("error", fail);
    stream.pipe(req);
  });
}

async function uploadAll() {
  const release = await viewRelease();
  const token = (await gh(["auth", "token"])).trim();

  // Largest first, so the big installers overlap instead of one trailing alone.
  const queue = files
    .map((file) => ({ file, name: path.basename(file), size: fs.statSync(file).size, sent: 0 }))
    .sort((a, b) => b.size - a.size);
  const totalSize = queue.reduce((sum, t) => sum + t.size, 0);

  console.log(`   Uploading ${queue.length} file(s), ${formatBytes(totalSize)} total, ${CONCURRENCY} at a time.`);
  const board = new ProgressBoard(totalSize, queue.length);

  async function uploadWithRetry(task) {
    // GitHub rejects a duplicate asset name, so drop the old one first.
    let existing = release.assets.find((a) => a.name === task.name);
    for (let attempt = 1; ; attempt++) {
      if (existing) await gh(["api", "-X", "DELETE", existing.apiUrl]);
      task.sent = 0;
      task.started = Date.now();
      board.active.add(task);
      try {
        await uploadAsset(release.uploadUrl, token, task);
        board.active.delete(task);
        return;
      } catch (err) {
        board.active.delete(task);
        if (attempt >= MAX_ATTEMPTS) throw new Error(`${task.name}: ${err.message}`);
        board.log(`   ${task.name}: upload failed (${err.message}) — retrying (${attempt + 1}/${MAX_ATTEMPTS})`);
        // A failed attempt can leave a partial asset behind that would block
        // the retry, so look again.
        existing = (await viewRelease()).assets.find((a) => a.name === task.name);
      }
    }
  }

  async function worker() {
    while (queue.length > 0) {
      const task = queue.shift();
      await uploadWithRetry(task);
      board.doneBytes += task.size;
      board.doneCount++;
      const elapsed = (Date.now() - task.started) / 1000;
      board.log(`   ✓ ${task.name} (${formatBytes(task.size)} in ${formatDuration(elapsed)})`);
    }
  }

  try {
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
  } finally {
    board.stop();
  }

  const elapsed = (Date.now() - board.started) / 1000;
  console.log(
    `   Uploaded ${formatBytes(totalSize)} in ${formatDuration(elapsed)} ` +
      `(avg ${formatBytes(totalSize / Math.max(elapsed, 0.001))}/s).`
  );
}

uploadAll().catch((err) => {
  console.error(`❌ Failed to upload assets to ${tag}: ${err.message}`);
  process.exit(1);
});
