// Minimal InnerTube client: asks YouTube's player API for a video's streams.
//
// Posing as the visionOS app (with the page's own visitor ID) gives an HLS
// manifest plus plain, full-length stream URLs — nothing to decipher and no
// PO token. The iOS client is a fallback; without a PO token it only serves
// ~60s of its plain URLs, but its HLS is fine. If YouTube starts rejecting a
// client, refresh its values from YouTube.js's src/utils/Constants.ts.
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
        clientVersion: "20.11.6",
        deviceMake: "Apple",
        deviceModel: "iPhone10,4",
        osName: "iOS",
        osVersion: "16.7.7.20H330",
      },
    },
  ];

  let visitorData = null;

  // The anonymous visitor ID youtube.com embeds in every page (ytcfg).
  // Without it YouTube answers "Sign in to confirm you're not a bot".
  async function getVisitorData() {
    if (visitorData) return visitorData;
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
    const html = await (await fetch("https://www.youtube.com/", { credentials: "omit" })).text();
    visitorData = find(html) || null;
    return visitorData;
  }

  async function requestPlayer(videoId, client, visitor) {
    const lang = (navigator.language || "en-US").split("-");
    const res = await fetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
      method: "POST",
      credentials: "omit", // logged-out request; web cookies confuse app clients
      headers: {
        "Content-Type": "application/json",
        "X-Youtube-Client-Name": client.id,
        "X-Youtube-Client-Version": client.context.clientVersion,
        ...(visitor ? { "X-Goog-Visitor-Id": visitor } : {}),
      },
      body: JSON.stringify({
        videoId,
        contentCheckOk: true,
        racyCheckOk: true,
        context: {
          client: {
            ...client.context,
            userAgent: navigator.userAgent,
            visitorData: visitor || undefined,
            hl: lang[0],
            gl: lang[1] || "US",
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
      title: j.videoDetails?.title || videoId,
      isLive: !!j.videoDetails?.isLive,
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
  async function getPlayer(videoId) {
    const visitor = await getVisitorData().catch(() => null);
    let first = null;
    for (const client of CLIENTS) {
      try {
        const info = parse(videoId, await requestPlayer(videoId, client, visitor));
        info.client = client.context.clientName;
        if (info.ok && (info.hls || info.videoFormats.length)) return info;
        first ??= info;
      } catch (e) {
        if (!first) first = e;
      }
    }
    if (first instanceof Error) throw first;
    return first;
  }

  globalThis.YLP = Object.assign(globalThis.YLP || {}, { getPlayer });
})();
