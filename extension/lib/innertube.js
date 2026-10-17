// Minimal InnerTube client: asks YouTube's player API for a video's streams.
//
// Prefer the web session (including the user's YouTube login cookies).
// App clients remain fallbacks for sessions without usable web streams.
(() => {
  const CLIENTS = [
    {
      id: "101",
      context: {
        clientName: "VISIONOS",
        clientVersion: "1.02",
        deviceMake: "Apple",
        deviceModel: "RealityDevice17,1",
        osName: "visionOS",
        osVersion: "26.5.23O471",
        platform: "MOBILE",
      },
    },
    {
      id: "5",
      context: {
        clientName: "IOS",
        clientVersion: "21.26.4",
        deviceMake: "Apple",
        deviceModel: "iPhone16,2",
        osName: "iPhone",
        osVersion: "18.3.2.22D82",
        userAgent: "com.google.ios.youtube/21.26.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)",
      },
    },
  ];

  // Parse JSON data only; never execute scripts taken from the page.
  function jsonAfter(text, pattern) {
    const match = pattern.exec(text);
    if (!match) return null;
    const start = match.index + match[0].length;
    let depth = 0, quoted = false, escaped = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === '"') quoted = false;
      } else if (c === '"') quoted = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
      }
    }
    return null;
  }

  function pageData() {
    const config = {};
    let player = null;
    for (const script of document.scripts) {
      const text = script.textContent;
      Object.assign(config, jsonAfter(text, /ytcfg\.set\(\s*(?=\{)/));
      player ||= jsonAfter(text, /(?:var\s+)?ytInitialPlayerResponse\s*=\s*(?=\{)/);
    }
    return { config, player };
  }

  // Generate YouTube's normal cookie authentication header in memory. Cookies
  // and hashes never leave youtube.com and are never saved or sent to a helper.
  async function authHeaders(config, origin) {
    const cookies = Object.fromEntries((document.cookie || "").split(/;\s*/).map((entry) => {
      const i = entry.indexOf("=");
      return i < 0 ? [entry, ""] : [entry.slice(0, i), entry.slice(i + 1)];
    }));
    const timestamp = Math.floor(Date.now() / 1000);
    const schemes = [
      ["SAPISIDHASH", cookies.SAPISID || cookies["__Secure-3PAPISID"]],
      ["SAPISID1PHASH", cookies["__Secure-1PAPISID"]],
      ["SAPISID3PHASH", cookies["__Secure-3PAPISID"]],
    ];
    const auth = await Promise.all(schemes.filter(([, sid]) => sid).map(async ([scheme, sid]) => {
      const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(`${timestamp} ${sid} ${origin}`));
      const hash = Array.from(new Uint8Array(digest), (n) => n.toString(16).padStart(2, "0")).join("");
      return `${scheme} ${timestamp}_${hash}`;
    }));
    return {
      "X-Goog-AuthUser": String(config.SESSION_INDEX ?? 0),
      ...(config.DELEGATED_SESSION_ID ? { "X-Goog-PageId": config.DELEGATED_SESSION_ID } : {}),
      ...(auth.length ? { Authorization: auth.join(" "), "X-Origin": origin } : {}),
      ...(config.LOGGED_IN ? { "X-Youtube-Bootstrap-Logged-In": "true" } : {}),
    };
  }

  // Keep the visitor ID aligned with the current browser session. A visitor
  // ID alone is not authentication and does not prevent bot challenges.
  async function getVisitorData() {
    let visitorData;
    const find = (text) => text.match(/"VISITOR_DATA":"([^"]+)"/)?.[1] || text.match(/"visitorData":"([^"]+)"/)?.[1];
    // At document_start ytcfg may not be parsed yet: poll the page for ~3s.
    for (let i = 0; i < 30; i++) {
      for (const s of document.scripts) {
        visitorData = find(s.textContent);
        if (visitorData) {
          YLP.mark?.("visitorFromPage");
          return visitorData;
        }
      }
      if (document.readyState === "complete") break;
      await new Promise((r) => setTimeout(r, 100));
    }
    YLP.mark?.("visitorFetchStart");
    const html = await (await fetch("https://www.youtube.com/", { credentials: "include" })).text();
    visitorData = find(html) || null;
    return visitorData;
  }

  async function requestPlayer(videoId, client, visitor, config = {}) {
    const lang = (navigator.language || "en-US").split("-");
    const origin = globalThis.location?.origin === "https://m.youtube.com" ? "https://m.youtube.com" : "https://www.youtube.com";
    const res = await fetch(`${origin}/youtubei/v1/player?prettyPrint=false`, {
      method: "POST",
      redirect: "error",
      credentials: client.web ? "include" : "omit",
      headers: {
        "Content-Type": "application/json",
        "X-Youtube-Client-Name": client.id,
        "X-Youtube-Client-Version": client.context.clientVersion,
        ...(visitor ? { "X-Goog-Visitor-Id": visitor } : {}),
        ...(client.web ? await authHeaders(config, origin) : {}),
      },
      body: JSON.stringify({
        videoId,
        contentCheckOk: true,
        racyCheckOk: true,
        context: {
          ...(client.web ? config.INNERTUBE_CONTEXT : {}),
          client: {
            userAgent: navigator.userAgent,
            ...client.context,
            visitorData: visitor || undefined,
            hl: client.context.hl || lang[0],
            gl: client.context.gl || "US",
          },
        },
      }),
    });
    if (!res.ok) throw new Error(`player API returned HTTP ${res.status}`);
    return res.json();
  }

  // Storyboard spec: "base|L0|L1|L2", each level "w#h#count#cols#rows#intervalMs#name#sigh".
  // Uses the largest level for hover previews.
  function parseStoryboard(spec, durationSec) {
    if (!spec) return null;
    const [base, ...levels] = spec.split("|");
    if (!levels.length) return null;
    const L = levels.length - 1;
    const [w, h, count, cols, rows, interval, name, sigh] = levels[L].split("#");
    return {
      width: +w,
      height: +h,
      count: +count,
      cols: +cols,
      rows: +rows,
      intervalMs: +interval,
      durationSec,
      url: (sheet) => `${base.replace("$L", L).replace("$N", name.replace("$M", sheet))}&sigh=${sigh}`,
    };
  }

  function parse(videoId, j) {
    const status = j.playabilityStatus || {};
    const sd = j.streamingData || {};
    // Web responses may contain encrypted signatures or SABR-only streams.
    // Those are not usable URLs for this player; continue to another client.
    const adaptive = (sd.adaptiveFormats || []).filter((f) => f.url);
    const mp4Video = adaptive
      .filter((f) => f.mimeType.startsWith("video/mp4") && /avc1/.test(f.mimeType) && f.indexRange)
      .sort((a, b) => b.height - a.height || b.bitrate - a.bitrate);
    // Videos with dubs list one audio stream per language; keep the original.
    const mp4Audio = adaptive
      .filter((f) => f.mimeType.startsWith("audio/mp4") && f.indexRange)
      .filter((f) => !f.audioTrack || f.audioTrack.audioIsDefault)
      .sort((a, b) => b.bitrate - a.bitrate);
    const captions = (j.captions?.playerCaptionsTracklistRenderer?.captionTracks || []).map((t) => ({
      lang: t.languageCode,
      name: t.name?.runs?.[0]?.text || t.name?.simpleText || t.languageCode,
      auto: t.kind === "asr",
      url: `${t.baseUrl}&fmt=vtt`,
    }));
    return {
      ok: status.status === "OK",
      reason: status.reason || status.status || "unknown error",
      loginRequired: status.status === "LOGIN_REQUIRED",
      title: j.videoDetails?.title || videoId,
      isLive: !!(j.videoDetails?.isLive || j.microformat?.playerMicroformatRenderer?.liveBroadcastDetails?.isLiveNow),
      isUpcoming: !!j.videoDetails?.isUpcoming || status.status === "LIVE_STREAM_OFFLINE",
      durationSec: +(j.videoDetails?.lengthSeconds || 0),
      hls: sd.hlsManifestUrl || null,
      videoFormats: mp4Video,
      audioFormats: mp4Audio,
      captions,
      storyboard: parseStoryboard(j.storyboards?.playerStoryboardSpecRenderer?.spec, +(j.videoDetails?.lengthSeconds || 0)),
    };
  }

  // Tries each client in order; returns the first playable result (or the
  // first failure, which carries YouTube's reason).
  async function getPlayer(videoId, { skipClients = [] } = {}) {
    const visitor = await getVisitorData().catch(() => null);
    // Read again on every navigation: account, visitor and video can change
    // without reloading the document on YouTube.
    const { config, player } = pageData();
    const playable = (info) => info.ok && (info.hls || (info.videoFormats.length && info.audioFormats.length));
    if (!skipClients.includes("WEB_PAGE") && player?.videoDetails?.videoId === videoId) {
      // A web HLS manifest can load even while every media segment is denied
      // unless its n signature has been transformed first.
      try {
        const broadcast = parse(videoId, player);
        if (broadcast.isLive || broadcast.isUpcoming) return { ...broadcast, client: "WEB_PAGE" };
        const info = parse(videoId, await (YLP.decipherStreams?.(player) || player));
        if (info.isLive || info.isUpcoming || playable(info)) return { ...info, client: "WEB_PAGE" };
      } catch (e) {
        console.warn("[YT Local Player] Page stream signature decoding failed:", e.message);
      }
    }
    const web = {
      web: true,
      id: config.INNERTUBE_CONTEXT?.client?.clientName === "MWEB" ? "2" : "1",
      context: {
        clientName: "WEB", clientVersion: config.INNERTUBE_CLIENT_VERSION || "2.20260708.00.00",
        ...config.INNERTUBE_CONTEXT?.client,
      },
    };
    let first = null;
    for (const client of [web, ...CLIENTS]) {
      if (skipClients.includes(client.context.clientName)) continue;
      try {
        const response = await requestPlayer(videoId, client, visitor, config);
        const broadcast = parse(videoId, response);
        if (broadcast.isLive || broadcast.isUpcoming) return { ...broadcast, client: client.context.clientName };
        const info = parse(videoId, await (YLP.decipherStreams?.(response) || response));
        info.client = client.context.clientName;
        // A live/upcoming broadcast belongs in YouTube's native player even
        // when this client cannot supply playable streams for it.
        if (info.isLive || info.isUpcoming) return info;
        if (playable(info)) return info;
        // Keep a meaningful rejection instead of an OK response with no URLs,
        // or a transport error that masks the server's later explanation.
        if (!first || first instanceof Error || (first.ok && !info.ok)) first = info;
      } catch (e) {
        if (!first) first = e;
      }
    }
    if (first instanceof Error) throw first;
    return first || { ok: false, reason: "None of YouTube's available streams could be played." };
  }

  globalThis.YLP = Object.assign(globalThis.YLP || {}, { getPlayer });
})();
