#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
KEEP_DESKTOP_TARGET=0
if [[ "${1:-}" == "--keep-desktop-target" ]]; then
  KEEP_DESKTOP_TARGET=1
elif [[ $# -gt 0 ]]; then
  echo "Unknown option: $1" >&2
  exit 2
fi

targets=(
  "$ROOT/client/dist"
  "$ROOT/desktop/dist"
  "$ROOT/.pkg-cache"
)
if ((KEEP_DESKTOP_TARGET == 0)); then
  targets+=("$ROOT/desktop/src-tauri/target")
fi

for target in "${targets[@]}"; do
  case "$target" in
    "$ROOT"/*) ;;
    *) echo "Refusing to clean a path outside the workspace: $target" >&2; exit 1 ;;
  esac
  if [[ -e "$target" ]]; then
    rm -rf -- "$target"
    echo "Removed ${target#"$ROOT"/}"
  fi
done

SIDECAR_DIR="$ROOT/desktop/src-tauri/binaries"
case "$SIDECAR_DIR" in
  "$ROOT"/*) ;;
  *) echo "Refusing to clean a path outside the workspace: $SIDECAR_DIR" >&2; exit 1 ;;
esac
if [[ -d "$SIDECAR_DIR" ]]; then
  find "$SIDECAR_DIR" -maxdepth 1 -type f -name '*.exe' -delete
  echo 'Removed generated desktop sidecar executables'
fi

echo 'Generated build artifacts cleaned. Source files and the installer were not changed.'
