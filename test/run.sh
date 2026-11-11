#!/usr/bin/env bash
# Run the complete remote-desktop end-to-end suite.
#
# Part 1 — test/e2e.mjs (cases 01-22 real Linux/X11 stack: Xvfb + xterm/xev +
#          Agent; cases 23-27 Windows/win32 backend via the fake helper
#          test/fixtures/fake-win-helper.mjs, no Windows needed).
# Part 2 — test/relay.mjs (cross-NAT relay: a plain node:http server mounting
#          plugin/relay-host.mjs RelayHub, a real Agent connected with
#          `--relay ws://127.0.0.1:<port> --relay-code TESTCODE`, and the
#          browser side going only through the relay paths).
#
# Both suites print per-case PASS/FAIL plus a summary and exit non-zero on
# failure; this script runs both and returns non-zero if either failed.
# Static checks for the Windows artifacts are optional and run separately:
#   node test/static-checks.mjs
#
# Extra arguments are forwarded to test/e2e.mjs (and to test/relay.mjs, which
# accepts --keep-artifacts/--verbose). Useful environment variables:
#   PORT             preferred Agent port (both suites skip occupied ports)
#   DISPLAY          preferred X display (default :99; occupied ones are skipped)
#   E2E_DISPLAY      explicit display preference for both suites
#   VERBOSE=1        print extra diagnostics
#   KEEP_ARTIFACTS=1 keep the temp dirs of both suites
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${REPO_DIR}"

if [[ ! -f test/e2e.mjs ]]; then
  echo "test/e2e.mjs is missing" >&2
  exit 2
fi
if [[ ! -f test/relay.mjs ]]; then
  echo "test/relay.mjs is missing" >&2
  exit 2
fi

status=0

echo "===== remote-desktop E2E (test/e2e.mjs) ====="
node test/e2e.mjs "$@" || status=$?

echo
echo "===== cross-NAT relay E2E (test/relay.mjs) ====="
node test/relay.mjs "$@" || status=$?

exit "${status}"
