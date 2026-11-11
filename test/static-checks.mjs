#!/usr/bin/env node
/**
 * Optional static validation for the Windows controlled-end artifacts.
 *
 * These checks do NOT replace the Windows runtime validation (which can only be
 * done on a real Windows machine); they catch syntax/compile errors early on
 * Linux:
 *
 *   1. the committed JPEG fixture is a structurally valid 800x600 JPEG
 *      (and, when Python/Pillow is present, decodes to 800x600);
 *   2. `agent/windows/capture-input.ps1` parses with the real PowerShell 7
 *      parser (`/opt/pwsh/pwsh`);
 *   3. the inline C# from the helper compiles with Mono `mcs`
 *      (`-target:library -r:System.Drawing.dll -r:System.Windows.Forms.dll`).
 *
 * Missing artifacts or missing tools produce an explicit SKIP line (a SKIP is
 * NOT a PASS) so nobody mistakes "not checked" for "verified". Real failures
 * exit with a non-zero code.
 *
 * Usage:
 *   node test/static-checks.mjs
 *   PWSH=/path/to/pwsh MCS=mcs node test/static-checks.mjs
 *
 * C# extraction: the helper may expose either
 *   pwsh -File agent/windows/capture-input.ps1 --dump-csharp <file>
 * or the environment variable DS_REMOTE_DUMP_CSHARP=<file>.
 * A standalone agent/windows/*.cs file or RDA_WIN_HELPER_CSHARP_PATH is used
 * when present. If none of those exist, the compile check is SKIPped.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { parseJpeg, looksLikeJpeg } from './lib/jpeg.mjs';

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JPEG_FIXTURE = path.join(REPO_DIR, 'test', 'fixtures', 'fake-800x600.jpg');
const PS_HELPER = path.join(REPO_DIR, 'agent', 'windows', 'capture-input.ps1');
const WINDOWS_DIR = path.join(REPO_DIR, 'agent', 'windows');
const PWSH = process.env.PWSH || '/opt/pwsh/pwsh';
const MCS = process.env.MCS || 'mcs';

const results = [];
function record(status, name, detail = '') {
  results.push({ status, name, detail });
  const suffix = detail ? ` — ${String(detail).replace(/\s*\n\s*/g, ' | ')}` : '';
  console.log(`${status.padEnd(4)} ${name}${suffix}`);
}

function toolVersion(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 20000 });
  if (result.error) return { ok: false, error: result.error.message };
  const text = `${result.stdout || ''}${result.stderr || ''}`.trim().split('\n')[0];
  return { ok: result.status === 0, version: text, status: result.status };
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rdtest-static-'));
  try {
    console.log('Windows controlled-end static checks');
    console.log(`repo: ${REPO_DIR}`);
    console.log('');

    // ---- 1. JPEG fixture --------------------------------------------------
    if (!fs.existsSync(JPEG_FIXTURE)) {
      record('FAIL', 'JPEG fixture exists', `missing ${JPEG_FIXTURE}`);
    } else {
      const bytes = fs.readFileSync(JPEG_FIXTURE);
      const info = parseJpeg(bytes);
      if (!info.valid) {
        record('FAIL', 'JPEG fixture is structurally valid', JSON.stringify(info));
      } else if (!looksLikeJpeg(bytes)) {
        record('FAIL', 'JPEG fixture starts FFD8 / ends FFD9', `size=${bytes.length}`);
      } else if (info.width !== 800 || info.height !== 600) {
        record('FAIL', 'JPEG fixture is 800x600', `${info.width}x${info.height}`);
      } else {
        record(
          'PASS',
          `JPEG fixture valid (${info.format} ${info.width}x${info.height}, ${bytes.length} bytes)`,
        );
      }

      // Independent decode with Python/Pillow when available (optional).
      const py = spawnSync(
        'python3',
        [
          '-c',
          'from PIL import Image; im=Image.open(__import__("sys").argv[1]); im.load(); print(im.size, im.mode)',
          JPEG_FIXTURE,
        ],
        { encoding: 'utf8', timeout: 20000 },
      );
      if (py.error || py.status !== 0) {
        record(
          'SKIP',
          'JPEG fixture decodes with Python/Pillow',
          py.error ? py.error.message : (py.stderr || '').trim().split('\n')[0],
        );
      } else {
        record('PASS', `JPEG fixture decodes with Python/Pillow (${py.stdout.trim()})`);
      }
    }

    // ---- 2. PowerShell syntax --------------------------------------------
    if (!fs.existsSync(PS_HELPER)) {
      record('SKIP', 'capture-input.ps1 parses with pwsh', `missing ${PS_HELPER} (win32-helper not delivered yet)`);
    } else if (!fs.existsSync(PWSH)) {
      record('SKIP', 'capture-input.ps1 parses with pwsh', `pwsh not available at ${PWSH}`);
    } else {
      const psPath = PS_HELPER.replace(/'/g, "''");
      const command =
        `$tokens=$null; $errors=$null; ` +
        `[System.Management.Automation.Language.Parser]::ParseFile('${psPath}',[ref]$tokens,[ref]$errors) | Out-Null; ` +
        `if ($errors.Count -gt 0) { foreach ($e in $errors) { [Console]::Error.WriteLine($e.Message) }; exit 1 }; exit 0`;
      const result = spawnSync(
        PWSH,
        ['-NoProfile', '-NonInteractive', '-Command', command],
        { encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      const detail = `${(result.stdout || '').trim()} ${(result.stderr || '').trim()}`.trim();
      if (result.error) {
        record('SKIP', 'capture-input.ps1 parses with pwsh', `pwsh failed to run: ${result.error.message}`);
      } else if (result.status !== 0) {
        record('FAIL', 'capture-input.ps1 parses with pwsh', detail || `exit ${result.status}`);
      } else {
        const version = toolVersion(PWSH, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()']);
        record('PASS', `capture-input.ps1 parses with pwsh${version.ok ? ` (${version.version})` : ''}`);
      }
    }

    // ---- 3. Inline C# compiles with mcs ----------------------------------
    const csPath = await extractCSharp(tmpDir);
    if (!csPath) {
      record(
        'SKIP',
        'inline C# compiles with mcs',
        'no C# source available (need capture-input.ps1 --dump-csharp / DS_REMOTE_DUMP_CSHARP, or a standalone .cs file)',
      );
    } else if (!fs.existsSync(MCS) && spawnSync('which', [MCS]).status !== 0) {
      record('SKIP', 'inline C# compiles with mcs', `mcs not available (${MCS})`);
    } else {
      const outDll = path.join(tmpDir, 'helper-csharp-check.dll');
      const result = spawnSync(
        MCS,
        [
          '-target:library',
          '-r:System.Drawing.dll',
          '-r:System.Windows.Forms.dll',
          '-out:' + outDll,
          csPath,
        ],
        { encoding: 'utf8', timeout: 180000, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      const detail = `${(result.stdout || '').trim()} ${(result.stderr || '').trim()}`.trim();
      if (result.error) {
        record('FAIL', 'inline C# compiles with mcs', `mcs failed to run: ${result.error.message}`);
      } else if (result.status !== 0) {
        record('FAIL', 'inline C# compiles with mcs', detail || `mcs exit ${result.status}`);
      } else if (!fs.existsSync(outDll) || fs.statSync(outDll).size === 0) {
        record('FAIL', 'inline C# compiles with mcs', 'mcs returned success but produced no assembly');
      } else {
        const version = toolVersion(MCS, ['--version']);
        record(
          'PASS',
          `inline C# compiles with mcs${version.ok ? ` (${version.version})` : ''} — ${csPath}`,
        );
      }
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  const failed = results.filter((entry) => entry.status === 'FAIL');
  const passed = results.filter((entry) => entry.status === 'PASS');
  const skipped = results.filter((entry) => entry.status === 'SKIP');
  console.log('');
  console.log(`STATIC CHECKS SUMMARY: ${passed.length} PASS, ${failed.length} FAIL, ${skipped.length} SKIP`);
  if (failed.length > 0) {
    console.log('failures:');
    for (const entry of failed) console.log(`  - ${entry.name}: ${entry.detail}`);
    process.exitCode = 1;
  } else if (skipped.length > 0) {
    console.log('skipped checks are NOT verified (artifacts/tools missing), see lines above');
  }
}

/**
 * Locate C# source for the mcs compile check:
 *   1. explicit RDA_WIN_HELPER_CSHARP_PATH
 *   2. a standalone agent/windows/*.cs file
 *   3. helper script dump via --dump-csharp <file>
 *   4. helper script dump via DS_REMOTE_DUMP_CSHARP=<file>
 */
async function extractCSharp(tmpDir) {
  const explicit = process.env.RDA_WIN_HELPER_CSHARP_PATH;
  if (explicit && fs.existsSync(explicit) && fs.statSync(explicit).size > 0) return explicit;

  if (fs.existsSync(WINDOWS_DIR)) {
    const candidates = fs
      .readdirSync(WINDOWS_DIR)
      .filter((name) => name.toLowerCase().endsWith('.cs'))
      .map((name) => path.join(WINDOWS_DIR, name));
    if (candidates.length > 0) return candidates[0];
  }

  if (!fs.existsSync(PS_HELPER) || !fs.existsSync(PWSH)) return null;

  const dumpPath = path.join(tmpDir, 'helper-dump.cs');
  const attempts = [
    {
      label: '--dump-csharp',
      args: ['-NoProfile', '-NonInteractive', '-File', PS_HELPER, '--dump-csharp', dumpPath],
      env: { ...process.env },
    },
    {
      label: 'DS_REMOTE_DUMP_CSHARP',
      args: ['-NoProfile', '-NonInteractive', '-File', PS_HELPER],
      env: { ...process.env, DS_REMOTE_DUMP_CSHARP: dumpPath },
    },
  ];
  for (const attempt of attempts) {
    try {
      fs.mkdirSync(tmpDir, { recursive: true });
      const result = spawnSync(PWSH, attempt.args, {
        encoding: 'utf8',
        timeout: 120000,
        env: attempt.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (result.status === 0 && fs.existsSync(dumpPath) && fs.statSync(dumpPath).size > 0) {
        console.log(`(C# extracted with ${attempt.label})`);
        return dumpPath;
      }
    } catch {
      /* try next mechanism */
    }
    if (fs.existsSync(dumpPath)) {
      try {
        fs.unlinkSync(dumpPath);
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

main().catch((err) => {
  console.error('static checks crashed:', err && err.stack ? err.stack : err);
  process.exit(1);
});
