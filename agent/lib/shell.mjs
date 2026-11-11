// Remote shell session with a pseudo terminal when possible.
//
// Preferred path: `script -qfec "/bin/bash -i" /dev/null` gives bash a real PTY
// (job control, line editing, colors) while our process talks to `script` over
// ordinary pipes. Fallback: plain `bash -i` with piped stdio when /usr/bin/script
// is unavailable.
//
// Public API (per task-2):
//   class ShellSession {
//     constructor({cols=120, rows=32, cwd, env});
//     write(str); kill(); onData(cb); onExit(cb); readonly pid
//   }
// onData(cb) is called as cb(chunk: Buffer, stream: 'stdout'|'stderr').
// onExit(cb) is called once as cb(code: number, signal: string|null).

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCRIPT_BIN = '/usr/bin/script';
const BASH_BIN = '/bin/bash';
const TERM = 'xterm-256color';
const KILL_ESCALATION_MS = 500;

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function signalExitCode(signal) {
  if (!signal) return 1;
  if (signal === 'SIGTERM') return 143;
  if (signal === 'SIGKILL') return 137;
  if (signal === 'SIGINT') return 130;
  if (signal === 'SIGHUP') return 129;
  return 1;
}

function usableCwd(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) return null;
  try {
    const resolved = path.resolve(cwd);
    if (fs.statSync(resolved).isDirectory()) return resolved;
  } catch {
    /* fall through */
  }
  return null;
}

export class ShellSession {
  constructor({ cols = 120, rows = 32, cwd, env } = {}) {
    this.cols = clampInt(cols, 2, 500, 120);
    this.rows = clampInt(rows, 2, 500, 32);
    this.cwd = usableCwd(cwd) || process.cwd() || os.homedir();

    this._dataHandlers = [];
    this._exitHandlers = [];
    this._exited = false;
    this._exitCode = null;
    this._exitSignal = null;
    this._killTimer = null;
    this._exitPromise = new Promise((resolve) => {
      this._resolveExit = resolve;
    });

    const childEnv = {
      ...process.env,
      ...(env && typeof env === 'object' ? env : {}),
      TERM,
      COLORTERM: 'truecolor',
      COLUMNS: String(this.cols),
      LINES: String(this.rows),
    };

    const useScript = process.platform === 'linux' && fs.existsSync(SCRIPT_BIN);
    let command;
    let args;
    if (useScript) {
      command = SCRIPT_BIN;
      args = ['-qfec', `${BASH_BIN} -i`, '/dev/null'];
      this.pty = true;
    } else {
      command = BASH_BIN;
      args = ['-i'];
      this.pty = false;
    }

    this._child = spawn(command, args, {
      cwd: this.cwd,
      env: childEnv,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this._child.stdout?.on('data', (chunk) => this._emitData(chunk, 'stdout'));
    this._child.stderr?.on('data', (chunk) => this._emitData(chunk, 'stderr'));
    this._child.stdin?.on('error', () => {
      /* EPIPE when the child is gone; exit event is authoritative */
    });

    this._child.on('error', (err) => {
      this._emitData(Buffer.from(`\r\n[shell error] ${err && err.message ? err.message : err}\r\n`, 'utf8'), 'stderr');
      this._finish(1, null);
    });
    this._child.on('exit', (code, signal) => {
      this._finish(typeof code === 'number' ? code : signalExitCode(signal), signal || null);
    });
  }

  get pid() {
    return this._child && typeof this._child.pid === 'number' ? this._child.pid : null;
  }

  get exited() {
    return this._exited;
  }

  write(str) {
    if (this._exited || !this._child || !this._child.stdin) return false;
    try {
      return this._child.stdin.write(String(str));
    } catch {
      return false;
    }
  }

  kill(signal = 'SIGTERM') {
    if (this._exited) return this._exitPromise;
    const pid = this.pid;
    if (pid) {
      try {
        // Negative pid targets the whole detached process group: `script`, the
        // interactive bash and anything bash spawned.
        process.kill(-pid, signal);
      } catch {
        try {
          this._child.kill(signal);
        } catch {
          /* ignore */
        }
      }
    }
    if (!this._killTimer && signal !== 'SIGKILL') {
      this._killTimer = setTimeout(() => {
        this._killTimer = null;
        if (this._exited) return;
        const livePid = this.pid;
        if (livePid) {
          try {
            process.kill(-livePid, 'SIGKILL');
          } catch {
            try {
              this._child.kill('SIGKILL');
            } catch {
              /* ignore */
            }
          }
        }
      }, KILL_ESCALATION_MS);
      this._killTimer.unref?.();
    }
    return this._exitPromise;
  }

  onData(cb) {
    if (typeof cb === 'function') this._dataHandlers.push(cb);
    return this;
  }

  onExit(cb) {
    if (typeof cb !== 'function') return this;
    if (this._exited) {
      queueMicrotask(() => cb(this._exitCode, this._exitSignal));
      return this;
    }
    this._exitHandlers.push(cb);
    return this;
  }

  // ---- internals -----------------------------------------------------------

  _emitData(chunk, stream) {
    if (this._exited) return;
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    for (const handler of this._dataHandlers.slice()) {
      try {
        handler(data, stream);
      } catch {
        /* a subscriber must never break the shell session */
      }
    }
  }

  _finish(code, signal) {
    if (this._exited) return;
    this._exited = true;
    this._exitCode = typeof code === 'number' ? code : 1;
    this._exitSignal = signal || null;
    if (this._killTimer) {
      clearTimeout(this._killTimer);
      this._killTimer = null;
    }
    try {
      this._child.stdin?.destroy();
    } catch {
      /* ignore */
    }
    try {
      this._child.stdout?.destroy();
      this._child.stderr?.destroy();
    } catch {
      /* ignore */
    }
    const handlers = this._exitHandlers;
    this._exitHandlers = [];
    for (const handler of handlers) {
      try {
        handler(this._exitCode, this._exitSignal);
      } catch {
        /* ignore */
      }
    }
    this._resolveExit(this._exitCode);
  }
}
