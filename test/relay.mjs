#!/usr/bin/env node
/**
 * Cross-NAT relay E2E — independent of the Harness process.
 *
 * Topology (all on loopback, exactly the production bytes):
 *
 *   real Agent ──outbound WS──▶ node:http server ──▶ RelayHub (plugin/relay-host.mjs)
 *                                    ▲
 *   this file as the "browser" ──────┘  HTTP + WS through the relay paths
 *
 * The Agent runs with `--relay ws://127.0.0.1:<relayPort> --relay-code TESTCODE`
 * and never listens to the browser directly; every HTTP/WS assertion below is
 * made through `/api/auth/remote-desktop/relay/client/<code>/...` and
 * `/api/auth/remote-desktop/relay/ws?code=...&token=...`.
 *
 * Cases:
 *   01 relay /info contract
 *   02 Xvfb + RelayHub + real Agent registers via relay (connection log, code)
 *   03 relay HTTP auth: wrong password → 401 invalid_password
 *   04 relay HTTP auth + /api/info fields
 *   05 relay HTTP files: upload → list → download byte exact
 *   06 relay WS: hello/welcome, tile keyframe, input, shell, screen.stop, close
 *   07 unknown relay code → HTTP 404 / WS rejected
 *   08 wrong agent token via relay → rejected, tunnel unaffected
 *   09 Agent disconnect → stats drop, relay HTTP 5xx, WS rejected
 *   10 Agent restart with same code → relay recovers
 *   11 optional win32 Agent via relay → encoding="jpeg" frames
 *   12 cleanup: stats back to {agents:0,clients:0}, no residue
 *
 * Usage:
 *   node test/relay.mjs [--keep-artifacts] [--display :99] [--port 38080]
 *   bash test/run.sh    (runs test/e2e.mjs first, then this file)
 *
 * Environment: KEEP_ARTIFACTS=1 keeps the temp dir; VERBOSE=1 extra logs.
 *
 * Prerequisites: plugin/relay-host.mjs (RelayHub) and Agent `--relay` support.
 * If either is missing the startup case fails with a clear diagnostic instead
 * of silently skipping.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { startXvfb } from './lib/xvfb.mjs';
import { captureRootPixels, pixelAt } from './lib/xwd.mjs';
import { setRootColor } from './lib/x11-fixtures.mjs';
import { parseJpeg, looksLikeJpeg } from './lib/jpeg.mjs';
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
const RELAY_HOST_ENTRY = path.join(REPO_DIR, 'plugin', 'relay-host.mjs');
const WIN_HELPER = path.join(REPO_DIR, 'test', 'fixtures', 'fake-win-helper.mjs');

const PASSWORD = 'relay-pass';
const CODE = 'TESTCODE';
const WIN_CODE = 'WIN32CODE';
const SCREEN_WIDTH = 1280;
const SCREEN_HEIGHT = 800;
const TILE = 64;
const KEYFRAME_TILES = Math.ceil(SCREEN_WIDTH / TILE) * Math.ceil(SCREEN_HEIGHT / TILE); // 260
const RELAY_PREFIX = '/api/auth/remote-desktop/relay';

const RELAY_INFO = {
  enabled: true,
  protocol: 1,
  agentPath: '/api/auth/remote-desktop/relay/agent',
  clientPath: '/api/auth/remote-desktop/relay/client',
  wsPath: '/api/auth/remote-desktop/relay/ws',
};

// ---- tiny test runner ------------------------------------------------------

const suiteStartedAt = Date.now();
const cases = [];
let fatal = false;

async function testCase(name, fn) {
  if (fatal) {
    cases.push({ name, ok: false, error: 'not run: a prerequisite/startup step failed' });
    console.log(`FAIL ${String(cases.length).padStart(2, '0')} ${name} — not run (startup failed)`);
    return;
  }
  const startedAt = Date.now();
  try {
    await fn();
    const duration = Date.now() - startedAt;
    cases.push({ name, ok: true, duration });
    console.log(`PASS ${String(cases.length).padStart(2, '0')} ${name} (${duration}ms)`);
  } catch (err) {
    const duration = Date.now() - startedAt;
    cases.push({ name, ok: false, duration, error: formatError(err) });
    console.log(`FAIL ${String(cases.length).padStart(2, '0')} ${name} (${duration}ms) — ${formatError(err)}`);
  }
}

// ---- shared helpers --------------------------------------------------------

function tailFile(filePath, maxChars = 4000) {
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
  for (let port = startPort; port < startPort + 200; port += 1) {
    if (await isPortFree(port)) return port;
  }
  throw new Error(`no free TCP port in ${startPort}..${startPort + 199}`);
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

function listChildren(pid) {
  const result = spawnSync('ps', ['-o', 'pid=', '--ppid', String(pid)], { encoding: 'utf8' });
  return (result.stdout || '')
    .split('\n')
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((value) => Number.isFinite(value));
}

// ---- relay hub mounting on a plain node:http server ------------------------

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve(server.address().port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

async function startRelayServer(RelayHub, { log }) {
  const hub = new RelayHub({ log });
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (url.pathname === `${RELAY_PREFIX}/info`) {
        await hub.handleInfo(req, res);
        return;
      }
      if (url.pathname.startsWith(`${RELAY_PREFIX}/client/`)) {
        await hub.handleHttp(req, res);
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'not_found', message: `no relay route for ${url.pathname}` }));
    } catch (err) {
      log(`relay request handler error: ${err && err.stack ? err.stack : err}`);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'relay_error', message: err && err.message ? err.message : String(err) }));
      } else if (!res.writableEnded) {
        res.destroy();
      }
    }
  });
  server.on('upgrade', (req, socket, head) => {
    let pathname = '';
    try {
      pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname;
    } catch {
      socket.destroy();
      return;
    }
    try {
      if (pathname === `${RELAY_PREFIX}/agent`) {
        hub.handleAgentUpgrade(req, socket, head);
        return;
      }
      if (pathname === `${RELAY_PREFIX}/ws`) {
        hub.handleClientUpgrade(req, socket, head);
        return;
      }
    } catch (err) {
      log(`relay upgrade handler error: ${err && err.stack ? err.stack : err}`);
      socket.destroy();
      return;
    }
    socket.destroy();
  });

  const port = await listen(server, 0);
  return {
    hub,
    server,
    port,
    async close() {
      try {
        hub.close();
      } catch {
        /* ignore */
      }
      try {
        server.closeAllConnections?.();
      } catch {
        /* ignore */
      }
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

function hubStats(hub) {
  try {
    const value = typeof hub.stats === 'function' ? hub.stats() : hub.stats;
    if (value && typeof value === 'object') {
      return {
        agents: Number(value.agents) || 0,
        clients: Number(value.clients) || 0,
      };
    }
  } catch {
    /* fall through */
  }
  return { agents: NaN, clients: NaN };
}

// ---- HTTP client through the relay ----------------------------------------

function createRelayHttp(relayBase) {
  async function request(
    pathname,
    { method = 'GET', token = null, json = null, rawBody = null, contentType = null, timeoutMs = 15000 } = {},
  ) {
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
    const response = await fetch(`${relayBase}${pathname}`, {
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

// ---- browser-side WS client through the relay -----------------------------

class RelayClient {
  constructor(conn, name) {
    this.conn = conn;
    this.name = name;
    this.messages = [];
    this.frames = [];
    this.shellChunks = [];
    this.closed = false;
    this.closeInfo = null;
    this.canvas = null;
    this.canvasWidth = 0;
    this.canvasHeight = 0;
    this.decodeErrors = [];
    this.welcome = null;

    conn.onMessage((data, isBinary) => {
      try {
        if (isBinary) this._handleBinary(data);
        else this.messages.push(JSON.parse(data));
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
    return new RelayClient(conn, name);
  }

  _handleBinary(data) {
    assert(data.length >= 4, `${this.name}: binary message shorter than header length`);
    const headerLength = data.readUInt32LE(0);
    assert(headerLength > 0 && 4 + headerLength <= data.length, `${this.name}: bad relay frame header`);
    const header = JSON.parse(data.subarray(4, 4 + headerLength).toString('utf8'));
    const payload = data.subarray(4 + headerLength);
    if (header.t === 'shell.data') {
      this.shellChunks.push({ stream: header.stream === 'stderr' ? 'stderr' : 'stdout', text: payload.toString('utf8') });
      return;
    }
    if (header.t !== 'frame') return;
    const width = Number(header.width);
    const height = Number(header.height);
    const encoding = header.encoding === 'jpeg' ? 'jpeg' : 'tiles';
    assertEqual(payload.length, Number(header.payloadLen), `${this.name}: frame payloadLen`);
    if (encoding === 'jpeg') {
      this.frames.push({ header, encoding, payload: Buffer.from(payload), payloadLen: payload.length, seq: header.seq, keyframe: true, tiles: [] });
      return;
    }
    if (!this.canvas || this.canvasWidth !== width || this.canvasHeight !== height) {
      this.canvas = Buffer.alloc(width * height * 4);
      this.canvasWidth = width;
      this.canvasHeight = height;
    }
    let tileArea = 0;
    for (const tile of header.tiles) {
      const raw = zlib.inflateSync(payload.subarray(tile.off, tile.off + tile.len));
      assertEqual(raw.length, tile.w * tile.h * 4, `${this.name}: tile ${tile.x},${tile.y} inflated size`);
      for (let row = 0; row < tile.h; row += 1) {
        raw.copy(this.canvas, ((tile.y + row) * width + tile.x) * 4, row * tile.w * 4, row * tile.w * 4 + tile.w * 4);
      }
      tileArea += tile.w * tile.h;
    }
    this.frames.push({ header, encoding, tiles: header.tiles, payloadLen: payload.length, tileArea, seq: header.seq, keyframe: Boolean(header.keyframe) });
  }

  send(message) {
    this.conn.sendText(JSON.stringify(message));
  }

  mark() {
    return { messages: this.messages.length, frames: this.frames.length };
  }

  _scanMessages(predicate, from = 0) {
    for (let i = from; i < this.messages.length; i += 1) if (predicate(this.messages[i])) return this.messages[i];
    return false;
  }

  _scanFrames(predicate, from = 0) {
    for (let i = from; i < this.frames.length; i += 1) if (predicate(this.frames[i])) return this.frames[i];
    return false;
  }

  async waitForMessage(predicate, { timeoutMs = 8000, label = 'message', from = 0 } = {}) {
    return await waitFor(() => this._scanMessages(predicate, from), { timeoutMs, intervalMs: 25, label: `${this.name}: ${label}` });
  }

  async waitForNewMessage(predicate, { timeoutMs = 8000, label = 'message', mark = null } = {}) {
    return await this.waitForMessage(predicate, { timeoutMs, label, from: mark ? mark.messages : this.messages.length });
  }

  async waitForFrame(predicate, { timeoutMs = 10000, label = 'frame', from = 0 } = {}) {
    return await waitFor(() => this._scanFrames(predicate, from), { timeoutMs, intervalMs: 25, label: `${this.name}: ${label}` });
  }

  async waitForNewFrame(predicate, { timeoutMs = 10000, label = 'frame', mark = null } = {}) {
    return await this.waitForFrame(predicate, { timeoutMs, label, from: mark ? mark.frames : this.frames.length });
  }

  pixelAt(x, y) {
    assert(this.canvas, `${this.name}: no decoded tile frame`);
    const offset = (y * this.canvasWidth + x) * 4;
    return [this.canvas[offset], this.canvas[offset + 1], this.canvas[offset + 2], this.canvas[offset + 3]];
  }

  shellOutput() {
    return this.shellChunks.map((chunk) => chunk.text).join('');
  }

  async hello() {
    const mark = this.mark();
    this.send({ t: 'hello', client: 'relay-e2e', version: 1 });
    const welcome = await this.waitForNewMessage((message) => message.t === 'welcome', { label: 'welcome', mark });
    this.welcome = welcome;
    return welcome;
  }

  async close() {
    if (this.closed) return;
    this.conn.close(1000, 'relay e2e done');
    await waitFor(() => this.closed, { timeoutMs: 5000, label: `${this.name}: close handshake` }).catch(() => {});
  }
}

/** Fake-helper processes scoped to one run's FAKE_HELPER_LOG (shared host safe). */
function findHelperPidsByLog(helperLogPath) {
  const pids = [];
  let entries = [];
  try {
    entries = fs.readdirSync('/proc');
  } catch {
    return pids;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid) continue;
    let environ;
    let cmdline;
    try {
      environ = fs.readFileSync(`/proc/${pid}/environ`).toString('latin1');
      cmdline = fs.readFileSync(`/proc/${pid}/cmdline`).toString('latin1');
    } catch {
      continue;
    }
    if (!cmdline.includes('fake-win-helper.mjs')) continue;
    if (!environ.split('\0').some((kv) => kv === `FAKE_HELPER_LOG=${helperLogPath}`)) continue;
    pids.push(pid);
  }
  return pids;
}


// ---- minimal raw WebSocket client for the agent-tunnel probe --------------
//
// The hub sends `relay.ready` immediately after the 101 response; depending on
// TCP coalescing it can arrive in the same chunk, before a higher-level client
// has attached handlers. This raw client parses frames itself, so no handshake
// frame is lost, and it lets the test prove ping→pong behaviour on the tunnel.

class RawAgentTunnel {
  constructor(socket, { name = 'raw-agent-tunnel' } = {}) {
    this.socket = socket;
    this.name = name;
    this.messages = [];
    this.closed = false;
    this.closeInfo = null;
    this.buffer = Buffer.alloc(0);
    this._closeCode = null;
    this._closeReason = null;
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('error', () => this._finish(1006, 'socket error'));
    socket.on('close', () => this._finish(this._closeCode ?? 1006, this._closeReason ?? 'socket closed'));
  }

  static async open({ port, code, timeoutMs = 5000, name = 'raw-agent-tunnel' }) {
    const socket = net.connect({ host: '127.0.0.1', port });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        socket.destroy();
        reject(new Error(`raw WS connect timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        socket.removeListener('connect', onConnect);
        socket.removeListener('error', onError);
      };
      const onConnect = () => {
        cleanup();
        resolve();
      };
      const onError = (err) => {
        cleanup();
        socket.destroy();
        reject(err);
      };
      socket.once('connect', onConnect);
      socket.once('error', onError);
    });

    const key = crypto.randomBytes(16).toString('base64');
    socket.write(
      `GET /api/auth/remote-desktop/relay/agent?code=${encodeURIComponent(code)} HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${port}\r\n` +
        'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    );

    const handshake = await new Promise((resolve, reject) => {
      let buf = Buffer.alloc(0);
      const timer = setTimeout(() => {
        cleanup();
        socket.destroy();
        reject(new Error('raw WS handshake timed out'));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        socket.removeListener('data', onData);
        socket.removeListener('error', onError);
      };
      const onError = (err) => {
        cleanup();
        socket.destroy();
        reject(err);
      };
      const onData = (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        const idx = buf.indexOf('\r\n\r\n');
        if (idx === -1) return;
        cleanup();
        resolve({ head: buf.subarray(0, idx).toString('latin1'), rest: buf.subarray(idx + 4) });
      };
      socket.on('data', onData);
      socket.once('error', onError);
    });

    const statusLine = handshake.head.split('\r\n')[0] || '';
    const statusMatch = /^HTTP\/\d\.\d\s+(\d{3})/.exec(statusLine);
    const status = statusMatch ? Number(statusMatch[1]) : 0;
    if (status !== 101) {
      socket.destroy();
      const err = new Error(`raw WS upgrade failed with HTTP ${status}`);
      err.status = status;
      throw err;
    }
    const tunnel = new RawAgentTunnel(socket, { name });
    if (handshake.rest && handshake.rest.length > 0) tunnel._onData(handshake.rest);
    return tunnel;
  }

  _finish(code, reason) {
    if (this.closed) return;
    this.closed = true;
    this.closeInfo = { code, reason };
  }

  _onData(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    for (;;) {
      if (this.buffer.length < 2) return;
      const b0 = this.buffer[0];
      const b1 = this.buffer[1];
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let length = b1 & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        length = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }
      let mask = null;
      if (masked) {
        if (this.buffer.length < offset + 4) return;
        mask = this.buffer.subarray(offset, offset + 4);
        offset += 4;
      }
      if (this.buffer.length < offset + length) return;
      let payload = this.buffer.subarray(offset, offset + length);
      this.buffer = this.buffer.subarray(offset + length);
      if (mask) {
        const unmasked = Buffer.from(payload);
        for (let i = 0; i < unmasked.length; i += 1) unmasked[i] ^= mask[i % 4];
        payload = unmasked;
      }
      if (opcode === 0x1) {
        try {
          this.messages.push(JSON.parse(payload.toString('utf8')));
        } catch {
          /* ignore malformed text frame */
        }
      } else if (opcode === 0x9) {
        this._sendFrame(0xa, payload); // answer hub heartbeat
      } else if (opcode === 0x8) {
        if (payload.length >= 2) {
          this._closeCode = payload.readUInt16BE(0);
          this._closeReason = payload.subarray(2).toString('utf8');
        }
        this._finish(this._closeCode ?? 1000, this._closeReason ?? '');
        try {
          this.socket.end();
        } catch {
          /* ignore */
        }
        return;
      }
    }
  }

  _sendFrame(opcode, payload) {
    if (this.closed) return;
    const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload ?? ''), 'utf8');
    const mask = crypto.randomBytes(4);
    let header;
    if (data.length < 126) {
      header = Buffer.from([0x80 | opcode, 0x80 | data.length]);
    } else if (data.length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(data.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(data.length), 2);
    }
    const masked = Buffer.from(data);
    for (let i = 0; i < masked.length; i += 1) masked[i] ^= mask[i % 4];
    try {
      this.socket.write(Buffer.concat([header, mask, masked]));
    } catch {
      /* ignore */
    }
  }

  sendText(message) {
    this._sendFrame(0x1, JSON.stringify(message));
  }

  close(code = 1000, reason = '') {
    const reasonBytes = Buffer.from(reason, 'utf8');
    const payload = Buffer.alloc(2 + reasonBytes.length);
    payload.writeUInt16BE(code, 0);
    reasonBytes.copy(payload, 2);
    this._sendFrame(0x8, payload);
    this._finish(code, reason);
    const timer = setTimeout(() => {
      try {
        this.socket.destroy();
      } catch {
        /* ignore */
      }
    }, 50);
    timer.unref?.();
  }

  async waitForMessage(predicate, { timeoutMs = 5000, label = 'raw tunnel message' } = {}) {
    return await waitFor(
      () => {
        for (const message of this.messages) if (predicate(message)) return message;
        return false;
      },
      { timeoutMs, intervalMs: 25, label: `${this.name}: ${label}` },
    );
  }
}

// ---- Agents ---------------------------------------------------------------

async function startAgent({
  ctx,
  label,
  display = null,
  relayPort,
  relayCode,
  fsRootDir,
  noScreen = false,
  envExtra = {},
  password = PASSWORD,
}) {
  const localPort = await findFreePort(38300 + ctx.agents.length * 3);
  const agentLog = path.join(ctx.tmpDir, `agent-${label}.log`);
  fs.writeFileSync(agentLog, '');
  const args = [
    AGENT_ENTRY,
    '--port',
    String(localPort),
    '--bind',
    '127.0.0.1',
    '--password',
    password,
    '--fs-root',
    fsRootDir,
    '--relay',
    `ws://127.0.0.1:${relayPort}`,
    '--relay-code',
    relayCode,
  ];
  if (display) args.push('--display', display);
  if (noScreen) args.push('--no-screen');

  const logFd = fs.openSync(agentLog, 'a');
  const proc = spawn(process.execPath, args, {
    cwd: REPO_DIR,
    env: { ...process.env, ...envExtra },
    stdio: ['ignore', logFd, logFd],
  });
  fs.closeSync(logFd);

  const instance = { label, proc, pid: proc.pid, localPort, agentLog, relayCode, fsRootDir, stopped: false };
  ctx.agents.push(instance);

  await waitFor(
    async () => {
      if (proc.exitCode !== null || proc.signalCode !== null) {
        throw new Error(
          `agent "${label}" exited early (code=${proc.exitCode}, signal=${proc.signalCode}); log:\n${tailFile(agentLog)}`,
        );
      }
      return hubStats(ctx.hub).agents >= ctx.expectedAgents;
    },
    { timeoutMs: 25000, intervalMs: 100, label: `agent "${label}" to register through the relay` },
  );

  // The relay client is implemented in the Agent; a registered tunnel without
  // the documented connection log would be suspicious.
  const log = tailFile(agentLog, 6000);
  assertIncludes(log, '[relay]', `agent "${label}" log must mention relay status`);
  if (!noScreen) {
    assertMatch(log, new RegExp(relayCode), `agent "${label}" log must print the relay code`);
  }
  return instance;
}

async function stopAgent(instance, { signal = 'SIGINT', timeoutMs = 10000 } = {}) {
  if (!instance || instance.stopped) return instance?.proc?.exitCode ?? null;
  instance.stopped = true;
  const children = listChildren(instance.proc.pid);
  if (instance.proc.exitCode === null && instance.proc.signalCode === null) {
    try {
      process.kill(instance.proc.pid, signal);
    } catch {
      /* gone */
    }
    assert(
      await waitForExit(instance.proc, timeoutMs),
      `agent "${instance.label}" (pid ${instance.proc.pid}) did not exit within ${timeoutMs}ms after ${signal}`,
    );
  }
  await waitFor(() => children.filter(pidAlive).length === 0, {
    timeoutMs: 8000,
    intervalMs: 100,
    label: `agent "${instance.label}" children to exit`,
  }).catch(() => {});
  const survivors = children.filter(pidAlive);
  assertEqual(survivors, [], `agent "${instance.label}" child processes must not survive`);
  return instance.proc.exitCode;
}

// ---- main -----------------------------------------------------------------

async function main() {
  const cli = { keepArtifacts: process.env.KEEP_ARTIFACTS === '1', verbose: process.env.VERBOSE === '1' };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--keep-artifacts') cli.keepArtifacts = true;
    else if (arg === '--verbose' || arg === '-v') cli.verbose = true;
    else if (arg === '--display' || arg === '--port') {
      // Accepted for symmetry with test/e2e.mjs; this suite picks its own
      // loopback ports and its own X display. Consume the flag's value.
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node test/relay.mjs [--keep-artifacts] [--verbose] [--display :n] [--port n]');
      process.exit(0);
    } else if (!arg.startsWith('--')) {
      throw new Error(`unknown argument: ${arg}`);
    }
    // Other --flags are tolerated so `bash test/run.sh --anything` works.
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rdtest-relay-'));
  const fsRoot = path.join(tmpDir, 'fsroot');
  fs.mkdirSync(fsRoot, { recursive: true });
  const relayLog = path.join(tmpDir, 'relay.log');

  const ctx = {
    tmpDir,
    fsRoot,
    relayLog,
    xvfb: null,
    relay: null,
    hub: null,
    agents: [],
    clients: [],
    expectedAgents: 0,
    xvfbStopped: false,
    linuxAgent: null,
  };
  const logRelay = (message) => {
    if (cli.verbose) console.log(`        [relay-hub] ${message}`);
    try {
      fs.appendFileSync(relayLog, `[relay-hub] ${message}\n`);
    } catch {
      /* ignore */
    }
  };

  console.log('========================================================================');
  console.log('Cross-NAT relay E2E — RelayHub + real Agent + browser through the relay');
  console.log(`repo:     ${REPO_DIR}`);
  console.log(`node:     ${process.version}`);
  console.log(`temp dir: ${tmpDir}`);
  console.log('========================================================================');

  try {
    await testCase('01 relay /info exposes the documented routing contract', async () => {
      let RelayHub;
      try {
        const mod = await import(pathToFileURL(RELAY_HOST_ENTRY).href);
        RelayHub = mod.RelayHub;
      } catch (err) {
        fatal = true;
        throw new Error(
          `cannot load plugin/relay-host.mjs (${RELAY_HOST_ENTRY}): ${err.message}; ` +
            'the relay host module is a prerequisite for this suite',
        );
      }
      assert(typeof RelayHub === 'function', 'plugin/relay-host.mjs must export class RelayHub');
      ctx.relay = await startRelayServer(RelayHub, { log: logRelay });
      ctx.hub = ctx.relay.hub;

      const info = await fetch(`http://127.0.0.1:${ctx.relay.port}${RELAY_PREFIX}/info`, {
        signal: AbortSignal.timeout(5000),
      });
      assertEqual(info.status, 200, 'relay /info status');
      const body = await info.json();
      // RELAY.md documents these fields; the hub may add diagnostics such as
      // tokenRequired/agents, so assert the documented contract, not identity.
      assertEqual(
        {
          enabled: body.enabled,
          protocol: body.protocol,
          agentPath: body.agentPath,
          clientPath: body.clientPath,
          wsPath: body.wsPath,
        },
        RELAY_INFO,
        'relay /info documented fields',
      );
      if ('tokenRequired' in body) assertEqual(typeof body.tokenRequired, 'boolean', '/info tokenRequired type');
      if ('agents' in body) assertEqual(typeof body.agents, 'number', '/info agents type');
    });

    await testCase('02 Xvfb + real Linux Agent registers through the relay (code printed)', async () => {
      assert(ctx.relay, 'relay server from case 01');
      ctx.xvfb = await startXvfb({
        display: process.env.E2E_DISPLAY || process.env.DISPLAY || ':99',
        width: SCREEN_WIDTH,
        height: SCREEN_HEIGHT,
        depth: 24,
        logDir: tmpDir,
      });
      setRootColor(ctx.xvfb.display, '#3366cc');
      console.log(`        Xvfb ${ctx.xvfb.display} pid ${ctx.xvfb.pid}`);

      ctx.expectedAgents = 1;
      ctx.linuxAgent = await startAgent({
        ctx,
        label: 'linux',
        display: ctx.xvfb.display,
        relayPort: ctx.relay.port,
        relayCode: CODE,
        fsRootDir: fsRoot,
      });
      ctx.linuxAgent.http = createRelayHttp(relayClientBase(ctx.relay.port, CODE));
      // Registration is already asserted by startAgent; prove auth works over the relay.
      const auth = await waitForRelayAuth(ctx.linuxAgent.http, PASSWORD);
      ctx.linuxAgent.token = auth.token;
      assertEqual(hubStats(ctx.hub).agents, 1, 'relay stats.agents after registration');
      const log = tailFile(ctx.linuxAgent.agentLog, 6000);
      assertIncludes(log, '[relay] connected', 'agent relay connection log');
      console.log(`        agent pid ${ctx.linuxAgent.pid} relay code ${CODE}, log has "[relay] connected"`);
    });

    await testCase('03 relay HTTP auth: wrong password → 401 invalid_password', async () => {
      const agent = ctx.linuxAgent;
      const response = await agent.http.request('/api/auth', { method: 'POST', json: { password: 'wrong-password' } });
      assertEqual(response.status, 401, 'relay wrong-password status');
      assertEqual(response.json?.error, 'invalid_password', 'relay wrong-password error code');
    });

    await testCase('04 relay HTTP auth + /api/info fields', async () => {
      const agent = ctx.linuxAgent;
      const auth = await agent.http.request('/api/auth', { method: 'POST', json: { password: PASSWORD } });
      assertEqual(auth.status, 200, 'relay auth status');
      assert(auth.json?.token, 'relay auth token');
      agent.token = auth.json.token;
      const info = await agent.http.request('/api/info', { token: agent.token });
      assertEqual(info.status, 200, 'relay /api/info status');
      assertEqual(info.json.protocol, 1, 'relay info.protocol');
      assertEqual(info.json.agent.platform, 'linux', 'relay info.agent.platform');
      assertEqual(info.json.screen, { width: SCREEN_WIDTH, height: SCREEN_HEIGHT, depth: 24 }, 'relay info.screen');
      assertEqual(
        {
          screen: info.json.capabilities.screen,
          input: info.json.capabilities.input,
          shell: info.json.capabilities.shell,
          files: info.json.capabilities.files,
          text: info.json.capabilities.text,
        },
        { screen: true, input: true, shell: true, files: true, text: true },
        'relay info capabilities',
      );
      assertEqual(path.resolve(info.json.fsRoot), path.resolve(fsRoot), 'relay info.fsRoot');
      assertMatch(info.headers.get('content-type') || '', /application\/json/, 'relay forwarded content-type');
    });

    await testCase('05 relay HTTP files: upload → list → download are byte exact', async () => {
      const agent = ctx.linuxAgent;
      const name = 'relay-roundtrip-测试.bin';
      const target = path.join(fsRoot, name);
      const content = Buffer.concat([Buffer.from('relay-file-content\n'), Buffer.from([0x00, 0x01, 0xfe, 0xff])]);

      const upload = await agent.http.request(`/api/fs/upload?path=${encodeURIComponent(target)}`, {
        method: 'PUT',
        token: agent.token,
        rawBody: content,
      });
      assertEqual(upload.status, 200, 'relay upload status');
      assertEqual(upload.json?.size, content.length, 'relay upload size');

      const list = await agent.http.request(`/api/fs/list?path=${encodeURIComponent(fsRoot)}`, { token: agent.token });
      assertEqual(list.status, 200, 'relay list status');
      const entry = list.json.entries.find((item) => item.name === name);
      assert(entry, `relay list must contain ${name}`);
      assertEqual(entry.size, content.length, 'relay list entry size');

      const download = await agent.http.request(`/api/fs/download?path=${encodeURIComponent(target)}`, { token: agent.token });
      assertEqual(download.status, 200, 'relay download status');
      assertEqual(download.headers.get('content-disposition')?.includes('attachment'), true, 'relay download disposition');
      assert(download.buffer.equals(content), 'relay download bytes must equal uploaded bytes');
    });

    await testCase('06 relay WS: hello/welcome, tile keyframe, input, shell, screen.stop, close', async () => {
      const agent = ctx.linuxAgent;
      const client = await RelayClient.connect(
        relayWsUrl(ctx.relay.port, CODE, agent.token),
        'relay-linux-ws',
      );
      ctx.clients.push(client);

      const welcome = await client.hello();
      assertEqual(welcome.protocol, 1, 'relay welcome.protocol');
      assertEqual(welcome.agent.platform, 'linux', 'relay welcome.agent.platform');
      assertEqual(welcome.screen, { width: SCREEN_WIDTH, height: SCREEN_HEIGHT, depth: 24 }, 'relay welcome.screen');
      assertEqual(hubStats(ctx.hub).clients >= 1, true, 'relay stats.clients while WS is open');

      const mark = client.mark();
      client.send({ t: 'screen.start', fps: 10, tile: TILE });
      const started = await client.waitForNewMessage((message) => message.t === 'screen.started', {
        label: 'screen.started through relay',
        mark,
      });
      assertEqual([started.width, started.height], [SCREEN_WIDTH, SCREEN_HEIGHT], 'relay screen.started size');
      const keyframe = await client.waitForNewFrame((frame) => frame.keyframe && frame.tiles.length > 0, {
        label: 'tile keyframe through relay',
        mark,
      });
      assertEqual(keyframe.header.encoding, 'tiles', 'relay tile frame header.encoding');
      assertEqual(keyframe.tiles.length, KEYFRAME_TILES, 'relay keyframe tile count');
      for (const tile of keyframe.tiles) {
        assert(tile.x >= 0 && tile.y >= 0 && tile.w > 0 && tile.h > 0, 'relay tile geometry');
      }
      assertPixelColor(client.pixelAt(5, 5), [0x33, 0x66, 0xcc], 0, 'relay keyframe pixel #3366cc');
      const reference = captureRootPixels(ctx.xvfb.display);
      assertEqual(
        client.pixelAt(640, 400).slice(0, 3),
        pixelAt(reference, 640, 400).slice(0, 3),
        'relay frame pixel vs xwd reference',
      );

      // Input messages must not break the tunnel.
      client.send({ t: 'mouse', action: 'move', x: 200, y: 200 });
      client.send({ t: 'mouse', action: 'down', x: 200, y: 200, button: 0 });
      client.send({ t: 'mouse', action: 'up', x: 200, y: 200, button: 0 });
      client.send({ t: 'wheel', dx: 0, dy: 120 });
      client.send({ t: 'key', code: 'KeyA', key: 'a', down: true, mods: { shift: false, ctrl: false, alt: false, meta: false } });
      client.send({ t: 'key', code: 'KeyA', key: 'a', down: false, mods: { shift: false, ctrl: false, alt: false, meta: false } });
      client.send({ t: 'text', text: 'relay text' });
      client.send({ t: 'releaseAll' });
      await sleep(150);
      assertEqual((await agent.http.request('/health')).status, 200, 'relay /health after input');

      const shellMark = client.mark();
      client.send({ t: 'shell.start', cols: 100, rows: 30, cwd: fsRoot });
      await client.waitForNewMessage((message) => message.t === 'shell.started', { label: 'shell.started through relay', mark: shellMark });
      client.send({ t: 'shell.input', data: 'echo relay-hello-$((2+2))\r' });
      await waitFor(() => (client.shellOutput().includes('relay-hello-4') ? true : false), {
        timeoutMs: 10000,
        intervalMs: 100,
        label: 'shell output through relay contains relay-hello-4',
      });
      assertIncludes(client.shellOutput(), 'relay-hello-4', 'relay shell output');
      const exitMark = client.mark();
      client.send({ t: 'shell.stop' });
      await client.waitForNewMessage((message) => message.t === 'shell.exit', { label: 'shell.exit through relay', mark: exitMark });

      const stopMark = client.mark();
      client.send({ t: 'screen.stop' });
      await client.waitForNewMessage((message) => message.t === 'screen.stopped', { label: 'screen.stopped through relay', mark: stopMark });

      await client.close();
      await waitFor(() => hubStats(ctx.hub).clients === 0, { timeoutMs: 5000, intervalMs: 100, label: 'relay stats.clients to return to 0' });
      assertEqual(client.decodeErrors.length, 0, `relay client decode errors: ${client.decodeErrors.map((e) => e.message).join('; ')}`);
    });

    await testCase('07 unknown relay code → HTTP 404 / WS rejected', async () => {
      const unknownHttp = await fetch(
        `http://127.0.0.1:${ctx.relay.port}${RELAY_PREFIX}/client/NOSUCHCODE/api/info`,
        { signal: AbortSignal.timeout(5000) },
      );
      const unknownBody = await unknownHttp.json().catch(() => null);
      // Lead's design (option A): a code never registered by any agent is a
      // 404 relay_unknown_code; a code that has been seen but is offline is a
      // 503 relay_offline (asserted in case 10).
      assertEqual(unknownHttp.status, 404, 'never-registered code HTTP status');
      assertEqual(unknownBody?.error, 'relay_unknown_code', 'never-registered code HTTP error');

      let outcome;
      try {
        const client = await RelayClient.connect(
          relayWsUrl(ctx.relay.port, 'NOSUCHCODE', 'irrelevant'),
          'relay-unknown-code',
        );
        ctx.clients.push(client);
        const closed = await waitFor(() => (client.closed ? client.closeInfo : false), {
          timeoutMs: 5000,
          intervalMs: 50,
          label: 'unknown-code WS to be closed',
        });
        outcome = { kind: 'closed', closed };
      } catch (err) {
        outcome = { kind: 'rejected', status: err.status ?? null, message: err.message };
      }
      assert(
        outcome.kind === 'rejected' || outcome.kind === 'closed',
        `unknown relay code must reject the WS, got ${JSON.stringify(outcome)}`,
      );
      if (outcome.kind === 'rejected') {
        assert(
          [403, 404, 400].includes(outcome.status),
          `unknown-code WS handshake status should be 4xx, got ${outcome.status}`,
        );
      }
      // The registered Agent's tunnel must be unaffected.
      assertEqual(hubStats(ctx.hub).agents, 1, 'unknown code must not disturb the registered agent');
    });

    await testCase('08 wrong agent token via relay → rejected, tunnel unaffected', async () => {
      let outcome;
      try {
        const client = await RelayClient.connect(
          relayWsUrl(ctx.relay.port, CODE, 'definitely-not-a-token'),
          'relay-bad-token',
        );
        ctx.clients.push(client);
        const closed = await waitFor(() => (client.closed ? client.closeInfo : false), {
          timeoutMs: 5000,
          intervalMs: 50,
          label: 'bad-token WS to be closed',
        });
        outcome = { kind: 'closed', closed, sawWelcome: Boolean(client.welcome) };
      } catch (err) {
        outcome = { kind: 'rejected', status: err.status ?? null, message: err.message };
      }
      assert(
        outcome.kind === 'rejected' || outcome.kind === 'closed',
        `wrong token must be rejected, got ${JSON.stringify(outcome)}`,
      );
      assertEqual(outcome.sawWelcome ?? false, false, 'wrong token must never produce a welcome');
      if (outcome.kind === 'closed') {
        // relay-host accepts the browser handshake, asks the Agent, then closes
        // the browser with 1011 (agent refused the token).
        assertEqual(outcome.closed.code, 1011, 'bad-token browser close code');
        assertMatch(String(outcome.closed.reason || ''), /token|websocket|401|unauthor/i, 'bad-token close reason');
      }
      // Real token still works over the same tunnel.
      const info = await ctx.linuxAgent.http.request('/api/info', { token: ctx.linuxAgent.token });
      assertEqual(info.status, 200, 'relay tunnel must survive a bad-token attempt');
    });

    await testCase('09 relay hub heartbeat: relay.ready + agent ping answered with pong, garbage tolerated', async () => {
      const probe = await RawAgentTunnel.open({ port: ctx.relay.port, code: 'PINGCODE', name: 'probe-agent-tunnel' });
      try {
        const ready = await probe.waitForMessage((message) => message.t === 'relay.ready', {
          timeoutMs: 5000,
          label: 'host relay.ready on agent tunnel (RELAY.md §2.2)',
        });
        assertEqual(ready.protocol, 1, 'relay.ready protocol');
        probe.sendText({
          t: 'relay.hello',
          agent: { name: 'e2e-probe', platform: 'linux', version: '1.0.0' },
          code: 'PINGCODE',
        });
        await waitFor(() => hubStats(ctx.hub).agents === 2, {
          timeoutMs: 5000,
          intervalMs: 25,
          label: 'probe agent tunnel registered (stats.agents=2)',
        });
        probe.sendText({ t: 'ping' });
        const pong = await probe.waitForMessage((message) => message.t === 'pong', {
          timeoutMs: 3000,
          label: 'hub pong in response to agent ping (RELAY.md §2.2)',
        });
        assert(pong, 'the hub must answer an agent heartbeat ping with pong');
        // Unknown control messages are logged but must not kill the tunnel.
        probe.sendText({ t: 'definitely-not-a-relay-message' });
        await sleep(200);
        assertEqual(hubStats(ctx.hub).agents, 2, 'tunnel must survive an unknown control message');
      } finally {
        probe.close(1000, 'probe done');
      }
      await waitFor(() => hubStats(ctx.hub).agents === 1, {
        timeoutMs: 5000,
        intervalMs: 50,
        label: 'probe tunnel removed after close (stats.agents=1)',
      });
    });

    await testCase('10 Agent disconnect → stats drop, relay HTTP 5xx, WS rejected', async () => {
      const agent = ctx.linuxAgent;
      // Crash the agent (no graceful close) so the relay notices the dropped tunnel.
      try {
        process.kill(agent.proc.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
      await waitForExit(agent.proc, 8000);
      agent.stopped = true;
      await waitFor(() => hubStats(ctx.hub).agents === 0, {
        timeoutMs: 8000,
        intervalMs: 100,
        label: 'relay stats.agents to drop after agent crash',
      });

      const response = await agent.http.request('/api/info', { token: agent.token });
      assertEqual(response.status, 503, 'relay HTTP for a seen-but-offline code status');
      assertEqual(response.json?.error, 'relay_offline', 'relay HTTP offline error code');

      let wsError = null;
      try {
        const client = await RelayClient.connect(relayWsUrl(ctx.relay.port, CODE, agent.token), 'relay-after-crash');
        ctx.clients.push(client);
        // Contract: offline codes are rejected at the WS handshake (404), not
        // accepted and closed later.
        await waitFor(() => (client.closed ? client.closeInfo : false), {
          timeoutMs: 3000,
          intervalMs: 50,
          label: 'relay WS after agent crash to be closed',
        });
      } catch (err) {
        wsError = err;
      }
      assert(wsError, 'relay WS for an offline code must be rejected at the handshake');
      assertEqual(wsError.status, 404, 'offline-code WS handshake status');
      console.log(`        disconnected agent: relay HTTP ${response.status} ${response.json?.error}, WS handshake ${wsError.status}`);
    });

    await testCase('11 Agent restart with the same code → relay recovers', async () => {
      const old = ctx.linuxAgent;
      old.stopped = true;
      ctx.expectedAgents = 1;
      const restarted = await startAgent({
        ctx,
        label: 'linux-restart',
        display: ctx.xvfb.display,
        relayPort: ctx.relay.port,
        relayCode: CODE,
        fsRootDir: fsRoot,
      });
      restarted.http = createRelayHttp(relayClientBase(ctx.relay.port, CODE));
      const auth = await waitForRelayAuth(restarted.http, PASSWORD);
      restarted.token = auth.token;
      ctx.linuxAgent = restarted;
      const info = await restarted.http.request('/api/info', { token: restarted.token });
      assertEqual(info.status, 200, 'relay /api/info after agent restart');
      assertEqual(info.json.screen, { width: SCREEN_WIDTH, height: SCREEN_HEIGHT, depth: 24 }, 'relay screen after restart');
      assertEqual(hubStats(ctx.hub).agents, 1, 'relay stats.agents after restart');
    });

    await testCase('12 optional win32 Agent via relay → encoding="jpeg" frame', async () => {
      const helperLog = path.join(tmpDir, 'win-helper-relay.log');
      fs.writeFileSync(helperLog, '');
      ctx.expectedAgents = 2;
      const winAgent = await startAgent({
        ctx,
        label: 'win32',
        relayPort: ctx.relay.port,
        relayCode: WIN_CODE,
        fsRootDir: path.join(tmpDir, 'win-fsroot'),
        envExtra: {
          RDA_HELPER_CMD: `${process.execPath} ${WIN_HELPER}`,
          FAKE_HELPER_LOG: helperLog,
        },
      });
      ctx.winAgent = winAgent;
      winAgent.http = createRelayHttp(relayClientBase(ctx.relay.port, WIN_CODE));
      const auth = await waitForRelayAuth(winAgent.http, PASSWORD);
      winAgent.token = auth.token;
      const info = await winAgent.http.request('/api/info', { token: winAgent.token });
      assertEqual(info.json.agent.platform, 'win32', 'relay win32 info.agent.platform');
      assertEqual(info.json.screen, { width: 800, height: 600 }, 'relay win32 info.screen from helper hello');

      const client = await RelayClient.connect(relayWsUrl(ctx.relay.port, WIN_CODE, winAgent.token), 'relay-win32-ws');
      ctx.clients.push(client);
      const welcome = await client.hello();
      assertEqual(welcome.agent.platform, 'win32', 'relay win32 welcome.agent.platform');
      assertEqual(welcome.screen, { width: 800, height: 600 }, 'relay win32 welcome.screen');
      const mark = client.mark();
      client.send({ t: 'screen.start', fps: 10, quality: 65 });
      await client.waitForNewMessage((message) => message.t === 'screen.started', { label: 'win32 screen.started via relay', mark });
      const frame = await client.waitForNewFrame((candidate) => candidate.encoding === 'jpeg', {
        label: 'win32 JPEG frame via relay',
        mark,
      });
      assertEqual(frame.header.encoding, 'jpeg', 'relay win32 frame encoding');
      assertEqual([frame.header.width, frame.header.height], [800, 600], 'relay win32 frame size');
      assertEqual(frame.header.payloadLen, frame.payload.length, 'relay win32 payloadLen');
      assert(looksLikeJpeg(frame.payload), 'relay win32 payload must be FFD8…FFD9');
      const parsed = parseJpeg(frame.payload);
      assert(parsed.valid, `relay win32 JPEG must parse: ${JSON.stringify(parsed)}`);
      assertEqual([parsed.width, parsed.height], [800, 600], 'relay win32 JPEG SOF size');
      const stopMark = client.mark();
      client.send({ t: 'screen.stop' });
      await client.waitForNewMessage((message) => message.t === 'screen.stopped', { label: 'win32 screen.stopped via relay', mark: stopMark });
      await client.close();
      assertEqual(await stopAgent(winAgent), 0, 'win32 relay agent SIGINT exit code');
      ctx.expectedAgents = 1;
      await waitFor(() => hubStats(ctx.hub).agents === 1, { timeoutMs: 8000, intervalMs: 100, label: 'relay stats.agents after win32 agent exit' });
    });

    await testCase('13 cleanup: stats back to zero, no residue', async () => {
      for (const client of ctx.clients) {
        if (!client.closed) await client.close();
      }
      await stopAgent(ctx.linuxAgent);
      await waitFor(() => hubStats(ctx.hub).agents === 0 && hubStats(ctx.hub).clients === 0, {
        timeoutMs: 8000,
        intervalMs: 100,
        label: 'relay hub stats to return to {agents:0, clients:0}',
      });
      assertEqual(hubStats(ctx.hub), { agents: 0, clients: 0 }, 'relay hub stats after cleanup');
      assert(!(await isPortOpen(ctx.linuxAgent.localPort)), 'agent local port must be closed');
      const relayPort = ctx.relay.port;
      await ctx.relay.close();
      ctx.relay = null;
      await waitFor(async () => !(await isPortOpen(relayPort)), {
        timeoutMs: 5000,
        intervalMs: 100,
        label: 'relay server port closed',
      });
      await ctx.xvfb.stop();
      ctx.xvfbStopped = true;
      assert(!fs.existsSync(ctx.xvfb.socketPath), 'Xvfb socket must be removed');
      assert(!pidAlive(ctx.xvfb.pid), 'Xvfb process must be gone');
      for (const agent of ctx.agents) {
        assert(agent.proc.exitCode !== null || agent.proc.signalCode !== null, `agent "${agent.label}" must be exited`);
      }
    });
  } finally {
    // ---- teardown ------------------------------------------------------
    for (const client of ctx.clients) {
      try {
        await client.close();
      } catch {
        /* ignore */
      }
    }
    for (const agent of [...ctx.agents].reverse()) {
      if (agent.proc.exitCode === null && agent.proc.signalCode === null) {
        try {
          process.kill(agent.proc.pid, 'SIGTERM');
        } catch {
          /* gone */
        }
        if (!(await waitForExit(agent.proc, 5000))) {
          try {
            process.kill(agent.proc.pid, 'SIGKILL');
          } catch {
            /* gone */
          }
          await waitForExit(agent.proc, 2000);
        }
      }
    }
    if (ctx.relay) {
      try {
        await ctx.relay.close();
      } catch {
        /* ignore */
      }
    }
    if (ctx.xvfb && !ctx.xvfbStopped) {
      try {
        await ctx.xvfb.stop();
      } catch {
        /* ignore */
      }
    }

    // ---- summary -------------------------------------------------------
    const duration = Date.now() - suiteStartedAt;
    const passed = cases.filter((entry) => entry.ok).length;
    const failed = cases.filter((entry) => !entry.ok);
    console.log('\n========================================================================');
    console.log('RELAY E2E SUMMARY');
    console.log(`  total:   ${cases.length}`);
    console.log(`  passed:  ${passed}`);
    console.log(`  failed:  ${failed.length}`);
    if (failed.length > 0) {
      console.log('  failed cases:');
      for (const entry of failed) console.log(`    - ${entry.name}: ${entry.error}`);
      console.log(`\n  relay hub log: ${relayLog}`);
      console.log('  relay hub log tail:');
      console.log(tailFile(relayLog, 3000).replace(/^/gm, '    '));
      for (const agent of ctx.agents) {
        console.log(`  agent "${agent.label}" log tail:`);
        console.log(tailFile(agent.agentLog, 2000).replace(/^/gm, '    '));
      }
    }
    console.log(`  duration: ${(duration / 1000).toFixed(2)}s`);
    console.log(`  result:   ${failed.length === 0 ? 'PASS' : 'FAIL'}`);
    console.log('========================================================================');

    const keep = failed.length > 0 || cli.keepArtifacts;
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

function relayClientBase(relayPort, code) {
  return `http://127.0.0.1:${relayPort}${RELAY_PREFIX}/client/${encodeURIComponent(code)}`;
}

function relayWsUrl(relayPort, code, token) {
  return (
    `ws://127.0.0.1:${relayPort}${RELAY_PREFIX}/ws` +
    `?code=${encodeURIComponent(code)}&token=${encodeURIComponent(token)}`
  );
}

async function waitForRelayAuth(relayHttp, password) {
  return await waitFor(
    async () => {
      const response = await relayHttp.request('/api/auth', { method: 'POST', json: { password }, timeoutMs: 3000 });
      return response.status === 200 && response.json?.token ? response.json : false;
    },
    { timeoutMs: 20000, intervalMs: 100, label: 'relay POST /api/auth ready' },
  );
}

main().catch((err) => {
  console.error('relay E2E runner crashed:', err && err.stack ? err.stack : err);
  process.exit(1);
});
