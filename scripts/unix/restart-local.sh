#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bash "$SCRIPT_DIR/stop-local.sh"
exec bash "$SCRIPT_DIR/start-local.sh" --background "$@"
