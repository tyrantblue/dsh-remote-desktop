#!/usr/bin/env bash
# Stop the local demo host started by scripts/demo-serve.sh (Linux: validates each
# recorded PID against its command line before killing, so a recycled PID can never
# take down an unrelated process).
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PIDS="$ROOT/demo/.demo.pids"
XDISPLAY="${XDISPLAY:-:97}"

cmdline_of() {
  [ -r "/proc/$1/cmdline" ] || return 1
  tr '\0' ' ' < "/proc/$1/cmdline" 2>/dev/null
}

kill_recorded() {
  role="$1"; pid="$2"; marker="$3"
  [ -n "$pid" ] || return 0
  cmd="$(cmdline_of "$pid")" || return 0
  case "$cmd" in
    *"$marker"*) kill "$pid" 2>/dev/null || true ;;
  esac
}

if [ -f "$PIDS" ]; then
  # children first: agent, xterm, then the X server
  while IFS=: read -r role pid; do
    case "$role" in
      agent) kill_recorded "$role" "$pid" "remote-agent.mjs" ;;
      xterm) kill_recorded "$role" "$pid" "Remote demo host" ;;
      xvfb)  kill_recorded "$role" "$pid" "Xvfb $XDISPLAY" ;;
    esac
  done < <(tac "$PIDS")
  rm -f "$PIDS"
fi

sleep 0.3
# Fallbacks for a lost pid file or a partially started run. Patterns are safe
# inside this script: its own command line is just "bash demo-stop.sh".
pkill -f "remote-agent\\.mjs --port 38080 --bind 127\\.0\\.0\\.1 .*--display $XDISPLAY" 2>/dev/null || true
pkill -f "xterm .*Remote demo host" 2>/dev/null || true
pkill -f "Xvfb $XDISPLAY " 2>/dev/null || true
sleep 0.3
rm -f "/tmp/.X${XDISPLAY#:}-lock" "/tmp/.X11-unix/X${XDISPLAY#:}" 2>/dev/null || true
echo "demo host stopped"
