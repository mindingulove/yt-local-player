// Custom player controls, replacing Safari's native ones so the seek bar can
// show SponsorBlock segments and storyboard thumbnails on hover.
(() => {
  const ICONS = {
    play: "M8 5v14l11-7z",
    pause: "M6 5h4v14H6zm8 0h4v14h-4z",
    cc: "M19 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm-8 7H9.5v-.5h-2v3h2V13H11v1a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1zm7 0h-1.5v-.5h-2v3h2V13H18v1a1 1 0 0 1-1 1h-3a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1z",
    pip: "M19 7h-8v6h8V7zm2-4H3a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h18a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm0 16H3V5h18v14z",
    full: "M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z",
    exitFull: "M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z",
  };
  const SPEEDS = [1, 1.25, 1.5, 1.75, 2, 0.5, 0.75];

  const fmt = (s) => {
    s = Math.max(0, Math.floor(s || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = String(s % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
  };

  const el = (tag, cls, ...kids) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    e.append(...kids);
    return e;
  };

  function icon(name) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", ICONS[name]);
    svg.append(path);
    return svg;
  }

  const fullscreenElement = () => document.fullscreenElement || document.webkitFullscreenElement;

  // opts: { onCaptions(), captionsOn() }
  function createControls(video, root, opts = {}) {
    video.controls = false;
    let storyboard = null;
    let markers = [];
    let dragging = false;
    let raf = 0;
    let idleTimer = 0;

    // ---- DOM ----
    const buffered = el("div", "ylp-buffered");
    const played = el("div", "ylp-played");
    const markerLayer = el("div", "ylp-markers");
    const knob = el("div", "ylp-knob");
    const track = el("div", "ylp-track", buffered, markerLayer, played, knob);
    const previewImg = el("div", "ylp-preview-img");
    const previewLabel = el("div", "ylp-preview-label");
    const previewTime = el("div", "ylp-preview-time");
    const preview = el("div", "ylp-preview", previewImg, previewLabel, previewTime);
    const seek = el("div", "ylp-seek", track, preview);

    const button = (iconName, title, fn) => {
      const b = el("button", "ylp-cbtn");
      b.title = title;
      if (iconName) b.append(icon(iconName));
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        fn();
      });
      return b;
    };
    const setIcon = (b, name) => b.replaceChildren(icon(name));

    const playBtn = button("play", "Play (k)", () => togglePlay());
    const time = el("span", "ylp-time");
    const speedBtn = button(null, "Playback speed", cycleSpeed);
    speedBtn.classList.add("ylp-speed");
    speedBtn.textContent = "1×";
    const ccBtn = button("cc", "Captions (c)", () => opts.onCaptions?.());
    const pipBtn = button("pip", "Picture in picture", togglePip);
    pipBtn.hidden = !(document.pictureInPictureEnabled || video.webkitSetPresentationMode);
    const fullBtn = button("full", "Fullscreen (f)", toggleFullscreen);
    const row = el("div", "ylp-row", playBtn, time, el("div", "ylp-spacer"), speedBtn, ccBtn, pipBtn, fullBtn);
    const bar = el("div", "ylp-controls", seek, row);
    const spinner = el("div", "ylp-spinner");
    root.append(spinner, bar);

    // ---- state → UI ----
    const duration = () => (isFinite(video.duration) ? video.duration : 0);

    function update() {
      const d = duration();
      const t = video.currentTime;
      if (!dragging) {
        const pct = d ? (t / d) * 100 : 0;
        played.style.width = `${pct}%`;
        knob.style.left = `${pct}%`;
      }
      let end = 0;
      for (let i = 0; i < video.buffered.length; i++) {
        if (video.buffered.start(i) <= t + 0.5) end = Math.max(end, video.buffered.end(i));
      }
      buffered.style.width = d ? `${(end / d) * 100}%` : "0";
      time.textContent = `${fmt(t)} / ${fmt(d)}`;
    }

    function loop() {
      update();
      raf = video.paused ? 0 : requestAnimationFrame(loop);
    }

    function syncPlayState() {
      setIcon(playBtn, video.paused ? "play" : "pause");
      playBtn.title = video.paused ? "Play (k)" : "Pause (k)";
      if (!video.paused && !raf) raf = requestAnimationFrame(loop);
      update();
      poke();
    }

    function renderMarkers() {
      const d = duration();
      markerLayer.replaceChildren(
        ...(d
          ? markers.map((m) => {
              const div = el("div", m.point ? "ylp-marker ylp-point" : "ylp-marker");
              div.style.left = `${(m.start / d) * 100}%`;
              if (!m.point) div.style.width = `${(Math.max(0, m.end - m.start) / d) * 100}%`;
              div.style.background = m.color;
              return div;
            })
          : [])
      );
    }

    // ---- seek bar: drag + hover preview ----
    const timeAt = (clientX) => {
      const r = track.getBoundingClientRect();
      const frac = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
      return { t: frac * duration(), frac, r };
    };

    function showPreview(clientX) {
      const { t, frac, r } = timeAt(clientX);
      previewTime.textContent = fmt(t);
      const m = markers.find((x) => !x.point && t >= x.start && t < x.end);
      previewLabel.textContent = m ? m.title : "";
      const frame = storyboardFrame(t);
      if (frame) {
        previewImg.hidden = false;
        previewImg.style.width = `${frame.w}px`;
        previewImg.style.height = `${frame.h}px`;
        previewImg.style.backgroundImage = `url("${frame.url}")`;
        previewImg.style.backgroundPosition = `-${frame.x}px -${frame.y}px`;
      } else {
        previewImg.hidden = true;
      }
      const half = (frame ? frame.w : 60) / 2 + 2;
      const x = Math.min(r.width - half, Math.max(half, frac * r.width));
      preview.style.left = `${x}px`;
    }

    function dragTo(clientX, final) {
      const { t, frac } = timeAt(clientX);
      played.style.width = `${frac * 100}%`;
      knob.style.left = `${frac * 100}%`;
      time.textContent = `${fmt(t)} / ${fmt(duration())}`;
      if (final || !video.fastSeek) video.currentTime = t;
      else video.fastSeek(t);
    }

    seek.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || !duration()) return;
      e.preventDefault();
      e.stopPropagation();
      dragging = true;
      seek.classList.add("ylp-drag");
      try {
        seek.setPointerCapture(e.pointerId);
      } catch {}
      dragTo(e.clientX, false);
      showPreview(e.clientX);
    });
    seek.addEventListener("pointermove", (e) => {
      if (!duration()) return;
      showPreview(e.clientX);
      if (dragging) dragTo(e.clientX, false);
    });
    const endDrag = (e) => {
      if (!dragging) return;
      dragging = false;
      seek.classList.remove("ylp-drag");
      dragTo(e.clientX, true);
    };
    seek.addEventListener("pointerup", endDrag);
    seek.addEventListener("pointercancel", endDrag);
    seek.addEventListener("click", (e) => e.stopPropagation());

    // ---- storyboard ----
    function storyboardFrame(t) {
      const sb = storyboard;
      if (!sb || !sb.count) return null;
      const d = duration() || sb.durationSec || 1;
      let i = sb.intervalMs ? Math.floor((t * 1000) / sb.intervalMs) : Math.floor((t / d) * sb.count);
      i = Math.min(sb.count - 1, Math.max(0, i));
      const perSheet = sb.cols * sb.rows;
      const pos = i % perSheet;
      return {
        url: sb.url(Math.floor(i / perSheet)),
        x: (pos % sb.cols) * sb.width,
        y: Math.floor(pos / sb.cols) * sb.height,
        w: sb.width,
        h: sb.height,
      };
    }

    // ---- actions ----
    function togglePlay() {
      if (video.paused) video.play().catch(() => {});
      else video.pause();
    }

    function cycleSpeed() {
      const next = SPEEDS[(SPEEDS.indexOf(video.playbackRate) + 1) % SPEEDS.length] || 1;
      video.playbackRate = next;
      speedBtn.textContent = `${next}×`;
    }

    function togglePip() {
      if (document.pictureInPictureElement) document.exitPictureInPicture();
      else if (video.requestPictureInPicture) video.requestPictureInPicture().catch(() => {});
      else if (video.webkitSetPresentationMode) {
        video.webkitSetPresentationMode(video.webkitPresentationMode === "picture-in-picture" ? "inline" : "picture-in-picture");
      }
    }

    function toggleFullscreen() {
      if (fullscreenElement()) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      else (root.requestFullscreen || root.webkitRequestFullscreen).call(root);
    }

    const onFullscreen = () => setIcon(fullBtn, fullscreenElement() === root ? "exitFull" : "full");
    document.addEventListener("fullscreenchange", onFullscreen);
    document.addEventListener("webkitfullscreenchange", onFullscreen);

    // ---- auto-hide while playing ----
    function poke() {
      root.classList.remove("ylp-idle");
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (!video.paused && !dragging && !bar.matches(":hover")) root.classList.add("ylp-idle");
      }, 2500);
    }
    root.addEventListener("mousemove", poke);
    root.addEventListener("mouseleave", () => !video.paused && root.classList.add("ylp-idle"));

    // Click the picture to play/pause, double-click for fullscreen.
    root.addEventListener("click", (e) => {
      if (e.target === video || e.target === root) togglePlay();
    });
    root.addEventListener("dblclick", (e) => {
      if (e.target === video || e.target === root) toggleFullscreen();
    });

    // ---- media events ----
    video.addEventListener("play", syncPlayState);
    video.addEventListener("pause", syncPlayState);
    video.addEventListener("timeupdate", () => !raf && update());
    video.addEventListener("progress", update);
    video.addEventListener("durationchange", () => (update(), renderMarkers()));
    video.addEventListener("ratechange", () => (speedBtn.textContent = `${video.playbackRate}×`));
    video.addEventListener("waiting", () => root.classList.add("ylp-buffering"));
    for (const ev of ["playing", "canplay", "seeked", "pause"]) video.addEventListener(ev, () => root.classList.remove("ylp-buffering"));
    syncPlayState();

    return {
      togglePlay,
      toggleFullscreen,
      setCaptionsOn(on) {
        ccBtn.classList.toggle("ylp-on", !!on);
      },
      setStoryboard(sb) {
        storyboard = sb;
        // Warm the cache so the first hover isn't blank.
        if (sb) {
          const sheets = Math.ceil(sb.count / (sb.cols * sb.rows));
          for (let i = 0; i < sheets; i++) new Image().src = sb.url(i);
        }
      },
      // [{start, end, color, title}] or {start, point: true, color, title}
      setMarkers(list) {
        markers = list || [];
        renderMarkers();
      },
      destroy() {
        cancelAnimationFrame(raf);
        clearTimeout(idleTimer);
        document.removeEventListener("fullscreenchange", onFullscreen);
        document.removeEventListener("webkitfullscreenchange", onFullscreen);
      },
    };
  }

  globalThis.YLP = Object.assign(globalThis.YLP || {}, { createControls });
})();
