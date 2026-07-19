#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PORT="${CROSSLAN_PORT:-${PORT:-6100}}"
RELAY_BUFFER_MB="${CROSSLAN_RELAY_BUFFER_MB:-256}"
ADVERTISED_IP="${CROSSLAN_ADVERTISED_IP:-}"

usage() {
  cat <<'EOF'
Usage: bash scripts/unix/start-docker.sh [options]

Options:
  --port PORT               Host and container service port; default 6100.
  --relay-buffer-mb MB      Relay memory budget; default 256.
  --advertised-ip IP        LAN address shown to other devices.
  --foreground              Keep Docker Compose attached.
  -h, --help                Show this help.
EOF
}

FOREGROUND=0
while (($# > 0)); do
  case "$1" in
    --port) PORT="${2:?Missing value for --port}"; shift ;;
    --relay-buffer-mb) RELAY_BUFFER_MB="${2:?Missing value for --relay-buffer-mb}"; shift ;;
    --advertised-ip) ADVERTISED_IP="${2:?Missing value for --advertised-ip}"; shift ;;
    --foreground) FOREGROUND=1 ;;
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

export PORT
export CROSSLAN_RELAY_BUFFER_MB="$RELAY_BUFFER_MB"
if [[ -n "$ADVERTISED_IP" ]]; then
  export CROSSLAN_ADVERTISED_IP="$ADVERTISED_IP"
else
  unset CROSSLAN_ADVERTISED_IP || true
fi

cd "$ROOT"
if ((FOREGROUND)); then
  docker compose up --build
else
  docker compose up -d --build
  echo "CrossLAN Docker service started in the background."
  echo "URL: http://<PC-LAN-IP>:$PORT"
fi
