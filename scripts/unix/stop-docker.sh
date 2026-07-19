#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REMOVE_VOLUMES=0
if [[ "${1:-}" == "--remove-volumes" ]]; then
  REMOVE_VOLUMES=1
elif [[ $# -gt 0 ]]; then
  echo "Unknown option: $1" >&2
  exit 2
fi

cd "$ROOT"
if ((REMOVE_VOLUMES)); then
  docker compose down --volumes
else
  docker compose down
fi
