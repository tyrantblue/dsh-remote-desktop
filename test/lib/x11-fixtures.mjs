/**
 * Controlled X11 applications used by the E2E suite and the demo.
 *
 * xterm is a real terminal emulator (coloured window, keyboard input, PTY),
 * xev is a real X event printer (it logs exactly the MotionNotify /
 * ButtonPress / KeyPress events the Agent's XTEST injection produces). Both run
 * against the dedicated test display, write their output to log files and are
 * always stopped through their returned `stop()`.
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { waitFor } from './wait.mjs';

let fixtureSequence = 0;
function nextFixtureId(prefix) {
  fixtureSequence += 1;
  return `${prefix}-${process.pid}-${fixtureSequence}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function openAppendFd(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  return fs.openSync(filePath, 'a');
}

function stopChild(proc, { graceMs = 3000 } = {}) {
  return new Promise((resolve) => {
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) {
      resolve();
      return;
    }
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      setTimeout(finish, 300);
    }, graceMs);
    proc.once('exit', finish);
    try {
      proc.kill('SIGTERM');
    } catch {
      finish();
    }
  });
}

/** Run xdotool against one display and return trimmed stdout/stderr. */
export function runXdotool(display, args, { timeoutMs = 5000 } = {}) {
  const result = spawnSync('xdotool', args, {
    env: { ...process.env, DISPLAY: display },
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
    error: result.error ?? null,
  };
}

/**
 * List windows matching a class or title.
 *
 * xdotool cannot combine `--name` and `--class` in one search on this version
 * (it treats the second option as a new command), so we search by the title
 * when one is given and then filter by class with `getwindowclassname`.
 *
 * @returns {number[]} window ids
 */
export function searchWindows(display, { name = null, className = null, onlyVisible = true } = {}) {
  const args = ['search'];
  if (onlyVisible) args.push('--onlyvisible');
  if (name) args.push('--name', name);
  else if (className) args.push('--class', className);
  const result = runXdotool(display, args);
  if (result.status !== 0) return [];
  let ids = result.stdout
    .split(/\s+/)
    .filter(Boolean)
    .map((value) => Number.parseInt(value, 10))
    .filter((value) => Number.isFinite(value));
  if (name && className) {
    const wanted = className.toLowerCase();
    ids = ids.filter((id) => {
      const classResult = spawnSync('xprop', ['-display', display, '-id', String(id), 'WM_CLASS'], {
        encoding: 'utf8',
        timeout: 5000,
      });
      const classes = (classResult.stdout ?? '').toLowerCase();
      return classResult.status === 0 && classes.includes(wanted);
    });
  }
  return ids;
}

/** Wait until a window matching class/title exists and return its id. */
export async function waitForWindow(
  display,
  { name = null, className = null, timeoutMs = 8000, label = null } = {},
) {
  const description = label ?? `window ${name ? `name~"${name}" ` : ''}${className ? `class="${className}" ` : ''}on ${display}`;
  return await waitFor(
    () => {
      const ids = searchWindows(display, { name, className });
      return ids.length > 0 ? ids[0] : false;
    },
    { timeoutMs, intervalMs: 100, label: description },
  );
}

/** Geometry of one window via `xdotool getwindowgeometry --shell`. */
export function getWindowGeometry(display, windowId) {
  const result = runXdotool(display, ['getwindowgeometry', '--shell', String(windowId)]);
  if (result.status !== 0) {
    throw new Error(`xdotool getwindowgeometry failed for ${windowId}: ${result.stderr}`);
  }
  const values = {};
  for (const line of result.stdout.split('\n')) {
    const match = /^([A-Z_]+)=(-?\d+)$/.exec(line.trim());
    if (match) values[match[1]] = Number(match[2]);
  }
  if (values.WIDTH == null || values.HEIGHT == null) {
    throw new Error(`could not parse xdotool geometry: ${result.stdout}`);
  }
  return {
    windowId: values.WINDOW ?? Number(windowId),
    x: values.X ?? 0,
    y: values.Y ?? 0,
    width: values.WIDTH,
    height: values.HEIGHT,
    screen: values.SCREEN ?? 0,
  };
}

/** Current pointer position (cross-check for the Agent's QueryPointer). */
export function getPointerLocation(display) {
  const result = runXdotool(display, ['getmouselocation', '--shell']);
  if (result.status !== 0) {
    throw new Error(`xdotool getmouselocation failed: ${result.stderr}`);
  }
  const values = {};
  for (const line of result.stdout.split('\n')) {
    const match = /^([A-Z_]+)=(-?\d+)$/.exec(line.trim());
    if (match) values[match[1]] = Number(match[2]);
  }
  return { x: values.X ?? 0, y: values.Y ?? 0, screen: values.SCREEN ?? 0, window: values.WINDOW ?? null };
}

/** Window that currently has the X input focus. */
export function getFocusedWindow(display) {
  const result = runXdotool(display, ['getwindowfocus']);
  if (result.status !== 0) return null;
  const value = Number.parseInt(result.stdout, 10);
  return Number.isFinite(value) ? value : null;
}

/** Paint the X root window a solid colour (works because Xvfb runs -noreset). */
export function setRootColor(display, color) {
  const result = spawnSync('xsetroot', ['-display', display, '-solid', color], {
    encoding: 'utf8',
    timeout: 10000,
  });
  if (result.error) throw new Error(`xsetroot failed to run: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`xsetroot -solid ${color} failed (status ${result.status}): ${result.stderr ?? ''}`);
  }
  return true;
}

/** Read the current xev log (empty string when the file does not exist yet). */
export function readXevLog(logPath) {
  try {
    return fs.readFileSync(logPath, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Start a real xterm.
 *
 * @param {string} display
 * @param {object} [options]
 * @param {string} [options.geometry='40x12+20+20']
 * @param {string} [options.bg='#3366cc']
 * @param {string} [options.fg='#ffffff']
 * @param {string|string[]|null} [options.command] shell command string (run via
 *   `bash -c`) or argv array passed to `xterm -e`. Defaults to an echo/cat loop.
 * @param {string} [options.title] window title (auto-generated when omitted)
 * @param {string|null} [options.fontFace='DejaVu Sans Mono'] Xft font face
 *   (`-fa`); pass null to use xterm's built-in font.
 * @param {number} [options.fontSize=11] Xft font size (`-fs`).
 * @param {string} [options.logPath] explicit log file
 * @param {string|null} [options.logDir] directory for the auto-generated log
 *   (defaults to os.tmpdir())
 * @param {boolean} [options.waitForWindow=true]
 */
export async function startXterm(
  display,
  {
    geometry = '40x12+20+20',
    bg = '#3366cc',
    fg = '#ffffff',
    command = null,
    title = null,
    fontFace = 'DejaVu Sans Mono',
    fontSize = 11,
    logPath = null,
    logDir = null,
    waitForWindow: shouldWait = true,
  } = {},
) {
  const windowTitle = title ?? nextFixtureId('xterm');
  const outputPath =
    logPath ?? path.join(logDir ?? os.tmpdir(), `rdtest-${windowTitle}.log`);
  const args = [
    '-display',
    display,
    '-geometry',
    geometry,
    '-bg',
    bg,
    '-fg',
    fg,
    '-T',
    windowTitle,
  ];
  if (fontFace) args.push('-fa', fontFace, '-fs', String(fontSize));
  if (Array.isArray(command)) args.push('-e', ...command);
  else if (typeof command === 'string' && command.length > 0) args.push('-e', 'bash', '-c', command);
  else args.push('-e', 'bash', '-c', 'echo READY; exec cat');

  const fd = openAppendFd(outputPath);
  let proc;
  try {
    proc = spawn('xterm', args, {
      env: { ...process.env, DISPLAY: display },
      stdio: ['ignore', fd, fd],
    });
  } finally {
    fs.closeSync(fd);
  }

  const fixture = {
    kind: 'xterm',
    display,
    title: windowTitle,
    geometry,
    logPath: outputPath,
    proc,
    pid: proc.pid,
    windowId: null,
    stop: () => stopChild(proc),
  };

  if (shouldWait) {
    fixture.windowId = await waitForWindow(display, {
      name: windowTitle,
      className: 'xterm',
      label: `xterm window "${windowTitle}" on ${display}`,
    });
  }
  return fixture;
}

/**
 * Start `xev`, a real X client that prints every input event it receives.
 * xev flushes each event line by itself, so the log can be polled live.
 *
 * @param {string} display
 * @param {{geometry?:string, logPath?:string, logDir?:string, waitForWindow?:boolean}} [options]
 */
export async function startXev(
  display,
  { geometry = '300x200+100+100', logPath = null, logDir = null, waitForWindow: shouldWait = true } = {},
) {
  const outputPath =
    logPath ?? path.join(logDir ?? os.tmpdir(), `rdtest-${nextFixtureId('xev')}.log`);
  const fd = openAppendFd(outputPath);
  let proc;
  try {
    proc = spawn('xev', ['-display', display, '-geometry', geometry], {
      env: { ...process.env, DISPLAY: display },
      stdio: ['ignore', fd, fd],
    });
  } finally {
    fs.closeSync(fd);
  }

  const fixture = {
    kind: 'xev',
    display,
    geometry,
    logPath: outputPath,
    proc,
    pid: proc.pid,
    windowId: null,
    readLog: () => readXevLog(outputPath),
    stop: () => stopChild(proc),
  };

  if (shouldWait) {
    const match = await waitFor(
      () => {
        const text = readXevLog(outputPath);
        return /Outer window is 0x[0-9a-fA-F]+/.exec(text);
      },
      { timeoutMs: 8000, intervalMs: 50, label: `xev window on ${display}` },
    );
    fixture.windowId = Number.parseInt(match[0].split(' ').pop(), 16);
    // Give xev a moment to finish setting up its event selection.
    await sleep(150);
  }
  return fixture;
}

/**
 * Kill every process a fixture (and its terminal children) started. xterm and
 * xev are stopped via their own stop(); this helper is for arrays of fixtures.
 */
export async function stopFixtures(fixtures) {
  for (const fixture of [...fixtures].reverse()) {
    if (!fixture) continue;
    try {
      await fixture.stop();
    } catch {
      /* best effort during cleanup */
    }
  }
}
