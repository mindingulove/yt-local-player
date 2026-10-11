// Small MediaSource player for YouTube's separate video/audio mp4 streams.
// Used when a video has no HLS manifest (Safari plays HLS natively).
(() => {
  // Like YouTube: play as soon as the first segment lands, then keep buffering
  // ahead (also while paused) so playback doesn't stall.
  const AHEAD = 120; // seconds to buffer ahead of the playhead
  const BEHIND = 60; // seconds of played media to keep

  class Track {
    constructor(player, fmt) {
      this.player = player;
      this.fmt = fmt;
      this.busy = false;
      this.done = false;
    }

    async init(ms) {
      const head = await YLP.fetchRange(this.fmt.url, 0, +this.fmt.indexRange.end, this.player.abort.signal);
      this.segments = YLP.parseSidx(head);
      this.sb = ms.addSourceBuffer(this.fmt.mimeType);
      await this.append(head.subarray(0, +this.fmt.initRange.end + 1));
    }

    append(data) {
      return new Promise((resolve, reject) => {
        const sb = this.sb;
        const done = () => {
          sb.removeEventListener("updateend", done);
          sb.removeEventListener("error", fail);
          resolve();
        };
        const fail = () => {
          sb.removeEventListener("updateend", done);
          sb.removeEventListener("error", fail);
          reject(new Error("append failed"));
        };
        sb.addEventListener("updateend", done);
        sb.addEventListener("error", fail);
        sb.appendBuffer(data);
      });
    }

    remove(start, end) {
      return new Promise((resolve) => {
        this.sb.addEventListener("updateend", resolve, { once: true });
        this.sb.remove(start, end);
      });
    }

    bufferedEnd(t) {
      const b = this.sb.buffered;
      for (let i = 0; i < b.length; i++) if (b.start(i) <= t + 0.2 && t < b.end(i)) return b.end(i);
      return t;
    }

    async pump() {
      if (this.busy || !this.sb) return;
      this.busy = true;
      try {
        const video = this.player.video;
        while (!this.player.destroyed) {
          const t = video.currentTime;
          const end = this.bufferedEnd(t);
          if (end - t > AHEAD) break;
          const seg = this.segments.find((s) => s.time + s.duration > end + 0.05);
          if (!seg) {
            this.done = true;
            break;
          }
          this.done = false;
          const data = await YLP.fetchRange(this.fmt.url, seg.start, seg.end, this.player.abort.signal);
          if (this.player.destroyed) break;
          if (this.sb.buffered.length && this.sb.buffered.start(0) < t - BEHIND) {
            await this.remove(0, t - BEHIND / 2);
          }
          try {
            await this.append(data);
          } catch (e) {
            // Probably over quota: drop everything behind the playhead and retry once.
            if (t > 1) await this.remove(0, t - 1);
            await this.append(data);
          }
        }
      } finally {
        this.busy = false;
      }
      this.player.maybeEnd();
    }
  }

  class DashPlayer {
    constructor(video, videoFmt, audioFmt, durationSec, onError) {
      this.video = video;
      this.abort = new AbortController();
      this.destroyed = false;
      this.onError = onError;
      this.tracks = [new Track(this, videoFmt), new Track(this, audioFmt)];
      this.duration = durationSec || +videoFmt.approxDurationMs / 1000;
    }

    async start() {
      const MS = window.MediaSource || window.ManagedMediaSource;
      if (!MS) throw new Error("MediaSource not available");
      this.ms = new MS();
      if (MS !== window.MediaSource) this.video.disableRemotePlayback = true;
      this.video.src = URL.createObjectURL(this.ms);
      await new Promise((r) => this.ms.addEventListener("sourceopen", r, { once: true }));
      this.ms.duration = this.duration;
      await Promise.all(this.tracks.map((t) => t.init(this.ms)));
      this.pump = () => this.tracks.forEach((t) => t.pump().catch((e) => this.fail(e)));
      this.video.addEventListener("seeking", this.pump);
      this.timer = setInterval(this.pump, 500);
      this.pump();
    }

    maybeEnd() {
      if (this.ms?.readyState === "open" && this.tracks.every((t) => t.done && !t.sb.updating)) {
        try {
          this.ms.endOfStream();
        } catch {}
      }
    }

    fail(e) {
      if (this.destroyed || e.name === "AbortError") return;
      this.onError?.(e);
    }

    destroy() {
      this.destroyed = true;
      this.abort.abort();
      clearInterval(this.timer);
      this.video.removeEventListener("seeking", this.pump);
    }
  }

  const supported = (f) => {
    const MS = window.MediaSource || window.ManagedMediaSource;
    return !MS || MS.isTypeSupported(f.mimeType);
  };

  // H.264 video formats MSE can play, best first, one per height.
  function playableVideoFormats(info) {
    const seen = new Set();
    return info.videoFormats.filter((f) => supported(f) && !seen.has(f.height) && seen.add(f.height));
  }

  const playableAudioFormat = (info) => info.audioFormats.find(supported);

  globalThis.YLP = Object.assign(globalThis.YLP || {}, { DashPlayer, playableVideoFormats, playableAudioFormat });
})();
