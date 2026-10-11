#!/bin/sh
# Runs the helper at login (and keeps it running) via launchd.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
PLIST="$HOME/Library/LaunchAgents/io.github.ytlocalplayer.helper.plist"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>io.github.ytlocalplayer.helper</string>
  <key>ProgramArguments</key><array>
    <string>$(command -v python3)</string><string>$DIR/server.py</string>
  </array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/yt-local-player.log</string>
</dict></plist>
PLIST
launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Helper installed and running on http://127.0.0.1:8765"
