#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

if [[ "$(uname -s)" == "Linux" ]] && command -v systemctl >/dev/null 2>&1; then
  systemctl --user disable --now crosslan.service 2>/dev/null || true
  rm -f "$HOME/.config/systemd/user/crosslan.service"
  systemctl --user daemon-reload
  echo 'Removed Linux CrossLAN user service.'
  exit 0
fi

if [[ "$(uname -s)" == "Darwin" ]]; then
  PLIST_FILE="$HOME/Library/LaunchAgents/com.mrrubbish.crosslan.plist"
  launchctl bootout "gui/$(id -u)" "$PLIST_FILE" 2>/dev/null || true
  rm -f "$PLIST_FILE"
  echo 'Removed macOS CrossLAN LaunchAgent.'
  exit 0
fi

echo 'No CrossLAN autostart registration found for this platform.'
