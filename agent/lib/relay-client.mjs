// Agent-side reverse relay client (cross-NAT mode, docs/RELAY.md).
//
// The agent makes one outbound WebSocket connection to a Harness relay hub and
// tunnels browser HTTP/WS traffic to its own local server (127.0.0.1:<port>).
// The tunnel is byte forwarding only: authentication and tokens are still
// verified by the local agent itself.
//
// Public API (task-10):
//   class RelayClient {
//     constructor({relayUrl, code, port, host='127.0.0.1', log, warn})
//     async start(); async stop(); readonly code
//   }
//
// Protocol summary:
//   text frames   = JSON control messages
//   binary frames = uint32le headerLen + UTF-8 JSON header + payload
//   heartbeat: ping every 15s, close after 45s of silence, backoff reconnect
//   1/2/4/8/16/30s until stop() is called.

import http from 'node:http';
import crypto from 'node:crypto';
import os from 'node:os';
import { connectWebSocket } from './ws.mjs';

// The relay lives under the `/api/auth/` prefix, which the Harness
// `dsh-web-startup-auth` plugin leaves public (the agent has no browser login).
const RELAY_AGENT_PATH = '/api/auth/remote-desktop/relay/agent';
const RELAY_PROTOCOL = 1;

const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];
const HEARTBEAT_INTERVAL_MS = 15000;
const HEARTBEAT_CHECK_MS = 5000;
const IDLE_TIMEOUT_MS = 45000;
const READY_TIMEOUT_MS = 15000;
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_FRAME_PAYLOAD = 16 * 1024 * 1024;
const BODY_CHUNK_BYTES = 64 * 1024;
const BACKPRESSURE_BYTES = 4 * 1024 * 1024;
const STOP_CLOSE_TIMEOUT_MS = 1500;

const CODE_RE = /^[A-Za-z0-9_-]{6,32}$/;

/** True when `value` is a valid relay access code (6-32 chars A-Z a-z 0-9 _ -). */
export function isValidRelayCode(value) {
  return typeof value === 'string' && CODE_RE.test(value);
}
const CODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

// Headers the relay host is allowed to forward to the agent (RELAY.md §2.3).
const FORWARDED_REQUEST_HEADERS = new Set([
  'authorization',
  'content-type',
  'accept',
  'accept-language',
  'range',
  'if-none-match',
  'if-modified-since',
  'cache-control',
]);

// Hop-by-hop / local-connection headers that must not be relayed as response
// headers. (Node already lower-cases the names in res.headers.)
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
]);

export function generateRelayCode(length = 10) {
  const size = Math.max(6, Math.min(32, Math.trunc(Number(length) || 10)));
  const bytes = crypto.randomBytes(size);
  let code = '';
  for (let i = 0; i < size; i += 1) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return code;
}

export function buildAgentUrl(relayUrl, code, relayToken = null) {
  let url;
  try {
    url = new URL(String(relayUrl));
  } catch {
    throw new Error(`invalid relay URL: ${relayUrl}`);
  }
  let protocol;
  if (url.protocol === 'https:' || url.protocol === 'wss:') protocol = 'wss:';
  else if (url.protocol === 'http:' || url.protocol === 'ws:') protocol = 'ws:';
  else throw new Error(`unsupported relay URL protocol: ${url.protocol} (expected http(s) or ws(s))`);

  let basePath = url.pathname && url.pathname !== '/' ? url.pathname : '';
  while (basePath.endsWith('/')) basePath = basePath.slice(0, -1);
  const target = new URL(`${protocol}//${url.host}${basePath}${RELAY_AGENT_PATH}`);
  target.searchParams.set('code', code);
  if (relayToken) target.searchParams.set('token', relayToken);
  return target.toString();
}

function normalizeCode(input) {
  if (input === undefined || input === null || input === '') return generateRelayCode();
  const code = String(input);
  if (!isValidRelayCode(code)) {
    throw new Error(`invalid relay code: ${JSON.stringify(code)} (6-32 characters of A-Z a-z 0-9 _ -)`);
  }
  return code;
}

function filterRequestHeaders(headers) {
  const out = {};
  if (!headers || typeof headers !== 'object') return out;
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = String(rawName).toLowerCase();
    if (!FORWARDED_REQUEST_HEADERS.has(name)) continue;
    if (rawValue === undefined || rawValue === null) continue;
    out[name] = Array.isArray(rawValue) ? rawValue.join(', ') : String(rawValue);
  }
  return out;
}

function filterResponseHeaders(headers) {
  const out = {};
  if (!headers || typeof headers !== 'object') return out;
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = String(rawName).toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(name)) continue;
    if (rawValue === undefined || rawValue === null) continue;
    out[name] = Array.isArray(rawValue) ? rawValue.join(', ') : String(rawValue);
  }
  return out;
}

function sliceIntoChunks(buffer, size = BODY_CHUNK_BYTES) {
  if (!buffer || buffer.length === 0) return [];
  const chunks = [];
  for (let offset = 0; offset < buffer.length; offset += size) {
    chunks.push(buffer.subarray(offset, Math.min(buffer.length, offset + size)));
  }
  return chunks;
}

export class RelayClient {
  constructor(options = {}) {
    const {
      relayUrl,
      code,
      port,
      host = '127.0.0.1',
      log = console.log,
      warn = console.warn,
      relayToken = null,
      platform = null,
    } = options;
    if (!relayUrl) throw new Error('relayUrl is required');
    if (!Number.isInteger(Number(port)) || Number(port) <= 0 || Number(port) > 65535) {
      throw new Error(`invalid local agent port: ${port}`);
    }
    this.relayUrl = String(relayUrl);
    this.port = Number(port);
    this.host = host;
    this._relayToken = relayToken || null;
    this._platformName = platform === 'win32' || (!platform && process.platform === 'win32') ? 'win32' : 'linux';
    this._log = typeof log === 'function' ? log : () => {};
    this._warn = typeof warn === 'function' ? warn : () => {};

    const resolvedCode = normalizeCode(code);
    Object.defineProperty(this, 'code', {
      value: resolvedCode,
      enumerable: true,
      writable: false,
      configurable: false,
    });
    this.agentUrl = buildAgentUrl(this.relayUrl, resolvedCode, this._relayToken);

    this._ws = null;
    this._started = false;
    this._stopped = false;
    this._allowReconnect = true;
    this._generation = 0;
    this._reconnectAttempt = 0;
    this._reconnectTimer = null;
    this._readyTimer = null;
    this._heartbeatTimer = null;
    this._lastMessageAt = 0;
    this._lastPingAt = 0;
    this._lastError = null;
    this._receivedReady = false;
    this._hostCloseReason = null;
    this._httpSessions = new Map();
    this._wsSessions = new Map();
  }

  get connected() {
    return Boolean(this._ws && this._ws.readyState === 1);
  }

  async start() {
    if (this._started) return;
    if (typeof WebSocket !== 'function') {
      throw new Error('relay mode requires Node.js >= 22 (global WebSocket is not available)');
    }
    this._started = true;
    this._stopped = false;
    this._allowReconnect = true;
    this._reconnectAttempt = 0;
    this._connect();
  }

  async stop() {
    if (this._stopped) return;
    this._stopped = true;
    this._allowReconnect = false;
    this._clearReconnectTimer();
    this._clearReadyTimer();
    this._stopHeartbeat();
    this._closeLocalSessions();
    const ws = this._ws;
    this._ws = null;
    if (ws) {
      await new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(finish, STOP_CLOSE_TIMEOUT_MS);
        timer.unref?.();
        try {
          ws.addEventListener('close', finish, { once: true });
        } catch {
          /* ignore */
        }
        try {
          ws.close(1000, 'agent shutdown');
        } catch {
          finish();
        }
        if (ws.readyState === 3) finish();
      });
    }
    this._log('[relay] stopped');
  }

  // ---- connection lifecycle ------------------------------------------------

  _connect() {
    if (this._stopped) return;
    const generation = (this._generation += 1);
    this._receivedReady = false;
    this._hostCloseReason = null;
    this._lastError = null;
    let ws;
    try {
      ws = new WebSocket(this.agentUrl);
    } catch (err) {
      this._scheduleReconnect(err && err.message ? err.message : String(err));
      return;
    }
    this._ws = ws;
    try {
      ws.binaryType = 'arraybuffer';
    } catch {
      /* ignore */
    }

    const isCurrent = () => generation === this._generation;

    ws.addEventListener('open', () => {
      if (!isCurrent() || this._stopped) return;
      this._lastMessageAt = Date.now();
      this._lastPingAt = Date.now();
      // The host must send relay.ready right away; guard against a silent peer.
      this._readyTimer = setTimeout(() => {
        this._readyTimer = null;
        if (!isCurrent() || this._stopped || this._receivedReady) return;
        this._warn(`[relay] connect failed: no relay.ready within ${READY_TIMEOUT_MS / 1000}s`);
        try {
          ws.close(4000, 'ready timeout');
        } catch {
          /* ignore */
        }
      }, READY_TIMEOUT_MS);
      this._readyTimer.unref?.();
    });

    ws.addEventListener('message', (event) => {
      if (!isCurrent() || this._stopped) return;
      try {
        this._onWsData(event.data);
      } catch (err) {
        this._warn(`[relay] protocol error: ${err && err.message ? err.message : err}`);
        this._sendError('internal relay error');
      }
    });

    ws.addEventListener('error', () => {
      if (!isCurrent()) return;
      this._lastError = 'websocket error';
    });

    ws.addEventListener('close', (event) => {
      if (!isCurrent()) return;
      this._handleSocketClosed(event && event.code, event && event.reason);
    });
  }

  _handleSocketClosed(code, reason) {
    this._ws = null;
    this._clearReadyTimer();
    this._stopHeartbeat();
    this._closeLocalSessions();
    if (this._stopped) return;
    if (this._hostCloseReason === 'replaced' || code === 4001) {
      this._allowReconnect = false;
      this._warn('[relay] connection replaced by another agent with the same code; relay disabled');
      return;
    }
    const detail = reason ? `${reason}` : this._lastError || 'connection closed';
    this._scheduleReconnect(`closed (code=${code == null ? 'unknown' : code}, ${detail})`);
  }

  _scheduleReconnect(reason) {
    if (this._stopped || !this._allowReconnect) return;
    this._clearReconnectTimer();
    const delay = BACKOFF_MS[Math.min(this._reconnectAttempt, BACKOFF_MS.length - 1)];
    this._reconnectAttempt += 1;
    this._warn(`[relay] connect failed: ${reason} (retry in ${delay / 1000}s)`);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._connect();
    }, delay);
    this._reconnectTimer.unref?.();
  }

  _clearReconnectTimer() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }

  _clearReadyTimer() {
    if (this._readyTimer) {
      clearTimeout(this._readyTimer);
      this._readyTimer = null;
    }
  }

  // ---- heartbeat -----------------------------------------------------------

  _startHeartbeat() {
    this._stopHeartbeat();
    this._lastMessageAt = Date.now();
    this._lastPingAt = Date.now();
    this._heartbeatTimer = setInterval(() => {
      if (this._stopped) return;
      const ws = this._ws;
      if (!ws || ws.readyState !== 1) return;
      const now = Date.now();
      if (now - this._lastMessageAt > IDLE_TIMEOUT_MS) {
        this._warn(`[relay] no traffic for ${Math.round((now - this._lastMessageAt) / 1000)}s; reconnecting`);
        try {
          ws.close(4000, 'idle timeout');
        } catch {
          /* ignore */
        }
        return;
      }
      if (now - this._lastPingAt >= HEARTBEAT_INTERVAL_MS) {
        this._lastPingAt = now;
        this._sendText({ t: 'ping' });
      }
    }, HEARTBEAT_CHECK_MS);
    this._heartbeatTimer.unref?.();
  }

  _stopHeartbeat() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  // ---- inbound -------------------------------------------------------------

  _onWsData(data) {
    this._lastMessageAt = Date.now();
    if (typeof data === 'string') {
      let message;
      try {
        message = JSON.parse(data);
      } catch {
        this._sendError('invalid JSON control message');
        return;
      }
      if (!message || typeof message !== 'object' || Array.isArray(message)) {
        this._sendError('control message must be a JSON object');
        return;
      }
      this._onControlMessage(message);
      return;
    }
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
    this._onBinaryFrame(buffer);
  }

  _onControlMessage(message) {
    switch (message.t) {
      case 'relay.ready':
        this._handleRelayReady(message);
        return;
      case 'relay.close':
        this._handleRelayClose(message);
        return;
      case 'http.request':
        this._handleHttpRequest(message);
        return;
      case 'http.end':
        this._handleHttpEnd(message);
        return;
      case 'http.abort':
        this._handleHttpAbort(message);
        return;
      case 'ws.open':
        this._handleWsOpen(message);
        return;
      case 'ws.msg':
        this._handleWsTextMessage(message);
        return;
      case 'ws.close':
        this._handleWsClose(message);
        return;
      case 'ping':
        this._sendText({ t: 'pong' });
        return;
      case 'pong':
        return;
      case 'error':
        this._warn(`[relay] host error: ${message.message || 'unknown'}`);
        return;
      default:
        this._sendError(`unknown relay message type: ${String(message.t)}`);
    }
  }

  _onBinaryFrame(buffer) {
    if (buffer.length < 4) {
      this._sendError('binary frame too short');
      return;
    }
    const headerLength = buffer.readUInt32LE(0);
    if (headerLength <= 0 || 4 + headerLength > buffer.length) {
      this._sendError('invalid binary frame header length');
      return;
    }
    let header;
    try {
      header = JSON.parse(buffer.subarray(4, 4 + headerLength).toString('utf8'));
    } catch {
      this._sendError('invalid binary frame JSON header');
      return;
    }
    const payload = buffer.subarray(4 + headerLength);
    if (!header || typeof header !== 'object') {
      this._sendError('binary frame header must be an object');
      return;
    }
    switch (header.t) {
      case 'http.body':
        this._handleHttpBody(header, payload);
        return;
      case 'ws.msg':
        this._handleWsBinaryMessage(header, payload);
        return;
      default:
        this._sendError(`unknown binary message type: ${String(header.t)}`);
    }
  }

  _handleRelayReady(message) {
    this._clearReadyTimer();
    this._receivedReady = true;
    this._reconnectAttempt = 0;
    this._allowReconnect = true;
    const info = this._agentIdentity();
    let host = this.agentUrl;
    try {
      host = new URL(this.agentUrl).host;
    } catch {
      /* ignore */
    }
    // Log before relay.hello: the host marks the tunnel registered when it
    // receives hello, and a synchronous log sink lets callers (and their logs)
    // observe "connected" first.
    this._log(`[relay] connected ${host} 接入码: ${this.code}`);
    this._sendText({ t: 'relay.hello', agent: info, code: this.code });
    this._startHeartbeat();
  }

  _handleRelayClose(message) {
    const reason = message && message.reason ? String(message.reason) : '';
    this._hostCloseReason = reason || null;
    if (reason === 'replaced') {
      this._allowReconnect = false;
    }
    this._warn(`[relay] host closed the tunnel${reason ? `: ${reason}` : ''}`);
    const ws = this._ws;
    if (ws && ws.readyState <= 1) {
      try {
        ws.close(reason === 'replaced' ? 4001 : 4000, reason || 'host close');
      } catch {
        /* ignore */
      }
    }
  }

  _agentIdentity() {
    if (!this._identity) {
      let name = 'agent';
      try {
        name = os.hostname();
      } catch {
        /* ignore */
      }
      this._identity = {
        name,
        platform: this._platformName,
        version: '1.0.0',
      };
    }
    return { ...this._identity };
  }

  // ---- HTTP tunnelling -----------------------------------------------------

  _handleHttpRequest(message) {
    const id = message.id;
    if (!Number.isInteger(id)) {
      this._sendError('http.request needs an integer id');
      return;
    }
    if (typeof message.path !== 'string' || !message.path.startsWith('/')) {
      this._sendText({ t: 'http.error', id, status: 502, message: 'invalid request path' });
      return;
    }
    if (this._httpSessions.has(id)) {
      this._sendText({ t: 'http.error', id, status: 502, message: 'duplicate request id' });
      return;
    }

    const method = typeof message.method === 'string' && message.method ? message.method.toUpperCase() : 'GET';
    const headers = filterRequestHeaders(message.headers);
    const session = {
      id,
      method,
      req: null,
      res: null,
      responseStarted: false,
      ended: false,
      aborted: false,
      closed: false,
      drainTimer: null,
    };

    let req;
    try {
      req = http.request(
        {
          host: this.host,
          port: this.port,
          method,
          path: message.path,
          headers,
        },
        (res) => this._onLocalResponse(session, res),
      );
    } catch (err) {
      this._httpSessions.delete(id);
      this._sendText({ t: 'http.error', id, status: 502, message: err && err.message ? err.message : 'local request failed' });
      return;
    }

    session.req = req;
    this._httpSessions.set(id, session);

    req.on('error', (err) => {
      if (session.closed || session.aborted) return;
      session.closed = true;
      this._httpSessions.delete(id);
      if (session.responseStarted) {
        this._sendText({ t: 'http.end', id });
      } else {
        this._sendText({ t: 'http.error', id, status: 502, message: err && err.message ? err.message : 'local request failed' });
      }
    });
  }

  _onLocalResponse(session, res) {
    if (session.closed || session.aborted) {
      res.resume();
      return;
    }
    session.res = res;
    session.responseStarted = true;
    this._sendText({
      t: 'http.response',
      id: session.id,
      status: res.statusCode || 502,
      headers: filterResponseHeaders(res.headers),
    });

    if (session.method === 'HEAD') {
      res.resume();
      res.on('end', () => {
        if (session.closed || session.aborted) return;
        session.closed = true;
        this._httpSessions.delete(session.id);
        this._sendText({ t: 'http.end', id: session.id });
      });
      return;
    }

    res.on('data', (chunk) => {
      if (session.closed || session.aborted) return;
      this._sendHttpBodyChunks(session, chunk);
    });
    res.on('end', () => {
      if (session.closed || session.aborted) return;
      session.closed = true;
      this._clearDrainTimer(session);
      this._httpSessions.delete(session.id);
      this._sendText({ t: 'http.end', id: session.id });
    });
    res.on('error', () => {
      if (session.closed || session.aborted) return;
      session.closed = true;
      this._clearDrainTimer(session);
      this._httpSessions.delete(session.id);
      this._sendText({ t: 'http.end', id: session.id });
    });
    res.on('aborted', () => {
      if (session.closed) return;
      session.closed = true;
      this._clearDrainTimer(session);
      this._httpSessions.delete(session.id);
    });
  }

  _sendHttpBodyChunks(session, chunk) {
    const pieces = sliceIntoChunks(chunk, BODY_CHUNK_BYTES);
    for (const piece of pieces) {
      if (!this._sendBinary({ t: 'http.body', id: session.id }, piece)) return;
    }
    const ws = this._ws;
    if (ws && ws.bufferedAmount > BACKPRESSURE_BYTES && session.res && !session.drainTimer) {
      session.res.pause();
      this._waitForDrain(session);
    }
  }

  _waitForDrain(session) {
    if (session.closed || session.aborted || !session.res) return;
    session.drainTimer = setTimeout(() => {
      session.drainTimer = null;
      if (session.closed || session.aborted || !session.res) return;
      const ws = this._ws;
      if (!ws || ws.bufferedAmount < BACKPRESSURE_BYTES / 2) {
        session.res.resume();
      } else {
        this._waitForDrain(session);
      }
    }, 25);
    session.drainTimer.unref?.();
  }

  _clearDrainTimer(session) {
    if (session.drainTimer) {
      clearTimeout(session.drainTimer);
      session.drainTimer = null;
    }
  }

  _handleHttpBody(header, payload) {
    const session = this._httpSessions.get(header.id);
    if (!session || session.ended || session.aborted) {
      this._sendText({ t: 'error', message: `http.body for unknown request ${header.id}` });
      return;
    }
    try {
      session.req.write(payload);
    } catch {
      /* local request already gone; error handler cleans up */
    }
  }

  _handleHttpEnd(message) {
    const session = this._httpSessions.get(message.id);
    if (!session || session.aborted) {
      this._sendText({ t: 'error', message: `http.end for unknown request ${message.id}` });
      return;
    }
    if (session.ended) return;
    session.ended = true;
    try {
      session.req.end();
    } catch {
      /* error handler cleans up */
    }
  }

  _handleHttpAbort(message) {
    const session = this._httpSessions.get(message.id);
    if (!session) return;
    session.aborted = true;
    session.closed = true;
    this._clearDrainTimer(session);
    this._httpSessions.delete(message.id);
    try {
      session.req.destroy();
    } catch {
      /* ignore */
    }
  }

  // ---- WS tunnelling -------------------------------------------------------

  _handleWsOpen(message) {
    const id = message.id;
    if (!Number.isInteger(id)) {
      this._sendError('ws.open needs an integer id');
      return;
    }
    if (typeof message.path !== 'string' || !message.path.startsWith('/')) {
      this._sendText({ t: 'ws.opened', id, ok: false, error: 'invalid websocket path' });
      return;
    }
    if (this._wsSessions.has(id)) {
      this._sendText({ t: 'ws.opened', id, ok: false, error: 'duplicate websocket id' });
      return;
    }
    const url = `ws://${this.host}:${this.port}${message.path}`;
    connectWebSocket(url, { timeoutMs: 10000 })
      .then((conn) => {
        if (this._stopped || !this._ws) {
          try {
            conn.close(1001, 'relay connection gone');
          } catch {
            /* ignore */
          }
          return;
        }
        const session = { id, conn, closedSent: false };
        this._wsSessions.set(id, session);
        conn.onMessage((data, isBinary) => {
          if (session.closedSent) return;
          if (isBinary) {
            const payload = Buffer.isBuffer(data) ? data : Buffer.from(data);
            this._sendBinary({ t: 'ws.msg', id, binary: true }, payload);
          } else {
            this._sendText({ t: 'ws.msg', id, binary: false, data });
          }
        });
        conn.onClose((code, reason) => {
          if (session.closedSent) return;
          session.closedSent = true;
          this._wsSessions.delete(id);
          this._sendText({ t: 'ws.closed', id, code: Number.isInteger(code) ? code : 1000, reason: reason || '' });
        });
        this._sendText({ t: 'ws.opened', id, ok: true });
      })
      .catch((err) => {
        this._sendText({ t: 'ws.opened', id, ok: false, error: err && err.message ? err.message : 'local websocket failed' });
      });
  }

  _handleWsTextMessage(message) {
    const session = this._wsSessions.get(message.id);
    if (!session || session.closedSent) {
      this._sendText({ t: 'error', message: `ws.msg for unknown session ${message.id}` });
      return;
    }
    if (typeof message.data !== 'string') {
      this._sendError('ws.msg text frame requires a string data field');
      return;
    }
    try {
      session.conn.sendText(message.data);
    } catch {
      /* local socket already gone; its close handler reports it */
    }
  }

  _handleWsBinaryMessage(header, payload) {
    const session = this._wsSessions.get(header.id);
    if (!session || session.closedSent) {
      this._sendText({ t: 'error', message: `ws.msg for unknown session ${header.id}` });
      return;
    }
    try {
      session.conn.sendBinary(Buffer.isBuffer(payload) ? payload : Buffer.from(payload));
    } catch {
      /* local socket already gone */
    }
  }

  _handleWsClose(message) {
    const session = this._wsSessions.get(message.id);
    if (!session) {
      this._sendText({
        t: 'ws.closed',
        id: message.id,
        code: Number.isInteger(message.code) ? message.code : 1000,
        reason: message.reason || '',
      });
      return;
    }
    const code = Number.isInteger(message.code) ? message.code : 1000;
    try {
      session.conn.close(code, typeof message.reason === 'string' ? message.reason : '');
    } catch {
      /* ignore */
    }
  }

  // ---- cleanup -------------------------------------------------------------

  _closeLocalSessions() {
    for (const [, session] of this._httpSessions) {
      session.aborted = true;
      session.closed = true;
      this._clearDrainTimer(session);
      try {
        session.req.destroy();
      } catch {
        /* ignore */
      }
    }
    this._httpSessions.clear();
    for (const [, session] of this._wsSessions) {
      session.closedSent = true;
      try {
        session.conn.close(1001, 'relay disconnected');
      } catch {
        /* ignore */
      }
    }
    this._wsSessions.clear();
  }

  // ---- outbound frames -----------------------------------------------------

  _sendText(message) {
    const ws = this._ws;
    if (!ws || ws.readyState !== 1) return false;
    let text;
    try {
      text = JSON.stringify(message);
    } catch {
      return false;
    }
    if (Buffer.byteLength(text) > MAX_JSON_BYTES) {
      this._warn('[relay] dropped an oversized JSON control message');
      return false;
    }
    try {
      ws.send(text);
      return true;
    } catch {
      return false;
    }
  }

  _sendBinary(header, payload) {
    const ws = this._ws;
    if (!ws || ws.readyState !== 1) return false;
    const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || []);
    if (data.length > MAX_FRAME_PAYLOAD) {
      this._warn(`[relay] dropped an oversized binary frame (${data.length} bytes)`);
      return false;
    }
    const headerBuffer = Buffer.from(JSON.stringify(header), 'utf8');
    if (headerBuffer.length > MAX_JSON_BYTES) return false;
    const lengthBuffer = Buffer.allocUnsafe(4);
    lengthBuffer.writeUInt32LE(headerBuffer.length, 0);
    const frame = Buffer.concat([lengthBuffer, headerBuffer, data]);
    try {
      ws.send(frame);
      return true;
    } catch {
      return false;
    }
  }

  _sendError(message) {
    this._sendText({ t: 'error', message: String(message || 'relay client error') });
  }
}

export default RelayClient;
