#!/usr/bin/env python3
"""Build Chrome and Firefox versions of the extension from extension/.

Output: dist/chrome/, dist/firefox/ (load unpacked) and dist/*.zip.
Safari is built separately with scripts/install-safari.sh.
"""
import json
import shutil
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "extension"
DIST = ROOT / "dist"
SHIM = "// Chrome exposes the WebExtension API as chrome.*; alias it to browser.*\nglobalThis.browser ??= globalThis.chrome;\n"
FIREFOX_ID = "yt-local-player@mindingulove.github.io"


def build(target):
    out = DIST / target
    shutil.rmtree(out, ignore_errors=True)
    shutil.copytree(SRC, out)
    shutil.copy(ROOT / "vendor" / "hls.min.js", out / "lib" / "hls.min.js")
    (out / "lib" / "browser-shim.js").write_text(SHIM)

    manifest = json.loads((SRC / "manifest.json").read_text())
    cs = manifest["content_scripts"][0]
    # hls.js is declared by the shared manifest; the API shim must load first.
    cs["js"] = ["lib/browser-shim.js", *cs["js"]]
    if target == "chrome":
        manifest["background"] = {"service_worker": "background.js"}
        manifest["minimum_chrome_version"] = "116"
    else:
        manifest["background"] = {"scripts": ["background.js"]}
        manifest["browser_specific_settings"] = {"gecko": {"id": FIREFOX_ID, "strict_min_version": "128.0"}}
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")

    popup = out / "popup.html"
    popup.write_text(popup.read_text().replace('<script src="popup.js">', '<script src="lib/browser-shim.js"></script>\n<script src="popup.js">'))

    zip_path = DIST / f"yt-local-player-{target}.zip"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
        for f in sorted(out.rglob("*")):
            if f.is_file():
                z.write(f, f.relative_to(out))
    print(f"{target}: {out.relative_to(ROOT)}  ({zip_path.relative_to(ROOT)})")


if __name__ == "__main__":
    DIST.mkdir(exist_ok=True)
    for t in ("chrome", "firefox"):
        build(t)
