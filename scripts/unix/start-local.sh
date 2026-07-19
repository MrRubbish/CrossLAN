#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG_DIR="$ROOT/logs"
PID_FILE="$LOG_DIR/crosslan-node.pid"
STDOUT_LOG="$LOG_DIR/crosslan-node.out.log"
STDERR_LOG="$LOG_DIR/crosslan-node.err.log"
SERVICE_LOG="$LOG_DIR/crosslan-server.log"

PORT="${CROSSLAN_PORT:-${PORT:-6100}}"
SAVE_DIR="${CROSSLAN_SAVE_DIR:-${HOME}/Downloads/CrossLAN}"
RELAY_BUFFER_MB="${CROSSLAN_RELAY_BUFFER_MB:-256}"
ADVERTISED_IP="${CROSSLAN_ADVERTISED_IP:-}"
BUILD=0
BACKGROUND=0

usage() {
  cat <<'EOF'
Usage: bash scripts/unix/start-local.sh [options]

Options:
  --background              Start the Node service in the background.
  --build                   Build the client before starting.
  --port PORT               Service port; default 6100.
  --save-dir PATH           Direct-save directory.
  --relay-buffer-mb MB      Relay memory budget; default 256.
  --advertised-ip IP        LAN address shown to other devices.
  -h, --help                Show this help.
EOF
}

while (($# > 0)); do
  case "$1" in
    --background) BACKGROUND=1 ;;
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

if ! [[ "$PORT" =~ ^[0-9]+$ ]] || ((PORT < 1 || PORT > 65535)); then
  echo "Invalid port: $PORT" >&2
  exit 2
fi
if [[ "$PORT" == "6000" ]]; then
  echo "Warning: Chromium-based browsers block port 6000; use 6100 or another safe port." >&2
fi

mkdir -p "$LOG_DIR"

if [[ -f "$PID_FILE" ]]; then
  existing_pid="$(tr -d '[:space:]' < "$PID_FILE")"
  if [[ "$existing_pid" =~ ^[0-9]+$ ]] && kill -0 "$existing_pid" 2>/dev/null; then
    echo "CrossLAN Node server is already running (PID $existing_pid)."
    echo "URL: http://<PC-LAN-IP>:$PORT"
    exit 0
  fi
  rm -f "$PID_FILE"
fi

if ((BUILD)); then
  (cd "$ROOT" && npm run build)
elif [[ ! -f "$ROOT/client/dist/index.html" ]]; then
  echo "client/dist/index.html is missing. Run with --build first." >&2
  exit 2
fi

export PORT
export CROSSLAN_SAVE_DIR="$SAVE_DIR"
export CROSSLAN_RELAY_BUFFER_MB="$RELAY_BUFFER_MB"
export CROSSLAN_LOG_FILE="$SERVICE_LOG"
if [[ -n "$ADVERTISED_IP" ]]; then
  export CROSSLAN_ADVERTISED_IP="$ADVERTISED_IP"
else
  unset CROSSLAN_ADVERTISED_IP || true
fi

if ((BACKGROUND)); then
  nohup node "$ROOT/server/src/index.js" >> "$STDOUT_LOG" 2>> "$STDERR_LOG" &
  server_pid=$!
  printf '%s\n' "$server_pid" > "$PID_FILE"
  echo "CrossLAN Node server started in the background (PID $server_pid)."
  echo "URL: http://<PC-LAN-IP>:$PORT"
  echo "Logs: $STDOUT_LOG, $STDERR_LOG, $SERVICE_LOG"
  exit 0
fi

exec node "$ROOT/server/src/index.js"
