// Network calls the content script can't (or shouldn't) make from the page.
const HELPER = "http://127.0.0.1:8765";
const SPONSORBLOCK = "https://sponsor.ajay.app/api";

browser.runtime.onMessage.addListener((msg) => {
  switch (msg?.type) {
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
});
