// Fragmented-MP4 helpers for YouTube's DASH streams: segment index (sidx)
// parsing, chunked downloading, and muxing a video-only + audio-only file
// into a single playable mp4 without re-encoding.
(() => {
  const CHUNK = 10 * 1024 * 1024; // googlevideo serves up to ~10MB per request

  const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  const u64 = (b, o) => u32(b, o) * 2 ** 32 + u32(b, o + 4);
  const setU32 = (b, o, v) => {
    b[o] = v >>> 24;
    b[o + 1] = (v >>> 16) & 255;
    b[o + 2] = (v >>> 8) & 255;
    b[o + 3] = v & 255;
  };
  const type = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

  // Iterate the boxes in b[start, end): yields {type, start, end, body}.
  function* boxes(b, start = 0, end = b.length) {
    let o = start;
    while (o + 8 <= end) {
      let size = u32(b, o);
      let header = 8;
      if (size === 1) {
        size = u64(b, o + 8);
        header = 16;
      } else if (size === 0) {
        size = end - o;
      }
      if (size < header || o + size > end) break;
      yield { type: type(b, o + 4), start: o, end: o + size, body: o + header };
      o += size;
    }
  }
  const child = (b, box, t) => {
    for (const c of boxes(b, box.body, box.end)) if (c.type === t) return c;
    return null;
  };

  // sidx -> [{start, end, time, duration}] with byte offsets into the file
  // and times in seconds.
  function parseSidx(b, fileOffsetOfB = 0) {
    for (const box of boxes(b)) {
      if (box.type !== "sidx") continue;
      let o = box.body;
      const version = b[o];
      o += 4 + 4; // version/flags, reference_ID
      const timescale = u32(b, o);
      o += 4;
      let time, first;
      if (version === 0) {
        time = u32(b, o);
        first = u32(b, o + 4);
        o += 8;
      } else {
        time = u64(b, o);
        first = u64(b, o + 8);
        o += 16;
      }
      o += 2; // reserved
      const count = (b[o] << 8) | b[o + 1];
      o += 2;
      let offset = fileOffsetOfB + box.end + first;
      const segments = [];
      for (let i = 0; i < count; i++, o += 12) {
        const size = u32(b, o) & 0x7fffffff;
        const dur = u32(b, o + 4);
        segments.push({ start: offset, end: offset + size - 1, time: time / timescale, duration: dur / timescale });
        offset += size;
        time += dur;
      }
      return segments;
    }
    throw new Error("no sidx box found");
  }

  // Safari reports some googlevideo hiccups as "Load failed"; retry those.
  async function fetchRange(url, start, end, signal) {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(`${url}&range=${start}-${end}`, { signal, credentials: "omit" });
        if (!res.ok) throw new Error(`stream request failed (HTTP ${res.status})`);
        return new Uint8Array(await res.arrayBuffer());
      } catch (e) {
        if (e.name === "AbortError" || attempt >= 2) throw e;
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      }
    }
  }

  // Downloads a whole format in chunks; onBytes(n) is called as data arrives.
  async function downloadFormat(fmt, onBytes, signal) {
    const total = +fmt.contentLength;
    const parts = [];
    for (let start = 0; start < total; start += CHUNK) {
      const part = await fetchRange(fmt.url, start, Math.min(start + CHUNK, total) - 1, signal);
      parts.push(part);
      onBytes(part.length);
    }
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }

  function setTrackId(b, trak, id) {
    const tkhd = child(b, trak, "tkhd");
    setU32(b, tkhd.body + 4 + (b[tkhd.body] === 1 ? 16 : 8), id);
  }

  // Fragments: [{moof, mdat, time}] where time is in seconds (from tfdt).
  function fragments(b, timescale) {
    const out = [];
    let moof = null;
    for (const box of boxes(b)) {
      if (box.type === "moof") moof = box;
      else if (box.type === "mdat" && moof) {
        const traf = child(b, moof, "traf");
        const tfhd = child(b, traf, "tfhd");
        if (u32(b, tfhd.body) & 0x000001) throw new Error("absolute base-data-offset not supported");
        const tfdt = child(b, traf, "tfdt");
        const t = tfdt ? (b[tfdt.body] === 1 ? u64(b, tfdt.body + 4) : u32(b, tfdt.body + 4)) : 0;
        out.push({ moof, mdat: box, traf, tfhd, time: t / timescale });
        moof = null;
      }
    }
    return out;
  }

  function trackTimescale(b, moov) {
    const mdhd = child(b, child(b, child(b, moov, "trak"), "mdia"), "mdhd");
    return u32(b, mdhd.body + 4 + (b[mdhd.body] === 1 ? 16 : 8));
  }

  const box = (t, ...parts) => {
    const size = 8 + parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(size);
    setU32(out, 0, size);
    for (let i = 0; i < 4; i++) out[4 + i] = t.charCodeAt(i);
    let o = 8;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  };

  // Combine a video-only and an audio-only fragmented mp4 into one file.
  // Returns an array of Uint8Array parts (pass straight to new Blob()).
  function mux(v, a) {
    const top = (b) => Object.fromEntries([...boxes(b)].filter((x) => x.type !== "moof" && x.type !== "mdat").map((x) => [x.type, x]));
    const vt = top(v);
    const at = top(a);
    if (!vt.moov || !at.moov) throw new Error("missing moov box");

    const vTrak = child(v, vt.moov, "trak");
    const aTrak = child(a, at.moov, "trak");
    const vTrex = child(v, child(v, vt.moov, "mvex"), "trex");
    const aTrex = child(a, child(a, at.moov, "mvex"), "trex");
    const vMehd = child(v, child(v, vt.moov, "mvex"), "mehd");

    const vTrakB = v.slice(vTrak.start, vTrak.end);
    const aTrakB = a.slice(aTrak.start, aTrak.end);
    setTrackId(vTrakB, [...boxes(vTrakB)][0], 1);
    setTrackId(aTrakB, [...boxes(aTrakB)][0], 2);
    const vTrexB = v.slice(vTrex.start, vTrex.end);
    const aTrexB = a.slice(aTrex.start, aTrex.end);
    setU32(vTrexB, 12, 1);
    setU32(aTrexB, 12, 2);

    const mvhd = child(v, vt.moov, "mvhd");
    const mvhdB = v.slice(mvhd.start, mvhd.end);
    setU32(mvhdB, mvhdB.length - 4, 3); // next_track_ID

    const mvex = box("mvex", ...(vMehd ? [v.slice(vMehd.start, vMehd.end)] : []), vTrexB, aTrexB);
    const moov = box("moov", mvhdB, vTrakB, aTrakB, mvex);
    const ftyp = v.slice(vt.ftyp.start, vt.ftyp.end);

    const vFrags = fragments(v, trackTimescale(v, vt.moov)).map((f) => ({ ...f, b: v, track: 1 }));
    const aFrags = fragments(a, trackTimescale(a, at.moov)).map((f) => ({ ...f, b: a, track: 2 }));
    const all = [...vFrags, ...aFrags].sort((x, y) => x.time - y.time || x.track - y.track);

    const parts = [ftyp, moov];
    let seq = 1;
    for (const f of all) {
      const moofB = f.b.slice(f.moof.start, f.moof.end);
      const off = f.moof.start;
      const mfhd = child(f.b, f.moof, "mfhd");
      setU32(moofB, mfhd.body - off + 4, seq++);
      setU32(moofB, f.tfhd.body - off + 4, f.track);
      parts.push(moofB, f.b.subarray(f.mdat.start, f.mdat.end));
    }
    return parts;
  }

  globalThis.YLP = Object.assign(globalThis.YLP || {}, { parseSidx, fetchRange, downloadFormat, mux });
})();
