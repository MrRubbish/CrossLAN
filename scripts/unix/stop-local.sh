#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PID_FILE="$ROOT/logs/crosslan-node.pid"

if [[ ! -f "$PID_FILE" ]]; then
  echo "CrossLAN Node server is not running."
  exit 0
fi

server_pid="$(tr -d '[:space:]' < "$PID_FILE")"
if ! [[ "$server_pid" =~ ^[0-9]+$ ]]; then
  rm -f "$PID_FILE"
  echo "Removed stale CrossLAN PID file."
  exit 0
fi

if ! kill -0 "$server_pid" 2>/dev/null; then
  rm -f "$PID_FILE"
  echo "CrossLAN Node server is not running; removed stale PID file."
  exit 0
fi

kill "$server_pid"
for _ in {1..50}; do
  if ! kill -0 "$server_pid" 2>/dev/null; then
    rm -f "$PID_FILE"
    echo "Stopped CrossLAN Node server (PID $server_pid)."
    exit 0
  fi
  sleep 0.1
done

kill -9 "$server_pid" 2>/dev/null || true
rm -f "$PID_FILE"
echo "Stopped CrossLAN Node server (PID $server_pid)."
