#!/usr/bin/env bash
# One-command demo: real Xvfb + real xterm/bash + real agent + real protocol
# client, ending in a genuine remote-screen capture at demo/screenshot.png.
#
# Extra arguments are forwarded to demo/demo.mjs. Environment variables:
#   DISPLAY / E2E_DISPLAY  preferred X display (occupied displays are skipped)
#   PORT                   preferred agent port (occupied ports are skipped)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${REPO_DIR}"

if [[ ! -f demo/demo.mjs ]]; then
  echo "demo/demo.mjs is missing" >&2
  exit 2
fi

exec node demo/demo.mjs "$@"
