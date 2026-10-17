#!/bin/bash
# Build the signed Safari app with your Local.xcconfig, install it to /Applications and
# launch it once so Safari registers the extension.
set -eo pipefail   # a failed build must not get installed
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cp "$ROOT/vendor/hls.min.js" "$ROOT/extension/lib/hls.min.js"
cd "$ROOT/YT Local Player"
[ -f "$ROOT/Local.xcconfig" ] || { echo "Create Local.xcconfig first (see Local.xcconfig.example)"; exit 1; }
xcodebuild -scheme "YT Local Player" -configuration Release -derivedDataPath build \
  -xcconfig "$ROOT/Local.xcconfig" -allowProvisioningUpdates build | grep -E "error:|BUILD"
ditto "build/Build/Products/Release/YT Local Player.app" "/Applications/YT Local Player.app"
rm -rf build/Build/Products   # one registered copy only, or Safari lists the extension twice
open "/Applications/YT Local Player.app"
