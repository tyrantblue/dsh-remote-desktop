/**
 * Xvfb lifecycle management for the remote-desktop end-to-end tests.
 *
 * Design notes (verified against the Xvfb installed on this host):
 *  - Every test run starts its own dedicated X server. We never reuse an
 *    existing display (the host already has an Xvfb :99 owned by someone else),
 *    so a display number that is in use is skipped and the next free number is
 *    taken.
 *  - Xvfb is started with `-noreset`. Without it an X server performs a full
 *    reset as soon as its last client disconnects, which silently discards
 *    state such as the root window background set by `xsetroot`. That reset
 *    would make the pixel-reference checks meaningless.
 *  - Readiness is confirmed with a real `xdpyinfo` round trip (not just the
 *    socket file), because the socket can appear slightly before the server
 *    answers requests.
 *  - stop() terminates the server, waits for it to exit and removes the
 *    `/tmp/.X<n>-lock` and `/tmp/.X11-unix/X<n>` artifacts it owns.
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const LOCK_DIR = '/tmp';
const SOCKET_DIR = '/tmp/.X11-unix';

export function parseDisplayNumber(display) {
  const value = String(display ?? '').trim();
  const match = /^:(\d+)(?:\.\d+)?$/.exec(value);
  if (!match) {
    throw new Error(`invalid X display "${value}" (expected a form like ":99")`);
  }
  return Number(match[1]);
}

export function socketPathFor(displayNumber) {
  return path.join(SOCKET_DIR, `X${displayNumber}`);
}

export function lockPathFor(displayNumber) {
  return path.join(LOCK_DIR, `.X${displayNumber}-lock`);
}

function readLockPid(displayNumber) {
  try {
    const text = fs.readFileSync(lockPathFor(displayNumber), 'utf8').trim();
    const pid = Number.parseInt(text, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to somebody else.
    return err?.code === 'EPERM';
  }
}

/**
 * True when something is actually accepting connections on the display socket,
 * or when a live process holds the X lock file. A leftover socket/lock pair
 * from a crashed server is NOT considered "in use".
 */
export async function isDisplayInUse(displayNumber, { timeoutMs = 400 } = {}) {
  const lockPid = readLockPid(displayNumber);
  if (lockPid && isPidAlive(lockPid)) return true;

  const socketPath = socketPathFor(displayNumber);
  if (!fs.existsSync(socketPath)) return false;

  return await new Promise((resolve) => {
    const socket = net.connect(socketPath);
    let settled = false;
    const finish = (inUse) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(inUse);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(timeoutMs, () => finish(false));
  });
}

function removeStaleDisplayArtifacts(displayNumber) {
  const lockPath = lockPathFor(displayNumber);
  const socketPath = socketPathFor(displayNumber);
  const lockPid = readLockPid(displayNumber);
  if (lockPid && isPidAlive(lockPid)) return false;
  for (const p of [lockPath, socketPath]) {
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch {
      /* best effort */
    }
  }
  return true;
}

/** Return the first display number >= startNumber that is not in use. */
export async function findFreeDisplayNumber(startNumber, { maxAttempts = 50 } = {}) {
  for (let n = startNumber; n < startNumber + maxAttempts; n += 1) {
    if (await isDisplayInUse(n)) continue;
    removeStaleDisplayArtifacts(n);
    return n;
  }
  throw new Error(
    `could not find a free X display in :${startNumber}..:${startNumber + maxAttempts - 1} ` +
      `(all in use or stale locks could not be removed)`,
  );
}

/**
 * Run `xdpyinfo` once. Returns parsed geometry when the server answers,
 * otherwise null. Synchronous on purpose: the outer loop is already async and
 * a spawn per poll is cheap (a few milliseconds).
 */
export function probeDisplay(displayNumber, { timeoutMs = 3000 } = {}) {
  const result = spawnSync('xdpyinfo', ['-display', `:${displayNumber}`], {
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) return null;
  const stdout = result.stdout ?? '';
  const dims = /dimensions:\s+(\d+)x(\d+)\s+pixels/.exec(stdout);
  const depth = /depth of root window:\s+(\d+)\s+planes/.exec(stdout);
  const vendor = /vendor string:\s+(.+)/.exec(stdout);
  if (!dims) return null;
  return {
    width: Number(dims[1]),
    height: Number(dims[2]),
    depth: depth ? Number(depth[1]) : null,
    hasXTEST: /\bXTEST\b/.test(stdout),
    vendor: vendor ? vendor[1].trim() : null,
    raw: stdout,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tailFile(filePath, maxBytes = 4000) {
  try {
    const stat = fs.statSync(filePath);
    const start = Math.max(0, stat.size - maxBytes);
    const fd = fs.openSync(filePath, 'r');
    try {
      const buffer = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      return buffer.toString('utf8').trim();
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

function waitForProcessExit(proc, timeoutMs) {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.removeListener('exit', onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(true);
    };
    proc.once('exit', onExit);
  });
}

async function terminateProcess(proc, { graceMs = 4000 } = {}) {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return true;
  try {
    proc.kill('SIGTERM');
  } catch {
    /* already gone */
  }
  if (await waitForProcessExit(proc, graceMs)) return true;
  try {
    proc.kill('SIGKILL');
  } catch {
    /* already gone */
  }
  return await waitForProcessExit(proc, 2000);
}

/** Remove lock/socket only when they are demonstrably ours or stale. */
function cleanupDisplayArtifacts(displayNumber, ownerPid) {
  const lockPath = lockPathFor(displayNumber);
  const socketPath = socketPathFor(displayNumber);
  const lockPid = readLockPid(displayNumber);
  const lockIsOurs = lockPid == null || lockPid === ownerPid || !isPidAlive(lockPid);
  if (lockIsOurs) {
    for (const p of [lockPath, socketPath]) {
      try {
        if (fs.existsSync(p)) fs.unlinkSync(p);
      } catch {
        /* best effort */
      }
    }
  }
}

/**
 * Start an isolated Xvfb server.
 *
 * @param {object} [options]
 * @param {string} [options.display=':99']  Requested display; occupied numbers are skipped.
 * @param {number} [options.width=1280]
 * @param {number} [options.height=800]
 * @param {number} [options.depth=24]
 * @param {boolean} [options.noreset=true]  Keep server state between clients (needed by xsetroot).
 * @param {string[]} [options.extraArgs=[]] Extra Xvfb arguments.
 * @param {string} [options.logDir=os.tmpdir()] Where the Xvfb log is written.
 * @param {number} [options.timeoutMs=15000]
 * @returns {Promise<{display:string, displayNumber:number, width:number, height:number,
 *   depth:number|null, hasXTEST:boolean, pid:number, proc:import('node:child_process').ChildProcess,
 *   socketPath:string, lockPath:string, logPath:string, stop:()=>Promise<void>}>}
 */
export async function startXvfb({
  display = ':99',
  width = 1280,
  height = 800,
  depth = 24,
  noreset = true,
  extraArgs = [],
  logDir = os.tmpdir(),
  timeoutMs = 15000,
} = {}) {
  const startNumber = parseDisplayNumber(display);
  fs.mkdirSync(logDir, { recursive: true });

  let lastFailure = null;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const displayNumber = await findFreeDisplayNumber(startNumber + attempt);
    const logPath = path.join(logDir, `xvfb-${displayNumber}.log`);
    const args = [
      `:${displayNumber}`,
      '-screen',
      '0',
      `${width}x${height}x${depth}`,
      '-nolisten',
      'tcp',
      ...(noreset ? ['-noreset'] : []),
      ...extraArgs,
    ];

    let logFd;
    try {
      logFd = fs.openSync(logPath, 'a');
      fs.writeSync(logFd, `\n[${new Date().toISOString()}] xvfb ${args.join(' ')}\n`);
    } catch {
      logFd = null;
    }

    let proc;
    try {
      proc = spawn('Xvfb', args, {
        stdio: logFd == null ? ['ignore', 'ignore', 'ignore'] : ['ignore', logFd, logFd],
      });
    } catch (err) {
      if (logFd != null) fs.closeSync(logFd);
      throw new Error(`failed to spawn Xvfb: ${err.message}`);
    }
    if (logFd != null) fs.closeSync(logFd);

    let spawnError = null;
    let exitInfo = null;
    proc.on('error', (err) => {
      spawnError = err;
    });
    proc.on('exit', (code, signal) => {
      exitInfo = { code, signal };
    });

    const deadline = Date.now() + timeoutMs;
    let ready = null;
    while (Date.now() < deadline) {
      if (spawnError) break;
      if (exitInfo) break;
      const info = probeDisplay(displayNumber, { timeoutMs: 2500 });
      if (info && info.width != null) {
        ready = info;
        break;
      }
      await sleep(100);
    }

    if (ready && ready.width === width && ready.height === height) {
      const serverPid = proc.pid;
      const lockPath = lockPathFor(displayNumber);
      const socketPath = socketPathFor(displayNumber);

      let stopped = false;
      const stop = async () => {
        if (stopped) return;
        stopped = true;
        await terminateProcess(proc);
        cleanupDisplayArtifacts(displayNumber, serverPid);
      };

      return {
        display: `:${displayNumber}`,
        displayNumber,
        width: ready.width,
        height: ready.height,
        depth: ready.depth ?? depth,
        hasXTEST: ready.hasXTEST,
        vendor: ready.vendor,
        pid: serverPid,
        proc,
        socketPath,
        lockPath,
        logPath,
        stop,
      };
    }

    // Not usable: gather diagnostics, terminate whatever was spawned and try
    // the next display number.
    await terminateProcess(proc, { graceMs: 1500 });
    cleanupDisplayArtifacts(displayNumber, proc.pid);
    if (ready) {
      lastFailure =
        `display :${displayNumber} came up as ${ready.width}x${ready.height} ` +
        `but ${width}x${height} was requested`;
    } else if (spawnError) {
      lastFailure = `spawn error on :${displayNumber}: ${spawnError.message}`;
    } else if (exitInfo) {
      lastFailure =
        `Xvfb :${displayNumber} exited early (code=${exitInfo.code}, signal=${exitInfo.signal})`;
    } else {
      lastFailure = `Xvfb :${displayNumber} did not become ready within ${timeoutMs}ms`;
    }
    const tail = tailFile(logPath);
    if (tail) lastFailure += `\n--- ${logPath} ---\n${tail}`;
    // If the failure is display-specific, the loop simply retries with :n+1.
  }

  throw new Error(`startXvfb failed after 10 attempts:\n${lastFailure ?? 'unknown reason'}`);
}
