#!/usr/bin/env bash
# Stop the local demo host started by scripts/demo-serve.sh.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PIDS="$ROOT/demo/.demo.pids"
if [ -f "$PIDS" ]; then
  # PIDs are recorded in start order: Xvfb, xterm, agent. Kill children first.
  tac "$PIDS" 2>/dev/null | while read -r pid; do
    [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  done
  rm -f "$PIDS"
fi
rm -f /tmp/.X97-lock /tmp/.X11-unix/X97 2>/dev/null || true
echo "demo host stopped"
