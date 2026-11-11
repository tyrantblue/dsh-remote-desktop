#!/usr/bin/env node
// remote-agent — zero-dependency remote desktop agent.
//
// Implements the agent side of docs/PROTOCOL.md on top of a platform backend
// (docs/WINDOWS.md):
//   * HTTP API: /health, /api/auth, /api/info, /api/fs/*
//   * WebSocket /ws: one remote session per connection (screen, input, shell)
//   * backend: Linux/X11 tiles (backend-x11.mjs) or Windows JPEG via helper
//     process (backend-win32.mjs)
//
// Run `node agent/remote-agent.mjs --help` for the CLI.

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';

import { attachWebSocketServer } from './lib/ws.mjs';
import { AuthService, HttpApi } from './lib/http.mjs';
import { FileService } from './lib/files.mjs';
import { ShellSession } from './lib/shell.mjs';
import { createBackend } from './lib/backend.mjs';

const PROTOCOL_VERSION = 1;
const AGENT_VERSION = '1.0.0';
const AGENT_NAME = os.hostname();

const DEFAULT_PORT = 38080;
const DEFAULT_BIND = '0.0.0.0';
const DEFAULT_TOKEN_TTL_HOURS = 12;
const DEFAULT_QUALITY = 65;
const MAX_FRAME_PAYLOAD = 12 * 1024 * 1024;
const MAX_BUFFERED_AMOUNT = 4 * 1024 * 1024;
const MAX_WS_TEXT_BYTES = 4 * 1024 * 1024;
const IDLE_TIMEOUT_MS = 30_000;
const IDLE_CHECK_INTERVAL_MS = 5_000;

let quiet = false;

function log(...args) {
  if (!quiet) console.log('[remote-agent]', ...args);
}

function logWarn(...args) {
  if (!quiet) console.warn('[remote-agent]', ...args);
}

function logError(...args) {
  console.error('[remote-agent]', ...args);
}

function usage() {
  return `Usage: node agent/remote-agent.mjs [options]

Options:
  --port <n>             listen port (default ${DEFAULT_PORT})
  --bind <addr>          listen address (default ${DEFAULT_BIND})
  --password <p>         access password (or REMOTE_AGENT_PASSWORD, or --password-file)
  --password-file <path> read the access password from a file
  --display <:n>         X11 display (default $DISPLAY or :0; ignored on Windows)
  --fs-root <dir>        root directory for the file API (default $HOME)
  --no-screen            disable screen capture and input
  --no-shell             disable the remote shell
  --no-files             disable the file API
  --read-only-fs         make the file API read-only
  --token-ttl-hours <n>  auth token lifetime in hours (default ${DEFAULT_TOKEN_TTL_HOURS})
  --insecure             no-password mode (testing only; binds 127.0.0.1 unless --bind given)
  --quiet                suppress informational output
  -h, --help             show this help
`;
}

function parseArgs(argv) {
  const opts = {
    port: DEFAULT_PORT,
    bind: null,
    bindExplicit: false,
    password: null,
    passwordFile: null,
    display: null,
    fsRoot: null,
    noScreen: false,
    noShell: false,
    noFiles: false,
    readOnlyFs: false,
    tokenTtlHours: DEFAULT_TOKEN_TTL_HOURS,
    insecure: false,
    quiet: false,
    help: false,
  };

  const valueFlags = new Set([
    '--port',
    '--bind',
    '--password',
    '--password-file',
    '--display',
    '--fs-root',
    '--token-ttl-hours',
  ]);
  const booleanFlags = new Set([
    '--no-screen',
    '--no-shell',
    '--no-files',
    '--read-only-fs',
    '--insecure',
    '--quiet',
  ]);

  for (let i = 0; i < argv.length; i += 1) {
    let token = argv[i];
    if (token === '--help' || token === '-h') {
      opts.help = true;
      continue;
    }
    if (!token.startsWith('--')) {
      throw new Error(`unexpected argument: ${token}`);
    }
    let inlineValue = null;
    const eq = token.indexOf('=');
    if (eq !== -1) {
      inlineValue = token.slice(eq + 1);
      token = token.slice(0, eq);
    }

    if (booleanFlags.has(token)) {
      if (inlineValue !== null) throw new Error(`${token} does not take a value`);
      switch (token) {
        case '--no-screen':
          opts.noScreen = true;
          break;
        case '--no-shell':
          opts.noShell = true;
          break;
        case '--no-files':
          opts.noFiles = true;
          break;
        case '--read-only-fs':
          opts.readOnlyFs = true;
          break;
        case '--insecure':
          opts.insecure = true;
          break;
        case '--quiet':
          opts.quiet = true;
          break;
        default:
          break;
      }
      continue;
    }

    if (!valueFlags.has(token)) {
      throw new Error(`unknown option: ${token}`);
    }
    let value = inlineValue;
    if (value === null) {
      i += 1;
      if (i >= argv.length) throw new Error(`${token} requires a value`);
      value = argv[i];
    }

    switch (token) {
      case '--port': {
        const port = Number(value);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          throw new Error(`invalid --port value: ${value}`);
        }
        opts.port = port;
        break;
      }
      case '--bind':
        opts.bind = value;
        opts.bindExplicit = true;
        break;
      case '--password':
        opts.password = value;
        break;
      case '--password-file':
        opts.passwordFile = value;
        break;
      case '--display':
        opts.display = value;
        break;
      case '--fs-root':
        opts.fsRoot = value;
        break;
      case '--token-ttl-hours': {
        const hours = Number(value);
        if (!Number.isFinite(hours) || hours <= 0) {
          throw new Error(`invalid --token-ttl-hours value: ${value}`);
        }
        opts.tokenTtlHours = hours;
        break;
      }
      default:
        break;
    }
  }
  return opts;
}

function expandHome(input) {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/')) return path.join(os.homedir(), input.slice(2));
  return input;
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function normalizePlatformName(platform) {
  return platform === 'win32' ? 'win32' : 'linux';
}

// `RDA_HELPER_CMD` is the documented testing hook that makes a non-Windows
// host exercise the win32 backend; on a real Windows host process.platform is
// already 'win32'.
function detectPlatform() {
  const helperCommand = process.env.RDA_HELPER_CMD;
  if (typeof helperCommand === 'string' && helperCommand.trim() !== '') return 'win32';
  return process.platform;
}

// ---------------------------------------------------------------------------
// One remote session per WebSocket connection.
// ---------------------------------------------------------------------------

class ClientSession {
  constructor(conn, ctx) {
    this.conn = conn;
    this.ctx = ctx;
    this.sessionId = crypto.randomBytes(8).toString('hex');
    this.closed = false;
    this.helloReceived = false;

    this.backend = null;
    this.backendInfo = null;
    this.screenReady = false;
    this.screenError = null;

    this.screenActive = false;
    this.fps = 15;
    this.tile = 64;
    this.quality = DEFAULT_QUALITY;
    this._screenTimer = null;
    this._forceKeyframe = false;
    this._tickPending = false;
    this.grabbing = false;
    this._seq = 0;
    this._frameCount = 0;
    this._lastCursor = null;
    this._lastWidth = 0;
    this._lastHeight = 0;

    this.shell = null;
    this.lastActivity = Date.now();
    this._idleTimer = null;
    this._queue = Promise.resolve();
    this.ready = this._init();
  }

  async _init() {
    if (!this.ctx.screenEnabled) return;
    let backend = null;
    try {
      backend = await this.ctx.createBackend();
      if (this.closed) {
        try {
          await backend.close();
        } catch {
          /* ignore */
        }
        return;
      }
      this.backend = backend;
      this.backendInfo = backend.info || {};
      this.screenReady = Boolean(backend.capabilities && backend.capabilities.screen && this.backendInfo.screen);
    } catch (err) {
      this.screenError = err && err.message ? err.message : String(err);
      if (backend) {
        try {
          await backend.close();
        } catch {
          /* ignore */
        }
      }
    }
  }

  start() {
    this.conn.onMessage((data, isBinary) => {
      this._queue = this._queue
        .then(() => this._handleMessage(data, isBinary))
        .catch((err) => this._internalError(err));
    });
    this.conn.onClose(() => {
      void this._cleanup();
      this.ctx.sessions.delete(this);
    });
    this._idleTimer = setInterval(() => this._checkIdle(), IDLE_CHECK_INTERVAL_MS);
    this._idleTimer.unref?.();
  }

  _checkIdle() {
    if (this.closed) return;
    if (Date.now() - this.lastActivity > IDLE_TIMEOUT_MS) {
      logWarn(`session ${this.sessionId}: closing idle connection`);
      this.conn.close(1000, 'idle timeout');
    }
  }

  _internalError(err) {
    logWarn(`session ${this.sessionId}: internal error: ${err && err.stack ? err.stack : err}`);
    this._sendError('internal', err && err.message ? err.message : 'internal error');
  }

  async _handleMessage(data, isBinary) {
    await this.ready;
    if (this.closed) return;
    this.lastActivity = Date.now();

    if (isBinary) {
      this._sendError('bad_request', 'binary messages are not accepted from the client');
      return;
    }
    if (typeof data !== 'string' || data.length > MAX_WS_TEXT_BYTES) {
      this._sendError('bad_request', 'message must be a UTF-8 JSON text frame');
      return;
    }

    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      this._sendError('bad_request', 'invalid JSON message');
      return;
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      this._sendError('bad_request', 'message must be a JSON object');
      return;
    }

    const type = msg.t;
    if (!this.helloReceived) {
      if (type === 'hello') {
        this._handleHello();
        return;
      }
      this._sendError('bad_request', 'hello must be the first message');
      return;
    }

    switch (type) {
      case 'hello':
        this._sendError('bad_request', 'hello already received');
        return;
      case 'screen.start':
        await this._handleScreenStart(msg);
        return;
      case 'screen.stop':
        this._stopScreenLoop(true);
        return;
      case 'screen.refresh':
        this._handleScreenRefresh();
        return;
      case 'mouse':
      case 'wheel':
      case 'key':
      case 'text':
      case 'releaseAll':
        this._handleInputMessage(msg);
        return;
      case 'shell.start':
        await this._handleShellStart(msg);
        return;
      case 'shell.input':
        this._handleShellInput(msg);
        return;
      case 'shell.stop':
        this._handleShellStop();
        return;
      case 'ping':
        this._send({ t: 'pong', id: msg.id });
        return;
      case 'pong':
        return;
      default:
        this._sendError('bad_request', `unknown message type: ${String(type)}`);
    }
  }

  // ---- handshake -----------------------------------------------------------

  _handleHello() {
    this.helloReceived = true;
    this._send({
      t: 'welcome',
      protocol: PROTOCOL_VERSION,
      session: this.sessionId,
      agent: { name: AGENT_NAME, version: AGENT_VERSION, platform: this.ctx.platform },
      screen: this.backendInfo && this.backendInfo.screen ? { ...this.backendInfo.screen } : null,
      capabilities: this.capabilities(),
      fsRoot: this.ctx.fsRootDisplay,
    });
  }

  capabilities() {
    const backendCaps = (this.backend && this.backend.capabilities) || {};
    const screen = Boolean(this.screenReady && backendCaps.screen);
    return {
      screen,
      input: Boolean(screen && backendCaps.input),
      shell: this.ctx.shellEnabled,
      files: this.ctx.filesEnabled,
      text: Boolean(screen && backendCaps.text),
    };
  }

  // ---- screen --------------------------------------------------------------

  async _handleScreenStart(msg) {
    if (!this.ctx.screenEnabled) {
      this._sendError('no_screen', 'screen capture is disabled on this agent');
      return;
    }
    if (!this.screenReady || !this.backend) {
      this._sendError('no_screen', this.screenError || 'screen capture is unavailable');
      return;
    }
    this.fps = clampInt(msg.fps, 1, 30, 15);
    this.tile = clampInt(msg.tile, 8, 256, 64);
    this.quality = clampInt(msg.quality, 30, 90, DEFAULT_QUALITY);

    const screenInfo = (this.backendInfo && this.backendInfo.screen) || {};
    this._forceKeyframe = true;
    this._lastCursor = null;
    this._frameCount = 0;
    this._lastWidth = 0;
    this._lastHeight = 0;
    this.screenActive = true;
    this._send({
      t: 'screen.started',
      fps: this.fps,
      tile: this.tile,
      width: Number(screenInfo.width) || 0,
      height: Number(screenInfo.height) || 0,
    });
    this._rescheduleScreen(0);
  }

  _handleScreenRefresh() {
    if (!this.screenReady || !this.backend) {
      this._sendError('no_screen', this.screenError || 'screen capture is unavailable');
      return;
    }
    if (!this.screenActive) return;
    this._forceKeyframe = true;
    if (this.grabbing) {
      this._tickPending = true;
    } else {
      this._rescheduleScreen(0);
    }
  }

  _stopScreenLoop(sendStopped) {
    const wasActive = this.screenActive;
    this.screenActive = false;
    this._tickPending = false;
    if (this._screenTimer) {
      clearTimeout(this._screenTimer);
      this._screenTimer = null;
    }
    if (sendStopped && this.helloReceived) {
      this._send({ t: 'screen.stopped' });
      if (wasActive) log(`session ${this.sessionId}: screen stopped`);
    }
  }

  _rescheduleScreen(delayMs) {
    if (this.closed || !this.screenActive) return;
    if (this._screenTimer) {
      clearTimeout(this._screenTimer);
      this._screenTimer = null;
    }
    const delay = Math.max(0, Math.trunc(Number(delayMs) || 0));
    this._screenTimer = setTimeout(() => {
      this._screenTimer = null;
      void this._screenTick();
    }, delay);
    this._screenTimer.unref?.();
  }

  async _screenTick() {
    if (this.closed || !this.screenActive || !this.backend) return;
    if (this.grabbing) {
      this._tickPending = true;
      return;
    }
    if (this.conn.bufferedAmount > MAX_BUFFERED_AMOUNT) {
      // Do not advance the capture diff state while we cannot send.
      this._rescheduleScreen(1000 / Math.max(1, this.fps));
      return;
    }

    this.grabbing = true;
    const started = Date.now();
    let keyframeRequested = this._forceKeyframe;
    this._forceKeyframe = false;

    try {
      const frame = await this.backend.grab({
        quality: this.quality,
        tile: this.tile,
        forceKeyframe: keyframeRequested,
      });
      if (this.closed || !this.screenActive) return;

      if (frame && frame.encoding === 'jpeg') {
        this._handleJpegFrame(frame);
      } else {
        this._handleTileFrame(frame, keyframeRequested);
      }
    } catch (err) {
      if (!this.closed) {
        this._sendError('no_screen', `screen capture failed: ${err && err.message ? err.message : err}`);
        this._stopScreenLoop(false);
      }
    } finally {
      this.grabbing = false;
      if (!this.closed && this.screenActive) {
        const elapsed = Date.now() - started;
        if (this._tickPending) {
          this._tickPending = false;
          this._rescheduleScreen(0);
        } else {
          this._rescheduleScreen(1000 / Math.max(1, this.fps) - elapsed);
        }
      }
    }
  }

  _cursorOf(frame) {
    const source = (frame && frame.cursor) || {};
    return {
      x: Number.isFinite(Number(source.x)) ? Number(source.x) : 0,
      y: Number.isFinite(Number(source.y)) ? Number(source.y) : 0,
      buttons: Number.isFinite(Number(source.buttons)) ? Number(source.buttons) : 0,
    };
  }

  _cursorChanged(cursor) {
    return (
      !this._lastCursor ||
      this._lastCursor.x !== cursor.x ||
      this._lastCursor.y !== cursor.y ||
      this._lastCursor.buttons !== cursor.buttons
    );
  }

  _handleTileFrame(frame, keyframeRequested) {
    if (!frame) return;
    const width = Number(frame.width) || (this.backendInfo && this.backendInfo.screen ? this.backendInfo.screen.width : 0);
    const height = Number(frame.height) || (this.backendInfo && this.backendInfo.screen ? this.backendInfo.screen.height : 0);
    const cursor = this._cursorOf(frame);
    const cursorChanged = this._cursorChanged(cursor);
    const geometryChanged = this._lastWidth !== width || this._lastHeight !== height;
    const tiles = Array.isArray(frame.tiles) ? frame.tiles : [];

    if (this.conn.bufferedAmount > MAX_BUFFERED_AMOUNT) {
      // The diff state has advanced without the client seeing it; recover with
      // a full keyframe once backpressure clears.
      this._forceKeyframe = true;
      return;
    }
    if (tiles.length > 0) {
      const keyframe = keyframeRequested || geometryChanged || this._frameCount === 0;
      this._lastWidth = width;
      this._lastHeight = height;
      if (this._sendTileFrame(width, height, cursor, tiles, keyframe)) {
        this._lastCursor = cursor;
        this._frameCount += 1;
      }
    } else if (cursorChanged) {
      if (this._sendTileFrame(width, height, cursor, [], false)) {
        this._lastCursor = cursor;
        this._frameCount += 1;
      }
    }
  }

  _handleJpegFrame(frame) {
    if (!frame || !frame.data) return;
    const width = Number(frame.width) || (this.backendInfo && this.backendInfo.screen ? this.backendInfo.screen.width : 0);
    const height = Number(frame.height) || (this.backendInfo && this.backendInfo.screen ? this.backendInfo.screen.height : 0);
    const cursor = this._cursorOf(frame);
    if (this.conn.bufferedAmount > MAX_BUFFERED_AMOUNT) {
      // Every JPEG grab is a complete frame; simply skip this one.
      return;
    }
    if (this._sendJpegFrame(width, height, cursor, frame.data)) {
      this._lastWidth = width;
      this._lastHeight = height;
      this._lastCursor = cursor;
      this._frameCount += 1;
    }
  }

  _sendTileFrame(width, height, cursor, tiles, keyframe) {
    const parts = [];
    const metas = [];
    let offset = 0;
    for (const tile of tiles) {
      let compressed;
      try {
        compressed = zlib.deflateSync(tile.data, { level: 3 });
      } catch {
        continue;
      }
      metas.push({ x: tile.x, y: tile.y, w: tile.w, h: tile.h, off: offset, len: compressed.length });
      offset += compressed.length;
      parts.push(compressed);
    }
    if (metas.length !== tiles.length) return false;
    const payload = Buffer.concat(parts, offset);
    if (payload.length > MAX_FRAME_PAYLOAD) {
      this._forceKeyframe = true;
      return false;
    }
    const header = {
      t: 'frame',
      seq: this._seq,
      width,
      height,
      keyframe: Boolean(keyframe),
      encoding: 'tiles',
      cursor: { x: cursor.x, y: cursor.y, buttons: cursor.buttons },
      tiles: metas,
      payloadLen: payload.length,
    };
    if (this._sendBinaryHeader(header, payload)) {
      this._seq += 1;
      return true;
    }
    return false;
  }

  _sendJpegFrame(width, height, cursor, jpeg) {
    if (!Buffer.isBuffer(jpeg) || jpeg.length === 0) return false;
    if (jpeg.length > MAX_FRAME_PAYLOAD) {
      this._sendError('internal', 'JPEG frame exceeds the maximum payload size');
      return false;
    }
    const header = {
      t: 'frame',
      seq: this._seq,
      width,
      height,
      keyframe: true,
      encoding: 'jpeg',
      cursor: { x: cursor.x, y: cursor.y, buttons: cursor.buttons },
      payloadLen: jpeg.length,
    };
    if (this._sendBinaryHeader(header, jpeg)) {
      this._seq += 1;
      return true;
    }
    return false;
  }

  // ---- input ---------------------------------------------------------------

  _handleInputMessage(msg) {
    if (!this.screenReady || !this.backend) {
      this._sendError('no_screen', 'input injection is unavailable');
      return;
    }
    let result;
    try {
      result = this.backend.handleInput(msg);
    } catch (err) {
      logWarn(`session ${this.sessionId}: input error: ${err && err.message ? err.message : err}`);
      return;
    }
    if (result && result.ok === false && result.error === 'unsupported_key') {
      this._sendError('unsupported_key', 'key is not supported by the remote platform');
    }
    // Other input failures are intentionally ignored: input must not break the
    // session (docs/WINDOWS.md, PROTOCOL.md §7).
  }

  // ---- shell ---------------------------------------------------------------

  async _handleShellStart(msg) {
    if (!this.ctx.shellEnabled) {
      this._sendError('no_shell', 'remote shell is disabled on this agent');
      return;
    }
    if (this.shell && !this.shell.exited) {
      this._sendError('bad_request', 'a shell session is already running');
      return;
    }
    const cols = clampInt(msg.cols, 2, 500, 120);
    const rows = clampInt(msg.rows, 2, 500, 32);
    const cwd = typeof msg.cwd === 'string' && msg.cwd.length > 0 ? msg.cwd : undefined;

    let shell;
    try {
      shell = new ShellSession({ cols, rows, cwd, env: this.ctx.shellEnv });
    } catch (err) {
      this._sendError('internal', `cannot start shell: ${err && err.message ? err.message : err}`);
      return;
    }
    this.shell = shell;

    shell.onData((chunk, stream) => {
      if (this.closed) return;
      this._sendBinaryHeader({ t: 'shell.data', stream: stream === 'stderr' ? 'stderr' : 'stdout' }, chunk);
    });
    shell.onExit((code) => {
      if (this.shell === shell) this.shell = null;
      if (!this.closed) this._send({ t: 'shell.exit', code: Number.isFinite(code) ? code : 1 });
    });

    this._send({ t: 'shell.started', cols, rows });
  }

  _handleShellInput(msg) {
    if (!this.shell || this.shell.exited) {
      this._sendError('bad_request', 'no shell session is running');
      return;
    }
    if (typeof msg.data !== 'string') {
      this._sendError('bad_request', 'shell.input data must be a string');
      return;
    }
    this.shell.write(msg.data);
  }

  _handleShellStop() {
    if (this.shell && !this.shell.exited) {
      void this.shell.kill();
    }
  }

  // ---- sending / teardown --------------------------------------------------

  _send(obj) {
    if (this.closed) return false;
    try {
      return this.conn.sendText(JSON.stringify(obj));
    } catch {
      return false;
    }
  }

  _sendError(code, message) {
    this._send({ t: 'error', code, message: String(message || code) });
  }

  _sendBinaryHeader(header, payload) {
    if (this.closed) return false;
    try {
      const headerBuf = Buffer.from(JSON.stringify(header), 'utf8');
      const lengthBuf = Buffer.allocUnsafe(4);
      lengthBuf.writeUInt32LE(headerBuf.length, 0);
      const body = payload && payload.length ? payload : Buffer.alloc(0);
      return this.conn.sendBinary(Buffer.concat([lengthBuf, headerBuf, body]));
    } catch {
      return false;
    }
  }

  _cleanup() {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    this.screenActive = false;
    this._tickPending = false;
    if (this._screenTimer) {
      clearTimeout(this._screenTimer);
      this._screenTimer = null;
    }
    if (this._idleTimer) {
      clearInterval(this._idleTimer);
      this._idleTimer = null;
    }

    let shellExit = Promise.resolve();
    if (this.shell) {
      const shell = this.shell;
      this.shell = null;
      try {
        shellExit = shell.kill();
      } catch {
        shellExit = Promise.resolve();
      }
    }

    const backend = this.backend;
    this.backend = null;
    if (!backend) {
      return shellExit.then(() => undefined).catch(() => undefined);
    }
    // Release every pressed key/button before tearing the backend down so the
    // remote desktop never gets stuck keys after a disconnect.
    try {
      backend.handleInput({ t: 'releaseAll' });
    } catch {
      /* ignore */
    }
    const closeBackend = Promise.resolve()
      .then(() => backend.close())
      .catch(() => undefined);
    return Promise.allSettled([closeBackend, shellExit]).then(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

function formatScreenInfo(screenInfo) {
  if (!screenInfo) return 'unavailable';
  const size = `${screenInfo.width}x${screenInfo.height}`;
  return screenInfo.depth ? `${size}x${screenInfo.depth}` : size;
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    logError(err.message);
    process.stderr.write(usage());
    process.exitCode = 1;
    return;
  }
  if (opts.help) {
    process.stdout.write(usage());
    return;
  }
  quiet = opts.quiet;

  // ---- password -----------------------------------------------------------
  let password = null;
  if (opts.password !== null) {
    password = opts.password;
  } else if (opts.passwordFile !== null) {
    let raw;
    try {
      raw = fs.readFileSync(path.resolve(expandHome(opts.passwordFile)), 'utf8');
    } catch (err) {
      logError(`cannot read password file: ${err && err.message ? err.message : err}`);
      process.exitCode = 1;
      return;
    }
    password = raw.replace(/\r?\n$/, '');
    if (password.length === 0) {
      logError('password file is empty');
      process.exitCode = 1;
      return;
    }
  } else if (typeof process.env.REMOTE_AGENT_PASSWORD === 'string') {
    password = process.env.REMOTE_AGENT_PASSWORD;
    if (password.length === 0) password = null;
  }

  if (password === null && !opts.insecure) {
    logError('a password is required: use --password, --password-file, REMOTE_AGENT_PASSWORD, or --insecure');
    process.stderr.write(usage());
    process.exitCode = 1;
    return;
  }
  if (password !== null && opts.insecure) {
    logWarn('--insecure ignored because a password is configured');
  }

  const bind = opts.bindExplicit ? opts.bind : password === null ? '127.0.0.1' : DEFAULT_BIND;
  const display = opts.display || process.env.DISPLAY || ':0';
  const tokenTtlMs = Math.round(opts.tokenTtlHours * 60 * 60 * 1000);
  const requestedPlatform = detectPlatform();
  const platform = normalizePlatformName(requestedPlatform);

  // ---- filesystem ---------------------------------------------------------
  let fsRoot = null;
  let fileService = null;
  if (!opts.noFiles) {
    try {
      fsRoot = path.resolve(expandHome(opts.fsRoot !== null ? opts.fsRoot : os.homedir()));
      if (!fs.existsSync(fsRoot)) {
        if (opts.readOnlyFs) throw new Error('filesystem root does not exist (read-only mode will not create it)');
        fs.mkdirSync(fsRoot, { recursive: true });
      }
      const info = fs.statSync(fsRoot);
      if (!info.isDirectory()) throw new Error('filesystem root is not a directory');
      fileService = new FileService({ root: fsRoot, readOnly: opts.readOnlyFs });
    } catch (err) {
      logError(`invalid --fs-root: ${err && err.message ? err.message : err}`);
      process.exitCode = 1;
      return;
    }
  }

  // ---- screen / input backend --------------------------------------------
  const backendOptions = {
    display,
    noScreen: opts.noScreen,
    noInput: false,
    env: process.env,
    platform: requestedPlatform,
  };
  let screenEnabled = false;
  let screenInfo = null;
  let backendCapabilities = { screen: false, input: false, text: false };
  let backendHelper = null;

  if (!opts.noScreen) {
    let probe = null;
    try {
      probe = await createBackend(backendOptions);
      backendCapabilities = probe.capabilities || backendCapabilities;
      screenInfo = (probe.info && probe.info.screen) || null;
      backendHelper = (probe.info && probe.info.helper) || null;
      screenEnabled = Boolean(screenInfo);
    } catch (err) {
      logWarn(`screen backend unavailable (${err && err.message ? err.message : err}); continuing without screen`);
    } finally {
      if (probe) {
        try {
          await probe.close();
        } catch {
          /* ignore */
        }
      }
    }
  } else {
    log('screen capture disabled by --no-screen');
  }

  const capabilities = {
    screen: screenEnabled,
    input: screenEnabled && Boolean(backendCapabilities.input),
    shell: !opts.noShell,
    files: !opts.noFiles,
    text: screenEnabled && Boolean(backendCapabilities.text),
  };
  const infoProvider = () => ({
    agent: { name: AGENT_NAME, version: AGENT_VERSION, platform },
    screen: screenInfo ? { ...screenInfo } : null,
    capabilities: { ...capabilities },
    fsRoot,
    protocol: PROTOCOL_VERSION,
  });

  // ---- services -----------------------------------------------------------
  const auth = new AuthService({ password, tokenTtlMs, maxFailuresPerMinute: 5 });
  const api = new HttpApi({ auth, fileService, infoProvider, corsOrigin: '*' });

  const context = {
    platform,
    display,
    fsRootDisplay: fsRoot,
    filesEnabled: !opts.noFiles,
    shellEnabled: !opts.noShell,
    screenEnabled,
    shellEnv: undefined,
    sessions: new Set(),
    createBackend: () =>
      createBackend({
        display,
        noScreen: false,
        noInput: false,
        env: process.env,
        platform: requestedPlatform,
      }),
  };

  const server = http.createServer(async (req, res) => {
    try {
      const handled = await api.handle(req, res);
      if (!handled) {
        if (res.headersSent || res.writableEnded) return;
        const body = Buffer.from(JSON.stringify({ error: 'not_found', message: 'not found' }), 'utf8');
        res.writeHead(404, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': String(body.length),
          'Access-Control-Allow-Origin': '*',
        });
        res.end(body);
      }
    } catch (err) {
      logWarn(`http handler error: ${err && err.stack ? err.stack : err}`);
      try {
        if (!res.headersSent) {
          const body = Buffer.from(JSON.stringify({ error: 'server_error', message: 'internal error' }), 'utf8');
          res.writeHead(500, {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': String(body.length),
            'Access-Control-Allow-Origin': '*',
          });
          res.end(body);
        } else {
          res.destroy();
        }
      } catch {
        /* ignore */
      }
    }
  });

  server.on('clientError', (err, socket) => {
    try {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    } catch {
      /* ignore */
    }
  });

  const wsServer = attachWebSocketServer(server, {
    path: '/ws',
    authorize: (req) => {
      let token = null;
      try {
        const url = new URL(req.url || '/ws', `http://${req.headers.host || 'localhost'}`);
        token = url.searchParams.get('token');
      } catch {
        return false;
      }
      return typeof token === 'string' && token.length > 0 && auth.verifyToken(token);
    },
    onConnection: (conn) => {
      const session = new ClientSession(conn, context);
      context.sessions.add(session);
      session.start();
    },
  });

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`received ${signal}, shutting down`);
    try {
      wsServer.close();
    } catch {
      /* ignore */
    }
    const cleanupPromises = [];
    for (const session of Array.from(context.sessions)) {
      try {
        session.conn.close(1001, 'server shutdown');
      } catch {
        /* ignore */
      }
      cleanupPromises.push(session._cleanup().catch(() => undefined));
    }
    try {
      server.close();
      server.closeAllConnections?.();
    } catch {
      /* ignore */
    }
    await Promise.race([
      Promise.allSettled(cleanupPromises),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  server.on('error', (err) => {
    logError(`http server error: ${err && err.message ? err.message : err}`);
    process.exit(1);
  });

  await new Promise((resolve) => {
    server.listen(opts.port, bind, () => resolve());
  });

  const address = server.address();
  const actualPort = address && typeof address === 'object' ? address.port : opts.port;
  log(`listening on http://${bind}:${actualPort}  ws://${bind}:${actualPort}/ws`);
  if (screenInfo) {
    if (platform === 'win32') {
      const helperVersion = backendHelper && backendHelper.version ? `, helper ${backendHelper.version}` : '';
      log(`screen: ${formatScreenInfo(screenInfo)} (win32 JPEG${helperVersion})`);
    } else {
      log(`screen: ${formatScreenInfo(screenInfo)} (display ${display})`);
    }
  } else {
    log('screen: unavailable');
  }
  log(`fsRoot: ${fsRoot === null ? '(files disabled)' : fsRoot}${opts.readOnlyFs ? ' (read-only)' : ''}`);
  log(
    `capabilities: screen=${capabilities.screen} input=${capabilities.input} shell=${capabilities.shell} files=${capabilities.files} text=${capabilities.text}`,
  );
}

main().catch((err) => {
  logError(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
