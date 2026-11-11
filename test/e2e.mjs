#!/usr/bin/env node
/**
 * Remote-desktop end-to-end test suite.
 *
 * Runs a REAL stack:
 *   dedicated Xvfb display  →  real agent process (agent/remote-agent.mjs)
 *   →  this file as a REAL protocol client (agent/lib/ws.mjs + fetch).
 *
 * Every pixel compared against the screen comes either from the Agent's own
 * WebSocket frames or from the independent `xwd`-based reference in
 * test/lib/xwd.mjs. Every input assertion is made against events that a real
 * X client (xev / xterm) actually received.
 *
 * Usage:
 *   node test/e2e.mjs [--display :99] [--port 38080] [--keep-artifacts]
 *   bash test/run.sh
 *
 * Environment:
 *   PORT   preferred agent port (default 38080; occupied ports are skipped)
 *   DISPLAY preferred X display (default :99; occupied displays are skipped)
 *   E2E_DISPLAY explicit display preference (takes precedence over DISPLAY)
 *   KEEP_ARTIFACTS=1 keep the temp dir even when the suite passes
 *
 * Exit code 0 only when every case passed.
 */

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { startXvfb } from './lib/xvfb.mjs';
import {
  captureRootPixels,
  pixelAt,
  pixelHex,
  countColor,
} from './lib/xwd.mjs';
import { writePng } from './lib/png.mjs';
import {
  startXterm,
  startXev,
  setRootColor,
  readXevLog,
  getWindowGeometry,
  getPointerLocation,
} from './lib/x11-fixtures.mjs';
import {
  waitFor,
  sleep,
  assert,
  assertEqual,
  assertMatch,
  assertIncludes,
  assertPixelColor,
  formatError,
} from './lib/wait.mjs';
import { connectWebSocket } from '../agent/lib/ws.mjs';

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AGENT_ENTRY = path.join(REPO_DIR, 'agent', 'remote-agent.mjs');
const PASSWORD = 'test-pass';
const SCREEN_WIDTH = 1280;
const SCREEN_HEIGHT = 800;
const TILE = 64;
const KEYFRAME_TILES = Math.ceil(SCREEN_WIDTH / TILE) * Math.ceil(SCREEN_HEIGHT / TILE); // 20*13 = 260

// ---- CLI -------------------------------------------------------------------

function parseCli(argv) {
  const options = { display: null, port: null, keepArtifacts: false, verbose: process.env.VERBOSE === '1' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--keep-artifacts') options.keepArtifacts = true;
    else if (arg === '--verbose' || arg === '-v') options.verbose = true;
    else if (arg === '--display') options.display = argv[++i];
    else if (arg === '--port') options.port = Number(argv[++i]);
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node test/e2e.mjs [--display :99] [--port 38080] [--keep-artifacts]');
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

// ---- tiny test runner ------------------------------------------------------

const suiteStartedAt = Date.now();
const cases = [];
let fatal = false;

function ms(value) {
  return `${value.toFixed(0)}ms`;
}

async function testCase(name, fn) {
  if (fatal) {
    cases.push({ name, ok: false, skipped: true, error: 'not run: a previous startup step failed' });
    console.log(`FAIL ${String(cases.length).padStart(2, '0')} ${name} — not run (startup failed)`);
    return;
  }
  const startedAt = Date.now();
  try {
    await fn();
    const duration = Date.now() - startedAt;
    cases.push({ name, ok: true, duration });
    console.log(`PASS ${String(cases.length).padStart(2, '0')} ${name} (${ms(duration)})`);
  } catch (err) {
    const duration = Date.now() - startedAt;
    cases.push({ name, ok: false, duration, error: formatError(err) });
    console.log(`FAIL ${String(cases.length).padStart(2, '0')} ${name} (${ms(duration)}) — ${formatError(err)}`);
  }
}

// ---- general helpers -------------------------------------------------------

function tailFile(filePath, maxChars = 3000) {
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    return text.length > maxChars ? `…${text.slice(-maxChars)}` : text;
  } catch {
    return '';
  }
}

async function isPortFree(port) {
  return await new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

async function findFreePort(startPort) {
  for (let port = startPort; port < startPort + 100; port += 1) {
    if (await isPortFree(port)) return port;
  }
  throw new Error(`no free TCP port in ${startPort}..${startPort + 99}`);
}

async function isPortOpen(port) {
  return await new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(500, () => finish(false));
  });
}

function listChildren(pid) {
  const result = spawnSync('ps', ['-o', 'pid=', '--ppid', String(pid)], { encoding: 'utf8' });
  if (result.status !== 0) return [];
  return result.stdout
    .split('\n')
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((value) => Number.isFinite(value));
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

function waitForExit(proc, timeoutMs) {
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

// ---- HTTP client -----------------------------------------------------------

function createHttp(baseUrl) {
  async function request(pathname, { method = 'GET', token = null, json = null, rawBody = null, contentType = null, timeoutMs = 15000 } = {}) {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    let body;
    if (rawBody != null) {
      body = rawBody;
      headers['Content-Type'] = contentType || 'application/octet-stream';
    } else if (json != null) {
      body = JSON.stringify(json);
      headers['Content-Type'] = 'application/json';
    }
    const response = await fetch(`${baseUrl}${pathname}`, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    const text = buffer.toString('utf8');
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    return { status: response.status, headers: response.headers, buffer, text, json: parsed };
  }
  return { request };
}

// ---- WebSocket protocol client --------------------------------------------

const rgbOf = (pixel) => [pixel[0], pixel[1], pixel[2]];

class RemoteClient {
  constructor(conn, name) {
    this.conn = conn;
    this.name = name;
    this.messages = [];
    this.frames = [];
    this.shellChunks = [];
    this.unknownBinary = [];
    this.decodeErrors = [];
    this.closed = false;
    this.closeInfo = null;
    this.canvas = null;
    this.canvasWidth = 0;
    this.canvasHeight = 0;
    this.welcome = null;

    conn.onMessage((data, isBinary) => {
      try {
        if (isBinary) this._handleBinary(data);
        else this._handleText(data);
      } catch (err) {
        this.decodeErrors.push(err);
      }
    });
    conn.onClose((code, reason) => {
      this.closed = true;
      this.closeInfo = { code, reason };
    });
  }

  static async connect(url, name) {
    const conn = await connectWebSocket(url, { timeoutMs: 8000 });
    return new RemoteClient(conn, name);
  }

  _handleText(data) {
    let message;
    try {
      message = JSON.parse(data);
    } catch {
      this.messages.push({ t: '__invalid_json__', raw: String(data) });
      return;
    }
    this.messages.push(message);
  }

  _handleBinary(data) {
    assert(data.length >= 4, `${this.name}: binary message shorter than the 4-byte header length`);
    const headerLength = data.readUInt32LE(0);
    assert(
      headerLength > 0 && 4 + headerLength <= data.length,
      `${this.name}: binary header length ${headerLength} outside message (${data.length} bytes)`,
    );
    const header = JSON.parse(data.subarray(4, 4 + headerLength).toString('utf8'));
    const payload = data.subarray(4 + headerLength);

    if (header.t === 'frame') {
      this.frames.push(this._applyFrame(header, payload));
      return;
    }
    if (header.t === 'shell.data') {
      const text = payload.toString('utf8');
      this.shellChunks.push({ stream: header.stream === 'stderr' ? 'stderr' : 'stdout', text });
      return;
    }
    this.unknownBinary.push(header);
  }

  _applyFrame(header, payload) {
    const width = Number(header.width);
    const height = Number(header.height);
    assert(width > 0 && height > 0, `${this.name}: frame has invalid size ${header.width}x${header.height}`);
    if (!this.canvas || this.canvasWidth !== width || this.canvasHeight !== height) {
      this.canvas = Buffer.alloc(width * height * 4);
      this.canvasWidth = width;
      this.canvasHeight = height;
    }
    assertEqual(payload.length, Number(header.payloadLen), `${this.name}: frame payloadLen`);
    let tileArea = 0;
    for (const tile of header.tiles) {
      const raw = zlib.inflateSync(payload.subarray(tile.off, tile.off + tile.len));
      assertEqual(raw.length, tile.w * tile.h * 4, `${this.name}: tile ${tile.x},${tile.y} inflated RGBA size`);
      for (let row = 0; row < tile.h; row += 1) {
        const srcStart = row * tile.w * 4;
        raw.copy(this.canvas, ((tile.y + row) * width + tile.x) * 4, srcStart, srcStart + tile.w * 4);
      }
      tileArea += tile.w * tile.h;
    }
    return {
      header,
      tiles: header.tiles,
      payloadLen: payload.length,
      tileArea,
      seq: header.seq,
      keyframe: Boolean(header.keyframe),
      cursor: header.cursor ?? null,
    };
  }

  send(message) {
    this.conn.sendText(JSON.stringify(message));
  }

  mark() {
    return { messages: this.messages.length, frames: this.frames.length, shellChunks: this.shellChunks.length };
  }

  fallbackMark() {
    return { messages: this.messages.length, frames: this.frames.length };
  }

  _scanMessages(predicate, from) {
    for (let i = from ?? 0; i < this.messages.length; i += 1) {
      if (predicate(this.messages[i], i)) return this.messages[i];
    }
    return false;
  }

  _scanFrames(predicate, from) {
    for (let i = from ?? 0; i < this.frames.length; i += 1) {
      if (predicate(this.frames[i], i)) return this.frames[i];
    }
    return false;
  }

  async waitForMessage(predicate, { timeoutMs = 8000, label = 'message', from = null } = {}) {
    return await waitFor(() => this._scanMessages(predicate, from), {
      timeoutMs,
      intervalMs: 25,
      label: `${this.name}: ${label}`,
    });
  }

  async waitForNewMessage(predicate, { timeoutMs = 8000, label = 'message', mark = null } = {}) {
    const start = mark ? mark.messages : this.messages.length;
    return await this.waitForMessage(predicate, { timeoutMs, label, from: start });
  }

  async waitForFrame(predicate, { timeoutMs = 10000, label = 'frame', from = null } = {}) {
    return await waitFor(() => this._scanFrames(predicate, from), {
      timeoutMs,
      intervalMs: 25,
      label: `${this.name}: ${label}`,
    });
  }

  async waitForNewFrame(predicate, { timeoutMs = 10000, label = 'frame', mark = null } = {}) {
    const start = mark ? mark.frames : this.frames.length;
    return await this.waitForFrame(predicate, { timeoutMs, label, from: start });
  }

  pixelAt(x, y) {
    assert(this.canvas, `${this.name}: no decoded frame yet`);
    assert(
      x >= 0 && y >= 0 && x < this.canvasWidth && y < this.canvasHeight,
      `${this.name}: pixel (${x},${y}) outside canvas ${this.canvasWidth}x${this.canvasHeight}`,
    );
    const offset = (y * this.canvasWidth + x) * 4;
    return [this.canvas[offset], this.canvas[offset + 1], this.canvas[offset + 2], this.canvas[offset + 3]];
  }

  /**
   * Wait until a pixel of the locally reconstructed screen has the expected
   * RGB values. The canvas only changes when a frame is received, so this is a
   * strict "the client observed the change" condition.
   */
  async waitForCanvasColor(x, y, expected, { timeoutMs = 10000, label = null, tolerance = 0 } = {}) {
    const [er, eg, eb] = expected;
    await waitFor(
      () => {
        const pixel = this.pixelAt(x, y);
        return (
          Math.abs(pixel[0] - er) <= tolerance &&
          Math.abs(pixel[1] - eg) <= tolerance &&
          Math.abs(pixel[2] - eb) <= tolerance
        );
      },
      {
        timeoutMs,
        intervalMs: 25,
        label: label || `${this.name}: canvas pixel (${x},${y}) must become rgb(${er},${eg},${eb})`,
      },
    );
    return this.pixelAt(x, y);
  }

  shellOutput() {
    return this.shellChunks.map((chunk) => chunk.text).join('');
  }

  async hello() {
    const mark = this.mark();
    this.send({ t: 'hello', client: 'remote-desktop-e2e', version: 1 });
    const welcome = await this.waitForNewMessage((message) => message.t === 'welcome', {
      label: 'welcome',
      mark,
    });
    this.welcome = welcome;
    return welcome;
  }

  async ping(id = 1) {
    const mark = this.mark();
    this.send({ t: 'ping', id });
    return await this.waitForNewMessage((message) => message.t === 'pong' && message.id === id, {
      label: `pong id=${id}`,
      mark,
      timeoutMs: 5000,
    });
  }

  async close() {
    if (this.closed) return;
    this.conn.close(1000, 'e2e finished');
    await waitFor(() => this.closed, { timeoutMs: 5000, label: `${this.name}: close handshake` }).catch(() => {});
  }
}

function assertFrameTilesGrid(frame, label) {
  const { header, tiles } = frame;
  assertEqual(header.width, SCREEN_WIDTH, `${label}: frame width`);
  assertEqual(header.height, SCREEN_HEIGHT, `${label}: frame height`);
  assertEqual(tiles.length, KEYFRAME_TILES, `${label}: keyframe tile count`);
  let area = 0;
  for (const tile of tiles) {
    assert(tile.w > 0 && tile.h > 0, `${label}: tile has empty size`);
    assert(tile.x >= 0 && tile.y >= 0, `${label}: negative tile origin`);
    assert(tile.x + tile.w <= SCREEN_WIDTH, `${label}: tile exceeds screen width`);
    assert(tile.y + tile.h <= SCREEN_HEIGHT, `${label}: tile exceeds screen height`);
    area += tile.w * tile.h;
  }
  assertEqual(area, SCREEN_WIDTH * SCREEN_HEIGHT, `${label}: tiles cover the whole screen`);
}

function tileCovers(frame, x, y) {
  return frame.tiles.some(
    (tile) => x >= tile.x && x < tile.x + tile.w && y >= tile.y && y < tile.y + tile.h,
  );
}

// ---- xev log parsing -------------------------------------------------------

function parseXevEvents(text) {
  const events = [];
  let current = null;
  for (const line of text.split('\n')) {
    const start = /^([A-Z][A-Za-z0-9]*) event,/.exec(line);
    if (start) {
      if (current) events.push(current);
      current = { type: start[1], text: `${line}\n`, root: null, keycode: null, state: null, keysym: null, button: null };
      continue;
    }
    if (!current) continue;
    current.text += `${line}\n`;
    const rootMatch = /root:\((-?\d+),(-?\d+)\)/.exec(line);
    if (rootMatch) current.root = { x: Number(rootMatch[1]), y: Number(rootMatch[2]) };
    const keyMatch = /keycode (\d+)/.exec(line);
    if (keyMatch) current.keycode = Number(keyMatch[1]);
    const stateMatch = /state 0x([0-9a-fA-F]+)/.exec(line);
    if (stateMatch) current.state = Number.parseInt(stateMatch[1], 16);
    const keysymMatch = /keysym 0x([0-9a-fA-F]+), (\S+)/.exec(line);
    if (keysymMatch) current.keysym = { value: Number.parseInt(keysymMatch[1], 16), name: keysymMatch[2] };
    const buttonMatch = /button (\d+)/.exec(line);
    if (buttonMatch) current.button = Number(buttonMatch[1]);
  }
  if (current) events.push(current);
  return events;
}

function eventsAfter(events, offset) {
  return events.filter((event) => event.offset > offset);
}

function assertNoDecodeErrors(client) {
  assertEqual(client.decodeErrors.length, 0, `${client.name}: binary decode errors: ${client.decodeErrors.map((e) => e.message).join('; ')}`);
}

// ---- main ------------------------------------------------------------------

async function main() {
  const cli = parseCli(process.argv.slice(2));
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rdtest-e2e-'));
  const fsRoot = path.join(tmpDir, 'fsroot');
  fs.mkdirSync(fsRoot, { recursive: true });
  const agentLogPath = path.join(tmpDir, 'agent.log');
  const preferredDisplay = cli.display || process.env.E2E_DISPLAY || process.env.DISPLAY || ':99';
  const preferredPort = cli.port || Number(process.env.PORT) || 38080;

  const ctx = {
    tmpDir,
    fsRoot,
    agentLogPath,
    display: null,
    port: null,
    agent: null,
    xvfb: null,
    token: null,
    http: null,
    clients: [],
    fixtures: [],
    screenStartedAt: null,
    mainClient: null,
    xvfbStopped: false,
    display99Before: null,
    display98Before: null,
  };

  console.log('========================================================================');
  console.log('Remote desktop E2E — real Xvfb + real Agent process + protocol client');
  console.log(`repo:      ${REPO_DIR}`);
  console.log(`node:      ${process.version}`);
  console.log(`display:   requested ${preferredDisplay} (occupied numbers are skipped)`);
  console.log(`port:      requested ${preferredPort} (occupied ports are skipped)`);
  console.log(`temp dir:  ${tmpDir}`);
  console.log('========================================================================');

  try {
    // ---- startup ----------------------------------------------------------
    await testCase('01 Xvfb: dedicated 1280x800 server started on a free display', async () => {
      ctx.display99Before = {
        socket: fs.existsSync('/tmp/.X11-unix/X99'),
        lock: fs.existsSync('/tmp/.X99-lock'),
        lockPid: (() => {
          try {
            return Number.parseInt(fs.readFileSync('/tmp/.X99-lock', 'utf8').trim(), 10) || null;
          } catch {
            return null;
          }
        })(),
      };
      ctx.display98Before = { socket: fs.existsSync('/tmp/.X11-unix/X98') };

      ctx.xvfb = await startXvfb({
        display: preferredDisplay,
        width: SCREEN_WIDTH,
        height: SCREEN_HEIGHT,
        depth: 24,
        logDir: tmpDir,
      });
      ctx.display = ctx.xvfb.display;
      console.log(`        Xvfb ${ctx.display} pid=${ctx.xvfb.pid} XTEST=${ctx.xvfb.hasXTEST}`);
      assert(ctx.xvfb.hasXTEST, 'Xvfb must provide the XTEST extension');
      assertEqual(ctx.xvfb.width, SCREEN_WIDTH, 'Xvfb width');
      assertEqual(ctx.xvfb.height, SCREEN_HEIGHT, 'Xvfb height');
      // Never attach to a display that another session already had in use.
      const reservedInUse = [];
      if (ctx.display99Before.socket || ctx.display99Before.lock) reservedInUse.push(':99');
      if (ctx.display98Before.socket) reservedInUse.push(':98');
      assert(
        !reservedInUse.includes(ctx.display),
        `display ${ctx.display} was already in use by another session (${reservedInUse.join(', ')}); ` +
          'the test must start its own server',
      );
      // Sanity: the independent xwd pixel reference can read the fresh screen.
      setRootColor(ctx.display, '#3366cc');
      const reference = captureRootPixels(ctx.display);
      assertEqual([reference.width, reference.height], [SCREEN_WIDTH, SCREEN_HEIGHT], 'xwd reference size');
      assertPixelColor(pixelAt(reference, 5, 5), [0x33, 0x66, 0xcc], 0, 'xwd root pixel after xsetroot');
    });

    await testCase('02 Agent process starts and answers /health', async () => {
      assert(ctx.xvfb, 'Xvfb must be running');
      ctx.port = await findFreePort(preferredPort);
      fs.writeFileSync(agentLogPath, '');
      const logFd = fs.openSync(agentLogPath, 'a');
      ctx.agent = spawn(
        process.execPath,
        [
          AGENT_ENTRY,
          '--port',
          String(ctx.port),
          '--bind',
          '127.0.0.1',
          '--password',
          PASSWORD,
          '--display',
          ctx.display,
          '--fs-root',
          ctx.fsRoot,
        ],
        {
          cwd: REPO_DIR,
          env: { ...process.env, DISPLAY: ctx.display },
          stdio: ['ignore', logFd, logFd],
        },
      );
      fs.closeSync(logFd);
      console.log(`        agent pid=${ctx.agent.pid} port=${ctx.port} --display ${ctx.display}`);

      ctx.http = createHttp(`http://127.0.0.1:${ctx.port}`);
      const health = await waitFor(
        async () => {
          if (ctx.agent.exitCode !== null || ctx.agent.signalCode !== null) {
            throw new Error(
              `agent exited early (code=${ctx.agent.exitCode}, signal=${ctx.agent.signalCode}); ` +
                `log:\n${tailFile(agentLogPath)}`,
            );
          }
          try {
            const response = await ctx.http.request('/health', { timeoutMs: 2000 });
            return response.status === 200 ? response : false;
          } catch {
            return false;
          }
        },
        { timeoutMs: 20000, intervalMs: 100, label: '/health ready' },
      );
      assertEqual(health.json, { ok: true, protocol: 1 }, '/health body');
      assertMatch(health.headers.get('content-type') || '', /application\/json/, '/health content-type');
      assertEqual(health.headers.get('access-control-allow-origin'), '*', '/health CORS header');
      const log = tailFile(agentLogPath, 4000);
      assertIncludes(log, `127.0.0.1:${ctx.port}`, 'agent startup log listening address');
    });

    // ---- HTTP API ---------------------------------------------------------
    await testCase('03 HTTP auth: correct password returns a usable token', async () => {
      const response = await ctx.http.request('/api/auth', { method: 'POST', json: { password: PASSWORD } });
      assertEqual(response.status, 200, 'POST /api/auth status');
      assert(response.json && typeof response.json.token === 'string', 'auth response must carry a token');
      assert(response.json.token.length >= 32, `token looks too short: ${JSON.stringify(response.json.token)}`);
      assert(response.json.expiresAt > Date.now(), 'token expiry must be in the future');
      assertEqual(response.json.agent?.version, '1.0.0', 'auth agent.version');
      ctx.token = response.json.token;
    });

    await testCase('04 HTTP auth: wrong password → 401 invalid_password', async () => {
      const response = await ctx.http.request('/api/auth', { method: 'POST', json: { password: 'definitely-wrong' } });
      assertEqual(response.status, 401, 'wrong password status');
      assertEqual(response.json?.error, 'invalid_password', 'wrong password error code');
    });

    await testCase('05 HTTP auth: repeated failures → 429 rate_limited', async () => {
      // One failure was recorded by case 04; the limit is 5 failures/minute.
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const response = await ctx.http.request('/api/auth', { method: 'POST', json: { password: `wrong-${attempt}` } });
        assertEqual(response.status, 401, `wrong password attempt ${attempt + 2} status`);
      }
      const limited = await ctx.http.request('/api/auth', { method: 'POST', json: { password: PASSWORD } });
      assertEqual(limited.status, 429, 'rate-limited request status');
      assertEqual(limited.json?.error, 'rate_limited', 'rate-limited error code');
      assert(typeof limited.json?.retryAfterMs === 'number' && limited.json.retryAfterMs > 0, 'retryAfterMs must be positive');
      // The already-issued token keeps working while the IP is rate limited.
      const info = await ctx.http.request('/api/info', { token: ctx.token });
      assertEqual(info.status, 200, 'token must remain valid while the auth endpoint is rate limited');
    });

    await testCase('06 HTTP /api/info: missing token → 401 no_token', async () => {
      const response = await ctx.http.request('/api/info');
      assertEqual(response.status, 401, 'no-token status');
      assertEqual(response.json?.error, 'no_token', 'no-token error code');
    });

    await testCase('07 HTTP /api/info: invalid token → 401 bad_token', async () => {
      const response = await ctx.http.request('/api/info', { token: 'not-a-real-token' });
      assertEqual(response.status, 401, 'bad-token status');
      assertEqual(response.json?.error, 'bad_token', 'bad-token error code');
    });

    await testCase('08 HTTP /api/info: valid token reports screen/capabilities/fsRoot', async () => {
      const response = await ctx.http.request('/api/info', { token: ctx.token });
      assertEqual(response.status, 200, '/api/info status');
      const info = response.json;
      assertEqual(info.protocol, 1, 'info.protocol');
      assertEqual(info.agent?.platform, 'linux', 'info.agent.platform');
      assertEqual(info.screen, { width: SCREEN_WIDTH, height: SCREEN_HEIGHT, depth: 24 }, 'info.screen');
      assertEqual(
        info.capabilities,
        { screen: true, input: true, shell: true, files: true, text: true },
        'info.capabilities',
      );
      assertEqual(path.resolve(info.fsRoot), path.resolve(ctx.fsRoot), 'info.fsRoot');
      assertEqual(response.headers.get('access-control-allow-origin'), '*', '/api/info CORS header');

      // CORS preflight must answer 204.
      const preflight = await fetch(`http://127.0.0.1:${ctx.port}/api/fs/list`, {
        method: 'OPTIONS',
        headers: { Origin: 'http://example.test', 'Access-Control-Request-Method': 'GET' },
      });
      assertEqual(preflight.status, 204, 'OPTIONS preflight status');
      assertEqual(preflight.headers.get('access-control-allow-origin'), '*', 'OPTIONS CORS header');
    });

    // ---- file API ---------------------------------------------------------
    await testCase('09 FS API: upload → list → download round-trip is byte exact', async () => {
      const fileName = 'roundtrip-测试.bin';
      const target = path.join(ctx.fsRoot, fileName);
      const content = Buffer.concat([
        Buffer.from('hello-remote-file\n'),
        Buffer.from([0x00, 0x01, 0x02, 0xfe, 0xff, 0x80]),
      ]);
      const upload = await ctx.http.request(`/api/fs/upload?path=${encodeURIComponent(target)}`, {
        method: 'PUT',
        token: ctx.token,
        rawBody: content,
      });
      assertEqual(upload.status, 200, 'upload status');
      assertEqual(path.resolve(upload.json?.path || ''), path.resolve(target), 'upload response path');
      assertEqual(upload.json?.size, content.length, 'upload response size');

      const list = await ctx.http.request(`/api/fs/list?path=${encodeURIComponent(ctx.fsRoot)}`, { token: ctx.token });
      assertEqual(list.status, 200, 'list status');
      assertEqual(path.resolve(list.json.path), path.resolve(ctx.fsRoot), 'list.path');
      const entry = list.json.entries.find((item) => item.name === fileName);
      assert(entry, `list must contain ${fileName}: ${JSON.stringify(list.json.entries)}`);
      assertEqual(entry.type, 'file', 'list entry type');
      assertEqual(entry.size, content.length, 'list entry size');
      assert(typeof entry.mtimeMs === 'number' && entry.mtimeMs > 0, 'list entry mtimeMs');

      const download = await ctx.http.request(`/api/fs/download?path=${encodeURIComponent(target)}`, { token: ctx.token });
      assertEqual(download.status, 200, 'download status');
      assertEqual(download.headers.get('content-type'), 'application/octet-stream', 'download content-type');
      assertEqual(download.headers.get('content-length'), String(content.length), 'download content-length');
      assert(download.buffer.equals(content), 'download bytes must equal uploaded bytes');

      // Downloading a directory must be rejected with is_directory.
      const dirDownload = await ctx.http.request(`/api/fs/download?path=${encodeURIComponent(ctx.fsRoot)}`, { token: ctx.token });
      assertEqual(dirDownload.status, 400, 'download-directory status');
      assertEqual(dirDownload.json?.error, 'is_directory', 'download-directory error code');
    });

    await testCase('10 FS API: mkdir → rename → remove lifecycle', async () => {
      const dirPath = path.join(ctx.fsRoot, 'subdir');
      const movedPath = path.join(dirPath, 'moved.txt');
      const sourcePath = path.join(ctx.fsRoot, 'roundtrip-测试.bin');

      const mkdir = await ctx.http.request('/api/fs/mkdir', { method: 'POST', token: ctx.token, json: { path: dirPath } });
      assertEqual(mkdir.status, 200, 'mkdir status');
      assertEqual(path.resolve(mkdir.json?.path || ''), path.resolve(dirPath), 'mkdir response path');

      const rename = await ctx.http.request('/api/fs/rename', {
        method: 'POST',
        token: ctx.token,
        json: { from: sourcePath, to: movedPath },
      });
      assertEqual(rename.status, 200, 'rename status');
      assertEqual(path.resolve(rename.json?.from || ''), path.resolve(sourcePath), 'rename.from');
      assertEqual(path.resolve(rename.json?.to || ''), path.resolve(movedPath), 'rename.to');

      const dirList = await ctx.http.request(`/api/fs/list?path=${encodeURIComponent(dirPath)}`, { token: ctx.token });
      assertEqual(dirList.status, 200, 'list subdir status');
      assert(
        dirList.json.entries.some((item) => item.name === 'moved.txt' && item.type === 'file'),
        `subdir must contain moved.txt: ${JSON.stringify(dirList.json.entries)}`,
      );

      const removeFile = await ctx.http.request('/api/fs/remove', {
        method: 'POST',
        token: ctx.token,
        json: { path: movedPath },
      });
      assertEqual(removeFile.status, 200, 'remove file status');
      assertEqual(path.resolve(removeFile.json?.removed || ''), path.resolve(movedPath), 'remove.removed');

      const removeDir = await ctx.http.request('/api/fs/remove', {
        method: 'POST',
        token: ctx.token,
        json: { path: dirPath },
      });
      assertEqual(removeDir.status, 200, 'remove empty dir status');

      const rootList = await ctx.http.request(`/api/fs/list?path=${encodeURIComponent(ctx.fsRoot)}`, { token: ctx.token });
      assertEqual(rootList.status, 200, 'list root after cleanup status');
      assert(
        !rootList.json.entries.some((item) => item.name === 'subdir'),
        `subdir must be gone: ${JSON.stringify(rootList.json.entries)}`,
      );
    });

    await testCase('11 FS API: paths outside fs-root are rejected (absolute 403, relative 400), nothing leaks', async () => {
      // PROTOCOL.md §2: paths are absolute or ~-prefixed; a path that resolves
      // outside fs-root must be 403 outside_root, and a relative path is an
      // invalid_request (400). Both are rejections; neither may read outside.
      const rejectionCases = [
        { method: 'GET', pathname: `/api/fs/list?path=${encodeURIComponent('/etc')}`, expectedStatus: 403, expectedCode: 'outside_root' },
        { method: 'GET', pathname: `/api/fs/download?path=${encodeURIComponent('/etc/passwd')}`, expectedStatus: 403, expectedCode: 'outside_root' },
        { method: 'GET', pathname: `/api/fs/download?path=${encodeURIComponent('~/../../../../etc/passwd')}`, expectedStatus: 403, expectedCode: 'outside_root' },
        { method: 'GET', pathname: `/api/fs/download?path=${encodeURIComponent('../../etc/passwd')}`, expectedStatus: 400, expectedCode: 'invalid_request' },
        { method: 'POST', pathname: '/api/fs/mkdir', json: { path: '/tmp/should-not-be-created-by-e2e' }, expectedStatus: 403, expectedCode: 'outside_root' },
      ];
      for (const rejection of rejectionCases) {
        const response = await ctx.http.request(rejection.pathname, {
          method: rejection.method,
          token: ctx.token,
          json: rejection.json ?? null,
        });
        assertEqual(response.status, rejection.expectedStatus, `${rejection.method} ${rejection.pathname} status`);
        assertEqual(response.json?.error, rejection.expectedCode, `${rejection.method} ${rejection.pathname} error code`);
        assert(!response.text.includes('root:'), `${rejection.pathname} must not leak /etc/passwd contents`);
      }
      assert(!fs.existsSync('/tmp/should-not-be-created-by-e2e'), 'outside-root mkdir must not create anything');
    });

    // ---- WebSocket handshake ---------------------------------------------
    await testCase('12 WS: connection without a token is rejected with HTTP 401', async () => {
      let error = null;
      try {
        await connectWebSocket(`ws://127.0.0.1:${ctx.port}/ws`, { timeoutMs: 5000 });
      } catch (err) {
        error = err;
      }
      assert(error, 'connecting without a token must fail');
      assertEqual(error.status, 401, 'WS handshake HTTP status');
    });

    await testCase('13 WS: pre-hello message → error bad_request; hello → welcome', async () => {
      const client = await RemoteClient.connect(`ws://127.0.0.1:${ctx.port}/ws?token=${encodeURIComponent(ctx.token)}`, 'handshake');
      ctx.clients.push(client);
      const mark = client.mark();
      client.send({ t: 'screen.start', fps: 15, tile: TILE });
      const error = await client.waitForNewMessage((message) => message.t === 'error', {
        label: 'bad_request before hello',
        mark,
      });
      assertEqual(error.code, 'bad_request', 'pre-hello error code');

      const welcome = await client.hello();
      assertEqual(welcome.protocol, 1, 'welcome.protocol');
      assertMatch(welcome.session, /^[0-9a-f]{8,}$/, 'welcome.session');
      assertEqual(welcome.screen, { width: SCREEN_WIDTH, height: SCREEN_HEIGHT, depth: 24 }, 'welcome.screen');
      assertEqual(
        welcome.capabilities,
        { screen: true, input: true, shell: true, files: true, text: true },
        'welcome.capabilities',
      );
      assertEqual(path.resolve(welcome.fsRoot), path.resolve(ctx.fsRoot), 'welcome.fsRoot');
      assertEqual(welcome.agent?.version, '1.0.0', 'welcome.agent.version');

      // Unknown message types must be reported as bad_request, not crash.
      const mark2 = client.mark();
      client.send({ t: 'definitely-not-a-message' });
      const unknown = await client.waitForNewMessage((message) => message.t === 'error', {
        label: 'unknown message error',
        mark: mark2,
      });
      assertEqual(unknown.code, 'bad_request', 'unknown message error code');

      // Second hello is rejected too.
      const mark3 = client.mark();
      client.send({ t: 'hello', client: 'remote-desktop-e2e', version: 1 });
      const duplicate = await client.waitForNewMessage((message) => message.t === 'error', {
        label: 'duplicate hello error',
        mark: mark3,
      });
      assertEqual(duplicate.code, 'bad_request', 'duplicate hello error code');
      await client.close();
    });

    // ---- screen ----------------------------------------------------------
    await testCase('14 WS screen: keyframe tiles decode to exact root pixel (vs xwd reference)', async () => {
      setRootColor(ctx.display, '#3366cc');
      const client = await RemoteClient.connect(`ws://127.0.0.1:${ctx.port}/ws?token=${encodeURIComponent(ctx.token)}`, 'screen');
      ctx.clients.push(client);
      ctx.mainClient = client;
      await client.hello();
      const mark = client.mark();
      client.send({ t: 'screen.start', fps: 15, tile: TILE });
      const started = await client.waitForNewMessage((message) => message.t === 'screen.started', {
        label: 'screen.started',
        mark,
      });
      assertEqual(started, { t: 'screen.started', fps: 15, tile: TILE, width: SCREEN_WIDTH, height: SCREEN_HEIGHT }, 'screen.started payload');

      const keyframe = await client.waitForNewFrame((frame) => frame.keyframe && frame.tiles.length > 0, {
        label: 'keyframe',
      });
      ctx.screenStartedAt = Date.now();
      assertFrameTilesGrid(keyframe, 'keyframe');
      assertEqual(keyframe.header.t, 'frame', 'frame header.t');
      assert(typeof keyframe.seq === 'number', 'frame seq must be numeric');
      assert(keyframe.payloadLen > 0, 'keyframe payload must not be empty');

      // The independent xwd capture is taken immediately after the frame; the
      // screen is static here so both must agree pixel-for-pixel.
      const reference = captureRootPixels(ctx.display);
      for (const [x, y] of [[5, 5], [640, 400], [1279, 799], [100, 700], [1234, 56]]) {
        const agentPixel = client.pixelAt(x, y);
        const referencePixel = pixelAt(reference, x, y);
        assertEqual(rgbOf(agentPixel), rgbOf(referencePixel), `agent vs xwd pixel at (${x},${y})`);
        assertPixelColor(agentPixel, [0x33, 0x66, 0xcc], 0, `agent pixel(${x},${y}) = #3366cc`);
      }
      assertNoDecodeErrors(client);
    });

    await testCase('15 WS screen: incremental frames (partial tiles), recolor < 260 tiles, refresh → keyframe', async () => {
      const client = ctx.mainClient;
      assert(client, 'screen client from case 14 must exist');

      // A real window appearing after the keyframe must produce a limited,
      // non-keyframe tile update.
      const beforeWindow = client.mark();
      const windowFixture = await startXterm(ctx.display, {
        geometry: '60x18+40+40',
        bg: '#ff8800',
        fg: '#000000',
        title: 'e2e-static-xterm',
        command: 'sleep 120',
        logDir: ctx.tmpDir,
      });
      ctx.fixtures.push(windowFixture);
      const geometry = getWindowGeometry(ctx.display, windowFixture.windowId);
      const partial = await client.waitForNewFrame(
        (frame) => !frame.keyframe && frame.tiles.length > 0,
        { label: 'window-appearance incremental frame', mark: beforeWindow },
      );
      assert(
        partial.tiles.length < KEYFRAME_TILES,
        `window appearance must be partial: ${partial.tiles.length} of ${KEYFRAME_TILES} tiles changed`,
      );
      const xtermPoint = [geometry.x + geometry.width - 8, geometry.y + geometry.height - 8];
      assertPixelColor(client.pixelAt(xtermPoint[0], xtermPoint[1]), [0xff, 0x88, 0x00], 2, 'xterm bg pixel in incremental frame');
      assertNoDecodeErrors(client);

      // Change the root colour: non-keyframe frame whose tiles are only the
      // changed ones (< full grid because the static xterm area does not change).
      const beforeRecolor = client.mark();
      const rootPoint = [1150, 700];
      setRootColor(ctx.display, '#cc6633');
      await client.waitForCanvasColor(rootPoint[0], rootPoint[1], [0xcc, 0x66, 0x33], {
        label: 'recolored root pixel observed through a received frame',
      });
      const recolorFrames = client.frames
        .slice(beforeRecolor.frames)
        .filter((frame) => frame.tiles.length > 0 && tileCovers(frame, rootPoint[0], rootPoint[1]));
      assert(
        recolorFrames.length > 0,
        'recolor must be delivered in a tiles-bearing frame that covers the recolored root pixel',
      );
      const recolored = recolorFrames[0];
      assert(
        recolored.tiles.length > 0 && recolored.tiles.length < KEYFRAME_TILES,
        `recolor must only resend changed tiles, got ${recolored.tiles.length} (full grid ${KEYFRAME_TILES})`,
      );
      assertPixelColor(client.pixelAt(rootPoint[0], rootPoint[1]), [0xcc, 0x66, 0x33], 0, 'recolored root pixel');
      const reference = captureRootPixels(ctx.display);
      assertEqual(rgbOf(client.pixelAt(rootPoint[0], rootPoint[1])), rgbOf(pixelAt(reference, rootPoint[0], rootPoint[1])), 'recolored pixel vs xwd');
      assertEqual(rgbOf(client.pixelAt(xtermPoint[0], xtermPoint[1])), rgbOf(pixelAt(reference, xtermPoint[0], xtermPoint[1])), 'static window pixel vs xwd');

      // screen.refresh must force a new keyframe even without any pixel change.
      const beforeRefresh = client.mark();
      client.send({ t: 'screen.refresh' });
      const refreshed = await client.waitForNewFrame((frame) => frame.keyframe, {
        label: 'refresh keyframe',
        mark: beforeRefresh,
      });
      assertFrameTilesGrid(refreshed, 'refresh keyframe');
      assertEqual(refreshed.tiles.length, KEYFRAME_TILES, 'refresh keyframe tile count');
      assertNoDecodeErrors(client);
    });

    // ---- mouse -----------------------------------------------------------
    await testCase('16 WS mouse: move/down/up produce MotionNotify + ButtonPress/Release in xev', async () => {
      const client = ctx.mainClient;
      assert(client, 'screen client must exist');
      const xev = await startXev(ctx.display, { geometry: '300x200+100+100', logDir: ctx.tmpDir });
      ctx.fixtures.push(xev);
      const geometry = getWindowGeometry(ctx.display, xev.windowId);
      const center = [geometry.x + Math.floor(geometry.width / 2), geometry.y + Math.floor(geometry.height / 2)];
      console.log(`        xev window ${xev.windowId} ${geometry.width}x${geometry.height}+${geometry.x}+${geometry.y}, center (${center[0]},${center[1]})`);

      const logBefore = readXevLog(xev.logPath).length;
      client.send({ t: 'mouse', action: 'move', x: center[0], y: center[1] });
      const motion = await waitFor(
        () => {
          const text = readXevLog(xev.logPath);
          const events = parseXevEvents(text.slice(logBefore));
          return events.find(
            (event) =>
              event.type === 'MotionNotify' &&
              event.root &&
              Math.abs(event.root.x - center[0]) <= 2 &&
              Math.abs(event.root.y - center[1]) <= 2,
          );
        },
        { timeoutMs: 6000, intervalMs: 50, label: 'xev MotionNotify at target' },
      );
      assertEqual(motion.root.x, center[0], 'MotionNotify root x');
      assertEqual(motion.root.y, center[1], 'MotionNotify root y');
      const pointer = getPointerLocation(ctx.display);
      assert(Math.abs(pointer.x - center[0]) <= 2 && Math.abs(pointer.y - center[1]) <= 2, `pointer at ${pointer.x},${pointer.y}, expected ${center[0]},${center[1]}`);

      const logBeforeClick = readXevLog(xev.logPath).length;
      client.send({ t: 'mouse', action: 'down', x: center[0], y: center[1], button: 0 });
      client.send({ t: 'mouse', action: 'up', x: center[0], y: center[1], button: 0 });
      const press = await waitFor(
        () => {
          const events = parseXevEvents(readXevLog(xev.logPath).slice(logBeforeClick));
          const buttonPress = events.find((event) => event.type === 'ButtonPress');
          const buttonRelease = events.find((event) => event.type === 'ButtonRelease');
          return buttonPress && buttonRelease ? { buttonPress, buttonRelease } : false;
        },
        { timeoutMs: 6000, intervalMs: 50, label: 'xev ButtonPress/ButtonRelease' },
      );
      assertEqual(press.buttonPress.button, 1, 'ButtonPress detail (left button → 1)');
      assertEqual(press.buttonRelease.button, 1, 'ButtonRelease detail');
      assertNoDecodeErrors(client);
    });

    // ---- keyboard --------------------------------------------------------
    await testCase('17 WS keyboard: KeyA, Shift+a state 0x1, releaseAll clears stuck modifiers (xev)', async () => {
      const client = ctx.mainClient;
      const xev = ctx.fixtures.find((fixture) => fixture.kind === 'xev');
      assert(xev, 'xev from the mouse case must exist');
      const geometry = getWindowGeometry(ctx.display, xev.windowId);
      const center = [geometry.x + Math.floor(geometry.width / 2), geometry.y + Math.floor(geometry.height / 2)];

      // Click to make sure the pointer (PointerRoot focus) is over xev.
      client.send({ t: 'mouse', action: 'down', x: center[0], y: center[1], button: 0 });
      client.send({ t: 'mouse', action: 'up', x: center[0], y: center[1], button: 0 });
      await sleep(120);

      const logBeforeA = readXevLog(xev.logPath).length;
      client.send({ t: 'key', code: 'KeyA', key: 'a', down: true, mods: { shift: false, ctrl: false, alt: false, meta: false } });
      client.send({ t: 'key', code: 'KeyA', key: 'a', down: false, mods: { shift: false, ctrl: false, alt: false, meta: false } });
      const plainA = await waitFor(
        () => {
          const events = parseXevEvents(readXevLog(xev.logPath).slice(logBeforeA));
          const press = events.find((event) => event.type === 'KeyPress' && event.keycode === 38);
          const release = events.find((event) => event.type === 'KeyRelease' && event.keycode === 38);
          return press && release ? { press, release } : false;
        },
        { timeoutMs: 6000, intervalMs: 50, label: 'xev KeyPress/KeyRelease keycode 38' },
      );
      assertEqual(plainA.press.keycode, 38, 'KeyA keycode');
      assert(plainA.press.keysym && plainA.press.keysym.value === 0x61, `KeyA keysym must be 0x61 (a), got ${JSON.stringify(plainA.press.keysym)}`);
      assertEqual(plainA.press.state & 0x1, 0, 'plain KeyA must not carry ShiftMask');

      // Shift+a: the Agent must press ShiftLeft, then 'a' arrives with ShiftMask.
      const logBeforeShift = readXevLog(xev.logPath).length;
      const shiftMods = { shift: true, ctrl: false, alt: false, meta: false };
      client.send({ t: 'key', code: 'ShiftLeft', key: 'Shift', down: true, mods: { shift: false, ctrl: false, alt: false, meta: false } });
      client.send({ t: 'key', code: 'KeyA', key: 'A', down: true, mods: shiftMods });
      client.send({ t: 'key', code: 'KeyA', key: 'A', down: false, mods: shiftMods });
      client.send({ t: 'key', code: 'ShiftLeft', key: 'Shift', down: false, mods: { shift: false, ctrl: false, alt: false, meta: false } });
      const shifted = await waitFor(
        () => {
          const events = parseXevEvents(readXevLog(xev.logPath).slice(logBeforeShift));
          const shiftPress = events.find((event) => event.type === 'KeyPress' && event.keycode === 50);
          const aPress = events.find(
            (event) => event.type === 'KeyPress' && event.keycode === 38 && (event.state & 0x1) !== 0,
          );
          return shiftPress && aPress ? { shiftPress, aPress } : false;
        },
        { timeoutMs: 6000, intervalMs: 50, label: 'xev Shift_L + ShiftMask KeyPress' },
      );
      assertEqual(shifted.shiftPress.keycode, 50, 'Shift_L keycode');
      assertEqual(shifted.aPress.state & 0x1, 0x1, 'Shift+a must carry ShiftMask (0x1)');

      // Stuck-modifier protection: press only ShiftLeft, then releaseAll, then
      // a plain 'a' must arrive without ShiftMask.
      const logBeforeReleaseAll = readXevLog(xev.logPath).length;
      client.send({ t: 'key', code: 'ShiftLeft', key: 'Shift', down: true, mods: { shift: false, ctrl: false, alt: false, meta: false } });
      await waitFor(
        () => {
          const events = parseXevEvents(readXevLog(xev.logPath).slice(logBeforeReleaseAll));
          return events.some((event) => event.type === 'KeyPress' && event.keycode === 50);
        },
        { timeoutMs: 5000, intervalMs: 50, label: 'xev Shift_L KeyPress before releaseAll' },
      );
      const logBeforeAfterRelease = readXevLog(xev.logPath).length;
      client.send({ t: 'releaseAll' });
      await sleep(120);
      client.send({ t: 'key', code: 'KeyA', key: 'a', down: true, mods: { shift: false, ctrl: false, alt: false, meta: false } });
      client.send({ t: 'key', code: 'KeyA', key: 'a', down: false, mods: { shift: false, ctrl: false, alt: false, meta: false } });
      const cleanedA = await waitFor(
        () => {
          const events = parseXevEvents(readXevLog(xev.logPath).slice(logBeforeAfterRelease));
          return events.find((event) => event.type === 'KeyPress' && event.keycode === 38) || false;
        },
        { timeoutMs: 6000, intervalMs: 50, label: 'xev KeyPress after releaseAll' },
      );
      assertEqual(cleanedA.state & 0x1, 0, 'releaseAll must release Shift so the next KeyA has no ShiftMask');
      assertNoDecodeErrors(client);
    });

    // ---- real text input through a terminal ------------------------------
    await testCase('18 WS keyboard: real characters reach xterm (typed abc + Enter → file)', async () => {
      const client = ctx.mainClient;
      const typedFile = path.join(ctx.tmpDir, 'typed-by-keys.txt');
      const xterm = await startXterm(ctx.display, {
        geometry: '60x14+500+400',
        bg: '#1b1b2f',
        fg: '#ffffff',
        title: 'e2e-typed-xterm',
        command: `read -r line; printf '%s' "$line" > ${typedFile}; read -r line2; printf '%s' "$line2" > ${path.join(ctx.tmpDir, 'typed-by-text.txt')}; sleep 120`,
        logDir: ctx.tmpDir,
      });
      ctx.fixtures.push(xterm);
      const geometry = getWindowGeometry(ctx.display, xterm.windowId);
      const center = [geometry.x + Math.floor(geometry.width / 2), geometry.y + Math.floor(geometry.height / 2)];
      await sleep(300); // let the shell reach `read`
      client.send({ t: 'mouse', action: 'down', x: center[0], y: center[1], button: 0 });
      client.send({ t: 'mouse', action: 'up', x: center[0], y: center[1], button: 0 });
      await sleep(150);

      for (const [code, key] of [['KeyA', 'a'], ['KeyB', 'b'], ['KeyC', 'c']]) {
        client.send({ t: 'key', code, key, down: true, mods: { shift: false, ctrl: false, alt: false, meta: false } });
        client.send({ t: 'key', code, key, down: false, mods: { shift: false, ctrl: false, alt: false, meta: false } });
        await sleep(60);
      }
      client.send({ t: 'key', code: 'Enter', key: 'Enter', down: true, mods: { shift: false, ctrl: false, alt: false, meta: false } });
      client.send({ t: 'key', code: 'Enter', key: 'Enter', down: false, mods: { shift: false, ctrl: false, alt: false, meta: false } });

      const content = await waitFor(
        () => {
          try {
            const text = fs.readFileSync(typedFile, 'utf8');
            return text.length > 0 ? text : false;
          } catch {
            return false;
          }
        },
        { timeoutMs: 8000, intervalMs: 100, label: 'xterm received typed "abc"' },
      );
      assertEqual(content, 'abc', 'characters delivered through the Agent key path');
      assertNoDecodeErrors(client);
    });

    await testCase('19 WS text: text injection reaches xterm (xdotool path)', async () => {
      const client = ctx.mainClient;
      assert(client.welcome?.capabilities?.text === true, 'agent must report capabilities.text=true (xdotool installed)');
      const textFile = path.join(ctx.tmpDir, 'typed-by-text.txt');
      const xterm = ctx.fixtures.find((fixture) => fixture.kind === 'xterm' && fixture.title === 'e2e-typed-xterm');
      assert(xterm, 'typed xterm from case 18 must exist');
      const geometry = getWindowGeometry(ctx.display, xterm.windowId);
      const center = [geometry.x + Math.floor(geometry.width / 2), geometry.y + Math.floor(geometry.height / 2)];
      client.send({ t: 'mouse', action: 'move', x: center[0], y: center[1] });
      await sleep(100);
      client.send({ t: 'text', text: 'xyz-text' });
      await sleep(150);
      client.send({ t: 'key', code: 'Enter', key: 'Enter', down: true, mods: { shift: false, ctrl: false, alt: false, meta: false } });
      client.send({ t: 'key', code: 'Enter', key: 'Enter', down: false, mods: { shift: false, ctrl: false, alt: false, meta: false } });
      const content = await waitFor(
        () => {
          try {
            const text = fs.readFileSync(textFile, 'utf8');
            return text.length > 0 ? text : false;
          } catch {
            return false;
          }
        },
        { timeoutMs: 8000, intervalMs: 100, label: 'xterm received injected text' },
      );
      assertEqual(content, 'xyz-text', 'text delivered through the Agent text path');
    });

    // ---- shell -----------------------------------------------------------
    await testCase('20 WS shell: shell.start/input/stop → output contains hello-2 and shell.exit', async () => {
      const client = ctx.mainClient;
      const mark = client.mark();
      client.send({ t: 'shell.start', cols: 120, rows: 32, cwd: ctx.fsRoot });
      const started = await client.waitForNewMessage((message) => message.t === 'shell.started', {
        label: 'shell.started',
        mark,
      });
      assertEqual(started.cols, 120, 'shell.started cols');
      assertEqual(started.rows, 32, 'shell.started rows');

      client.send({ t: 'shell.input', data: 'echo shell-hello-$((1+1))\r' });
      await waitFor(() => (client.shellOutput().includes('shell-hello-2') ? true : false), {
        timeoutMs: 10000,
        intervalMs: 100,
        label: 'shell output contains shell-hello-2',
      });
      assertIncludes(client.shellOutput(), 'shell-hello-2', 'shell output');
      assert(client.shellChunks.some((chunk) => chunk.stream === 'stdout'), 'shell must emit stdout chunks');

      const markStop = client.mark();
      client.send({ t: 'shell.stop' });
      const exit = await client.waitForNewMessage((message) => message.t === 'shell.exit', {
        label: 'shell.exit',
        mark: markStop,
      });
      assert(typeof exit.code === 'number', `shell.exit code must be numeric, got ${JSON.stringify(exit.code)}`);
    });

    // ---- concurrency -----------------------------------------------------
    await testCase('21 WS concurrency: two clients both receive frames; input on one keeps the other alive', async () => {
      const clientA = ctx.mainClient;
      assert(clientA, 'main client must exist');
      const clientB = await RemoteClient.connect(
        `ws://127.0.0.1:${ctx.port}/ws?token=${encodeURIComponent(ctx.token)}`,
        'concurrent-B',
      );
      ctx.clients.push(clientB);
      await clientB.hello();
      const markB = clientB.mark();
      clientB.send({ t: 'screen.start', fps: 10, tile: TILE });
      const startedB = await clientB.waitForNewMessage((message) => message.t === 'screen.started', {
        label: 'screen.started on B',
        mark: markB,
      });
      assertEqual(startedB.width, SCREEN_WIDTH, 'B screen.started width');
      const keyframeB = await clientB.waitForNewFrame((frame) => frame.keyframe && frame.tiles.length > 0, {
        label: 'keyframe on B',
      });
      assertFrameTilesGrid(keyframeB, 'client B keyframe');

      // A screen change must reach both independent frame streams.
      const markA = clientA.mark();
      const markB2 = clientB.mark();
      setRootColor(ctx.display, '#6633cc');
      await Promise.all([
        clientA.waitForCanvasColor(1100, 650, [0x66, 0x33, 0xcc], { label: 'A observes recolored pixel' }),
        clientB.waitForCanvasColor(1100, 650, [0x66, 0x33, 0xcc], { label: 'B observes recolored pixel' }),
      ]);
      const framesA = clientA.frames.slice(markA.frames).filter((frame) => frame.tiles.length > 0);
      const framesB = clientB.frames.slice(markB2.frames).filter((frame) => frame.tiles.length > 0);
      assert(framesA.length > 0, 'A must receive the change in a tiles-bearing frame');
      assert(framesB.length > 0, 'B must receive the change in a tiles-bearing frame');
      assertPixelColor(clientA.pixelAt(1100, 650), [0x66, 0x33, 0xcc], 0, 'A recolored pixel');
      assertPixelColor(clientB.pixelAt(1100, 650), [0x66, 0x33, 0xcc], 0, 'B recolored pixel');

      // Input on A must not disturb B.
      clientA.send({ t: 'mouse', action: 'move', x: 300, y: 300 });
      await clientA.ping(101);
      await clientB.ping(102);
      assert(!clientA.closed, 'client A must stay alive after input');
      assert(!clientB.closed, 'client B must stay alive while A sends input');

      // Closing B must not affect A: A keeps receiving frames.
      await clientB.close();
      const markA2 = clientA.mark();
      setRootColor(ctx.display, '#33cc66');
      await clientA.waitForCanvasColor(1100, 650, [0x33, 0xcc, 0x66], {
        label: 'A observes recolored pixel after B disconnected',
      });
      const framesA2 = clientA.frames.slice(markA2.frames).filter((frame) => frame.tiles.length > 0);
      assert(framesA2.length > 0, 'A must keep receiving tiles-bearing frames after B disconnects');
      assertPixelColor(clientA.pixelAt(1100, 650), [0x33, 0xcc, 0x66], 0, 'A pixel after B disconnect');
      await clientA.ping(103);
      assertNoDecodeErrors(clientA);
    });

    // ---- cleanup ---------------------------------------------------------
    await testCase('22 Cleanup: disconnects healthy, SIGINT exits agent, port closed, no orphans, Xvfb cleaned', async () => {
      // Disconnecting all clients must leave the agent healthy.
      for (const client of ctx.clients) {
        if (!client.closed) await client.close();
      }
      const health = await ctx.http.request('/health');
      assertEqual(health.status, 200, '/health after all clients disconnected');
      assertEqual(health.json, { ok: true, protocol: 1 }, '/health body after disconnects');

      // Record children before signalling so we can prove none survive the exit.
      const childPids = listChildren(ctx.agent.pid);
      const agentPid = ctx.agent.pid;
      process.kill(agentPid, 'SIGINT');
      const exited = await waitForExit(ctx.agent, 12000);
      assert(exited, `agent (pid ${agentPid}) did not exit within 12s after SIGINT`);
      assertEqual(ctx.agent.exitCode, 0, `agent exit code (signal=${ctx.agent.signalCode})`);
      console.log(`        agent pid ${agentPid} exited with code ${ctx.agent.exitCode}`);

      await waitFor(async () => !(await isPortOpen(ctx.port)), {
        timeoutMs: 8000,
        intervalMs: 100,
        label: `agent port ${ctx.port} closed`,
      });
      assert(!(await isPortOpen(ctx.port)), `port ${ctx.port} must be closed after agent exit`);

      await waitFor(() => childPids.filter((pid) => pidAlive(pid)).length === 0, {
        timeoutMs: 8000,
        intervalMs: 100,
        label: `agent child processes to exit (children before exit: ${JSON.stringify(childPids)})`,
      });
      const survivors = childPids.filter((pid) => pidAlive(pid));
      assertEqual(survivors, [], `agent child processes must not survive (children before exit: ${JSON.stringify(childPids)})`);

      // No agent process must be left behind (the 'exit' event means reaped).
      await waitFor(() => !pidAlive(agentPid), {
        timeoutMs: 3000,
        intervalMs: 100,
        label: `agent pid ${agentPid} to disappear`,
      });
      assert(!pidAlive(agentPid), `agent pid ${agentPid} is still alive`);

      // Xvfb cleanup is explicit in the last case; the outer finally stops it
      // again if an earlier failure left it running.
      await ctx.xvfb.stop();
      ctx.xvfbStopped = true;
      assert(!fs.existsSync(ctx.xvfb.socketPath), 'Xvfb socket must be removed');
      assert(!fs.existsSync(ctx.xvfb.lockPath), 'Xvfb lock must be removed');
      assert(!pidAlive(ctx.xvfb.pid), 'Xvfb process must be gone');
      assert(
        ctx.display99Before.socket === fs.existsSync('/tmp/.X11-unix/X99'),
        ':99 display socket was left untouched',
      );
      if (ctx.display98Before.socket) {
        assert(fs.existsSync('/tmp/.X11-unix/X98'), ':98 display socket was left untouched');
      }
    });
  } finally {
    // ---- teardown (always runs) -----------------------------------------
    for (const client of ctx.clients) {
      try {
        await client.close();
      } catch {
        /* ignore */
      }
    }
    for (const fixture of [...ctx.fixtures].reverse()) {
      try {
        await fixture.stop();
      } catch {
        /* ignore */
      }
    }
    if (ctx.agent && pidAlive(ctx.agent.pid)) {
      try {
        process.kill(ctx.agent.pid, 'SIGTERM');
      } catch {
        /* ignore */
      }
      const gone = await waitForExit(ctx.agent, 5000);
      if (!gone) {
        try {
          process.kill(ctx.agent.pid, 'SIGKILL');
        } catch {
          /* ignore */
        }
        await waitForExit(ctx.agent, 2000);
      }
    }
    if (ctx.xvfb && !ctx.xvfbStopped) {
      try {
        await ctx.xvfb.stop();
      } catch {
        /* ignore */
      }
    }

    // ---- summary ---------------------------------------------------------
    const duration = Date.now() - suiteStartedAt;
    const passed = cases.filter((entry) => entry.ok).length;
    const failed = cases.filter((entry) => !entry.ok);
    console.log('\n========================================================================');
    console.log('E2E SUMMARY');
    console.log(`  total:   ${cases.length}`);
    console.log(`  passed:  ${passed}`);
    console.log(`  failed:  ${failed.length}`);
    if (failed.length > 0) {
      console.log('  failed cases:');
      for (const entry of failed) {
        console.log(`    - ${entry.name}: ${entry.error}`);
      }
      console.log(`\n  agent log: ${agentLogPath}`);
      console.log(`  artifacts: ${tmpDir}`);
      console.log('  agent log tail:');
      console.log(tailFile(agentLogPath, 4000).replace(/^/gm, '    '));
    }
    console.log(`  duration: ${(duration / 1000).toFixed(2)}s`);
    console.log(`  result:   ${failed.length === 0 ? 'PASS' : 'FAIL'}`);
    console.log('========================================================================');

    const keep = failed.length > 0 || cli.keepArtifacts || process.env.KEEP_ARTIFACTS === '1';
    if (!keep) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        console.log(`  (temp dir removed; set KEEP_ARTIFACTS=1 to keep ${tmpDir})`);
      } catch {
        /* ignore */
      }
    } else {
      console.log(`  (temp dir kept: ${tmpDir})`);
    }
    process.exitCode = failed.length === 0 ? 0 : 1;
  }
}

main().catch((err) => {
  console.error('E2E runner crashed:', err && err.stack ? err.stack : err);
  process.exit(1);
});
