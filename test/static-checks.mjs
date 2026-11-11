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
const GUI_PS = path.join(REPO_DIR, 'agent', 'windows', 'gui.ps1');
const GUI_BAT = path.join(REPO_DIR, 'agent', 'windows', 'start-agent-gui.bat');
const INSTALL_PS = path.join(REPO_DIR, 'agent', 'windows', 'install.ps1');
const ROOT_README = path.join(REPO_DIR, 'README.md');

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

function readFileOrNull(filePath) {
  try {
    return fs.readFileSync(filePath);
  } catch {
    return null;
  }
}

function nonAsciiByteCount(buffer) {
  let count = 0;
  for (const byte of buffer) if (byte > 0x7f) count += 1;
  return count;
}

/** PASS/FAIL ASCII check for one file. */
function checkAscii(filePath, label) {
  const bytes = readFileOrNull(filePath);
  if (!bytes) {
    record('SKIP', `${label} is pure ASCII`, `missing ${filePath}`);
    return;
  }
  const count = nonAsciiByteCount(bytes);
  if (count === 0) record('PASS', `${label} is pure ASCII (0 non-ASCII bytes)`);
  else record('FAIL', `${label} is pure ASCII`, `${count} non-ASCII byte(s) in ${filePath}`);
}

/** PowerShell parser check via the real pwsh (SKIP when pwsh is unavailable). */
function checkPwshParse(psPath, label) {
  if (!fs.existsSync(PWSH)) {
    record('SKIP', `${label} parses with pwsh`, `pwsh not available at ${PWSH}`);
    return;
  }
  const escaped = psPath.replace(/'/g, "''");
  const command =
    `$tokens=$null; $errors=$null; ` +
    `[System.Management.Automation.Language.Parser]::ParseFile('${escaped}',[ref]$tokens,[ref]$errors) | Out-Null; ` +
    `if ($errors.Count -gt 0) { foreach ($e in $errors) { [Console]::Error.WriteLine($e.Message) }; exit 1 }; exit 0`;
  const result = spawnSync(PWSH, ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
    timeout: 120000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const detail = `${(result.stdout || '').trim()} ${(result.stderr || '').trim()}`.trim();
  if (result.error) record('SKIP', `${label} parses with pwsh`, `pwsh failed to run: ${result.error.message}`);
  else if (result.status !== 0) record('FAIL', `${label} parses with pwsh`, detail || `exit ${result.status}`);
  else {
    const version = toolVersion(PWSH, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()']);
    record('PASS', `${label} parses with pwsh${version.ok ? ` (${version.version})` : ''}`);
  }
}

/**
 * Compile the GUI's inline log-pump class from --dump-csharp with Mono.
 *
 * gui.ps1 must both define `$csharp` AND call `Add-Type -TypeDefinition $csharp`
 * before `New-Object DsRemoteGuiLogPump`; a Windows user hit "cannot find type
 * DsRemoteGuiLogPump" because only the dump path used the source. The markers
 * check the call exists, and this check proves the source itself compiles under
 * a .NET Framework-ish reference set (Mono mscorlib/System), like
 * capture-input.ps1's inline C#.
 */
function checkGuiCsharpCompiles() {
  if (!fs.existsSync(GUI_PS)) {
    record('SKIP', 'gui.ps1 inline C# compiles', `missing ${GUI_PS}`);
    return;
  }
  if (!fs.existsSync(PWSH)) {
    record('SKIP', 'gui.ps1 inline C# compiles', `pwsh not available at ${PWSH}`);
    return;
  }
  if (!fs.existsSync(MCS) && spawnSync('which', [MCS]).status !== 0) {
    record('SKIP', 'gui.ps1 inline C# compiles', `mcs not available (${MCS})`);
    return;
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rdtest-gui-'));
  const csPath = path.join(tmpDir, 'gui-helper.cs');
  const dllPath = path.join(tmpDir, 'gui-helper.dll');
  try {
    const dump = spawnSync(PWSH, ['-NoProfile', '-NonInteractive', '-File', GUI_PS, '--dump-csharp', csPath], {
      encoding: 'utf8',
      timeout: 120000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (dump.error || dump.status !== 0 || !fs.existsSync(csPath)) {
      const detail = `${(dump.stdout || '').trim()} ${(dump.stderr || '').trim()}`.trim();
      record('FAIL', 'gui.ps1 inline C# compiles', `--dump-csharp failed: ${detail || `exit ${dump.status}`}`);
      return;
    }
    const compile = spawnSync(MCS, ['-target:library', '-out:' + dllPath, csPath], {
      encoding: 'utf8',
      timeout: 120000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const detail = `${(compile.stdout || '').trim()} ${(compile.stderr || '').trim()}`.trim();
    if (compile.error) record('SKIP', 'gui.ps1 inline C# compiles', `mcs failed to run: ${compile.error.message}`);
    else if (compile.status !== 0) record('FAIL', 'gui.ps1 inline C# compiles', detail || `exit ${compile.status}`);
    else record('PASS', 'gui.ps1 inline C# compiles (log pump helper)');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** Windows GUI scripts + launchers (win32-helper artifacts). Missing files SKIP. */
function checkWindowsGuiArtifacts() {
  // ---- gui.ps1 ---------------------------------------------------------
  if (!fs.existsSync(GUI_PS)) {
    record('SKIP', 'gui.ps1 exists', `missing ${GUI_PS} (win32-helper GUI not delivered yet)`);
  } else {
    record('PASS', 'gui.ps1 exists');
    checkAscii(GUI_PS, 'gui.ps1');
    checkPwshParse(GUI_PS, 'gui.ps1');
    const text = fs.readFileSync(GUI_PS).toString('latin1');
    const markers = [
      ['Add-Type -AssemblyName System.Windows.Forms', /Add-Type\s+-AssemblyName\s+System\.Windows\.Forms/],
      ['CreateNoWindow', /CreateNoWindow/],
      ['--relay-code-file', /--relay-code-file/],
      ['Add-Type -TypeDefinition $csharp (log pump compiled)', /Add-Type\s+-TypeDefinition\s+\$csharp/],
      ['New-Object DsRemoteGuiLogPump', /New-Object\s+DsRemoteGuiLogPump/],
      ['Start button/label', /\bStart\b/],
      ['Stop button/label', /\bStop\b/],
    ];
    const missing = markers.filter(([, regex]) => !regex.test(text)).map(([name]) => name);
    if (missing.length === 0) {
      record('PASS', `gui.ps1 contains ${markers.map(([name]) => name).join(' + ')}`);
    } else {
      record('FAIL', 'gui.ps1 contains required markers', `missing: ${missing.join(', ')}`);
    }
  }

  // ---- gui.ps1 inline C# actually compiles and loads --------------------
  checkGuiCsharpCompiles();

  // ---- start-agent-gui.bat --------------------------------------------
  if (!fs.existsSync(GUI_BAT)) {
    record('SKIP', 'start-agent-gui.bat exists', `missing ${GUI_BAT} (win32-helper GUI not delivered yet)`);
  } else {
    record('PASS', 'start-agent-gui.bat exists');
    checkAscii(GUI_BAT, 'start-agent-gui.bat');
    const bytes = fs.readFileSync(GUI_BAT);
    let loneLf = 0;
    let loneCr = 0;
    for (let i = 0; i < bytes.length; i += 1) {
      if (bytes[i] === 0x0a && (i === 0 || bytes[i - 1] !== 0x0d)) loneLf += 1;
      if (bytes[i] === 0x0d && (i + 1 >= bytes.length || bytes[i + 1] !== 0x0a)) loneCr += 1;
    }
    const hasNewlines = bytes.includes(0x0a);
    if (hasNewlines && loneLf === 0 && loneCr === 0) {
      record('PASS', 'start-agent-gui.bat uses CRLF line endings');
    } else {
      record('FAIL', 'start-agent-gui.bat uses CRLF line endings', `loneLF=${loneLf}, loneCR=${loneCr}, newlines=${hasNewlines}`);
    }
    const text = bytes.toString('latin1');
    if (/gui\.ps1/i.test(text)) record('PASS', 'start-agent-gui.bat references gui.ps1');
    else record('FAIL', 'start-agent-gui.bat references gui.ps1', 'no "gui.ps1" reference found');
  }

  // ---- install.ps1 ------------------------------------------------------
  if (!fs.existsSync(INSTALL_PS)) {
    record('SKIP', 'install.ps1 exists', `missing ${INSTALL_PS}`);
  } else {
    record('PASS', 'install.ps1 exists');
    const text = fs.readFileSync(INSTALL_PS).toString('utf8');
    const hasRelayCodeTxt = /relay-code\.txt/i.test(text);
    const prefersGui = /(start-agent-gui|gui\.ps1)/i.test(text);
    if (hasRelayCodeTxt && prefersGui) {
      record('PASS', 'install.ps1 preserves relay-code.txt and prefers the GUI launcher');
    } else {
      record(
        'FAIL',
        'install.ps1 preserves relay-code.txt and prefers the GUI launcher',
        `relay-code.txt=${hasRelayCodeTxt}, GUI reference=${prefersGui}`,
      );
    }
  }
}

/**
 * No hardcoded public Harness domain in the Windows scripts/docs.
 * `dsh.tyrantblue.xyz` is never allowed; a bare `dsh.tyrantblue` is only
 * tolerated inside a github.com URL (repository link).
 */
function checkNoHardcodedHarnessDomain() {
  const targets = [];
  const walk = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) targets.push(full);
    }
  };
  walk(WINDOWS_DIR);
  if (fs.existsSync(ROOT_README)) targets.push(ROOT_README);

  const violations = [];
  const githubTyranblueLinks = [];
  for (const filePath of targets) {
    let text;
    try {
      text = fs.readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }
    const relative = path.relative(REPO_DIR, filePath);
    text.split('\n').forEach((line, index) => {
      if (line.includes('dsh.tyrantblue.xyz')) {
        violations.push(`${relative}:${index + 1}: ${line.trim().slice(0, 160)}`);
        return;
      }
      if (line.includes('dsh.tyrantblue')) {
        if (/github\.com\/[^\s"'<>)]*tyrantblue/i.test(line)) githubTyranblueLinks.push(relative);
        else violations.push(`${relative}:${index + 1}: ${line.trim().slice(0, 160)}`);
      }
    });
  }
  if (violations.length === 0) {
    record(
      'PASS',
      `no hardcoded dsh.tyrantblue.xyz in agent/windows/* or README.md (${targets.length} files scanned)` +
        (githubTyranblueLinks.length > 0 ? `; GitHub tyrantblue links allowed in ${new Set(githubTyranblueLinks).size} file(s)` : ''),
    );
  } else {
    record('FAIL', 'no hardcoded Harness domain in Windows docs/scripts', violations.slice(0, 6).join(' | '));
  }
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
    // ---- 4. Windows GUI / launcher static checks -------------------------
    checkWindowsGuiArtifacts();

    // ---- 5. No hardcoded public Harness domain ---------------------------
    checkNoHardcodedHarnessDomain();
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
