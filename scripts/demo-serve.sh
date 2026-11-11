#!/usr/bin/env bash
# Start a local, loopback-only demo remote host for the Harness "Remote desktop" panel.
#
#   bash scripts/demo-serve.sh            # Xvfb :97 + xterm + agent on 127.0.0.1:38080
#   PASSWORD=... PORT=... bash scripts/demo-serve.sh
#   bash scripts/demo-stop.sh             # stop everything this script started
#
# The agent is bound to 127.0.0.1 only, so it is reachable from a browser running on
# this machine (add host `127.0.0.1:38080`, password `demo-pass`). Never expose this
# demo agent on a public interface.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-38080}"
XDISPLAY="${XDISPLAY:-:97}"
PASSWORD="${PASSWORD:-demo-pass}"
SANDBOX="${SANDBOX:-$ROOT/demo/sandbox}"
PIDS="$ROOT/demo/.demo.pids"

mkdir -p "$SANDBOX"
if [ ! -f "$SANDBOX/welcome.txt" ]; then
  cat > "$SANDBOX/welcome.txt" <<'TXT'
This directory is the file-transfer sandbox of the demo agent.
Use the file drawer in the remote desktop panel to browse, download and upload files here.
TXT
  mkdir -p "$SANDBOX/reports"
  printf 'date,visitors,signups\n2026-11-01,120,7\n2026-11-02,143,11\n' > "$SANDBOX/reports/daily.csv"
fi

bash "$ROOT/scripts/demo-stop.sh" >/dev/null 2>&1 || true

# 1. A private X server (1280x800) -- -noreset keeps the root colour across client changes.
if [ -e "/tmp/.X${XDISPLAY#:}-lock" ]; then
  echo "display $XDISPLAY is already in use; set XDISPLAY=:9x to pick another" >&2
  exit 1
fi
Xvfb "$XDISPLAY" -screen 0 1280x800x24 -nolisten tcp -noreset >/tmp/rd-demo-xvfb.log 2>&1 &
echo "$!" > "$PIDS"
sleep 1
DISPLAY="$XDISPLAY" xsetroot -solid '#1b2430'

# 2. A real desktop program to control: xterm running an interactive bash in the sandbox.
DISPLAY="$XDISPLAY" xterm -geometry 104x30+40+40 -fa 'DejaVu Sans Mono' -fs 12 \
  -bg '#101820' -fg '#e6edf3' -T 'Remote demo host' \
  -e bash -lc "cd '$SANDBOX' && echo 'Remote demo host -- controlled through the DSH remote desktop panel.' && exec bash --noprofile --norc" \
  >/tmp/rd-demo-xterm.log 2>&1 &
echo "$!" >> "$PIDS"

# Xvfb runs without a window manager, so nothing assigns keyboard focus on a click.
# Focus the demo window explicitly when xdotool is available (real desktops do this
# through their window manager).
if command -v xdotool >/dev/null 2>&1; then
  for _ in $(seq 1 30); do
    WID=$(DISPLAY="$XDISPLAY" xdotool search --name 'Remote demo host' 2>/dev/null | head -1 || true)
    [ -n "${WID:-}" ] && break
    sleep 0.1
  done
  if [ -n "${WID:-}" ]; then DISPLAY="$XDISPLAY" xdotool windowfocus "$WID" 2>/dev/null || true; fi
fi

# 3. The agent itself.
cd "$ROOT"
node agent/remote-agent.mjs --port "$PORT" --bind 127.0.0.1 \
  --password "$PASSWORD" --display "$XDISPLAY" --fs-root "$SANDBOX" \
  >/tmp/rd-demo-agent.log 2>&1 &
echo "$!" >> "$PIDS"

for _ in $(seq 1 50); do
  if curl -s --noproxy '*' -m 1 "http://127.0.0.1:$PORT/health" | grep -q '"ok":true'; then break; fi
  sleep 0.2
done

echo "remote desktop demo host is up"
echo "  panel host: 127.0.0.1:$PORT"
echo "  password:   $PASSWORD"
echo "  display:    $XDISPLAY (1280x800, xterm + bash)"
echo "  fs root:    $SANDBOX"
echo "  logs:       /tmp/rd-demo-agent.log  /tmp/rd-demo-xvfb.log"
echo "  stop:       bash scripts/demo-stop.sh"
