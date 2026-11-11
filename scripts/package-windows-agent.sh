#!/usr/bin/env bash
# Build the Windows controlled-end zip published as a GitHub release asset.
# The archive layout is:
#   agent/remote-agent.mjs
#   agent/lib/*.mjs
#   agent/windows/{capture-input.ps1,start-agent.bat,stop-agent.bat,README.zh.md,install.ps1}
# (no portable node/, no agent-password.txt -- those are created on the target machine)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$ROOT/dist"
OUT="$OUT_DIR/dsh-remote-desktop-windows.zip"
mkdir -p "$OUT_DIR"
rm -f "$OUT"
cd "$ROOT"
python3 - "$OUT" <<'PY'
import os
import sys
import zipfile

out = sys.argv[1]
skip_dirs = {'node'}
skip_files = {'agent-password.txt', '.demo.pids'}
count = 0
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    for root, dirs, files in os.walk('agent'):
        dirs[:] = sorted(d for d in dirs if d not in skip_dirs)
        for name in sorted(files):
            if name in skip_files or name.endswith('.log'):
                continue
            path = os.path.join(root, name)
            info = zipfile.ZipInfo(path, date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = (os.stat(path).st_mode & 0o777) << 16
            with open(path, 'rb') as fh:
                z.writestr(info, fh.read())
            count += 1
print('wrote %s (%d files, %d bytes)' % (out, count, os.path.getsize(out)))
PY
