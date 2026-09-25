# YouTube Terminal GUI

A Tauri v2 desktop app that searches, plays and downloads YouTube videos in a
terminal-style window.

**The installers are self-contained.** `yt-dlp`, `ffmpeg` and `ffprobe` ship
inside the app, so end users do not need Python, Rust, ffmpeg, mpv, or any
package manager. Download one file, install, run.

## Download

All installers are attached to the [v0.1.1 release](https://github.com/dnysaz/ytg-dev/releases/tag/v0.1.1).

| Platform | Architecture | Installer | Size |
|---|---|---|---|
| macOS (10.15+) | Universal — Intel + Apple Silicon | [`.dmg`](https://github.com/dnysaz/ytg-dev/releases/download/v0.1.1/youtube-terminal-gui_0.1.1_universal.dmg) | 124 MB |
| Windows 10/11 | x64 | [`-setup.exe`](https://github.com/dnysaz/ytg-dev/releases/download/v0.1.1/youtube-terminal-gui_0.1.1_x64-setup.exe) | 108 MB |
| Windows 10/11 | arm64 | [`-setup.exe`](https://github.com/dnysaz/ytg-dev/releases/download/v0.1.1/youtube-terminal-gui_0.1.1_arm64-setup.exe) | 81 MB |
| Linux (glibc 2.28+) | x64 | [`.deb`](https://github.com/dnysaz/ytg-dev/releases/download/v0.1.1/youtube-terminal-gui_0.1.1_amd64.deb) · [`.AppImage`](https://github.com/dnysaz/ytg-dev/releases/download/v0.1.1/youtube-terminal-gui_0.1.1_amd64.AppImage) | 175 / 236 MB |
| Linux (glibc 2.28+) | arm64 | [`.deb`](https://github.com/dnysaz/ytg-dev/releases/download/v0.1.1/youtube-terminal-gui_0.1.1_arm64.deb) · [`.AppImage`](https://github.com/dnysaz/ytg-dev/releases/download/v0.1.1/youtube-terminal-gui_0.1.1_aarch64.AppImage) | 163 / 221 MB |

### ⚠️ The installers are not signed

You will get a security warning on first launch. This is expected, not a sign of
malware — the project has no code-signing certificate. See
[Code signing](#code-signing) for the workaround and the permanent fix.

The application is GPL-3.0 and the binaries are built publicly by GitHub
Actions, so every installer has a verifiable provenance: open the
[Actions tab](https://github.com/dnysaz/ytg-dev/actions), pick the `release` run
for `v0.1.1`, and you will see all five build jobs.

## Requirements (build machine only)

- Node.js 20+
- Rust (stable) with the target for the OS you are building on
- macOS: Xcode Command Line Tools — Windows: MSVC Build Tools — Linux: see below

End users need none of this.

## Quick start

```bash
npm install
npm run fetch-deps   # downloads yt-dlp + ffmpeg + ffprobe for your host target
npm run dev          # tauri dev
npm run build        # tauri build, produces the installer
```

`npm run fetch-deps` writes to `src-tauri/binaries/` (git-ignored). Tauri's
`bundle.externalBin` requires the `<name>-<target-triple>` naming convention,
which the script handles.

```bash
node scripts/fetch-deps.mjs --target universal-apple-darwin   # explicit target
node scripts/fetch-deps.mjs --force                           # re-download
```

## How playback works

| Path | Mechanism | Quality |
|---|---|---|
| Normal play (`Enter` / `y`) | Bundled yt-dlp returns a muxed progressive MP4 or an HLS manifest; the webview plays it directly | 360p, or live HLS |
| **Play 1080p** (`m`) | Bundled yt-dlp + bundled ffmpeg download and mux the best video+audio to a local MP4 in the app cache, then the webview plays it via the asset protocol | up to 1080p |

The 1080p path exists because webviews cannot mux separate DASH video/audio
streams. Merging locally keeps playback **in the same window** and needs no
external media player.

## Bundled tool sources

| Tool | Windows | Linux | macOS |
|---|---|---|---|
| yt-dlp | `yt-dlp.exe`, `yt-dlp_arm64.exe` | `yt-dlp_linux`, `yt-dlp_linux_aarch64` | `yt-dlp_macos` (universal2) |
| ffmpeg / ffprobe | [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds) `win64` / `winarm64` | BtbN `linux64` / `linuxarm64` | [eugeneware/ffmpeg-static](https://github.com/eugeneware/ffmpeg-static), merged with `lipo` |

There is no published universal ffmpeg for macOS, so `fetch-deps` downloads the
x86_64 and arm64 builds separately and merges them with `lipo` (available on the
macOS runner). This is the only target that needs platform-specific handling.

## Building installers

Tauri **cannot cross-compile**. Each installer must be built on its own OS, so
this repository uses a GitHub Actions matrix
(`.github/workflows/release.yml`) rather than a single local command.

| Target triple | Runner | Installer |
|---|---|---|
| `universal-apple-darwin` | `macos-14` | `.dmg` |
| `x86_64-pc-windows-msvc` | `windows-latest` | `-setup.exe` (NSIS) |
| `aarch64-pc-windows-msvc` | `windows-11-arm` | `-setup.exe` (NSIS) |
| `x86_64-unknown-linux-gnu` | `ubuntu-22.04` | `.deb`, `.AppImage` |
| `aarch64-unknown-linux-gnu` | `ubuntu-22.04-arm` | `.deb`, `.AppImage` |

Run it via *Actions → release → Run workflow*, or push a `v*` tag to also
publish a GitHub Release with every installer attached.

Linux build dependencies are installed by the workflow:
`libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev patchelf rpm xz-utils`.

### Size

The installers are large because a whole media stack is packed inside. Raw
payload is roughly **195 MB** (yt-dlp ~37 MB, ffmpeg ~79 MB, ffprobe ~79 MB,
app ~12 MB), which the formats compress to:

| Installer | Shipped size |
|---|---|
| Windows `-setup.exe` (NSIS) | 81–108 MB |
| macOS `.dmg` | 124 MB |
| Linux `.deb` | 163–175 MB |
| Linux `.AppImage` | 221–236 MB |

Dropping `ffprobe` would cut ~79 MB of payload but breaks some yt-dlp
post-processing options, so it is bundled by default.

## License

[GPL-3.0](LICENSE).

This is not optional for the installers. The PyInstaller-bundled yt-dlp
executables contain GPLv3+ licensed code, and yt-dlp's own documentation states
that the combined work is therefore licensed under GPLv3+. The ffmpeg builds used
here are the **GPL** variants for the same reason.

If you give a built installer to anyone, you must also make the corresponding
source available and include the third-party license texts. The application
source in this repository is covered by GPL-3.0; the bundled yt-dlp and ffmpeg
binaries keep their own upstream licenses (GPLv3+ and GPLv3 respectively).

## Code signing

The installers are **not signed**. Users will see:

- **macOS** — Gatekeeper blocks the app ("damaged" / unidentified developer).
  Mitigate with an Apple Developer ID and notarization (`bundle.macOS.signingIdentity`).
- **Windows** — SmartScreen warns ("Windows protected your PC"). Mitigate with an
  EV/OV code-signing certificate.
- **Linux** — AppImage files need `chmod +x` and some distros flag them as
  unsigned.

Ad-hoc workaround for testers:

- **macOS**: `xattr -dr com.apple.quarantine /Applications/youtube-terminal-gui.app`
- **Windows**: open the installer → "Windows protected your PC" → **More info** →
  **Run anyway**. Verify the download first against `SHA256SUMS.txt` on the
  release page (`certutil -hashfile <file> SHA256`).

## Keyboard shortcuts

| Key | Action |
|---|---|
| `↑` `↓` / `j` `k` | Move selection |
| `Enter` / `y` | Play (fast, 360p / HLS) |
| `m` | Play 1080p (merged locally) |
| `/` | Focus search |
| `Enter` in search | Search YouTube |
