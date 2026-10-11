#!/usr/bin/env python3
"""Local helper for the YT Local Player Safari extension.

Downloads YouTube videos with yt-dlp and serves them (with HTTP Range support)
on 127.0.0.1 so the extension can play them in a plain <video> element.

  GET /prepare?v=<id>   start (or reuse) a download, returns status JSON
  GET /status?v=<id>    status JSON: {state, progress, error}
  GET /video/<id>       the downloaded mp4
"""
import json
import os
import re
import shutil
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

HOST = "127.0.0.1"
PORT = int(os.environ.get("YTLP_PORT", "8765"))
CACHE = Path(os.environ.get("YTLP_CACHE", Path.home() / "Library/Caches/yt-local-player"))
MAX_CACHE_BYTES = int(os.environ.get("YTLP_MAX_CACHE_GB", "10")) * 1024**3
MAX_HEIGHT = os.environ.get("YTLP_MAX_HEIGHT", "1080")
# Prefer H.264/AAC mp4, which Safari plays natively.
FORMAT = (
    f"bv*[vcodec^=avc1][height<={MAX_HEIGHT}]+ba[ext=m4a]"
    f"/b[ext=mp4][height<={MAX_HEIGHT}]/bv*[height<={MAX_HEIGHT}]+ba/b"
)
ALLOWED_ORIGINS = ("https://www.youtube.com", "https://m.youtube.com", "https://youtube.com")
VIDEO_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")
PROGRESS = re.compile(r"\[download\]\s+([\d.]+)%")

YT_DLP = shutil.which("yt-dlp") or "/opt/homebrew/bin/yt-dlp"

jobs = {}  # id -> {"state", "progress", "error", "stage"}
lock = threading.Lock()


def final_path(vid):
    return CACHE / f"{vid}.mp4"


def prune_cache():
    files = sorted(CACHE.glob("*.mp4"), key=lambda p: p.stat().st_atime)
    total = sum(p.stat().st_size for p in files)
    while files and total > MAX_CACHE_BYTES:
        p = files.pop(0)
        total -= p.stat().st_size
        p.unlink(missing_ok=True)


def download(vid):
    cmd = [
        YT_DLP, "--no-playlist", "--newline", "--no-part",
        "-f", FORMAT, "--merge-output-format", "mp4",
        "-o", str(CACHE / f"{vid}.tmp.%(ext)s"),
        f"https://www.youtube.com/watch?v={vid}",
    ]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    stage, last_pct, tail = 0, 0.0, []
    for line in proc.stdout:
        tail = (tail + [line.rstrip()])[-15:]
        m = PROGRESS.search(line)
        if m:
            pct = float(m.group(1))
            if pct < last_pct - 50:  # second stream (audio) started
                stage += 1
            last_pct = pct
            with lock:
                # video stream counts as 90% of the bar, audio as the rest
                jobs[vid]["progress"] = pct * 0.9 if stage == 0 else 90 + pct * 0.1
        elif "[Merger]" in line:
            with lock:
                jobs[vid]["stage"] = "merging"
    proc.wait()
    merged = CACHE / f"{vid}.tmp.mp4"
    with lock:
        if proc.returncode == 0 and merged.exists():
            merged.rename(final_path(vid))
            jobs[vid].update(state="ready", progress=100)
        else:
            jobs[vid].update(state="error", error="\n".join(tail[-5:]) or "yt-dlp failed")
    for leftover in CACHE.glob(f"{vid}.tmp*"):
        leftover.unlink(missing_ok=True)
    prune_cache()


def status(vid):
    if final_path(vid).exists():
        return {"state": "ready", "progress": 100}
    with lock:
        return dict(jobs.get(vid, {"state": "none"}))


def prepare(vid):
    if final_path(vid).exists():
        return status(vid)
    with lock:
        job = jobs.get(vid)
        if not job or job["state"] == "error":
            jobs[vid] = {"state": "downloading", "progress": 0}
            threading.Thread(target=download, args=(vid,), daemon=True).start()
    return status(vid)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def cors(self):
        origin = self.headers.get("Origin", "")
        if origin in ALLOWED_ORIGINS or origin.startswith("safari-web-extension://"):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")

    def send_json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.send_header("Access-Control-Allow-Methods", "GET")
        self.end_headers()

    def do_GET(self):
        url = urlparse(self.path)
        if url.path == "/ping":
            return self.send_json({"ok": True})
        if url.path in ("/prepare", "/status"):
            vid = parse_qs(url.query).get("v", [""])[0]
            if not VIDEO_ID.match(vid):
                return self.send_json({"error": "bad id"}, 400)
            return self.send_json(prepare(vid) if url.path == "/prepare" else status(vid))
        if url.path.startswith("/video/"):
            vid = url.path[len("/video/"):]
            if VIDEO_ID.match(vid) and final_path(vid).exists():
                return self.serve_file(final_path(vid))
        self.send_json({"error": "not found"}, 404)

    def serve_file(self, path):
        size = path.stat().st_size
        os.utime(path)  # keep recently watched files out of pruning
        start, end = 0, size - 1
        rng = re.match(r"bytes=(\d*)-(\d*)", self.headers.get("Range", ""))
        if rng:
            if rng.group(1):
                start = int(rng.group(1))
                if rng.group(2):
                    end = min(int(rng.group(2)), size - 1)
            elif rng.group(2):  # suffix range: last N bytes
                start = max(0, size - int(rng.group(2)))
            if start > end:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.end_headers()
                return
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        else:
            self.send_response(200)
        length = end - start + 1
        self.cors()
        self.send_header("Content-Type", "video/mp4")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        self.end_headers()
        try:
            with open(path, "rb") as f:
                f.seek(start)
                while length > 0:
                    chunk = f.read(min(1 << 20, length))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    length -= len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass


if __name__ == "__main__":
    CACHE.mkdir(parents=True, exist_ok=True)
    for stale in CACHE.glob("*.tmp*"):
        stale.unlink(missing_ok=True)
    print(f"yt-local-player helper on http://{HOST}:{PORT}  cache={CACHE}  yt-dlp={YT_DLP}")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
