#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PORT="${CROSSLAN_PORT:-${PORT:-6100}}"
SAVE_DIR="${CROSSLAN_SAVE_DIR:-${HOME}/Downloads/CrossLAN}"
RELAY_BUFFER_MB="${CROSSLAN_RELAY_BUFFER_MB:-256}"
ADVERTISED_IP="${CROSSLAN_ADVERTISED_IP:-}"
BUILD=0

usage() {
  cat <<'EOF'
Usage: bash scripts/unix/install-autostart.sh [options]

Options:
  --build                   Build the client before installing autostart.
  --port PORT               Service port; default 6100.
  --save-dir PATH           Direct-save directory.
  --relay-buffer-mb MB      Relay memory budget; default 256.
  --advertised-ip IP        LAN address shown to other devices.
  -h, --help                Show this help.
EOF
}

while (($# > 0)); do
  case "$1" in
    --build) BUILD=1 ;;
    --port) PORT="${2:?Missing value for --port}"; shift ;;
    --save-dir) SAVE_DIR="${2:?Missing value for --save-dir}"; shift ;;
    --relay-buffer-mb) RELAY_BUFFER_MB="${2:?Missing value for --relay-buffer-mb}"; shift ;;
    --advertised-ip) ADVERTISED_IP="${2:?Missing value for --advertised-ip}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

if ((BUILD)); then
  (cd "$ROOT" && npm run build)
elif [[ ! -f "$ROOT/client/dist/index.html" ]]; then
  echo "client/dist/index.html is missing. Run with --build first." >&2
  exit 2
fi

NODE_PATH="$(command -v node || true)"
if [[ -z "$NODE_PATH" ]]; then
  echo "Node.js was not found in PATH." >&2
  exit 2
fi

if [[ "$(uname -s)" == "Linux" ]] && command -v systemctl >/dev/null 2>&1; then
  SERVICE_DIR="$HOME/.config/systemd/user"
  SERVICE_FILE="$SERVICE_DIR/crosslan.service"
  mkdir -p "$SERVICE_DIR" "$ROOT/logs"
  systemd_quote() {
    local value="$1"
    value="${value//\\/\\\\}"
    value="${value//\"/\\\"}"
    printf '"%s"' "$value"
  }
  cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=CrossLAN LAN file transfer service
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$(systemd_quote "$ROOT")
ExecStart=$(systemd_quote "$NODE_PATH") $(systemd_quote "$ROOT/server/src/index.js")
Environment=$(systemd_quote "PORT=$PORT")
Environment=$(systemd_quote "CROSSLAN_SAVE_DIR=$SAVE_DIR")
Environment=$(systemd_quote "CROSSLAN_RELAY_BUFFER_MB=$RELAY_BUFFER_MB")
Environment=$(systemd_quote "CROSSLAN_LOG_FILE=$ROOT/logs/crosslan-server.log")
Environment=$(systemd_quote "CROSSLAN_ADVERTISED_IP=$ADVERTISED_IP")
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now crosslan.service
  echo "Installed Linux user service: crosslan.service"
  echo "URL: http://<PC-LAN-IP>:$PORT"
  exit 0
fi

if [[ "$(uname -s)" == "Darwin" ]]; then
  xml_escape() {
    local value="$1"
    value="${value//&/&amp;}"
    value="${value//</&lt;}"
    value="${value//>/&gt;}"
    value="${value//\"/&quot;}"
    value="${value//\'/&apos;}"
    printf '%s' "$value"
  }

  LABEL="com.mrrubbish.crosslan"
  PLIST_DIR="$HOME/Library/LaunchAgents"
  PLIST_FILE="$PLIST_DIR/$LABEL.plist"
  mkdir -p "$PLIST_DIR" "$ROOT/logs"
  launchctl bootout "gui/$(id -u)" "$PLIST_FILE" 2>/dev/null || true
  cat > "$PLIST_FILE" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml_escape "$NODE_PATH")</string>
    <string>$(xml_escape "$ROOT/server/src/index.js")</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$(xml_escape "$ROOT")</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PORT</key><string>$(xml_escape "$PORT")</string>
    <key>CROSSLAN_SAVE_DIR</key><string>$(xml_escape "$SAVE_DIR")</string>
    <key>CROSSLAN_RELAY_BUFFER_MB</key><string>$(xml_escape "$RELAY_BUFFER_MB")</string>
    <key>CROSSLAN_LOG_FILE</key><string>$(xml_escape "$ROOT/logs/crosslan-server.log")</string>
    <key>CROSSLAN_ADVERTISED_IP</key><string>$(xml_escape "$ADVERTISED_IP")</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key>
  <string>$(xml_escape "$ROOT/logs/crosslan-node.out.log")</string>
  <key>StandardErrorPath</key>
  <string>$(xml_escape "$ROOT/logs/crosslan-node.err.log")</string>
</dict>
</plist>
EOF
  launchctl bootstrap "gui/$(id -u)" "$PLIST_FILE"
  echo "Installed macOS LaunchAgent: $LABEL"
  echo "URL: http://<PC-LAN-IP>:$PORT"
  exit 0
fi

echo 'Automatic startup is supported on Linux systemd and macOS launchd.' >&2
exit 2
