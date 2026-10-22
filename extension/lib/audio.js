// Audio selection is per video. Never carry a dub choice to the next video.
(() => {
  function selectedAudioTrack(info, id) {
    const tracks = info.audioTracks || [];
    return tracks.find((t) => t.id === id) || tracks.find((t) => t.isDefault) || tracks.find((t) => t.original) || tracks[0] || null;
  }

  function audioFormatsForTrack(info, id) {
    const track = selectedAudioTrack(info, id);
    return info.audioFormats.filter((f) => track ? f.audioTrack?.id === track.id : !f.audioTrack);
  }

  function decoded(text) {
    for (let i = 0; i < 3; i++) {
      try { text = decodeURIComponent(text); } catch { break; }
    }
    return text;
  }

  const variantLanguage = (uri) => decoded(uri).match(/(?:^|[^a-z])lang[=:]([a-zA-Z0-9-]+)/)?.[1] || null;
  const isOriginal = (text) => /acont[=:]original/.test(decoded(text));
  const attr = (line, name) => line.match(new RegExp(`(?:[:,])${name}=(?:"([^"]*)"|([^,]*))`))?.slice(1).find((v) => v != null) ?? null;

  // Language-tagged entries for the chosen track. Without a track (or for the
  // default one) prefer YouTube's original audio over dubs, so Safari and
  // hls.js never pick a dub from the system language.
  function chooseAudio(entries, track) {
    if (!entries.some((e) => e.lang)) return entries;
    const lang = track?.lang.toLowerCase();
    const base = lang?.split("-")[0];
    const exact = lang ? entries.filter((e) => e.lang?.toLowerCase() === lang) : [];
    if (exact.length) return exact;
    const near = lang ? entries.filter((e) => e.lang?.toLowerCase().split("-")[0] === base) : [];
    if (near.length) return near;
    if (track && !track.isDefault) return [];
    for (const pick of [(e) => e.original, (e) => e.isDefault, (e) => !e.lang]) {
      const chosen = entries.filter(pick);
      if (chosen.length) return chosen;
    }
    return track ? [] : entries;
  }

  // YouTube muxes each language into its own set of video variants. Leaving
  // them all in the master lets ABR switch languages while changing quality.
  function parseHlsMaster(manifest, baseUrl) {
    const lines = manifest.split(/\r?\n/);
    const variants = [];
    const headers = [];
    const media = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith("#EXT-X-STREAM-INF:")) {
        let uri;
        while (++i < lines.length) {
          if (lines[i].trim() && !lines[i].startsWith("#")) { uri = lines[i].trim(); break; }
        }
        if (uri) variants.push({
          header: line, uri: new URL(uri, baseUrl).href, lang: variantLanguage(uri),
          height: +(line.match(/(?:^|,)RESOLUTION=\d+x(\d+)/)?.[1] || 0),
          bandwidth: +(line.match(/BANDWIDTH=(\d+)/)?.[1] || 0),
          audioGroup: line.match(/(?:^|,)AUDIO="([^"]+)"/)?.[1] || null,
          original: isOriginal(line + uri),
        });
      } else if (line.startsWith("#EXT-X-MEDIA:") && attr(line, "TYPE") === "AUDIO") {
        // One audio group can hold every dub; keep its renditions apart so
        // they can be filtered like the muxed variants.
        const contentId = attr(line, "YT-EXT-AUDIO-CONTENT-ID");
        media.push({
          line, group: attr(line, "GROUP-ID"),
          lang: attr(line, "LANGUAGE") || contentId?.split(".")[0] || variantLanguage(attr(line, "URI") || ""),
          original: isOriginal(line),
          isDefault: attr(line, "DEFAULT") === "YES",
        });
      } else if (!line.startsWith("#EXT-X-I-FRAME-STREAM-INF:")) headers.push(line);
    }
    return { variants, headers, media };
  }

  function selectVariants(variants, track) {
    const selected = chooseAudio(variants, track);
    if (selected.length) return selected;
    if (!track) return variants;
    throw new Error(`No HLS streams for ${track.name}`);
  }

  // Per audio group, keep the chosen language and make it the group's only
  // default/autoselect rendition.
  function selectMedia(media, track) {
    const groups = new Map();
    for (const m of media) groups.set(m.group, [...(groups.get(m.group) || []), m]);
    return [...groups.values()].flatMap((entries) => {
      const chosen = chooseAudio(entries, track);
      return (chosen.length ? chosen : entries).map((m, i) => {
        const flag = i === 0 ? "YES" : "NO";
        let line = m.line;
        for (const name of ["DEFAULT", "AUTOSELECT"]) {
          line = attr(line, name) != null ? line.replace(new RegExp(`([:,])${name}=[^,]*`), `$1${name}=${flag}`) : `${line},${name}=${flag}`;
        }
        return line;
      });
    });
  }

  // True when the master mixes languages, even if the player response
  // listed no audio tracks.
  function hlsHasMultipleAudio(info) {
    const { variants = [], media = [] } = info.hlsPlaylist || {};
    return new Set([...variants, ...media].map((e) => e.lang?.toLowerCase()).filter(Boolean)).size > 1;
  }

  function filterHlsAudio(manifest, track, baseUrl) {
    const { variants, headers, media } = parseHlsMaster(manifest, baseUrl);
    // Media playlists already contain just one language.
    if (!variants.length) return manifest;
    return [
      ...headers.filter(Boolean),
      ...selectMedia(media, track),
      ...selectVariants(variants, track).flatMap((v) => [v.header, v.uri]),
      "",
    ].join("\n");
  }

  async function loadHlsPlaylist(info) {
    if (!info.hls) return;
    info.hlsPlaylistPromise ||= (async () => {
      const response = await fetch(info.hls, { credentials: "omit" });
      if (!response.ok) throw new Error(`HLS manifest returned HTTP ${response.status}`);
      info.hlsPlaylist = parseHlsMaster(await response.text(), response.url || info.hls);
    })();
    return info.hlsPlaylistPromise;
  }

  function hlsVideoVariants(info, trackId) {
    const variants = info.hlsPlaylist?.variants || [];
    if (!variants.length) return [];
    return selectVariants(variants, selectedAudioTrack(info, trackId))
      .filter((v) => v.height > 0).sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth);
  }

  // Filter the master before hls.js parses it; child playlists and segment
  // requests retain their original signed URLs and adaptive quality choices.
  function audioPlaylistLoader(Hls, track) {
    return class extends Hls.DefaultConfig.loader {
      load(context, config, callbacks) {
        super.load(context, config, {
          ...callbacks,
          onSuccess: (response, stats, ctx, networkDetails) => {
            if (ctx.type === "manifest") {
              try { response.data = filterHlsAudio(response.data, track, response.url || ctx.url); }
              catch (e) { callbacks.onError({ code: 0, text: e.message }, ctx, networkDetails, stats); return; }
            }
            callbacks.onSuccess(response, stats, ctx, networkDetails);
          },
        });
      }
    };
  }

  globalThis.YLP = Object.assign(globalThis.YLP || {}, { selectedAudioTrack, audioFormatsForTrack, filterHlsAudio, hlsHasMultipleAudio, audioPlaylistLoader, parseHlsMaster, loadHlsPlaylist, hlsVideoVariants });
})();
