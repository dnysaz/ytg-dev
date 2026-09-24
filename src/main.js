const { invoke } = window.__TAURI__.core;

let searchInput, searchBtn, ytList, leftTitle, playerPlaceholder, nativePlayer, playerError, playerInfo, playerTitle, playerMeta, descContent, statusText, fallbackBar, embedWarn, hqBtn, browserBtn, dlMp4Btn, dlMp3Btn, dlStatus, downloadBar, dlProgressContainer, dlProgressBar, dlProgressText, dlProgressLabel, dlProgressLog;

let videos = [];
let selectedIdx = 0;
let isDownloading = false;
let isFetchingHq = false;

async function searchYoutube() {
  const query = searchInput.value.trim();
  if (!query) {
    statusText.textContent = "Please enter a query first!";
    return;
  }
  ytList.innerHTML = '<div class="placeholder">⏳ Searching YouTube "' + escapeHtml(query) + '" via yt-dlp ...</div>';
  leftTitle.textContent = '▶ YouTube (searching...)';
  statusText.textContent = 'Searching YouTube "' + query + '" via yt-dlp (bukan embed)...';
  searchBtn.disabled = true;
  try {
    const results = await invoke("search_youtube", { query });
    videos = results;
    selectedIdx = 0;
    renderList();
    if (videos.length > 0) {
      selectVideo(0);
      statusText.textContent = `Found ${videos.length} videos for "${query}" (yt-dlp search) - Enter to play (direct stream)`;
    }
  } catch (e) {
    ytList.innerHTML = '<div class="placeholder" style="color:#ff4444">Error: ' + escapeHtml(String(e)) + '</div>';
    statusText.textContent = "Error: " + e;
  } finally {
    searchBtn.disabled = false;
  }
}

function renderList() {
  leftTitle.textContent = `▶ YouTube (${videos.length} videos)`;
  if (videos.length === 0) {
    ytList.innerHTML = '<div class="placeholder">No results</div>';
    return;
  }
  ytList.innerHTML = "";
  videos.forEach((v, i) => {
    const div = document.createElement("div");
    div.className = "list-item" + (i === selectedIdx ? " active" : "");
    div.innerHTML = `<div class="item-title">${escapeHtml(v.title)}</div><div class="item-meta">${escapeHtml(v.channel)} • ${v.duration} • ${v.view_count}</div>`;
    div.onclick = () => selectVideo(i);
    div.ondblclick = () => playVideo(i);
    ytList.appendChild(div);
  });
}

function selectVideo(idx) {
  selectedIdx = idx;
  renderList();
  const v = videos[idx];
  if (!v) return;
  playerTitle.textContent = v.title;
  playerMeta.textContent = `${v.channel} • ${v.duration} • ${v.view_count}`;
  descContent.textContent = v.description || "No description\n\nURL: " + v.url;
  fallbackBar.style.display = "flex";
  downloadBar.style.display = "flex";
  // reset download UI when switching video - don't stay stuck disabled
  if (!isDownloading) {
    dlMp4Btn.disabled = false;
    dlMp3Btn.disabled = false;
    dlStatus.textContent = "";
    dlStatus.style.color = "#888";
    dlProgressContainer.style.display = "none";
    dlProgressBar.style.width = "0%";
    dlProgressText.textContent = "0%";
  } else {
    dlStatus.textContent = "⏳ Download in progress... (switching video won't cancel)";
    dlStatus.style.color = "#ffcc00";
  }
  embedWarn.textContent = "Direct stream via bundled yt-dlp (no embed) • 'Play 1080p' merges locally with bundled ffmpeg";
  embedWarn.style.color = "#888";
}

function hideAllPlayers() {
  playerPlaceholder.style.display = "none";
  nativePlayer.style.display = "none";
  playerError.style.display = "none";
  try { nativePlayer.pause(); nativePlayer.removeAttribute('src'); nativePlayer.load(); } catch {}
}

function showError(msg) {
  playerError.innerHTML = `<div style="font-size:13px; color:#ff6666">${escapeHtml(msg)}</div><div style="font-size:11px; color:#888; margin-top:4px">Try "Play 1080p" (merges locally with bundled ffmpeg)</div>`;
  playerError.style.display = "flex";
}

async function playVideo(idx) {
  const v = videos[idx ?? selectedIdx];
  if (!v) {
    statusText.textContent = "Please select a video first";
    return;
  }
  hideAllPlayers();
  playerPlaceholder.style.display = "none";
  playerInfo.style.display = "block";
  fallbackBar.style.display = "flex";
  playerTitle.textContent = v.title;
  playerMeta.textContent = `${v.channel} • ${v.duration} • ${v.view_count}`;
  descContent.textContent = v.description || "No description";
  statusText.textContent = `Loading direct stream for: ${v.title} ...`;
  embedWarn.textContent = "Fetching direct stream via yt-dlp (android 360p progressive + HLS live)...";
  embedWarn.style.color = "#ffcc00";

  // Direct stream via the bundled yt-dlp, always inside the window. Nothing external is auto-launched.
  try {
    const streamUrl = await invoke("get_stream_url", { videoId: v.id });
    console.log("get_stream_url ok:", streamUrl.slice(0,120));
    if (!streamUrl || !streamUrl.startsWith("http")) throw new Error("invalid url");
    nativePlayer.style.display = "block";
    playerError.style.display = "none";
    nativePlayer.src = streamUrl;
    nativePlayer.controls = true;
    // For HLS live, WKWebView plays natively. For progressive mp4, also native.
    nativePlayer.onerror = () => {
      console.log("nativePlayer error");
      statusText.textContent = "Native player error - try the 1080p button if needed";
      embedWarn.textContent = "Native failed (codec/CORS) - click 'Play 1080p' to merge locally, or try another video";
      embedWarn.style.color = "#ff6666";
      showError("Native player cannot play this stream - use the 1080p button");
    };
    nativePlayer.oncanplay = () => {
      playerError.style.display = "none";
    };
    try {
      await nativePlayer.play();
      statusText.textContent = `Now Playing (inside window): ${v.title}`;
      embedWarn.textContent = streamUrl.includes("hls_playlist") || streamUrl.includes("manifest") ? "Playing HLS live inside window" : "Playing MP4 inside window (360p direct) • All videos stay in window";
      embedWarn.style.color = "#4caf50";
      return;
    } catch (e) {
      console.log("native play() autoplay blocked", e);
      statusText.textContent = `Stream ready (inside window): ${v.title} - click ▶ on video to play`;
      embedWarn.textContent = "Autoplay blocked - click play on video • Stays inside window";
      embedWarn.style.color = "#ffcc00";
      return;
    }
  } catch (e) {
    console.log("get_stream_url failed:", e);
    statusText.textContent = "Direct stream failed: " + String(e).slice(0,80);
    embedWarn.textContent = "Stream not available inside window - try the 1080p button or another video";
    embedWarn.style.color = "#ff6666";
    showError("Cannot get direct stream: " + String(e).slice(0,100) + " - try the 1080p button");
    return;
  }
}

async function playHqInline() {
  const v = videos[selectedIdx];
  if (!v) {
    statusText.textContent = "Please select a video first";
    return;
  }
  if (isFetchingHq) return;
  isFetchingHq = true;

  hideAllPlayers();
  playerPlaceholder.style.display = "none";
  playerInfo.style.display = "block";
  fallbackBar.style.display = "flex";
  playerTitle.textContent = v.title;
  playerMeta.textContent = `${v.channel} • ${v.duration} • ${v.view_count}`;
  statusText.textContent = `Merging best quality (up to 1080p) with bundled ffmpeg: ${v.title} ...`;
  embedWarn.textContent = "Downloading + merging best video/audio locally (bundled yt-dlp + ffmpeg)...";
  embedWarn.style.color = "#ffcc00";
  playerError.style.display = "flex";
  playerError.innerHTML = '<div style="color:#ffcc00">Merging 1080p locally...</div><div style="color:#888; font-size:11px; margin-top:4px">Bundled yt-dlp + ffmpeg - no external player needed</div>';

  try {
    const path = await invoke("fetch_hq_stream", { videoId: v.id });
    // Local files need the asset protocol to be playable in the webview.
    const src = window.__TAURI__.core.convertFileSrc(path);
    nativePlayer.style.display = "block";
    playerError.style.display = "none";
    nativePlayer.src = src;
    nativePlayer.controls = true;
    try {
      await nativePlayer.play();
    } catch (e) {
      console.log("HQ autoplay blocked", e);
    }
    statusText.textContent = `Now Playing 1080p (local, inside window): ${v.title}`;
    embedWarn.textContent = "Playing merged 1080p inside window (local ffmpeg merge)";
    embedWarn.style.color = "#4caf50";
  } catch (e) {
    console.log("fetch_hq_stream failed:", e);
    statusText.textContent = "1080p merge failed: " + String(e).slice(0, 80);
    embedWarn.textContent = "Could not merge 1080p - try the normal play button, or Open in Browser";
    embedWarn.style.color = "#ff6666";
    showError("1080p failed: " + String(e).slice(0, 120));
  } finally {
    isFetchingHq = false;
  }
}

function showDlProgress(kind) {
  dlProgressContainer.style.display = "block";
  dlProgressBar.style.width = "0%";
  dlProgressBar.style.background = kind === "mp3" ? "#ffab00" : "#00c853";
  dlProgressText.textContent = "0%";
  dlProgressLabel.textContent = kind === "mp3" ? "Downloading MP3..." : "Downloading MP4...";
  dlProgressLog.textContent = "Starting...";
}

function hideDlProgress() {
  setTimeout(() => { dlProgressContainer.style.display = "none"; }, 2500);
}

async function downloadMP4() {
  const v = videos[selectedIdx];
  if (!v) { statusText.textContent = "Select a video to download"; return; }
  isDownloading = true;
  dlMp4Btn.disabled = true; dlMp3Btn.disabled = true;
  dlStatus.textContent = "⏳ Downloading MP4...";
  dlStatus.style.color = "#ffcc00";
  statusText.textContent = `Downloading MP4: ${v.title} ...`;
  showDlProgress("mp4");
  try {
    const res = await invoke("download_mp4", { videoId: v.id });
    dlStatus.textContent = "✓ MP4 done";
    dlStatus.style.color = "#4caf50";
    dlProgressText.textContent = "100%";
    dlProgressBar.style.width = "100%";
    dlProgressLog.textContent = "Saved to ~/Downloads";
    statusText.textContent = res + ` - ${v.title}`;
    hideDlProgress();
  } catch (e) {
    dlStatus.textContent = "✗ " + String(e).slice(0,60);
    dlStatus.style.color = "#ff6666";
    dlProgressLabel.textContent = "Failed";
    dlProgressLog.textContent = String(e).slice(0,80);
    statusText.textContent = "MP4 download failed: " + e;
    dlProgressBar.style.width = "0%";
  } finally { isDownloading = false; dlMp4Btn.disabled = false; dlMp3Btn.disabled = false; }
}

async function downloadMP3() {
  const v = videos[selectedIdx];
  if (!v) { statusText.textContent = "Select a video to download"; return; }
  isDownloading = true;
  dlMp4Btn.disabled = true; dlMp3Btn.disabled = true;
  dlStatus.textContent = "⏳ Downloading MP3...";
  dlStatus.style.color = "#ffcc00";
  statusText.textContent = `Downloading MP3 (audio): ${v.title} ...`;
  showDlProgress("mp3");
  try {
    const res = await invoke("download_mp3", { videoId: v.id });
    dlStatus.textContent = "✓ MP3 done";
    dlStatus.style.color = "#4caf50";
    dlProgressText.textContent = "100%";
    dlProgressBar.style.width = "100%";
    dlProgressLog.textContent = "Saved to ~/Downloads";
    statusText.textContent = res + ` - ${v.title}`;
    hideDlProgress();
  } catch (e) {
    dlStatus.textContent = "✗ " + String(e).slice(0,60);
    dlStatus.style.color = "#ff6666";
    dlProgressLabel.textContent = "Failed";
    dlProgressLog.textContent = String(e).slice(0,80);
    statusText.textContent = "MP3 download failed: " + e;
    dlProgressBar.style.width = "0%";
  } finally { isDownloading = false; dlMp4Btn.disabled = false; dlMp3Btn.disabled = false; }
}

async function openInBrowser() {
  const v = videos[selectedIdx];
  if (!v) return;
  try {
    if (window.__TAURI__ && window.__TAURI__.opener && window.__TAURI__.opener.openUrl) {
      await window.__TAURI__.opener.openUrl(v.url);
    } else {
      window.open(v.url, "_blank");
    }
    statusText.textContent = "Opened in browser: " + v.url;
  } catch (e) {
    window.open(v.url, "_blank");
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

window.addEventListener("DOMContentLoaded", () => {
  searchInput = document.getElementById("search-input");
  searchBtn = document.getElementById("search-btn");
  ytList = document.getElementById("yt-list");
  leftTitle = document.getElementById("left-title");
  playerPlaceholder = document.getElementById("player-placeholder");
  nativePlayer = document.getElementById("native-player");
  playerError = document.getElementById("player-error");
  playerInfo = document.getElementById("player-info");
  playerTitle = document.getElementById("player-title");
  playerMeta = document.getElementById("player-meta");
  descContent = document.getElementById("desc-content");
  statusText = document.getElementById("status-text");
  fallbackBar = document.getElementById("fallback-bar");
  embedWarn = document.getElementById("embed-warn");
  hqBtn = document.getElementById("hq-btn");
  browserBtn = document.getElementById("browser-btn");
  dlMp4Btn = document.getElementById("dl-mp4-btn");
  dlMp3Btn = document.getElementById("dl-mp3-btn");
  dlStatus = document.getElementById("dl-status");
  downloadBar = document.getElementById("download-bar");
  dlProgressContainer = document.getElementById("dl-progress-container");
  dlProgressBar = document.getElementById("dl-progress-bar");
  dlProgressText = document.getElementById("dl-progress-text");
  dlProgressLabel = document.getElementById("dl-progress-label");
  dlProgressLog = document.getElementById("dl-progress-log");

  searchBtn.onclick = searchYoutube;
  searchInput.addEventListener("keydown", (e) => { if (e.key === "Enter") searchYoutube(); });

  hqBtn.onclick = playHqInline;
  browserBtn.onclick = openInBrowser;
  dlMp4Btn.onclick = downloadMP4;
  dlMp3Btn.onclick = downloadMP3;

  // listen for download progress from Rust
  if (window.__TAURI__ && window.__TAURI__.event) {
    window.__TAURI__.event.listen("download-progress", (event) => {
      const p = event.payload;
      const pct = p.percent ?? 0;
      dlProgressBar.style.width = pct + "%";
      dlProgressText.textContent = Math.round(pct) + "%";
      if (p.kind === "mp3") dlProgressBar.style.background = "#ffab00";
      else dlProgressBar.style.background = "#00c853";
      if (p.log) dlProgressLog.textContent = p.log;
      if (pct >= 100) {
        dlStatus.textContent = "✓ Done";
        dlStatus.style.color = "#4caf50";
      } else if (pct > 0) {
        dlStatus.textContent = Math.round(pct) + "%";
        dlStatus.style.color = "#ffcc00";
      }
    });
    window.__TAURI__.event.listen("download-log", (event) => {
      // optional log debugging
    });
  }

  nativePlayer.addEventListener("error", () => {
    console.log("nativePlayer error event");
    // Never auto-launch an external player - keep playback in-window and surface the error
    const v = videos[selectedIdx];
    statusText.textContent = "Video error inside window - try the 1080p button if needed";
    showError("Video playback error inside window");
  });

  document.addEventListener("keydown", (e) => {
    if (e.target === searchInput) return;
    if (videos.length === 0) return;
    if (e.key === "ArrowUp" || e.key === "k") { e.preventDefault(); selectedIdx = selectedIdx === 0 ? videos.length - 1 : selectedIdx - 1; selectVideo(selectedIdx); document.querySelectorAll(".list-item")[selectedIdx]?.scrollIntoView({ block: "nearest" }); }
    else if (e.key === "ArrowDown" || e.key === "j") { e.preventDefault(); selectedIdx = (selectedIdx + 1) % videos.length; selectVideo(selectedIdx); document.querySelectorAll(".list-item")[selectedIdx]?.scrollIntoView({ block: "nearest" }); }
    else if (e.key === "Enter" || e.key === "y" || e.key === "Y") { e.preventDefault(); playVideo(selectedIdx); }
    else if (e.key === "m" || e.key === "M") { e.preventDefault(); playHqInline(); }
    else if (e.key === "/") { e.preventDefault(); searchInput.focus(); }
  });

  searchInput.value = "lofi hip hop";
});
