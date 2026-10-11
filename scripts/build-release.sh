#!/bin/bash
# Build release downloads into dist/release/:
#   yt-local-player-chrome.zip, yt-local-player-firefox.zip, YT-Local-Player-Safari.zip
# The Safari app is ad-hoc signed with a neutral bundle id (no personal team), so it
# carries no personal details; users enable "Allow unsigned extensions" in Safari.
set -eo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/dist/release"
BUNDLE_PREFIX="${BUNDLE_PREFIX:-io.github.mindingulove}"
rm -rf "$OUT" && mkdir -p "$OUT"

python3 "$ROOT/scripts/build-browsers.py"
cp "$ROOT/dist/yt-local-player-chrome.zip" "$ROOT/dist/yt-local-player-firefox.zip" "$OUT/"

DERIVED="$(mktemp -d)"
trap 'rm -rf "$DERIVED"' EXIT
cd "$ROOT/YT Local Player"
# Relative source paths (no /Users/<you>/... baked into the binaries).
xcodebuild -scheme "YT Local Player" -configuration Release -derivedDataPath "$DERIVED" \
  BUNDLE_ID_PREFIX="$BUNDLE_PREFIX" DEVELOPMENT_TEAM="" CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY="-" \
  OTHER_SWIFT_FLAGS="-file-prefix-map $ROOT=. -file-prefix-map $DERIVED=build" \
  OTHER_CFLAGS="-ffile-prefix-map=$ROOT=. -ffile-prefix-map=$DERIVED=build" \
  DEBUG_INFORMATION_FORMAT=dwarf-with-dsym \
  build | grep -E "error:|BUILD"
APP="$DERIVED/Build/Products/Release/YT Local Player.app"

# Strip debug symbols (they record build paths), then re-apply the ad-hoc signature.
strip -S -x "$APP/Contents/MacOS/YT Local Player" \
  "$APP/Contents/PlugIns/YT Local Player Extension.appex/Contents/MacOS/YT Local Player Extension"
codesign --force --deep --sign - "$APP"

# Refuse to ship anything that still names this machine's user or home folder.
if grep -rlaF -e "$HOME" -e "$(id -un)" "$APP" >/dev/null; then
  echo "error: personal paths still present in:"; grep -rlaF -e "$HOME" -e "$(id -un)" "$APP"; exit 1
fi
ditto -c -k --keepParent "$APP" "$OUT/YT-Local-Player-Safari.zip"
# Don't leave this copy registered, or Safari lists the extension twice.
LSR=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
pluginkit -r "$APP/Contents/PlugIns/YT Local Player Extension.appex" 2>/dev/null || true
"$LSR" -u "$APP" 2>/dev/null || true

cd "$OUT" && shasum -a 256 *.zip > SHA256SUMS.txt
ls -lh "$OUT"
