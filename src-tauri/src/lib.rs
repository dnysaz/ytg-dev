use serde::{Deserialize, Serialize};
use std::env;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use tauri::{Emitter, Manager};

// ---------------------------------------------------------------------------
// Bundled tool discovery (sidecars)
// ---------------------------------------------------------------------------
//
// `yt-dlp`, `ffmpeg` and `ffprobe` are shipped inside the installer via
// `bundle.externalBin`, so the app never depends on the user's PATH, on
// Python, or on any distro package. Tauri copies each sidecar next to the main
// executable, dropping the `-$TARGET_TRIPLE` suffix it has in `src-tauri/binaries`.

fn exe_suffix() -> &'static str {
    if cfg!(windows) {
        ".exe"
    } else {
        ""
    }
}

/// Resolve a bundled sidecar to an absolute path.
fn which_sidecar(name: &str) -> Option<PathBuf> {
    let filename = format!("{name}{}", exe_suffix());

    // 1. Production: Tauri places sidecars beside the main executable.
    if let Ok(exe) = env::current_exe() {
        if let Some(dir) = exe.parent() {
            let candidate = dir.join(&filename);
            if candidate.is_file() {
                return Some(candidate);
            }
            // Tolerate a Resources/ layout on macOS if the bundler puts them there.
            let in_resources = dir.parent().map(|p| p.join("Resources").join(&filename));
            if let Some(candidate) = in_resources {
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }

    // 2. Development: `tauri dev` does not copy externalBin entries, so fall
    //    back to the downloaded, target-suffixed file.
    let dev = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("binaries")
        .join(format!("{name}-{}{}", env!("TARGET"), exe_suffix()));
    if dev.is_file() {
        return Some(dev);
    }

    None
}

fn require_sidecar(name: &str) -> Result<PathBuf, String> {
    which_sidecar(name).ok_or_else(|| {
        format!(
            "Bundled '{name}' not found. Run `npm run fetch-deps` before building or running the app."
        )
    })
}

/// Directory holding the bundled tools, so yt-dlp can locate the ffmpeg that
/// ships with the app instead of whatever happens to be installed.
fn tools_dir() -> Option<PathBuf> {
    which_sidecar("ffmpeg")
        .or_else(|| which_sidecar("ffprobe"))
        .or_else(|| which_sidecar("yt-dlp"))
        .and_then(|p| p.parent().map(Path::to_path_buf))
}

fn build_tool_command(program: &Path) -> Command {
    let mut cmd = Command::new(program);

    // Put the bundled tools first on PATH. `env::join_paths` uses the correct
    // separator per platform (`;` on Windows, `:` elsewhere).
    let mut paths: Vec<PathBuf> = Vec::new();
    if let Some(dir) = tools_dir() {
        paths.push(dir);
    }
    if let Some(existing) = env::var_os("PATH") {
        paths.extend(env::split_paths(&existing));
    }
    if let Ok(joined) = env::join_paths(paths) {
        cmd.env("PATH", joined);
    }

    // `yt-dlp`, `ffmpeg` and `ffprobe` are console binaries. On Windows every
    // spawn would otherwise flash a terminal window over the app (and confuse
    // users into thinking a second app had opened).
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    cmd
}

fn ytdlp_command() -> Result<Command, String> {
    let ytdlp = require_sidecar("yt-dlp")?;
    let mut cmd = build_tool_command(&ytdlp);

    // Point yt-dlp at the bundled ffmpeg explicitly instead of relying on the
    // PATH tweak above: merges fail silently on Windows when ffprobe/ffmpeg
    // cannot be resolved.
    if let Some(dir) = which_sidecar("ffmpeg").and_then(|p| p.parent().map(Path::to_path_buf)) {
        cmd.arg("--ffmpeg-location");
        cmd.arg(dir);
    }

    Ok(cmd)
}

// ---------------------------------------------------------------------------
// YouTube types
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct YoutubeVideo {
    id: String,
    title: String,
    channel: String,
    duration: String,
    url: String,
    description: String,
    view_count: String,
}

#[derive(Debug, Deserialize)]
struct YtDump {
    id: String,
    title: Option<String>,
    uploader: Option<String>,
    channel: Option<String>,
    duration: Option<f64>,
    webpage_url: Option<String>,
    url: Option<String>,
    description: Option<String>,
    view_count: Option<u64>,
}

fn format_duration(secs: f64) -> String {
    let s = secs as u64;
    format!("{}:{:02}", s / 60, s % 60)
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

// NOTE: every command that runs a subprocess is marked `async`. Tauri executes
// synchronous commands on the main thread, and a yt-dlp call can take seconds -
// that froze the event loop and Windows reported the window as "Not responding".

#[tauri::command(async)]
fn search_youtube(query: String) -> Result<Vec<YoutubeVideo>, String> {
    if query.trim().is_empty() {
        return Err("Query is empty".into());
    }

    let mut cmd = ytdlp_command()?;
    cmd.args([
        "--flat-playlist",
        "--dump-json",
        "--no-warnings",
        "--socket-timeout",
        "10",
        &format!("ytsearch10:{query}"),
    ]);

    let output = cmd.output().map_err(|e| e.to_string())?;
    if !output.status.success() && output.stdout.is_empty() {
        let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if err.is_empty() {
            "yt-dlp failed".into()
        } else {
            err
        });
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut results = Vec::new();
    for line in stdout.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(dump) = serde_json::from_str::<YtDump>(line) else {
            continue;
        };

        let title = dump.title.unwrap_or_else(|| dump.id.clone());
        let channel = dump
            .channel
            .or(dump.uploader)
            .unwrap_or_else(|| "YouTube".to_string());
        let duration = dump
            .duration
            .map(format_duration)
            .unwrap_or_else(|| "-".to_string());
        let url = dump
            .webpage_url
            .or(dump.url)
            .unwrap_or_else(|| format!("https://www.youtube.com/watch?v={}", dump.id));
        let description = dump.description.unwrap_or_default();
        let view_count = dump
            .view_count
            .map(|v| {
                if v >= 1_000_000 {
                    format!("{:.1}M views", v as f64 / 1_000_000.0)
                } else if v >= 1000 {
                    format!("{:.1}K views", v as f64 / 1000.0)
                } else {
                    format!("{v} views")
                }
            })
            .unwrap_or_default();
        results.push(YoutubeVideo {
            id: dump.id,
            title,
            channel,
            duration,
            url,
            description,
            view_count,
        });
    }

    if results.is_empty() {
        return Err("No YouTube results".into());
    }
    Ok(results)
}

/// Best-effort *low latency* stream for inline playback: a muxed progressive
/// MP4 (360p) or an HLS manifest for live streams. High quality is served by
/// `fetch_hq_stream` instead, which lets ffmpeg merge a local file.
#[tauri::command(async)]
fn get_stream_url(video_id: String) -> Result<String, String> {
    let url = format!("https://www.youtube.com/watch?v={video_id}");

    // Progressive muxed formats (360p video + audio) play directly in the
    // webview without merging. One probe per player client: `18/22` means
    // "format 18, else 22". The old matrix of 4 formats x 3 clients could run
    // 12 yt-dlp processes back to back, which made playback take 30s to start.
    for client in ["android", "ios", "web"] {
        let mut cmd = ytdlp_command()?;
        cmd.args([
            "-g",
            "-f",
            "18/22",
            "--socket-timeout",
            "8",
            "--no-warnings",
            "--no-playlist",
            "--extractor-args",
            &format!("youtube:player_client={client}"),
            &url,
        ]);
        let Ok(output) = cmd.output() else { continue };
        if !output.status.success() {
            continue;
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        let first = stdout.lines().next().unwrap_or("").trim().to_string();
        if first.starts_with("http") {
            return Ok(first);
        }
    }

    // Live streams surface as an HLS manifest, which the webview plays natively.
    let mut cmd = ytdlp_command()?;
    cmd.args([
        "-g",
        "--socket-timeout",
        "8",
        "--no-warnings",
        "--no-playlist",
        &url,
    ]);
    let output = cmd.output().map_err(|e| e.to_string())?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if err.is_empty() {
            "yt-dlp -g failed".into()
        } else {
            err
        });
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let first = stdout.lines().next().unwrap_or("").trim().to_string();
    if first.is_empty() {
        return Err("No stream URL returned".into());
    }
    if first.contains("hls_playlist") || first.contains("manifest.googlevideo") {
        return Ok(first);
    }
    // Separate DASH streams cannot be muxed by the webview; the caller should
    // offer the 1080p path instead.
    if first.contains("videoplayback") {
        return Err("Separate DASH streams - use 1080p playback".into());
    }
    Ok(first)
}

/// Download the best video+audio (up to 1080p), mux it to a local MP4 with the
/// bundled ffmpeg, and return the path so the webview can play it inline.
///
/// This replaces the old external-player fallback: it stays in-window and needs
/// no third-party media player on the user's machine.
///
/// The heavy lifting runs on a blocking-pool thread (never on the async
/// runtime or the main thread), emits `hq-progress` events so the UI can show
/// the download/merge percentage, and stages the file under a temp name: an
/// interrupted run can never leave a half-merged MP4 that fails to play next
/// time.
#[tauri::command]
async fn fetch_hq_stream(app: tauri::AppHandle, video_id: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || fetch_hq_stream_blocking(&app, video_id))
        .await
        .map_err(|e| e.to_string())?
}

fn fetch_hq_stream_blocking(app: &tauri::AppHandle, video_id: String) -> Result<String, String> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("streams");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let target = dir.join(format!("{video_id}.mp4"));
    if target.is_file() {
        match target.metadata() {
            Ok(meta) if meta.len() > 64 * 1024 => {
                return Ok(target.to_string_lossy().into_owned());
            }
            // Empty or truncated leftover from an interrupted merge.
            _ => {
                let _ = std::fs::remove_file(&target);
            }
        }
    }

    let staging = dir.join(format!("{video_id}.staging.mp4"));
    let _ = std::fs::remove_file(&staging);
    let _ = std::fs::remove_file(dir.join(format!("{video_id}.staging.mp4.part")));

    let url = format!("https://www.youtube.com/watch?v={video_id}");
    let mut cmd = ytdlp_command()?;
    cmd.args([
        "--no-warnings",
        "--no-playlist",
        "--newline",
        "--progress",
        "--socket-timeout",
        "15",
        "-f",
        "bv*[height<=1080]+ba/b[height<=1080]/b",
        "--merge-output-format",
        "mp4",
        "-o",
        &staging.to_string_lossy(),
        &url,
    ]);
    // Progress, warnings and errors all arrive on stderr - reading a single
    // pipe keeps us free of the two-pipe deadlock, and stdout has nothing we
    // need for this invocation.
    cmd.stdout(Stdio::null());
    cmd.stderr(Stdio::piped());

    let emit = |percent: f64, log: &str| {
        let _ = app.emit(
            "hq-progress",
            serde_json::json!({ "percent": percent, "log": log }),
        );
    };
    emit(0.0, "Starting 1080p download (bundled yt-dlp)...");

    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let stderr = child.stderr.take().ok_or("no stderr")?;
    let reader = BufReader::new(stderr);

    let mut recent: Vec<String> = Vec::new();
    let mut last_percent = 0.0_f64;
    for line in reader.lines().map_while(Result::ok) {
        let trimmed = line.trim().to_string();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.contains("[download]") && trimmed.contains('%') {
            if let Some(pct) = parse_progress(&trimmed) {
                last_percent = pct;
                emit(pct, &trimmed);
                continue;
            }
        }
        if trimmed.contains("Merging formats") {
            last_percent = 95.0;
            emit(95.0, &trimmed);
        } else if trimmed.contains("Destination:")
            || trimmed.contains("[ffmpeg]")
            || trimmed.contains("[Merger]")
        {
            if last_percent < 90.0 {
                last_percent = 90.0;
                emit(90.0, &trimmed);
            }
        }
        if recent.len() >= 20 {
            recent.remove(0);
        }
        recent.push(trimmed);
    }

    let status = child.wait().map_err(|e| e.to_string())?;
    if !status.success() || !staging.is_file() {
        let _ = std::fs::remove_file(&staging);
        let tail = recent.join("\n");
        return Err(if tail.is_empty() {
            "yt-dlp could not fetch this video (see the app log)".into()
        } else {
            format!("1080p download failed:\n{tail}")
        });
    }

    if target.exists() {
        let _ = std::fs::remove_file(&target);
    }
    std::fs::rename(&staging, &target).map_err(|e| e.to_string())?;

    emit(100.0, "Merge complete");
    Ok(target.to_string_lossy().into_owned())
}

fn download_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().download_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn run_ytdlp_with_progress_sync(
    app: &tauri::AppHandle,
    args: &[String],
    kind: &str,
) -> Result<(), String> {
    let mut cmd = ytdlp_command()?;
    cmd.args(args);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let _ = app.emit(
        "download-progress",
        serde_json::json!({ "percent": 0.0, "kind": kind, "log": "Starting download..." }),
    );

    let mut child = cmd.spawn().map_err(|e| e.to_string())?;

    // Drain stderr in the background so a full pipe cannot deadlock the child.
    let stderr = child.stderr.take();
    std::thread::spawn(move || {
        if let Some(stderr) = stderr {
            let reader = BufReader::new(stderr);
            for _ in reader.lines() {}
        }
    });

    let stdout = child.stdout.take().ok_or("no stdout")?;
    let reader = BufReader::new(stdout);
    for line in reader.lines().map_while(Result::ok) {
        let trimmed = line.trim().to_string();
        if trimmed.is_empty() {
            continue;
        }
        let _ = app.emit("download-log", &trimmed);

        if trimmed.contains("[download]") && trimmed.contains('%') {
            if let Some(pct) = parse_progress(&trimmed) {
                let _ = app.emit(
                    "download-progress",
                    serde_json::json!({ "percent": pct, "kind": kind, "log": trimmed }),
                );
            }
        } else if trimmed.contains("[ExtractAudio]")
            || trimmed.contains("Merging formats")
            || trimmed.contains("Destination:")
        {
            let pct = if trimmed.contains("Merging") { 95.0 } else { 90.0 };
            let _ = app.emit(
                "download-progress",
                serde_json::json!({ "percent": pct, "kind": kind, "log": trimmed }),
            );
        } else if trimmed.contains("has already been downloaded") {
            let _ = app.emit(
                "download-progress",
                serde_json::json!({ "percent": 100.0, "kind": kind, "log": trimmed }),
            );
        }
    }

    let status = child.wait().map_err(|e| e.to_string())?;
    if !status.success() {
        return Err("yt-dlp download failed - check the output folder and that ffmpeg is bundled".into());
    }

    let _ = app.emit(
        "download-progress",
        serde_json::json!({ "percent": 100.0, "kind": kind, "log": "Done" }),
    );
    Ok(())
}

fn parse_progress(line: &str) -> Option<f64> {
    // example: "[download]  45.2% of 10.00MiB at 1.00MiB/s ETA 00:05"
    for token in line.split_whitespace() {
        if let Some(num) = token.strip_suffix('%') {
            if let Ok(v) = num.parse::<f64>() {
                return Some(v);
            }
        }
    }
    None
}

#[tauri::command]
async fn download_mp4(app: tauri::AppHandle, video_id: String) -> Result<String, String> {
    let dl_dir = download_dir(&app)?;
    let out = format!("{}/%(title)s [%(id)s].%(ext)s", dl_dir.to_string_lossy());
    let url = format!("https://www.youtube.com/watch?v={video_id}");
    let app_clone = app.clone();

    let args = vec![
        "--no-warnings".to_string(),
        "--no-playlist".to_string(),
        "--progress".to_string(),
        "--newline".to_string(),
        "-f".to_string(),
        "bv*[height<=1080]+ba/best[height<=1080]/best".to_string(),
        "--merge-output-format".to_string(),
        "mp4".to_string(),
        "-o".to_string(),
        out,
        url,
    ];

    // Run the blocking child process off the async runtime so the UI keeps painting.
    tauri::async_runtime::spawn_blocking(move || {
        run_ytdlp_with_progress_sync(&app_clone, &args, "mp4")
    })
    .await
    .map_err(|e| e.to_string())??;

    Ok(format!("MP4 downloaded to {}", dl_dir.to_string_lossy()))
}

#[tauri::command]
async fn download_mp3(app: tauri::AppHandle, video_id: String) -> Result<String, String> {
    let dl_dir = download_dir(&app)?;
    let out = format!("{}/%(title)s [%(id)s].%(ext)s", dl_dir.to_string_lossy());
    let url = format!("https://www.youtube.com/watch?v={video_id}");
    let app_clone = app.clone();

    let args = vec![
        "--no-warnings".to_string(),
        "--no-playlist".to_string(),
        "--progress".to_string(),
        "--newline".to_string(),
        "-x".to_string(),
        "--audio-format".to_string(),
        "mp3".to_string(),
        "--audio-quality".to_string(),
        "0".to_string(),
        "-o".to_string(),
        out,
        url,
    ];

    tauri::async_runtime::spawn_blocking(move || {
        run_ytdlp_with_progress_sync(&app_clone, &args, "mp3")
    })
    .await
    .map_err(|e| e.to_string())??;

    Ok(format!("MP3 downloaded to {}", dl_dir.to_string_lossy()))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            search_youtube,
            get_stream_url,
            fetch_hq_stream,
            download_mp4,
            download_mp3
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
