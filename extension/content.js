// Replaces the YouTube watch-page player with a plain <video>.
//
// Default ("browser") source: streams straight from YouTube's video servers
// using lib/innertube.js — HLS when available (Safari plays it natively),
// otherwise lib/dash-player.js. A Save button downloads and muxes an mp4.
// Optional "helper" source: plays a yt-dlp download from helper/server.py.
(() => {
  const HELPER = "http://127.0.0.1:8765";
  let settings = {
    enabled: true,
    source: "browser",
    quality: "auto",
    captions: "off",
    hideAds: true,
    hideShorts: true,
    sponsorBlock: true,
    sbCategories: ["sponsor", "selfpromo", "interaction"],
    sbMode: "auto", // "auto" skips; "ask" shows a Skip button
    sbExtras: true, // highlight button + whole-video labels
    saveEnabled: false, // Save (download) button is opt-in
    scrollHintDismissed: false,
  };
  let currentId = null;
  let overlay = null; // {root, video, status, toolbar}
  let dash = null;
  let saveAbort = null;
  let pollTimer = null;
  let suppressTimer = null;

  // Load-time marks (ms since page load), readable at <html data-ylp-timing>.
  const timing = {};
  function mark(name) {
    timing[name] = Math.round(performance.now());
    document.documentElement.dataset.ylpTiming = JSON.stringify(timing);
  }
  globalThis.YLP = Object.assign(globalThis.YLP || {}, { mark });

  const helper = (path) => browser.runtime.sendMessage({ type: "helper", path });

  // Tiny DOM builder (avoids innerHTML, which YouTube's Trusted Types policy blocks).
  function h(tag, props = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (k === "class") el.className = v;
      else el[k] = v;
    }
    el.append(...children.flat().filter((c) => c != null && c !== false));
    return el;
  }

  function videoIdFromUrl() {
    if (location.pathname !== "/watch") return null;
    return new URLSearchParams(location.search).get("v");
  }

  // Last position per video, so reopening a video resumes where you left off.
  const POS_KEY = "ylp-positions";
  function savedPosition(id) {
    try {
      return JSON.parse(sessionStorage.getItem(POS_KEY) || "{}")[id] || 0;
    } catch {
      return 0;
    }
  }
  function savePosition(id, t, duration) {
    try {
      const all = JSON.parse(sessionStorage.getItem(POS_KEY) || "{}");
      // Near the end counts as finished: start over next time.
      if (t < 5 || (duration && t > duration - 10)) delete all[id];
      else all[id] = Math.floor(t);
      const keys = Object.keys(all);
      if (keys.length > 200) delete all[keys[0]];
      sessionStorage.setItem(POS_KEY, JSON.stringify(all));
    } catch {}
  }

  // Where to start: this tab's own saved position wins (it's newer than the
  // t= YouTube puts on "continue watching" links), else the URL's t=.
  function startTimeFromUrl() {
    return savedPosition(currentId) || parseT(new URLSearchParams(location.search).get("t"));
  }

  function parseT(t) {
    if (!t) return 0;
    if (/^\d+$/.test(t)) return +t;
    const m = t.match(/(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/);
    return m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : 0;
  }

  // Timestamp links for the current video (description, comments, chapters)
  // would seek YouTube's hidden player; seek ours instead.
  function onLinkClick(e) {
    if (!overlay || overlay.mini || overlay.video.hidden) return;
    const a = e.target.closest?.("a[href]");
    if (!a || a.closest("#ylp-overlay")) return;
    const url = new URL(a.href, location.href);
    if (url.pathname !== "/watch" || url.searchParams.get("v") !== currentId || !url.searchParams.has("t")) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    overlay.video.currentTime = parseT(url.searchParams.get("t"));
    overlay.video.play().catch(() => {});
    overlay.root.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  const ytPlayer = () => document.querySelector("#movie_player");

  // Keep YouTube's own <video> (and any ad in it) paused and muted.
  function suppressYouTube() {
    const videos = document.querySelectorAll("#movie_player video, ytd-watch-flexy video, ytd-miniplayer video");
    for (const v of videos) {
      if (v.closest("#ylp-overlay")) continue; // never touch our own players
      v.muted = true;
      if (!v.paused) v.pause();
    }
  }

  function onAnyPlay(e) {
    const t = e.target;
    if (overlay && t instanceof HTMLVideoElement && !t.closest("#ylp-overlay") && !t.closest("ytd-video-preview")) {
      e.target.muted = true;
      e.target.pause();
    }
  }

  function teardown() {
    document.documentElement.classList.remove("ylp-mini-active");
    clearTimeout(pollTimer);
    clearInterval(suppressTimer);
    pollTimer = suppressTimer = null;
    dash?.destroy();
    dash = null;
    saveAbort?.abort();
    saveAbort = null;
    if (overlay) {
      overlay.controls.destroy();
      overlay.hls?.destroy();
      if (currentId && !overlay.video.hidden) savePosition(currentId, overlay.video.currentTime, overlay.video.duration);
      overlay.video.pause();
      overlay.video.removeAttribute("src");
      overlay.video.load();
      overlay.root.remove();
      overlay.toolbar.remove();
      overlay.submitPanel?.remove();
      overlay.scrollHint?.remove();
      overlay.trackEls?.forEach((el) => URL.revokeObjectURL(el.src));
    }
    ytPlayer()?.classList.remove("ylp-active");
    overlay = null;
    info = null;
    playToken++;
    currentId = null;
  }

  // ---- overlay UI -------------------------------------------------------

  function buildOverlay() {
    const video = h("video", { controls: true, playsInline: true, preload: "auto", hidden: true });
    video.addEventListener("loadedmetadata", () => mark("metadata"), { once: true });
    video.addEventListener("playing", () => mark("playing"), { once: true });
    video.addEventListener("timeupdate", checkSponsorSkip);
    let lastSave = 0;
    video.addEventListener("timeupdate", () => {
      if (Date.now() - lastSave < 3000 || !currentId) return;
      lastSave = Date.now();
      savePosition(currentId, video.currentTime, video.duration);
    });
    // If an error was shown but playback recovered, hide it.
    video.addEventListener("playing", () => {
      if (overlay?.video === video) showVideo();
    });
    // Restore the last volume the user chose (the controls save it).
    try {
      const saved = parseFloat(localStorage.getItem("ylp-volume"));
      if (saved >= 0 && saved <= 1) video.volume = saved;
    } catch {}
    const status = h("div", { class: "ylp-status" });
    const toolbar = h("div", { class: "ylp-toolbar", hidden: true });
    // Scrollable bar: vertical wheel scrolls it sideways; fade the clipped edges.
    const updateFades = () => {
      toolbar.classList.toggle("ylp-fade-start", toolbar.scrollLeft > 2);
      toolbar.classList.toggle("ylp-fade-end", toolbar.scrollLeft + toolbar.clientWidth < toolbar.scrollWidth - 2);
    };
    toolbar.addEventListener("scroll", updateFades);
    new ResizeObserver(updateFades).observe(toolbar);
    toolbar.addEventListener(
      "wheel",
      (e) => {
        if (toolbar.scrollWidth <= toolbar.clientWidth || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
        e.preventDefault();
        toolbar.scrollLeft += e.deltaY;
      },
      { passive: false }
    );
    const minibar = h(
      "div",
      { class: "ylp-minibar" },
      h("button", { title: "Expand (i)", onclick: () => expandMini() }, "⤢"),
      h("button", { title: "Close", onclick: () => closeMini() }, "✕")
    );
    const root = h("div", { id: "ylp-overlay" }, video, status, minibar);
    const controls = YLP.createControls(video, root, { onCaptions: () => toggleCaptions() });
    // Our overlay lives inside YouTube's #movie_player; stop pointer events
    // bubbling into it, or YouTube's handlers break dragging the seek bar.
    for (const type of ["mousedown", "mouseup", "mousemove", "click", "dblclick", "pointerdown", "pointerup", "pointermove", "touchstart", "touchmove", "touchend", "wheel", "contextmenu", "keydown"]) {
      root.addEventListener(type, (e) => e.stopPropagation());
    }
    return { root, video, status, toolbar, controls };
  }

  function button(label, onclick) {
    return h("button", { onclick }, label);
  }

  const btnYouTube = () => button("Use YouTube player", useYouTube);
  const btnSignIn = () => button("Sign in to YouTube", () => {
    location.href = `https://www.youtube.com/signin?next=${encodeURIComponent(location.href)}`;
  });
  const btnRetry = () =>
    button("Retry", () => {
      const id = currentId;
      teardown();
      setup(id);
    });
  const btnHelper = () =>
    button("Try local helper", () => {
      clearTimeout(pollTimer);
      dash?.destroy();
      dash = null;
      playViaHelper(currentId);
    });

  function setStatus(...children) {
    if (!overlay) return;
    overlay.video.hidden = true;
    overlay.status.hidden = false;
    overlay.status.replaceChildren(...children.flat().filter(Boolean));
  }

  function showError(title, detail, ...buttons) {
    setStatus(
      h("div", {}, title),
      detail ? h("pre", {}, detail) : null,
      h("div", { class: "ylp-buttons" }, ...buttons, btnYouTube())
    );
  }

  // The toolbar sits under the player (above the title) so Safari's native
  // control bar can never cover it; falls back to inside the overlay.
  // The toolbar sits in YouTube's channel/actions row (between Subscribe and
  // Like/Share), else under the player, else inside the overlay.
  function placeToolbar() {
    if (!overlay) return;
    const tb = overlay.toolbar;
    const row = document.querySelector("ytd-watch-metadata #top-row");
    const actions = row?.querySelector(":scope > #actions");
    if (row && actions) {
      if (tb.parentNode !== row || tb.nextElementSibling !== actions) row.insertBefore(tb, actions);
      // Line up with YouTube's buttons: same top offset and height as #actions.
      const a = getComputedStyle(actions);
      tb.style.marginTop = a.marginTop;
      tb.style.height = `${actions.offsetHeight}px`;
    } else {
      tb.style.marginTop = tb.style.height = "";
      const parent = document.querySelector("ytd-watch-flexy #below") || overlay.root;
      if (tb.parentNode !== parent) parent.prepend(tb);
    }
    const docked = tb.parentNode !== overlay.root;
    tb.classList.toggle("ylp-docked", docked);
    tb.classList.toggle("ylp-in-row", tb.parentNode === row);
    // Follow YouTube's theme: copy the title colour, and pick its light/dark chip tint.
    const title = document.querySelector("ytd-watch-metadata h1, #title h1");
    const color = docked && title ? getComputedStyle(title).color : "";
    const rgb = color.match(/\d+/g);
    const dark = !docked || (rgb ? 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2] > 140 : false);
    for (const el of [tb, overlay.submitPanel]) {
      if (!el) continue;
      el.style.color = color;
      el.classList.toggle("ylp-dark", dark);
    }
    maybeShowScrollHint();
  }

  // First time the bar overflows, nudge it and show a tip until "Got it".
  function maybeShowScrollHint() {
    const tb = overlay?.toolbar;
    if (!tb || tb.hidden || settings.scrollHintDismissed || tb.scrollWidth <= tb.clientWidth + 2) {
      if (overlay?.scrollHint && tb && tb.scrollWidth <= tb.clientWidth + 2) hideScrollHint();
      return;
    }
    if (!overlay.scrollHint) {
      const dismiss = () => {
        settings.scrollHintDismissed = true;
        browser.storage.local.set({ scrollHintDismissed: true });
        hideScrollHint();
      };
      overlay.scrollHint = h(
        "div",
        { class: "ylp-scroll-hint", role: "status" },
        h("span", {}, "Scroll sideways for more buttons ›"),
        h("button", { onclick: dismiss }, "Got it")
      );
      document.body.appendChild(overlay.scrollHint);
      // Nudge: slide the bar a little and back so it visibly moves.
      tb.scrollBy({ left: 56, behavior: "smooth" });
      setTimeout(() => tb.scrollBy({ left: -56, behavior: "smooth" }), 700);
    }
    // Keep it pinned under the bar (page coordinates).
    const r = tb.getBoundingClientRect();
    Object.assign(overlay.scrollHint.style, {
      top: `${r.bottom + window.scrollY + 8}px`,
      left: `${Math.max(8, r.left + window.scrollX)}px`,
    });
  }

  function hideScrollHint() {
    overlay?.scrollHint?.remove();
    if (overlay) overlay.scrollHint = null;
  }

  // YouTube-style pill button: icon + label, or a round icon-only button
  // (iconOnly: true) whose label becomes its tooltip.
  function pill(iconName, label, { iconOnly = false, ...props } = {}) {
    if (iconOnly) return h("button", { class: "ylp-pill ylp-icon-btn", title: label, "aria-label": label, ...props }, YLP.icon(iconName));
    return h("button", { class: "ylp-pill", ...props }, iconName ? YLP.icon(iconName) : null, h("span", { class: "ylp-pill-label" }, label));
  }
  const setPillLabel = (btn, text) => {
    const label = btn.querySelector(".ylp-pill-label");
    if (label) label.textContent = text;
    else btn.title = text;
  };

  // A pill that shows the current choice and opens a native menu (an invisible
  // <select> laid over it). options: [{value, label, short?}]
  function selectPill(iconName, title, options, current, onchange) {
    const text = h("span", { class: "ylp-pill-label" });
    const select = h(
      "select",
      { title },
      options.map((o) => h("option", { value: o.value, selected: String(o.value) === String(current) }, o.label))
    );
    const sync = () => {
      const o = options.find((x) => String(x.value) === select.value);
      text.textContent = o ? o.short || o.label : "";
    };
    select.addEventListener("change", () => (sync(), onchange(select.value)));
    sync();
    const wrap = h("label", { class: "ylp-pill ylp-select", title }, YLP.icon(iconName), text, YLP.icon("chevron"), select);
    return { wrap, select, sync };
  }

  function showVideo() {
    overlay.status.hidden = true;
    overlay.video.hidden = false;
  }

  function useYouTube() {
    const id = currentId;
    teardown();
    currentId = id; // remember so we don't take over this video again
    const v = ytPlayer()?.querySelector("video");
    if (v) v.muted = false;
  }

  // Seek to `at` once metadata is available, then play unless `paused`.
  function resumeAt(at, paused) {
    const video = overlay.video;
    const go = () => {
      if (at) video.currentTime = at;
      if (!paused) video.play().catch(() => {}); // autoplay may be refused; controls are visible
    };
    if (video.readyState >= 1) go();
    else video.addEventListener("loadedmetadata", go, { once: true });
  }

  // Used by the helper source: plain progressive file.
  function startPlayback(src) {
    overlay.video.src = src;
    showVideo();
    resumeAt(startTimeFromUrl(), false);
  }

  // ---- in-browser source ------------------------------------------------

  let info = null; // YLP.getPlayer() result for the current video
  let playToken = 0; // invalidates stale async work when the source changes

  function tryNextClient() {
    if (!overlay || !info?.client) return false;
    const failed = overlay.failedClients ||= [];
    if (failed.includes(info.client)) return false;
    failed.push(info.client);
    dash?.destroy();
    dash = null;
    overlay.hls?.destroy();
    overlay.hls = null;
    // Invalidate pending media errors before the next request starts.
    playToken++;
    overlay.triedHls = false;
    overlay.infoPromise = YLP.getPlayer(currentId, { skipClients: failed });
    playInBrowser(currentId);
    return true;
  }

  async function playInBrowser(id) {
    const token = playToken;
    setStatus(h("div", {}, "Loading…"));
    try {
      const result = await (overlay.infoPromise || YLP.getPlayer(id));
      if (token !== playToken || id !== currentId || !overlay) return;
      info = result;
      mark("apiDone");
    } catch (e) {
      if (token === playToken && id === currentId && overlay) showError("Couldn't reach YouTube's player API.", String(e.message || e), btnRetry(), btnHelper());
      return;
    }
    if (info.isLive || info.isUpcoming) return useYouTube();
    if (!info.ok) return showError(
      "YouTube won't stream this video here.",
      info.reason,
      ...(info.loginRequired ? [btnSignIn(), btnRetry()] : []),
      btnHelper()
    );
    if (!info.hls && !YLP.playableVideoFormats(info).length) {
      return showError("No playable formats for this video.", null, btnHelper());
    }
    buildToolbar();
    overlay.controls.setStoryboard(info.storyboard);
    await applyQuality(selectedQuality(), true);
    applyCaptions(preferredCaption());
  }

  // Heights offered in the quality menu ("auto" = Safari's adaptive HLS).
  function qualityChoices() {
    const heights = [...new Set(YLP.playableVideoFormats(info).map((f) => f.height))];
    return info.hls ? ["auto", ...heights] : heights;
  }

  // The stored preference mapped onto what this video actually offers.
  function selectedQuality() {
    const choices = qualityChoices();
    const q = settings.quality;
    if (q === "auto" && choices[0] === "auto") return "auto";
    const heights = choices.filter((c) => c !== "auto");
    const want = q === "auto" ? 1080 : +q;
    return heights.find((h) => h <= want) ?? heights[heights.length - 1] ?? (info.hls ? "auto" : undefined);
  }

  async function applyQuality(q, initial = false) {
    const token = ++playToken;
    const video = overlay.video;
    const at = initial ? startTimeFromUrl() : video.currentTime;
    const paused = initial ? false : video.paused;
    const audioTrack = YLP.selectedAudioTrack(info, overlay.audioTrackId);
    const selectHlsAudio = (info.audioTracks?.length || 0) > 1;
    dash?.destroy();
    dash = null;
    overlay.hls?.destroy();
    overlay.hls = null;
    if (q === "auto") {
      video.addEventListener(
        "error",
        () => {
          // HLS failed: fall back to the best fixed quality.
          if (token !== playToken || !overlay) return;
          const fixed = qualityChoices().find((c) => c !== "auto");
          if (fixed) applyQuality(fixed, initial);
          else if (!tryNextClient()) showError("Safari couldn't play this video.", overlay.video.error?.message, btnRetry(), btnHelper());
        },
        { once: true }
      );
      if (video.canPlayType("application/vnd.apple.mpegurl") && !selectHlsAudio) {
        video.src = info.hls; // Safari: native HLS
      } else if (globalThis.Hls?.isSupported()) {
        // hls.js handles Chrome/Firefox and language-filtered Safari streams.
        // Workers stay off because the page's CSP can block blob workers.
        const hls = new Hls({
          enableWorker: false,
          capLevelToPlayerSize: true,
          ...(selectHlsAudio ? { pLoader: YLP.audioPlaylistLoader(Hls, audioTrack) } : {}),
        });
        overlay.hls = hls;
        hls.on(Hls.Events.ERROR, (_e, data) => {
          if (data.fatal && token === playToken && overlay) video.dispatchEvent(new Event("error"));
        });
        hls.loadSource(info.hls);
        hls.attachMedia(video);
      } else {
        video.dispatchEvent(new Event("error")); // falls back to a fixed quality
      }
    } else {
      const vf = YLP.playableVideoFormats(info).find((f) => f.height === q);
      const af = YLP.playableAudioFormat(info, overlay.audioTrackId);
      const fail = (e) => {
        if (token !== playToken || !overlay) return;
        if (info.hls && !overlay.triedHls) {
          console.warn("[YT Local Player] fixed quality failed, falling back to Auto:", e);
          overlay.triedHls = true;
          return applyQuality("auto", initial);
        }
        if (!tryNextClient()) showError("Playback failed.", String(e.message || e), btnRetry(), btnHelper());
      };
      dash = new YLP.DashPlayer(video, vf, af, info.durationSec, fail);
      try {
        await dash.start();
      } catch (e) {
        return fail(e);
      }
    }
    if (token !== playToken || !overlay) return;
    showVideo();
    resumeAt(at, paused);
    restoreCaptionMode();
    renderSaveButton();
  }

  // ---- toolbar: quality, captions, save ------------------------------------

  function buildToolbar() {
    const tracks = info.audioTracks || [];
    if (!tracks.some((t) => t.id === overlay.audioTrackId)) overlay.audioTrackId = null;
    const defaultAudio = YLP.selectedAudioTrack(info);
    const audio = selectPill(
      "volHigh",
      "Audio language",
      [
        { value: "default", label: defaultAudio ? `Default (${defaultAudio.name})` : "Default", short: defaultAudio ? `${defaultAudio.lang} · Default` : "Default" },
        ...tracks.map((t) => ({ value: t.id, label: t.name, short: t.lang })),
      ],
      overlay.audioTrackId || "default",
      (id) => {
        overlay.audioTrackId = id === "default" ? null : id;
        applyQuality(selectedQuality());
      }
    );
    audio.select.disabled = !tracks.length;
    const quality = selectPill(
      "tune",
      "Quality",
      qualityChoices().map((c) => ({ value: c, label: c === "auto" ? "Auto" : `${c}p` })),
      selectedQuality(),
      (v) => {
        settings.quality = v === "auto" ? "auto" : +v;
        browser.storage.local.set({ quality: settings.quality });
        applyQuality(settings.quality);
      }
    );

    const pref = preferredCaption();
    const cc = selectPill(
      "cc",
      "Captions (c)",
      [
        { value: "off", label: "Off", short: "CC" },
        ...info.captions.map((t, i) => ({ value: i, label: t.name, short: t.lang.split("-")[0].toUpperCase() })),
      ],
      pref ? info.captions.indexOf(pref) : "off",
      (v) => {
        const t = info.captions[+v] || null;
        settings.captions = t ? t.lang : "off";
        browser.storage.local.set({ captions: settings.captions });
        applyCaptions(t);
      }
    );
    cc.wrap.hidden = !info.captions.length;
    overlay.ccSelect = cc.select;
    overlay.ccSync = cc.sync;

    overlay.saveLabel = h("span", { class: "ylp-save-progress" });
    overlay.saveBtn = pill("download", "Save as mp4", { iconOnly: true, onclick: save });
    const mini = pill("mini", "Mini player (i)", { iconOnly: true, onclick: () => enterMini() });
    const addSegment = pill("add", "Submit a SponsorBlock segment", { iconOnly: true, onclick: openSubmitPanel, hidden: !settings.sponsorBlock });
    overlay.sbSlot = h("span", { class: "ylp-sb" });
    overlay.toolbar.replaceChildren(overlay.sbSlot, quality.wrap, audio.wrap, cc.wrap, mini, addSegment, overlay.saveBtn, overlay.saveLabel);
    renderSponsorUi();
    overlay.toolbar.hidden = false;
    placeToolbar();
    renderSaveButton();
  }

  // ---- captions ----------------------------------------------------------

  function preferredCaption() {
    const pref = settings.captions;
    if (!pref || pref === "off") return null;
    const base = pref.split("-")[0];
    const c = info.captions;
    return (
      c.find((t) => t.lang === pref && !t.auto) ||
      c.find((t) => t.lang.split("-")[0] === base && !t.auto) ||
      c.find((t) => t.lang.split("-")[0] === base) ||
      null
    );
  }

  async function applyCaptions(track) {
    const video = overlay.video;
    overlay.caption = track;
    overlay.controls.setCaptionsOn(!!track);
    if (overlay.ccSelect) {
      overlay.ccSelect.value = track ? String(info.captions.indexOf(track)) : "off";
      overlay.ccSync?.();
    }
    for (const t of video.textTracks) t.mode = "disabled";
    if (!track) return;
    overlay.trackEls ??= new Map();
    let el = overlay.trackEls.get(track.url);
    if (!el) {
      try {
        const res = await fetch(track.url, { credentials: "omit" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        // YouTube's VTT pins cues to the left ("align:start position:0%");
        // drop cue settings so Safari centres them like YouTube does.
        const vtt = (await res.text()).replace(/^(\d[\d:.]* --> [\d:.]+).*$/gm, "$1");
        const url = URL.createObjectURL(new Blob([vtt], { type: "text/vtt" }));
        el = h("track", { kind: "subtitles", label: track.name, srclang: track.lang, src: url });
        // Lift cues a few lines so they sit above our control bar.
        el.addEventListener("load", () => {
          for (const cue of el.track.cues || []) cue.line = -3;
        });
        overlay.trackEls.set(track.url, el);
        video.appendChild(el);
      } catch (e) {
        console.warn("[YT Local Player] captions failed", e);
        return;
      }
    }
    if (overlay?.caption === track) el.track.mode = "showing";
  }

  // Changing the video source can reset text track modes; re-apply ours.
  function restoreCaptionMode() {
    const el = overlay.caption && overlay.trackEls?.get(overlay.caption.url);
    if (el) el.track.mode = "showing";
  }

  function toggleCaptions() {
    if (!info?.captions.length) return;
    const next = overlay.caption ? null : preferredCaption() || info.captions.find((t) => !t.auto) || info.captions[0];
    settings.captions = next ? next.lang : "off";
    browser.storage.local.set({ captions: settings.captions });
    applyCaptions(next);
  }

  // ---- Save (download + mux to mp4) ---------------------------------------

  // Save follows the quality menu; "auto" saves the best H.264 stream.
  function saveFormats() {
    const q = selectedQuality();
    const video = (q !== "auto" && info.videoFormats.find((f) => f.height === q)) || info.videoFormats[0];
    return { video, audio: YLP.audioFormatsForTrack(info, overlay.audioTrackId)[0] };
  }

  function renderSaveButton() {
    const btn = overlay?.saveBtn;
    if (!btn || saveAbort) return;
    const { video, audio } = saveFormats();
    btn.hidden = !settings.saveEnabled || !video || !audio || info.isLive;
    if (btn.hidden) return;
    const mb = (+video.contentLength + +audio.contentLength) / 1e6;
    setPillLabel(btn, `Save ${video.height}p as mp4 (${mb.toFixed(0)} MB)`);
    btn.classList.remove("ylp-busy");
  }

  async function save() {
    if (saveAbort) {
      saveAbort.abort();
      return;
    }
    const { video, audio } = saveFormats();
    const total = +video.contentLength + +audio.contentLength;
    const { saveBtn: btn, saveLabel: label } = overlay;
    saveAbort = new AbortController();
    const signal = saveAbort.signal;
    setPillLabel(btn, "Cancel download");
    btn.classList.add("ylp-busy");
    let got = 0;
    const progress = (n) => {
      got += n;
      label.textContent = `${Math.round((got / total) * 100)}%`;
    };
    try {
      const [v, a] = await Promise.all([
        YLP.downloadFormat(video, progress, signal),
        YLP.downloadFormat(audio, progress, signal),
      ]);
      label.textContent = "Muxing…";
      const blob = new Blob(YLP.mux(v, a), { type: "video/mp4" });
      const url = URL.createObjectURL(blob);
      const name = `${info.title.replace(/[\\/:*?"<>|]+/g, "_").slice(0, 150)}.mp4`;
      h("a", { href: url, download: name }).click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      label.textContent = "Saved ✓";
    } catch (e) {
      label.textContent = e.name === "AbortError" ? "Cancelled" : `Save failed: ${e.message || e}`;
    } finally {
      saveAbort = null;
      renderSaveButton();
    }
  }

  // ---- local yt-dlp helper source ----------------------------------------

  async function playViaHelper(id) {
    overlay.toolbar.hidden = true;
    const progressBar = h("div");
    const text = h("div", {}, "Preparing…");
    setStatus(text, h("div", { class: "ylp-bar" }, progressBar));
    const poll = async () => {
      if (id !== currentId) return;
      const s = await helper(`/status?v=${id}`);
      if (id !== currentId) return;
      if (s.state === "ready") return startPlayback(`${HELPER}/video/${id}`);
      if (s.state === "offline") return showError("Local helper isn't running.", "Start it with: python3 helper/server.py", btnRetry());
      if (s.state === "error") return showError("Download failed.", s.error, btnRetry());
      const pct = Math.round(s.progress || 0);
      progressBar.style.width = `${pct}%`;
      text.textContent = s.stage === "merging" ? "Merging…" : `Downloading… ${pct}%`;
      pollTimer = setTimeout(poll, 700);
    };
    const s = await helper(`/prepare?v=${id}`);
    if (id !== currentId) return;
    if (s.state === "offline") return showError("Local helper isn't running.", "Start it with: python3 helper/server.py", btnRetry());
    poll();
  }

  // ---- lifecycle ------------------------------------------------------------

  async function setup(id) {
    currentId = id;
    const token = playToken;
    for (const k in timing) delete timing[k];
    mark("setup");
    // Check the broadcast before touching YouTube's player, including when
    // using the helper (which would otherwise try to download a live stream).
    const infoPromise = YLP.getPlayer(id);
    infoPromise?.catch(() => {}); // handled in playInBrowser
    const [player, playerInfo] = await Promise.all([
      waitFor(() => token !== playToken || id !== currentId || ytPlayer()),
      infoPromise.catch(() => null),
    ]);
    mark("playerFound");
    if (token !== playToken || id !== currentId) return;
    // Keep currentId so navigation polling does not try to take over again.
    // No overlay or suppression has started: native playback stays untouched.
    if (playerInfo?.isLive || playerInfo?.isUpcoming) {
      mark("nativeLive");
      return;
    }
    overlay = buildOverlay();
    overlay.infoPromise = infoPromise;
    const thumb = `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
    overlay.video.poster = thumb;
    overlay.root.style.backgroundImage = `url("${thumb}")`;
    loadSponsorSegments(id);
    overlay.video.addEventListener("error", () => {
      // HLS errors are handled by playInBrowser's fallback to DASH.
      if (overlay && settings.source === "helper" && overlay.video.error) {
        showError("Safari couldn't play this video.", overlay.video.error.message, btnRetry());
      }
    });
    player.appendChild(overlay.root);
    player.classList.add("ylp-active");
    placeToolbar();
    suppressYouTube();
    suppressTimer = setInterval(() => {
      if (retireIfReplaced()) return;
      suppressYouTube();
      // YouTube sometimes rebuilds the player; put ourselves back if so.
      const p = ytPlayer();
      if (p && overlay && !overlay.mini && overlay.root.parentNode !== p) p.appendChild(overlay.root);
      placeToolbar();
      p?.classList.add("ylp-active");
    }, 300);
    if (settings.source === "helper") playViaHelper(id);
    else playInBrowser(id);
  }

  function waitFor(fn) {
    return new Promise((resolve) => {
      const tick = () => {
        const el = fn();
        el ? resolve(el) : setTimeout(tick, 200);
      };
      tick();
    });
  }

  // ---- SponsorBlock -------------------------------------------------------
  // skip: jump over (or offer a Skip button in "ask" mode)
  // mute: silence while inside
  // poi:  "highlight" — a Highlight button / prompt jumps there
  // full: whole-video label (e.g. the entire video is sponsored)

  const SB_LABELS = {
    sponsor: "sponsor",
    selfpromo: "self-promotion",
    interaction: "subscribe reminder",
    intro: "intro",
    outro: "endcards",
    preview: "preview",
    music_offtopic: "non-music section",
    filler: "filler",
  };
  const SB_FULL_LABELS = {
    sponsor: ["Sponsored video", "#00d400"],
    selfpromo: ["Self-promotion video", "#d4c200"],
    exclusive_access: ["Exclusive access", "#008a5c"],
  };

  async function loadSponsorSegments(id) {
    overlay.segments = [];
    overlay.highlight = null;
    overlay.fullLabel = null;
    renderSponsorUi();
    if (!settings.sponsorBlock) return;
    try {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(id));
      const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
      const categories = [...new Set([...(settings.sbCategories || []), "poi_highlight", "exclusive_access"])];
      const res = await browser.runtime.sendMessage({
        type: "sponsorblock",
        prefix: hash.slice(0, 4),
        categories,
        actionTypes: ["skip", "mute", "poi", "full"],
      });
      if (id !== currentId || !overlay) return;
      const segs = (Array.isArray(res) ? res : []).find((v) => v.videoID === id)?.segments || [];
      const chosen = new Set(settings.sbCategories || []);
      overlay.segments = segs
        .filter((s) => (s.actionType === "skip" || s.actionType === "mute") && chosen.has(s.category))
        .filter((s) => s.segment[1] - s.segment[0] > 0.5)
        .map((s) => ({ start: s.segment[0], end: s.segment[1], category: s.category, action: s.actionType, uuid: s.UUID }));
      if (settings.sbExtras) {
        const poi = segs.find((s) => s.actionType === "poi");
        overlay.highlight = poi ? { time: poi.segment[0], uuid: poi.UUID } : null;
        const full = segs.find((s) => s.actionType === "full" && SB_FULL_LABELS[s.category]);
        overlay.fullLabel = full ? full.category : null;
      }
      renderSponsorUi();
      offerHighlight();
    } catch (e) {
      console.warn("[YT Local Player] SponsorBlock lookup failed", e);
    }
  }

  const credit = (seg) => {
    if (seg.counted) return;
    seg.counted = true;
    browser.runtime.sendMessage({ type: "sbViewed", uuid: seg.uuid });
  };

  function checkSponsorSkip() {
    const video = overlay?.video;
    if (!video || !overlay.segments?.length) return;
    const t = video.currentTime;
    const inside = (s) => !s.ignored && t >= s.start && t < s.end - 0.3;

    // mute segments
    const mute = overlay.segments.find((s) => s.action === "mute" && inside(s));
    if (mute && !overlay.sbMuting) {
      overlay.sbMuting = true;
      video.muted = true;
      showToast(`Muted ${SB_LABELS[mute.category] || mute.category}`, "Unmute", () => {
        mute.ignored = true;
        overlay.sbMuting = false;
        video.muted = false;
      });
      credit(mute);
    } else if (!mute && overlay.sbMuting) {
      overlay.sbMuting = false;
      video.muted = false;
    }

    // skip segments
    const seg = overlay.segments.find((s) => s.action === "skip" && inside(s));
    if (!seg) {
      if (overlay.askingFor) hideToast();
      overlay.askingFor = null;
      return;
    }
    if (settings.sbMode === "ask") {
      if (overlay.askingFor === seg) return;
      overlay.askingFor = seg;
      showToast(`${SB_LABELS[seg.category] || seg.category}`, "Skip ↷", () => {
        video.currentTime = seg.end;
        credit(seg);
      }, (seg.end - t) * 1000);
      return;
    }
    video.currentTime = seg.end;
    showToast(
      `Skipped ${SB_LABELS[seg.category] || seg.category}`,
      "Undo",
      () => {
        seg.ignored = true;
        video.currentTime = seg.start;
      },
      6000,
      seg.uuid ? voteButtons(seg) : []
    );
    credit(seg);
  }

  function jumpToHighlight() {
    if (!overlay?.highlight) return;
    overlay.video.currentTime = overlay.highlight.time;
    overlay.video.play().catch(() => {});
    hideToast();
  }

  // Early in the video, offer the highlight once (like the official extension).
  function offerHighlight() {
    const hl = overlay?.highlight;
    if (!hl || overlay.offeredHighlight || overlay.video.currentTime > hl.time - 5) return;
    overlay.offeredHighlight = true;
    showToast("Highlight available", "Jump ★", jumpToHighlight, 8000);
  }

  // Toolbar: whole-video label + Highlight button.
  const SB_COLORS = {
    sponsor: "#00d400",
    selfpromo: "#ffff00",
    interaction: "#cc00ff",
    intro: "#00ffff",
    outro: "#0202ed",
    preview: "#008fd6",
    music_offtopic: "#ff9900",
    filler: "#7300ff",
    poi_highlight: "#ff1684",
  };

  function renderSponsorUi() {
    if (!overlay) return;
    // Seek-bar markers.
    const marks = (overlay.segments || []).map((s) => ({
      start: s.start,
      end: s.end,
      color: SB_COLORS[s.category] || "#fff",
      title: `${s.action === "mute" ? "Muted: " : ""}${SB_LABELS[s.category] || s.category}`,
    }));
    if (overlay.highlight) marks.push({ start: overlay.highlight.time, point: true, color: SB_COLORS.poi_highlight, title: "Highlight" });
    overlay.controls.setMarkers(marks);

    const slot = overlay.sbSlot;
    if (!slot) return;
    const parts = [];
    const label = overlay.fullLabel && SB_FULL_LABELS[overlay.fullLabel];
    if (label) {
      parts.push(h("span", { class: "ylp-sb-label", title: "SponsorBlock whole-video label", style: `--sb-color: ${label[1]}` }, label[0]));
    }
    if (overlay.highlight) {
      parts.push(pill("star", "Jump to the highlight (SponsorBlock)", { iconOnly: true, onclick: jumpToHighlight }));
    }
    slot.replaceChildren(...parts);
  }

  // extras: [{label, title, fn}] — more buttons (e.g. SponsorBlock votes).
  // ---- SponsorBlock: submit & vote ----------------------------------------

  // SponsorBlock identifies submitters by a private random ID (kept locally).
  async function sbUserId() {
    let { sbUserID } = await browser.storage.local.get("sbUserID");
    if (!sbUserID) {
      sbUserID = (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, "");
      await browser.storage.local.set({ sbUserID });
    }
    return sbUserID;
  }

  async function vote(seg, up) {
    const res = await browser.runtime.sendMessage({ type: "sbVote", uuid: seg.uuid, userID: await sbUserId(), voteType: up ? 1 : 0 });
    const ok = res?.status === 200;
    showToast(ok ? `Thanks — ${up ? "upvoted" : "downvoted"}` : `Vote failed (${res?.status || "network error"})`, null, null, 2500);
    if (ok && !up) seg.ignored = true;
  }

  const voteButtons = (seg) => [
    { label: "👍", title: "This segment was right", fn: () => vote(seg, true) },
    { label: "👎", title: "This segment was wrong", fn: () => vote(seg, false) },
  ];

  const SUBMIT_CATEGORIES = {
    sponsor: "Sponsor",
    selfpromo: "Self-promotion",
    interaction: "Interaction reminder",
    intro: "Intro animation",
    outro: "Endcards/credits",
    preview: "Preview/recap",
    filler: "Filler tangent",
    music_offtopic: "Non-music section",
    poi_highlight: "Highlight (one point)",
  };

  const clock = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, "0")}`;
  const parseClock = (str) => {
    const parts = String(str).trim().split(":").map(Number);
    return !str.trim() || parts.some(isNaN) ? NaN : parts.reduce((a, p) => a * 60 + p, 0);
  };

  function openSubmitPanel() {
    if (!overlay) return;
    if (overlay.submitPanel) return overlay.submitPanel.querySelector("input")?.focus();
    const video = overlay.video;
    const startIn = h("input", { value: clock(video.currentTime), size: 8, title: "m:ss.s" });
    const endIn = h("input", { placeholder: "m:ss.s", size: 8 });
    const now = (input) => button("now", () => (input.value = clock(video.currentTime)));
    const category = h("select", {}, Object.entries(SUBMIT_CATEGORIES).map(([k, v]) => h("option", { value: k }, v)));
    const action = h("select", {}, h("option", { value: "skip" }, "Skip"), h("option", { value: "mute" }, "Mute"));
    const msg = h("span", { class: "ylp-submit-msg" });
    category.addEventListener("change", () => {
      const poi = category.value === "poi_highlight";
      endIn.disabled = action.disabled = poi;
    });
    const read = () => {
      const poi = category.value === "poi_highlight";
      const start = parseClock(startIn.value);
      return { poi, start, end: poi ? start : parseClock(endIn.value) };
    };
    const preview = button("▶ Preview", () => {
      const { start } = read();
      if (isNaN(start)) return;
      video.currentTime = Math.max(0, start - 2);
      video.play().catch(() => {});
    });
    const submit = button("Submit", async () => {
      const { poi, start, end } = read();
      const dur = video.duration;
      if (isNaN(start) || isNaN(end) || start < 0 || end > dur + 1 || (!poi && end - start < 0.5)) {
        msg.textContent = "Check the start and end times.";
        return;
      }
      submit.disabled = true;
      msg.textContent = "Submitting…";
      const seg = { segment: [start, end], category: category.value, actionType: poi ? "poi" : action.value };
      const res = await browser.runtime.sendMessage({
        type: "sbSubmit",
        videoID: currentId,
        userID: await sbUserId(),
        videoDuration: dur,
        segments: [seg],
      });
      submit.disabled = false;
      if (res?.status !== 200) {
        const reasons = {
          400: "Rejected: the segment looks invalid.",
          403: "Rejected by SponsorBlock's moderation.",
          409: "That segment was already submitted.",
          429: "Too many submissions — try again later.",
        };
        msg.textContent = reasons[res?.status] || `Failed (${res?.status || "network error"}) ${String(res?.message || "").slice(0, 80)}`;
        return;
      }
      let uuid;
      try {
        uuid = JSON.parse(res.message)[0]?.UUID;
      } catch {}
      if (!overlay) return;
      if (poi) overlay.highlight = { time: start, uuid };
      // Show your segment on the seek bar, but don't auto-skip it right away.
      else overlay.segments.push({ start, end, category: category.value, action: seg.actionType, uuid, ignored: true });
      renderSponsorUi();
      closeSubmitPanel();
      showToast("Segment submitted — thanks!", null, null, 3000);
    });
    const panel = h(
      "div",
      { class: "ylp-submit" },
      h("strong", {}, "New SponsorBlock segment"),
      h("label", {}, "Start ", startIn, now(startIn)),
      h("label", {}, "End ", endIn, now(endIn)),
      category,
      action,
      preview,
      submit,
      button("Cancel", closeSubmitPanel),
      msg,
      h("div", { class: "ylp-submit-note" }, "Submissions are public and used by everyone — only mark segments you're sure about.")
    );
    overlay.submitPanel = panel;
    (overlay.toolbar.closest("#top-row") || overlay.toolbar).after(panel);
    placeToolbar(); // applies the theme colour to the panel
    endIn.focus();
  }

  function closeSubmitPanel() {
    overlay?.submitPanel?.remove();
    if (overlay) overlay.submitPanel = null;
  }

  function showToast(text, actionLabel, action, ms = 5000, extras = []) {
    if (!overlay) return;
    hideToast();
    const toast = h(
      "div",
      { class: "ylp-toast" },
      text,
      actionLabel ? button(actionLabel, () => (action(), hideToast())) : null,
      extras.map((x) => h("button", { title: x.title, onclick: () => (hideToast(), x.fn()) }, x.label))
    );
    overlay.root.appendChild(toast);
    overlay.toast = toast;
    overlay.toastTimer = setTimeout(() => overlay?.toast === toast && hideToast(), Math.max(1500, ms));
  }

  function hideToast() {
    if (!overlay) return;
    clearTimeout(overlay.toastTimer);
    overlay.toast?.remove();
    overlay.toast = null;
  }

  // ---- page-wide: hide ads / Shorts --------------------------------------

  function applyPageSettings() {
    const html = document.documentElement;
    html.classList.toggle("ylp-hide-ads", settings.enabled && settings.hideAds);
    html.classList.toggle("ylp-hide-shorts", settings.enabled && settings.hideShorts);
  }

  // Open Shorts in the normal watch page (and so in our player).
  function redirectShorts() {
    const m = location.pathname.match(/^\/shorts\/([\w-]{11})/);
    if (!m || !settings.enabled || !settings.hideShorts) return false;
    location.replace(`/watch?v=${m[1]}`);
    return true;
  }

  function onNavigate() {
    if (docEl.dataset.ylpInstance !== INSTANCE) return;
    trackNavigation();
    if (redirectShorts()) return;
    const id = settings.enabled ? videoIdFromUrl() : null;
    if (overlay?.mini) {
      if (id === currentId) {
        // Still on the page we're leaving (history.back() is async): wait.
        if (location.href === overlay.leaving) return;
        return setMini(false); // came back to its watch page
      }
      overlay.leaving = null;
      if (!id) return; // browsing elsewhere: keep playing in the corner
    }
    if (id === currentId) return;
    teardown();
    if (id) setup(id);
  }

  // ---- mini player ----------------------------------------------------------
  // Like YouTube's "i": the video floats in a corner and keeps playing while
  // you browse; expand returns to its watch page without interrupting it.

  function setMini(on) {
    if (!overlay) return;
    overlay.mini = on;
    overlay.root.classList.toggle("ylp-mini", on);
    document.documentElement.classList.toggle("ylp-mini-active", on);
    if (on) {
      document.body.appendChild(overlay.root);
    } else {
      const p = ytPlayer();
      if (p) p.appendChild(overlay.root);
      placeToolbar();
    }
  }

  // Leave the watch page the way YouTube does: back to the previous page (a
  // real history step its router handles), or home via its own logo link.
  // history.back() is only safe if this tab got to the video by navigating
  // inside YouTube; otherwise the previous entry may be another site, which
  // would unload the page (and the player). history.length can't tell us (it
  // is capped, and differs in Safari web apps), so track in-page navigations.
  let lastHref = null;
  let prevHref = null;
  function trackNavigation() {
    if (location.href === lastHref) return;
    prevHref = lastHref;
    lastHref = location.href;
  }

  function enterMini() {
    if (!overlay || overlay.mini || overlay.video.hidden) return;
    setMini(true);
    const watchUrl = location.href;
    overlay.leaving = watchUrl;
    overlay.cameFrom = null;
    if (prevHref) {
      history.back();
      overlay.cameFrom = watchUrl; // so expand can step forward again
    } else {
      document.querySelector("ytd-topbar-logo-renderer a, a#logo")?.click();
    }
  }

  // Open a watch page through YouTube's own router: no page load, so the
  // player (and whatever page is behind it) survives. Returns false if the
  // router isn't there to take the event.
  function spaNavigate(id, at) {
    const app = document.querySelector("ytd-app");
    if (!app) return false;
    const url = `/watch?v=${id}&t=${at}s`;
    app.dispatchEvent(
      new CustomEvent("yt-navigate", {
        bubbles: true,
        composed: true,
        detail: {
          endpoint: {
            commandMetadata: { webCommandMetadata: { url, webPageType: "WEB_PAGE_TYPE_WATCH", rootVe: 3832 } },
            watchEndpoint: { videoId: id, startTimeSeconds: at },
          },
        },
      })
    );
    return true;
  }

  // Return to the watch page without interrupting playback. Going "forward" is
  // not reliable (browsing while minimized discards the forward entry), so ask
  // YouTube's router; only if that does nothing fall back to a full page load.
  function expandMini() {
    if (!overlay?.mini) return;
    const id = currentId;
    const at = Math.floor(overlay.video.currentTime);
    overlay.leaving = null;
    const reload = () => location.assign(`/watch?v=${id}&t=${at}s`);
    if (!spaNavigate(id, at)) return reload();
    const started = Date.now();
    const wait = setInterval(() => {
      if (videoIdFromUrl() === id) return clearInterval(wait);
      if (Date.now() - started > 4000) {
        clearInterval(wait);
        reload();
      }
    }, 100);
  }

  function closeMini() {
    teardown();
    document.documentElement.classList.remove("ylp-mini-active");
  }

  // Map YouTube's keyboard shortcuts onto our player while it's active.
  function onKey(e) {
    const video = overlay?.video;
    if (!video || video.hidden || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
    if (e.key === "i") {
      e.preventDefault();
      e.stopImmediatePropagation();
      return overlay.mini ? expandMini() : enterMini();
    }
    if (overlay.mini) return; // while browsing, leave other keys to the page
    const actions = {
      " ": () => (video.paused ? video.play() : video.pause()),
      k: () => (video.paused ? video.play() : video.pause()),
      j: () => (video.currentTime -= 10),
      l: () => (video.currentTime += 10),
      ArrowLeft: () => (video.currentTime -= 5),
      ArrowRight: () => (video.currentTime += 5),
      c: toggleCaptions,
      m: () => (video.muted = !video.muted),
      ArrowUp: () => (video.volume = Math.min(1, video.volume + 0.05)),
      ArrowDown: () => (video.volume = Math.max(0, video.volume - 0.05)),
      f: () => overlay.controls.toggleFullscreen(),
    };
    const fn = actions[e.key];
    if (!fn) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    fn();
  }

  // Only one copy of this script may run per page. When Safari injects an
  // updated extension into an open tab, the old copy keeps running; two copies
  // would each mute and pause the other's player. The newest copy wins.
  const INSTANCE = Math.random().toString(36).slice(2);
  const docEl = document.documentElement;
  docEl.dataset.ylpInstance = INSTANCE;
  document.querySelectorAll("#ylp-overlay").forEach((el) => el.remove());
  let navTimer = null;

  function retireIfReplaced() {
    if (docEl.dataset.ylpInstance === INSTANCE) return false;
    teardown();
    clearInterval(navTimer);
    document.removeEventListener("play", onAnyPlay, true);
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("click", onLinkClick, true);
    document.removeEventListener("yt-navigate-finish", onNavigate);
    window.removeEventListener("popstate", onNavigate);
    settings.enabled = false;
    return true;
  }

  document.addEventListener("play", onAnyPlay, true);
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("click", onLinkClick, true);
  document.addEventListener("yt-navigate-finish", onNavigate);
  window.addEventListener("popstate", onNavigate);
  // Also the fallback for navigations without yt-navigate-finish.
  navTimer = setInterval(() => retireIfReplaced() || onNavigate(), 1000);

  browser.storage.local.get(settings).then((s) => {
    settings = s;
    applyPageSettings();
    onNavigate();
  });
  browser.storage.onChanged.addListener((changes) => {
    for (const [k, c] of Object.entries(changes)) settings[k] = c.newValue;
    applyPageSettings();
    if (changes.saveEnabled) renderSaveButton();
    if ((changes.sponsorBlock || changes.sbCategories || changes.sbExtras) && overlay && currentId) loadSponsorSegments(currentId);
    // Quality/caption changes are applied live by the toolbar; only restart for these.
    if (changes.enabled || changes.source) {
      teardown();
      onNavigate();
    }
  });
})();
