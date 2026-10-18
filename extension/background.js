// Network calls the content script can't (or shouldn't) make from the page.
globalThis.browser ??= globalThis.chrome; // Chrome exposes the same API as chrome.*

const HELPER = "http://127.0.0.1:8765";
const SPONSORBLOCK = "https://sponsor.ajay.app/api";
const RYD = "https://returnyoutubedislikeapi.com/votes";
const dislikeCache = new Map();
const dislikePending = new Map();
let dislikeBackoffUntil = 0;

async function getDislikes(videoId) {
  if (typeof videoId !== "string" || !/^[\w-]{11}$/.test(videoId)) return { error: "invalid video ID" };
  const cached = dislikeCache.get(videoId);
  if (cached?.expires > Date.now()) return cached.value;
  if (Date.now() < dislikeBackoffUntil) return { error: "rate limited" };
  if (dislikePending.has(videoId)) return dislikePending.get(videoId);
  const request = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    let value;
    try {
      const response = await fetch(`${RYD}?videoId=${encodeURIComponent(videoId)}`, {
        credentials: "omit", referrerPolicy: "no-referrer", signal: controller.signal,
      });
      if (response.status === 429) {
        const retry = response.headers.get("Retry-After");
        const seconds = Number(retry);
        const delay = retry && Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retry) - Date.now();
        dislikeBackoffUntil = Date.now() + Math.max(60000, Number.isFinite(delay) ? delay : 60000);
        throw new Error("rate limited");
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const votes = await response.json();
      if (votes.deleted || votes.id !== videoId || !Number.isSafeInteger(votes.dislikes) || votes.dislikes < 0) {
        throw new Error("counts unavailable");
      }
      value = { dislikes: votes.dislikes };
    } catch (error) {
      value = { error: String(error.message || error) };
    } finally {
      clearTimeout(timer);
    }
    // Cache failures briefly too; rebuilding the toolbar must not hammer the API.
    dislikeCache.set(videoId, { value, expires: Date.now() + (value.error ? 60000 : 600000) });
    if (dislikeCache.size > 200) dislikeCache.delete(dislikeCache.keys().next().value);
    return value;
  })();
  dislikePending.set(videoId, request);
  try { return await request; }
  finally { dislikePending.delete(videoId); }
}

// Returns a promise for messages that expect an answer, else undefined.
function handle(msg) {
  switch (msg?.type) {
    case "returnDislike":
      return getDislikes(msg.videoId);

    // Local yt-dlp helper.
    case "helper":
      return fetch(`${HELPER}${msg.path}`)
        .then((r) => r.json())
        .catch((e) => ({ state: "offline", error: String(e) }));

    // SponsorBlock segments, looked up by a 4-char SHA-256 prefix of the video
    // id so the server never learns exactly which video is being watched.
    case "sponsorblock": {
      const q = new URLSearchParams({
        categories: JSON.stringify(msg.categories),
        actionTypes: JSON.stringify(msg.actionTypes || ["skip"]),
      });
      return fetch(`${SPONSORBLOCK}/skipSegments/${msg.prefix}?${q}`)
        .then((r) => (r.status === 404 ? [] : r.json()))
        .catch(() => []);
    }

    // Submit new segments. Returns {status, message} (403 = rejected by the
    // auto-moderator, 409 = duplicate, 429 = rate limited).
    case "sbSubmit":
      return fetch(`${SPONSORBLOCK}/skipSegments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          videoID: msg.videoID,
          userID: msg.userID,
          userAgent: `YT Local Player/${browser.runtime.getManifest().version}`,
          videoDuration: msg.videoDuration,
          segments: msg.segments,
        }),
      })
        .then(async (r) => ({ status: r.status, message: await r.text() }))
        .catch((e) => ({ status: 0, message: String(e) }));

    // type: 1 = upvote, 0 = downvote.
    case "sbVote": {
      const q = new URLSearchParams({ UUID: msg.uuid, userID: msg.userID, type: String(msg.voteType) });
      return fetch(`${SPONSORBLOCK}/voteOnSponsorTime?${q}`, { method: "POST" })
        .then(async (r) => ({ status: r.status, message: await r.text() }))
        .catch((e) => ({ status: 0, message: String(e) }));
    }

    // Credits the segment's submitter, as the official extension does.
    case "sbViewed":
      fetch(`${SPONSORBLOCK}/viewedVideoSponsorTime?UUID=${encodeURIComponent(msg.uuid)}`, { method: "POST" }).catch(() => {});
      return;
  }
}

// sendResponse + `return true` works in Safari, Chrome and Firefox alike
// (Chrome ignores a promise returned from the listener).
browser.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const result = handle(msg);
  if (!result) return false;
  result.then(sendResponse, (e) => sendResponse({ error: String(e) }));
  return true;
});
