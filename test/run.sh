#!/usr/bin/env bash
# Run the remote-desktop end-to-end suite.
#
# Cases 01-22 exercise the real Linux/X11 stack (Xvfb + xterm/xev + Agent).
# Cases 23+ exercise the Windows (win32) platform backend on Linux through the
# fake helper test/fixtures/fake-win-helper.mjs (spawned with RDA_HELPER_CMD);
# they do not need Xvfb or Windows, only Node.
#
# Static checks for the Windows artifacts (PowerShell parse + inline C# compile)
# are optional and run separately:  node test/static-checks.mjs
#
# Extra arguments are forwarded to test/e2e.mjs. Useful environment variables:
#   PORT      preferred Agent port (the suite also skips occupied ports)
#   DISPLAY   preferred X display (default :99; an occupied display is skipped)
#   VERBOSE=1 print extra diagnostics
#   KEEP_ARTIFACTS=1 keep the temp dir
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${REPO_DIR}"

if [[ ! -f test/e2e.mjs ]]; then
  echo "test/e2e.mjs is missing" >&2
  exit 2
fi

exec node test/e2e.mjs "$@"
