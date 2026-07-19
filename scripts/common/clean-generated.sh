#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [[ $# -gt 0 ]]; then
  echo "Unknown option: $1" >&2
  exit 2
fi

targets=(
  "$ROOT/client/dist"
)

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

echo 'Generated web build artifacts cleaned. Source files were not changed.'
