// Audio selection is per video. Never carry a dub choice to the next video.
(() => {
  function selectedAudioTrack(info, id) {
    const tracks = info.audioTracks || [];
    return tracks.find((t) => t.id === id) || tracks.find((t) => t.isDefault) || tracks[0] || null;
  }

  function audioFormatsForTrack(info, id) {
    const track = selectedAudioTrack(info, id);
    return info.audioFormats.filter((f) => track ? f.audioTrack?.id === track.id : !f.audioTrack);
  }

  function variantLanguage(uri) {
    let text = uri;
    for (let i = 0; i < 3; i++) {
      try { text = decodeURIComponent(text); } catch { break; }
    }
    return text.match(/(?:^|[^a-z])lang[=:]([a-zA-Z0-9-]+)/)?.[1] || null;
  }

  // YouTube muxes each language into its own set of video variants. Leaving
  // them all in the master lets ABR switch languages while changing quality.
  function parseHlsMaster(manifest, baseUrl) {
    const lines = manifest.split(/\r?\n/);
    const variants = [];
    const headers = [];
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
        });
      } else if (!line.startsWith("#EXT-X-I-FRAME-STREAM-INF:")) headers.push(line);
    }
    return { variants, headers };
  }

  function selectVariants(variants, track) {
    if (!track) return variants;
    const exact = variants.filter((v) => v.lang?.toLowerCase() === track.lang.toLowerCase());
    const selected = exact.length ? exact : (track.isDefault || !variants.some((v) => v.lang) ? variants.filter((v) => !v.lang) : []);
    if (!selected.length) throw new Error(`No HLS streams for ${track.name}`);
    return selected;
  }

  function filterHlsAudio(manifest, track, baseUrl) {
    if (!track) return manifest;
    const { variants, headers } = parseHlsMaster(manifest, baseUrl);
    // Media playlists already contain just one language.
    if (!variants.length) return manifest;
    return [...headers.filter(Boolean), ...selectVariants(variants, track).flatMap((v) => [v.header, v.uri]), ""].join("\n");
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

  globalThis.YLP = Object.assign(globalThis.YLP || {}, { selectedAudioTrack, audioFormatsForTrack, filterHlsAudio, audioPlaylistLoader, parseHlsMaster, loadHlsPlaylist, hlsVideoVariants });
})();
