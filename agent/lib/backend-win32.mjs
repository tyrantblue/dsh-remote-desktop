// Windows platform backend: manages the PowerShell helper child process
// (`agent/windows/capture-input.ps1`) via the JSON Lines protocol from
// docs/WINDOWS.md §2.
//
// The helper is the only thing that touches Win32 (GDI capture + SendInput);
// this module owns process lifecycle, request/response correlation, timeouts
// and error reporting. A broken helper (crash, bad JSON, timeout) surfaces as
// a clear Error and never crashes the agent.
//
// Frames are full JPEG images: { encoding: 'jpeg', width, height, cursor,
// data: Buffer, changed: true }.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_HELPER_SCRIPT = path.resolve(MODULE_DIR, '..', 'windows', 'capture-input.ps1');

const HELLO_TIMEOUT_MS = 15_000;
const INFO_TIMEOUT_MS = 10_000;
const CAPTURE_TIMEOUT_MS = 10_000;
const SHUTDOWN_TIMEOUT_MS = 1_500;
const KILL_TIMEOUT_MS = 1_500;
const MAX_LINE_BYTES = 16 * 1024 * 1024;
const STDERR_TAIL_BYTES = 8 * 1024;
const DEFAULT_QUALITY = 65;

/**
 * Split a command line into argv, honouring single/double quotes so paths with
 * spaces work (e.g. `"C:\Program Files\node.exe" helper.js`). Backslashes are
 * kept literally; inside double quotes a backslash escapes only `"`.
 */
export function splitHelperCommand(input) {
  const text = String(input ?? '');
  const argv = [];
  let current = '';
  let quote = null;
  let hasToken = false;
  const push = () => {
    if (hasToken || current.length > 0) argv.push(current);
    current = '';
    hasToken = false;
  };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (ch === '\\' && quote === '"' && text[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      hasToken = true;
      continue;
    }
    if (/\s/.test(ch)) {
      push();
      continue;
    }
    current += ch;
    hasToken = true;
  }
  if (quote) throw new Error(`unterminated ${quote} quote in Windows helper command`);
  push();
  return argv;
}

function resolveHelperArgv(options, env) {
  let command = options.helperCommand;
  if (command == null && env && typeof env.RDA_HELPER_CMD === 'string' && env.RDA_HELPER_CMD.trim() !== '') {
    command = env.RDA_HELPER_CMD;
  }
  if (command == null) {
    return [
      'powershell.exe',
      '-NoLogo',
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      DEFAULT_HELPER_SCRIPT,
    ];
  }
  const argv = Array.isArray(command)
    ? command.map((part) => String(part)).filter((part) => part.length > 0)
    : splitHelperCommand(String(command));
  if (argv.length === 0) throw new Error('Windows helper command is empty');
  return argv;
}

function clampQuality(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_QUALITY;
  return Math.min(90, Math.max(30, Math.trunc(n)));
}

class HelperProcess {
  constructor(argv, { env, noInput = false } = {}) {
    this.argv = argv;
    this.env = env || process.env;
    this.noInput = noInput;
    this.child = null;
    this.buffer = Buffer.alloc(0);
    this.stderrTail = '';
    this.pending = new Map();
    this.nextId = 1;
    this.hello = null;
    this.exited = false;
    this.exitInfo = null;
    this.closing = false;
    this._closingPromise = null;
    this._helloResolve = null;
    this._helloReject = null;
    this._helloTimer = null;
    this._resolveExit = null;
    this._exitPromise = new Promise((resolve) => {
      this._resolveExit = resolve;
    });
    this._badLineCount = 0;
  }

  start() {
    const [command, ...args] = this.argv;
    try {
      this.child = spawn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: this.env,
      });
    } catch (err) {
      return Promise.reject(this._startError(err));
    }

    this.child.on('error', (err) => {
      this._spawnError = err;
      this._rejectHello(this._startError(err));
      this._markExited(null, null);
    });
    this.child.on('exit', (code, signal) => this._markExited(code, signal));
    this.child.on('close', (code, signal) => this._markExited(code, signal));
    this.child.stdout?.on('data', (chunk) => this._onStdout(chunk));
    this.child.stderr?.on('data', (chunk) => this._onStderr(chunk));
    this.child.stdin?.on('error', () => {
      /* EPIPE; the exit event is authoritative */
    });

    return this._waitForHello();
  }

  _startError(err) {
    const detail = err && err.message ? err.message : String(err);
    let message = `cannot start Windows helper (${this.argv.join(' ')}): ${detail}`;
    const tail = this._stderrSuffix();
    if (tail) message += `; stderr: ${tail}`;
    return new Error(message);
  }

  _waitForHello() {
    return new Promise((resolve, reject) => {
      if (this.hello) {
        resolve(this.hello);
        return;
      }
      if (this.exited) {
        reject(this._deadError());
        return;
      }
      this._helloResolve = resolve;
      this._helloReject = reject;
      this._helloTimer = setTimeout(() => {
        this._helloTimer = null;
        this._rejectHello(new Error(`Windows helper did not send hello within ${HELLO_TIMEOUT_MS}ms${this._stderrSuffix()}`));
      }, HELLO_TIMEOUT_MS);
      this._helloTimer.unref?.();
    });
  }

  _resolveHello(hello) {
    if (this._helloTimer) {
      clearTimeout(this._helloTimer);
      this._helloTimer = null;
    }
    const resolve = this._helloResolve;
    this._helloResolve = null;
    this._helloReject = null;
    if (resolve) resolve(hello);
  }

  _rejectHello(err) {
    if (this._helloTimer) {
      clearTimeout(this._helloTimer);
      this._helloTimer = null;
    }
    const reject = this._helloReject;
    this._helloResolve = null;
    this._helloReject = null;
    if (reject) reject(err);
  }

  _onStdout(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    try {
      while (true) {
        const newline = this.buffer.indexOf(0x0a);
        if (newline === -1) {
          if (this.buffer.length > MAX_LINE_BYTES) {
            this._protocolFailure(`helper output line exceeds ${MAX_LINE_BYTES} bytes`);
          }
          return;
        }
        let lineBuffer = this.buffer.subarray(0, newline);
        this.buffer = this.buffer.subarray(newline + 1);
        if (lineBuffer.length > 0 && lineBuffer[lineBuffer.length - 1] === 0x0d) {
          lineBuffer = lineBuffer.subarray(0, lineBuffer.length - 1);
        }
        if (lineBuffer.length > MAX_LINE_BYTES) {
          this._protocolFailure(`helper output line exceeds ${MAX_LINE_BYTES} bytes`);
          return;
        }
        const line = lineBuffer.toString('utf8');
        this._onLine(line);
      }
    } catch (err) {
      this._protocolFailure(err && err.message ? err.message : 'malformed helper output');
    }
  }

  _onLine(rawLine) {
    const line = rawLine.replace(/^\uFEFF/, '').trim();
    if (line === '') return;

    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this._badLineCount += 1;
      const snippet = line.length > 200 ? `${line.slice(0, 200)}...` : line;
      const error = new Error(`Windows helper sent malformed JSON: ${snippet}${this._stderrSuffix()}`);
      if (this._helloReject) {
        this._rejectHello(error);
      } else if (this.pending.size > 0) {
        this._rejectAllPending(error);
      }
      // Unsolicited garbage when idle: keep the helper, the next good line wins.
      return;
    }

    if (message == null || typeof message !== 'object') return;

    if (message.id !== undefined && message.id !== null) {
      const pending = this.pending.get(message.id);
      if (pending) {
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.ok === false) {
          const error = new Error(
            `Windows helper ${pending.cmd} failed: ${message.error || 'helper_error'}${message.message ? ` (${message.message})` : ''}`,
          );
          error.code = message.error || 'helper_error';
          pending.reject(error);
        } else {
          pending.resolve(message);
        }
        return;
      }
      // Late response for a timed-out request: fall through only when it also
      // carries a hello, so a slightly non-conforming helper still starts.
      if (!message.hello) return;
    }

    if (message.hello) {
      const raw = message.hello && typeof message.hello === 'object' ? message.hello : {};
      const hello = {
        helper: typeof raw.helper === 'string' ? raw.helper : 'unknown',
        width: Number(raw.width) || 0,
        height: Number(raw.height) || 0,
        screens: Number(raw.screens) || 1,
        format: raw.format === 'jpeg' ? 'jpeg' : undefined,
        dpi: Number(raw.dpi) || 0,
      };
      if (message.ok === false) {
        this._rejectHello(new Error(`Windows helper rejected startup: ${message.error || 'unknown'}${this._stderrSuffix()}`));
        return;
      }
      this.hello = hello;
      this._resolveHello(hello);
      return;
    }

    // A helper that refuses to start may answer with a bare error object.
    if (this._helloReject && message.ok === false) {
      this._rejectHello(
        new Error(`Windows helper rejected startup: ${message.error || 'unknown'}${message.message ? ` (${message.message})` : ''}`),
      );
      return;
    }

    // Other unsolicited messages (diagnostics) are ignored.
  }

  _onStderr(chunk) {
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    this.stderrTail += text;
    if (this.stderrTail.length > STDERR_TAIL_BYTES) {
      this.stderrTail = this.stderrTail.slice(-STDERR_TAIL_BYTES);
    }
  }

  _stderrSuffix() {
    const tail = this.stderrTail.replace(/\s+/g, ' ').trim();
    return tail ? ` [stderr: ${tail}]` : '';
  }

  _protocolFailure(message) {
    const error = new Error(`Windows helper protocol error: ${message}${this._stderrSuffix()}`);
    if (this._helloReject) this._rejectHello(error);
    this._rejectAllPending(error);
    // The stream is out of sync; stop using this helper.
    try {
      this.child?.kill();
    } catch {
      /* ignore */
    }
    this._markExited(null, null);
  }

  _rejectAllPending(error) {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  _markExited(code, signal) {
    if (this.exited) return;
    this.exited = true;
    this.exitInfo = { code, signal };
    // Wake the hello waiter with a useful message (no stale timeout error).
    if (this._helloReject) {
      this._rejectHello(this._spawnError ? this._startError(this._spawnError) : this._deadError());
    }
    this._rejectAllPending(this._deadError());
    this._resolveExit();
  }

  _deadError() {
    const info = this.exitInfo;
    let message = info
      ? `Windows helper exited (code=${info.code}, signal=${info.signal})`
      : this._spawnError
        ? `Windows helper failed to start (${this._spawnError.message || this._spawnError})`
        : 'Windows helper is not running';
    const tail = this._stderrSuffix();
    if (tail) message += tail;
    return new Error(message);
  }

  _writeLine(payload) {
    if (!this.child || !this.child.stdin || this.child.stdin.destroyed || this.child.stdin.writable === false) {
      throw this._deadError();
    }
    this.child.stdin.write(`${JSON.stringify(payload)}\n`, 'utf8');
  }

  request(cmd, fields = {}, timeoutMs = CAPTURE_TIMEOUT_MS) {
    if (this.exited) return Promise.reject(this._deadError());
    if (this.closing) return Promise.reject(new Error('Windows helper is closing'));
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Windows helper ${cmd} timed out after ${timeoutMs}ms${this._stderrSuffix()}`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer, cmd });
      try {
        this._writeLine({ id, cmd, ...fields });
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(this._deadError());
      }
    });
  }

  sendInput(message) {
    if (this.exited) return { ok: false, error: 'helper_not_running' };
    if (this.closing) return { ok: false, error: 'helper_closing' };
    const command = mapInputMessage(message);
    if (!command) return { ok: false, error: 'bad_request' };
    try {
      this._writeLine(command);
      return { ok: true };
    } catch {
      return { ok: false, error: 'helper_not_running' };
    }
  }

  _waitExit(timeoutMs) {
    if (this.exited) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this._exitPromise.then(() => resolve());
        resolve();
      }, timeoutMs);
      timer.unref?.();
      this._exitPromise.then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  close() {
    if (this._closingPromise) return this._closingPromise;
    this._closingPromise = (async () => {
      // Ask the helper to exit first; `request()` refuses while `closing` is
      // set, so only mark closing once shutdown has been sent.
      if (!this.exited) {
        try {
          await this.request('shutdown', {}, SHUTDOWN_TIMEOUT_MS);
        } catch {
          /* helper may exit without answering */
        }
      }
      this.closing = true;
      if (!this.exited) {
        try {
          this.child?.stdin?.end();
        } catch {
          /* ignore */
        }
        try {
          this.child?.kill();
        } catch {
          /* ignore */
        }
        await this._waitExit(1000);
      }
      if (!this.exited) {
        try {
          this.child?.kill('SIGKILL');
        } catch {
          /* ignore */
        }
        await this._waitExit(KILL_TIMEOUT_MS);
      }
      this._rejectAllPending(new Error('Windows helper closed'));
      try {
        this.child?.stdout?.destroy();
        this.child?.stderr?.destroy();
      } catch {
        /* ignore */
      }
    })();
    return this._closingPromise;
  }
}

function mapInputMessage(message) {
  if (!message || typeof message !== 'object') return null;
  const pick = (source, keys) => {
    const out = {};
    for (const key of keys) {
      if (source[key] !== undefined) out[key] = source[key];
    }
    return out;
  };
  switch (message.t) {
    case 'mouse':
      return { cmd: 'mouse', ...pick(message, ['action', 'x', 'y', 'button']) };
    case 'wheel':
      return { cmd: 'wheel', ...pick(message, ['dx', 'dy']) };
    case 'key':
      return { cmd: 'key', ...pick(message, ['code', 'key', 'down', 'mods']) };
    case 'text':
      return { cmd: 'text', ...pick(message, ['text']) };
    case 'releaseAll':
      return { cmd: 'releaseAll' };
    default:
      return null;
  }
}

export async function createWin32Backend(options = {}) {
  const env = options.env ? { ...process.env, ...options.env } : process.env;
  const argv = resolveHelperArgv(options, env);
  const helper = new HelperProcess(argv, { env, noInput: Boolean(options.noInput) });

  let hello;
  try {
    hello = await helper.start();
  } catch (err) {
    try {
      await helper.close();
    } catch {
      /* ignore */
    }
    throw err;
  }

  let width = hello.width;
  let height = hello.height;
  if (!(width > 0 && height > 0)) {
    try {
      const info = await helper.request('info', {}, INFO_TIMEOUT_MS);
      width = Number(info.width) || width;
      height = Number(info.height) || height;
    } catch {
      /* keep hello dimensions (possibly 0); capture will update them */
    }
  }

  const capabilities = {
    screen: true,
    input: !options.noInput,
    text: !options.noInput,
    shell: false, // filled in by the main program
    files: false,
  };

  const backend = {
    platform: 'win32',
    capabilities,
    info: {
      screen: { width, height },
      display: null,
      helper: { version: hello.helper, format: 'jpeg', screens: hello.screens, dpi: hello.dpi },
    },
    encoding: 'jpeg',

    async grab(grabOptions = {}) {
      const quality = clampQuality(grabOptions.quality);
      const response = await helper.request('capture', { quality }, CAPTURE_TIMEOUT_MS);
      if (typeof response.data !== 'string' || response.data.length === 0) {
        throw new Error('Windows helper returned a capture without JPEG data');
      }
      const data = Buffer.from(response.data, 'base64');
      if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) {
        throw new Error('Windows helper returned a capture that is not a JPEG (missing FFD8 marker)');
      }
      const frameWidth = Number(response.width) || width;
      const frameHeight = Number(response.height) || height;
      if (frameWidth > 0 && frameHeight > 0) {
        width = frameWidth;
        height = frameHeight;
        backend.info.screen = { width, height };
      }
      const cursorSource = response.cursor && typeof response.cursor === 'object' ? response.cursor : {};
      const buttons = Number.isFinite(Number(response.buttons))
        ? Number(response.buttons)
        : Number.isFinite(Number(cursorSource.buttons))
          ? Number(cursorSource.buttons)
          : 0;
      return {
        encoding: 'jpeg',
        width: frameWidth,
        height: frameHeight,
        cursor: { x: Number(cursorSource.x) || 0, y: Number(cursorSource.y) || 0, buttons },
        data,
        changed: true,
      };
    },

    handleInput(message) {
      if (options.noInput) return { ok: false, error: 'no_input' };
      return helper.sendInput(message);
    },

    async close() {
      await helper.close();
    },
  };

  return backend;
}
