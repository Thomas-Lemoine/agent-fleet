#!/bin/bash
# Link agent-fleet's tools into a PATH dir (default ~/.local/bin). Idempotent: re-run after adding
# tools; `git pull` updates the linked files in place.
#   install.sh [--router] [--prefix DIR]
# --router also links the codex router, which shadows the real `codex` (it must come first on PATH).
set -euo pipefail
here="$(cd "$(dirname "$(realpath "$0")")" && pwd)"
prefix="$HOME/.local/bin" router=0
while [ $# -gt 0 ]; do
  case "$1" in
    --router) router=1 ;;
    --prefix) prefix="$2"; shift ;;
    *) echo "usage: install.sh [--router] [--prefix DIR]" >&2; exit 2 ;;
  esac
  shift
done
mkdir -p "$prefix"
for f in "$here"/bin/*; do
  [ -f "$f" ] || continue                     # bin/__pycache__
  name="$(basename "$f")"
  [ "$name" = pool_status.py ] && continue  # a library the pools import, not a command
  [ "$name" = codex ] && [ $router = 0 ] && continue
  dst="$prefix/$name"
  if [ "$(readlink "$dst" 2>/dev/null)" = "$f" ]; then
    echo "ok      $dst"
    continue
  fi
  # Swapped in by rename, so a running pool or lane never finds the path missing.
  ln -sfn "$f" "$dst.agent-fleet-tmp"
  mv -f "$dst.agent-fleet-tmp" "$dst"
  echo "link    $dst -> $f"
done
case ":$PATH:" in *":$prefix:"*) ;; *) echo "note: $prefix is not on PATH" ;; esac
