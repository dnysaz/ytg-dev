#!/usr/bin/env node
/**
 * Downloads the third-party tools that get bundled into the installers, so that
 * an end user never has to install yt-dlp, ffmpeg, Python or a media player.
 *
 * Tauri's `bundle.externalBin` requires each binary to be stored as
 * `src-tauri/binaries/<name>-<target-triple><.exe>`, which is exactly what this
 * script produces.
 *
 * Usage:
 *   node scripts/fetch-deps.mjs                     # host target triple
 *   node scripts/fetch-deps.mjs --target <triple>   # explicit target
 *   node scripts/fetch-deps.mjs --force             # re-download
 */

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BIN_DIR = join(ROOT, "src-tauri", "binaries");

const YTDLP = "https://github.com/yt-dlp/yt-dlp/releases/latest/download";
const FFMPEG_STATIC = "https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1";
const FFMPEG_BUILDS = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest";

const MAC_TARGETS = ["x86_64-apple-darwin", "aarch64-apple-darwin", "universal-apple-darwin"];
const WIN_TARGETS = ["x86_64-pc-windows-msvc", "aarch64-pc-windows-msvc"];
const LINUX_TARGETS = ["x86_64-unknown-linux-gnu", "aarch64-unknown-linux-gnu"];
const ALL_TARGETS = [...MAC_TARGETS, ...WIN_TARGETS, ...LINUX_TARGETS];

/** yt-dlp ships self-contained PyInstaller builds - no Python needed. */
const YTDLP_ASSET = {
  "x86_64-apple-darwin": "yt-dlp_macos",
  "aarch64-apple-darwin": "yt-dlp_macos",
  "universal-apple-darwin": "yt-dlp_macos", // already a universal2 binary
  "x86_64-pc-windows-msvc": "yt-dlp.exe",
  "aarch64-pc-windows-msvc": "yt-dlp_arm64.exe",
  "x86_64-unknown-linux-gnu": "yt-dlp_linux",
  "aarch64-unknown-linux-gnu": "yt-dlp_linux_aarch64",
};

/** ffmpeg + ffprobe archives for Windows and Linux (both binaries in one archive). */
const FFMPEG_ARCHIVE = {
  "x86_64-pc-windows-msvc": `${FFMPEG_BUILDS}/ffmpeg-master-latest-win64-gpl.zip`,
  "aarch64-pc-windows-msvc": `${FFMPEG_BUILDS}/ffmpeg-master-latest-winarm64-gpl.zip`,
  "x86_64-unknown-linux-gnu": `${FFMPEG_BUILDS}/ffmpeg-master-latest-linux64-gpl.tar.xz`,
  "aarch64-unknown-linux-gnu": `${FFMPEG_BUILDS}/ffmpeg-master-latest-linuxarm64-gpl.tar.xz`,
};

/**
 * macOS has no published universal ffmpeg, so we download the two architecture
 * builds and merge them with `lipo` (macOS only, available on the CI runner).
 */
const FFMPEG_MAC = {
  ffmpeg: {
    "x86_64-apple-darwin": `${FFMPEG_STATIC}/ffmpeg-darwin-x64`,
    "aarch64-apple-darwin": `${FFMPEG_STATIC}/ffmpeg-darwin-arm64`,
  },
  ffprobe: {
    "x86_64-apple-darwin": `${FFMPEG_STATIC}/ffprobe-darwin-x64`,
    "aarch64-apple-darwin": `${FFMPEG_STATIC}/ffprobe-darwin-arm64`,
  },
};

function log(msg) {
  console.log(`[fetch-deps] ${msg}`);
}

function run(cmd, args) {
  execFileSync(cmd, args, { stdio: ["ignore", "ignore", "inherit"] });
}

function hostTriple() {
  // `--print host-tuple` landed in Rust 1.84; fall back to `rustc -vV` before that.
  try {
    return execFileSync("rustc", ["--print", "host-tuple"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    const info = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
    const line = info.split("\n").find((l) => l.startsWith("host:"));
    if (!line) throw new Error("could not determine host target triple from rustc");
    return line.slice("host:".length).trim();
  }
}

async function download(url, dest) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) {
    throw new Error(`empty response for ${url}`);
  }
  writeFileSync(dest, buf);
  return dest;
}

function artifactName(tool, triple) {
  return `${tool}-${triple}${triple.includes("windows") ? ".exe" : ""}`;
}

function artifactPath(tool, triple) {
  return join(BIN_DIR, artifactName(tool, triple));
}

function place(source, tool, triple) {
  const dest = artifactPath(tool, triple);
  if (source !== dest) copyFileSync(source, dest);
  if (!triple.includes("windows")) chmodSync(dest, 0o755);
  log(`  + ${artifactName(tool, triple)}`);
}

/** Locate `<archive-root>/bin/<name>` after extraction. */
function findExtracted(dir, name) {
  for (const entry of readdirSync(dir)) {
    for (const candidate of [join(dir, entry, "bin", name), join(dir, entry, name)]) {
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

async function fetchYtdlp(triple, work, force) {
  const dest = artifactPath("yt-dlp", triple);
  if (existsSync(dest) && !force) {
    log(`  = yt-dlp-${triple} (cached)`);
    return;
  }
  const asset = YTDLP_ASSET[triple];
  const tmp = join(work, "yt-dlp");
  await download(`${YTDLP}/${asset}`, tmp);
  place(tmp, "yt-dlp", triple);
}

async function fetchFfmpegArchives(triple, work, force) {
  const needed = ["ffmpeg", "ffprobe"].filter(
    (tool) => force || !existsSync(artifactPath(tool, triple)),
  );
  if (needed.length === 0) {
    log(`  = ffmpeg/ffprobe-${triple} (cached)`);
    return;
  }

  const url = FFMPEG_ARCHIVE[triple];
  const ext = url.endsWith(".zip") ? ".zip" : ".tar.xz";
  const archive = join(work, `ffmpeg${ext}`);
  log(`  downloading ffmpeg archive (${ext})`);
  await download(url, archive);

  const extracted = join(work, "ffmpeg-extracted");
  mkdirSync(extracted, { recursive: true });
  // `tar` (bsdtar on macOS/Windows, GNU tar on Linux) handles both zip and tar.xz.
  run("tar", ["-xf", archive, "-C", extracted]);

  for (const tool of needed) {
    const source = findExtracted(extracted, `${tool}.exe`) || findExtracted(extracted, tool);
    if (!source) throw new Error(`could not find ${tool} inside ${url}`);
    place(source, tool, triple);
  }
}

async function fetchMacTool(tool, triple, work, force) {
  const dest = artifactPath(tool, triple);
  if (existsSync(dest) && !force) {
    log(`  = ${tool}-${triple} (cached)`);
    return;
  }

  const urls = FFMPEG_MAC[tool];
  if (triple === "universal-apple-darwin") {
    // Merge the per-architecture artifacts we already placed, so nothing is
    // downloaded twice.
    const x64 = artifactPath(tool, "x86_64-apple-darwin");
    const arm = artifactPath(tool, "aarch64-apple-darwin");
    await fetchMacTool(tool, "x86_64-apple-darwin", work, force);
    await fetchMacTool(tool, "aarch64-apple-darwin", work, force);
    run("lipo", ["-create", "-output", dest, x64, arm]);
    chmodSync(dest, 0o755);
    log(`  + ${tool}-${triple} (lipo of x86_64 + aarch64)`);
    return;
  }

  const tmp = join(work, tool);
  await download(urls[triple], tmp);
  place(tmp, tool, triple);
}

async function fetchForTarget(triple, force) {
  if (!ALL_TARGETS.includes(triple)) {
    throw new Error(
      `unsupported target '${triple}'. Supported: ${ALL_TARGETS.join(", ")}`,
    );
  }

  log(`target ${triple}`);
  const work = mkdtempSync(join(tmpdir(), "fetch-deps-"));
  try {
    if (triple === "universal-apple-darwin") {
      // Tauri cross-compiles each macOS architecture separately for a universal
      // build, and every one of those builds resolves `externalBin` for its own
      // triple. So we must provide the per-architecture sidecars as well as the
      // merged universal one.
      for (const t of ["x86_64-apple-darwin", "aarch64-apple-darwin", "universal-apple-darwin"]) {
        await fetchYtdlp(t, work, force);
        await fetchMacTool("ffmpeg", t, work, force);
        await fetchMacTool("ffprobe", t, work, force);
      }
      return;
    }

    await fetchYtdlp(triple, work, force);
    if (MAC_TARGETS.includes(triple)) {
      await fetchMacTool("ffmpeg", triple, work, force);
      await fetchMacTool("ffprobe", triple, work, force);
    } else {
      await fetchFfmpegArchives(triple, work, force);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const i = args.indexOf("--target");
  const triple = i !== -1 ? args[i + 1] : hostTriple();

  if (i !== -1 && !triple) {
    throw new Error("--target requires a value");
  }

  mkdirSync(BIN_DIR, { recursive: true });
  await fetchForTarget(triple, force);
  log(`done -> ${BIN_DIR}`);
}

main().catch((err) => {
  console.error(`[fetch-deps] FAILED: ${err.message}`);
  process.exit(1);
});
