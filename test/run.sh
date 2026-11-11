#!/usr/bin/env bash
# Run the remote-desktop end-to-end suite.
#
# Extra arguments are forwarded to test/e2e.mjs. Useful environment variables:
#   PORT      preferred Agent port (the suite also skips occupied ports)
#   DISPLAY   preferred X display (default :99; an occupied display is skipped)
#   VERBOSE=1 print extra diagnostics
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${REPO_DIR}"

if [[ ! -f test/e2e.mjs ]]; then
  echo "test/e2e.mjs is missing" >&2
  exit 2
fi

exec node test/e2e.mjs "$@"
