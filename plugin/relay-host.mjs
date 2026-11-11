/**
 * Cross-NAT relay hub for the remote-desktop bundle (see docs/RELAY.md).
 *
 * The controlled host (Windows/Linux agent) cannot be dialed from a browser on a
 * normal NAT network, so it opens an outbound WebSocket to this hub instead. The
 * browser panel then talks to the agent *through* this hub over the same Harness
 * origin:
 *
 *   agent  --wss-->  /api/auth/remote-desktop/relay/agent?code=CODE
 *   browser --https--> /api/auth/remote-desktop/relay/client/CODE/<agent path>
 *   browser --wss-->  /api/auth/remote-desktop/relay/ws?code=CODE&token=<agent token>
 *
 * This module is plain Node (no cordis dependency): plugin/index.js registers the
 * four handlers on ctx.webServer, and test/relay.mjs mounts them on a bare http
 * server. It keeps the code -> tunnel mapping in memory only; payloads are never
 * logged or written to disk.
 */

import crypto from 'node:crypto';
import { WebSocketConnection } from '../agent/lib/ws.mjs';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export const RELAY_PROTOCOL = 1;
// The relay lives under the one prefix the web-startup-auth plugin leaves public
// (`/api/auth/`), because a controlled host behind NAT has no Harness login:
// the agent must be able to open its outbound tunnel without a browser session.
// Relay security does not depend on that prefix: the code is a random secret,
// the agent keeps enforcing its own password and WS token, and an optional
// DSH_REMOTE_RELAY_TOKEN can gate agent registrations.
export const RELAY_BASE = '/api/auth/remote-desktop/relay';
export const RELAY_PATHS = {
  info: `${RELAY_BASE}/info`,
  clientPrefix: `${RELAY_BASE}/client`,
  agent: `${RELAY_BASE}/agent`,
  ws: `${RELAY_BASE}/ws`,
};

const CODE_RE = /^[A-Za-z0-9_-]{6,32}$/;

const MAX_AGENTS = 128;
const MAX_CLIENTS_PER_AGENT = 8;
const MAX_INFLIGHT_HTTP = 32;
const MAX_HTTP_CHUNK = 64 * 1024;
const MAX_WS_MESSAGE = 16 * 1024 * 1024;
const MAX_WS_TEXT = 1 * 1024 * 1024;
const HEARTBEAT_MS = 15_000;
const AGENT_IDLE_MS = 45_000;
const HTTP_IDLE_TIMEOUT_MS = 120_000;
const WS_OPEN_TIMEOUT_MS = 15_000;
const MAX_JSON_BYTES = 1 * 1024 * 1024;
const UPLOAD_HIGH_WATER = 4 * 1024 * 1024;

// Only these request headers travel to the agent; everything hop-by-hop or
// browser-specific (host, connection, origin, sec-*, cookie, x-forwarded-*) stops
// here. The agent's own auth uses `authorization`.
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

const FORWARDED_RESPONSE_HEADERS = new Set([
  'content-type',
  'content-length',
  'content-disposition',
  'cache-control',
  'etag',
  'last-modified',
  'accept-ranges',
  'content-range',
]);

function now() {
  return Date.now();
}

function rejectUpgrade(socket, status, reason, message) {
  const body = Buffer.from(JSON.stringify({ error: reason, message }), 'utf8');
  const text =
    `HTTP/1.1 ${status} ${reason}\r\n` +
    'Connection: close\r\n' +
    'Content-Type: application/json; charset=utf-8\r\n' +
    `Content-Length: ${body.length}\r\n` +
    '\r\n';
  try {
    socket.write(text);
    socket.end(body);
  } catch {
    /* ignore */
  }
}

/** Complete the server side of the WebSocket handshake on an already-upgraded socket. */
function acceptWebSocket(req, socket, head) {
  if (String(req.headers.upgrade || '').toLowerCase() !== 'websocket') {
    rejectUpgrade(socket, 400, 'Bad Request', 'expected a websocket upgrade');
    return null;
  }
  const key = req.headers['sec-websocket-key'];
  if (!key || typeof key !== 'string') {
    rejectUpgrade(socket, 400, 'Bad Request', 'missing Sec-WebSocket-Key');
    return null;
  }
  if (String(req.headers['sec-websocket-version'] || '') !== '13') {
    rejectUpgrade(socket, 426, 'Upgrade Required', 'unsupported websocket version');
    return null;
  }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  const headers = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '',
    '',
  ].join('\r\n');
  try {
    socket.write(headers);
  } catch {
    try {
      socket.destroy();
    } catch {
      /* ignore */
    }
    return null;
  }
  const conn = new WebSocketConnection(socket, { isClient: false });
  if (head && head.length) conn._receive(head);
  return conn;
}

function parseUrl(req) {
  try {
    return new URL(req.url || '/', 'http://relay.invalid');
  } catch {
    return null;
  }
}

function sendJson(res, status, value, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  try {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': String(body.length),
      'Cache-Control': 'no-store',
      ...extraHeaders,
    });
    res.end(body);
  } catch {
    try {
      res.destroy();
    } catch {
      /* ignore */
    }
  }
}

function headerObject(nodeHeaders, allowSet) {
  const out = {};
  for (const [name, value] of Object.entries(nodeHeaders || {})) {
    const key = name.toLowerCase();
    if (!allowSet.has(key)) continue;
    if (Array.isArray(value)) out[key] = value.join(', ');
    else if (value !== undefined) out[key] = String(value);
  }
  return out;
}

function encodeBinaryFrame(header, payload) {
  const headerBytes = Buffer.from(JSON.stringify(header), 'utf8');
  const body = Buffer.isBuffer(payload) ? payload : Buffer.alloc(0);
  const out = Buffer.allocUnsafe(4 + headerBytes.length + body.length);
  out.writeUInt32LE(headerBytes.length, 0);
  headerBytes.copy(out, 4);
  body.copy(out, 4 + headerBytes.length);
  return out;
}

function decodeBinaryFrame(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 5) return null;
  const headerLen = buf.readUInt32LE(0);
  if (headerLen <= 0 || headerLen > MAX_JSON_BYTES || 4 + headerLen > buf.length) return null;
  let header;
  try {
    header = JSON.parse(buf.subarray(4, 4 + headerLen).toString('utf8'));
  } catch {
    return null;
  }
  if (!header || typeof header !== 'object' || Array.isArray(header)) return null;
  return { header, payload: buf.subarray(4 + headerLen) };
}

function safeClose(conn, code, reason) {
  try {
    if (conn && typeof conn.close === 'function' && !conn.closed) conn.close(code, reason);
  } catch {
    /* ignore */
  }
}

/**
 * Hub state for one connected agent. The tunnel owns its heartbeat, in-flight
 * HTTP requests and bridged browser WebSocket sessions.
 */
class AgentTunnel {
  constructor(hub, code, conn) {
    this.hub = hub;
    this.code = code;
    this.conn = conn;
    this.ready = false;
    this.hello = null;
    this.createdAt = now();
    this.lastSeen = now();
    this.pendingHttp = new Map();
    this.bridges = new Map();
    this._closed = false;

    this.heartbeat = setInterval(() => this._tick(), HEARTBEAT_MS);
    this.heartbeat.unref?.();

    conn.onMessage((data, isBinary) => this._onMessage(data, isBinary));
    conn.onClose(() => this._onClose());
  }

  get inflightHttp() {
    return this.pendingHttp.size;
  }

  sendText(value) {
    try {
      this.conn.sendText(JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  }

  sendBinary(header, payload) {
    try {
      this.conn.sendBinary(encodeBinaryFrame(header, payload));
      return true;
    } catch {
      return false;
    }
  }

  _tick() {
    if (this._closed) return;
    if (now() - this.lastSeen > AGENT_IDLE_MS) {
      this.hub._log(`agent ${this.code} idle timeout`);
      this.close(4001, 'idle timeout');
      return;
    }
    this.sendText({ t: 'ping' });
  }

  _onMessage(data, isBinary) {
    if (this._closed) return;
    this.lastSeen = now();
    if (isBinary) {
      const frame = decodeBinaryFrame(data);
      if (!frame) {
        this.hub._warn(`agent ${this.code}: invalid binary frame`);
        return;
      }
      this._onBinary(frame.header, frame.payload);
      return;
    }
    let message;
    try {
      message = JSON.parse(String(data));
    } catch {
      this.hub._warn(`agent ${this.code}: invalid JSON`);
      return;
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) return;
    this._onControl(message);
  }

  _onControl(message) {
    if (process.env.RDS_RELAY_DEBUG) this.hub._log(`agent<- ${String(message.t)} id=${message.id ?? ''}`);
    switch (message.t) {
      case 'relay.hello': {
        this.ready = true;
        this.hello = {
          name: String(message.agent?.name || 'agent').slice(0, 128),
          platform: String(message.agent?.platform || 'unknown').slice(0, 32),
          version: String(message.agent?.version || '').slice(0, 32),
        };
        this.hub._rememberCode(this.code);
        this.hub._log(
          `agent registered code=${this.code} name=${this.hello.name} platform=${this.hello.platform} agents=${this.hub._agents.size}`,
        );
        return;
      }
      case 'pong':
        return;
      case 'ping':
        this.sendText({ t: 'pong' });
        return;
      case 'http.response': {
        const pending = this.pendingHttp.get(message.id);
        if (!pending) return;
        pending.responded = true;
        pending.status = Number.isFinite(message.status) ? Number(message.status) : 502;
        pending.responseHeaders = headerObject(message.headers, FORWARDED_RESPONSE_HEADERS);
        this.hub._touchPending(pending);
        if (!pending.res.headersSent) {
          try {
            pending.res.writeHead(pending.status, pending.responseHeaders);
          } catch {
            this.hub._abortPending(pending, 'invalid response headers');
          }
        }
        if (pending.method === 'HEAD') {
          // The agent also sends http.end; nothing else to do here.
        }
        return;
      }
      case 'http.error': {
        const pending = this.pendingHttp.get(message.id);
        if (!pending) return;
        sendJson(pending.res, Number.isFinite(message.status) ? Number(message.status) : 502, {
          error: 'relay_agent_error',
          message: String(message.message || 'agent request failed'),
        });
        this.hub._finishPending(pending);
        return;
      }
      case 'http.end': {
        const pending = this.pendingHttp.get(message.id);
        if (!pending) return;
        if (!pending.res.headersSent) {
          sendJson(pending.res, 502, { error: 'relay_agent_error', message: 'agent returned no response' });
        } else {
          try {
            pending.res.end();
          } catch {
            /* ignore */
          }
        }
        this.hub._finishPending(pending);
        return;
      }
      case 'ws.opened': {
        const bridge = this.bridges.get(message.id);
        if (!bridge) return;
        if (message.ok === false) {
          bridge.opened = false;
          bridge.closeBrowser(1011, String(message.error || 'agent websocket failed').slice(0, 120));
          this.bridges.delete(bridge.id);
          return;
        }
        bridge.opened = true;
        clearTimeout(bridge.openTimer);
        bridge.openTimer = null;
        bridge.flush();
        return;
      }
      case 'ws.msg': {
        // Text frames from the agent's local /ws session (welcome, screen events,
        // shell output, errors, pong...). Binary frames arrive through _onBinary.
        const bridge = this.bridges.get(message.id);
        if (!bridge || bridge.closing) return;
        if (message.binary === true) return;
        if (typeof message.data !== 'string') {
          this.hub._warn(`agent ${this.code}: ws.msg without text data`);
          return;
        }
        if (message.data.length > MAX_WS_TEXT) {
          bridge.close(1009, 'message too large');
          return;
        }
        try {
          bridge.browser.sendText(message.data);
        } catch {
          bridge.close(1011, 'browser write failed');
        }
        return;
      }
      case 'ws.closed': {
        const bridge = this.bridges.get(message.id);
        if (!bridge) return;
        this.bridges.delete(bridge.id);
        bridge.closeBrowser(Number.isFinite(message.code) ? Number(message.code) : 1000, String(message.reason || ''));
        return;
      }
      case 'relay.close': {
        this.hub._log(`agent ${this.code} asked to close: ${String(message.reason || '')}`);
        this.close(4000, 'agent requested close');
        return;
      }
      case 'error':
        this.hub._warn(`agent ${this.code} error: ${String(message.message || '')}`);
        return;
      default:
        this.hub._warn(`agent ${this.code}: unknown message type ${String(message.t)}`);
    }
  }

  _onBinary(header, payload) {
    switch (header.t) {
      case 'http.body': {
        const pending = this.pendingHttp.get(header.id);
        if (!pending || pending.done) return;
        this.hub._touchPending(pending);
        if (!pending.res.headersSent) {
          pending.res.writeHead(200, pending.responseHeaders);
        }
        if (pending.method === 'HEAD') return;
        let ok = true;
        try {
          ok = pending.res.write(payload);
        } catch {
          this.hub._abortPending(pending, 'client write failed');
          return;
        }
        if (!ok && !pending.pausedTunnel) {
          // Pause the tunnel socket until the browser drains; otherwise a large
          // download would be buffered in memory without bound. The resume hook
          // is idempotent and also fires on finish/close, so a response that ends
          // while still "paused" can never leave the tunnel frozen.
          pending.pausedTunnel = true;
          try {
            this.conn.socket.pause();
          } catch {
            /* ignore */
          }
          const resume = () => {
            if (!pending.pausedTunnel) return;
            pending.pausedTunnel = false;
            pending.resumeTunnel = null;
            try {
              this.conn.socket.resume();
            } catch {
              /* ignore */
            }
          };
          pending.resumeTunnel = resume;
          pending.res.once('drain', resume);
          pending.res.once('finish', resume);
          pending.res.once('close', resume);
          pending.res.once('error', resume);
        }
        return;
      }
      case 'ws.msg': {
        const bridge = this.bridges.get(header.id);
        if (!bridge || bridge.closing) return;
        try {
          bridge.browser.sendBinary(payload);
        } catch {
          bridge.close(1011, 'relay forward failed');
        }
        return;
      }
      default:
        this.hub._warn(`agent ${this.code}: unknown binary type ${String(header.t)}`);
    }
  }

  _onClose() {
    if (this._closed) return;
    this._closed = true;
    clearInterval(this.heartbeat);
    this.hub._removeTunnel(this);
    for (const pending of Array.from(this.pendingHttp.values())) {
      if (!pending.res.headersSent) {
        sendJson(pending.res, 503, { error: 'relay_disconnected', message: 'the agent disconnected' });
      } else {
        try {
          pending.res.end();
        } catch {
          /* ignore */
        }
      }
      this.hub._finishPending(pending);
    }
    for (const bridge of Array.from(this.bridges.values())) {
      bridge.closeBrowser(1011, 'relay disconnected');
    }
    this.bridges.clear();
    this.hub._log(`agent disconnected code=${this.code}`);
  }

  close(code = 1000, reason = '') {
    this.sendText({ t: 'relay.close', reason: reason || 'closed' });
    safeClose(this.conn, code, reason);
  }
}

/** One browser WebSocket bridged to the agent's local /ws session. */
class WsBridge {
  constructor(tunnel, id, browser, tokenPath) {
    this.tunnel = tunnel;
    this.id = id;
    this.browser = browser;
    this.tokenPath = tokenPath;
    this.opened = false;
    this.closing = false;
    this.queued = [];
    this.queuedBytes = 0;

    this.openTimer = setTimeout(() => {
      if (!this.opened) this.close(1011, 'agent websocket timeout');
    }, WS_OPEN_TIMEOUT_MS);
    this.openTimer.unref?.();

    browser.onMessage((data, isBinary) => {
      if (this.closing) return;
      if (isBinary) {
        if (data.length > MAX_WS_MESSAGE) {
          this.close(1009, 'message too large');
          return;
        }
      } else if (String(data).length > MAX_WS_TEXT) {
        this.close(1009, 'message too large');
        return;
      }
      if (!this.opened) {
        // The agent may still be opening its local WebSocket; keep a bounded
        // queue so the browser's first frames (e.g. hello) are not lost.
        this.queued.push([isBinary, data]);
        this.queuedBytes += isBinary ? data.length : String(data).length;
        if (this.queuedBytes > MAX_WS_MESSAGE) {
          this.close(1009, 'queued messages too large');
        }
        return;
      }
      this._forward(data, isBinary);
    });
    browser.onClose((code, reason) => {
      if (this.closing) return;
      this.closing = true;
      clearTimeout(this.openTimer);
      tunnel.sendText({ t: 'ws.close', id: this.id, code: Number(code) || 1000, reason: String(reason || '') });
      tunnel.bridges.delete(this.id);
    });
  }

  get _tun() {
    return this.tunnel;
  }

  _forward(data, isBinary) {
    if (isBinary) this.tunnel.sendBinary({ t: 'ws.msg', id: this.id, binary: true }, data);
    else this.tunnel.sendText({ t: 'ws.msg', id: this.id, binary: false, data: String(data) });
  }

  flush() {
    const queued = this.queued;
    this.queued = [];
    this.queuedBytes = 0;
    for (const [isBinary, data] of queued) {
      if (this.closing) return;
      this._forward(data, isBinary);
    }
  }

  close(code, reason) {
    this.closeBrowser(code, reason);
    this.tunnel.sendText({ t: 'ws.close', id: this.id, code, reason });
    this.tunnel.bridges.delete(this.id);
  }

  closeBrowser(code, reason) {
    this.closing = true;
    this.queued = [];
    this.queuedBytes = 0;
    clearTimeout(this.openTimer);
    safeClose(this.browser, code, reason);
  }
}

export class RelayHub {
  /**
   * @param {object} [options]
   * @param {(message: string) => void} [options.log] informational log sink
   * @param {(message: string) => void} [options.warn] warning log sink
   * @param {string} [options.relayToken] optional shared secret required from agents
   * @param {number} [options.maxAgents] agent tunnel limit (tests use a small one)
   */
  constructor(options = {}) {
    this._log = typeof options.log === 'function' ? options.log : (message) => console.log(`[remote-desktop relay] ${message}`);
    this._warn = typeof options.warn === 'function' ? options.warn : (message) => console.warn(`[remote-desktop relay] ${message}`);
    this.relayToken = typeof options.relayToken === 'string' && options.relayToken.length > 0 ? options.relayToken : null;
    this.maxAgents = Number.isFinite(options.maxAgents) ? Math.max(1, Math.trunc(options.maxAgents)) : MAX_AGENTS;
    this._agents = new Map();
    this._seenCodes = new Map();
    this._seenCodesLimit = Number.isFinite(options.seenCodesLimit)
      ? Math.max(16, Math.trunc(options.seenCodesLimit))
      : 4096;
    this._nextId = 1;
    this._closed = false;

    this.handleInfo = this.handleInfo.bind(this);
    this.handleHttp = this.handleHttp.bind(this);
    this.handleAgentUpgrade = this.handleAgentUpgrade.bind(this);
    this.handleClientUpgrade = this.handleClientUpgrade.bind(this);
  }

  get stats() {
    let clients = 0;
    for (const tunnel of this._agents.values()) clients += tunnel.bridges.size;
    return { agents: this._agents.size, clients };
  }

  get codes() {
    return Array.from(this._agents.keys());
  }

  // ---- route handlers ------------------------------------------------------

  handleInfo(req, res) {
    if (this._closed) return sendJson(res, 503, { enabled: false });
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: 'GET, HEAD' });
    }
    return sendJson(res, 200, {
      enabled: true,
      protocol: RELAY_PROTOCOL,
      agentPath: RELAY_PATHS.agent,
      clientPath: RELAY_PATHS.clientPrefix,
      wsPath: RELAY_PATHS.ws,
      tokenRequired: Boolean(this.relayToken),
      agents: this._agents.size,
    });
  }

  handleHttp(req, res) {
    if (this._closed) return sendJson(res, 503, { error: 'relay_shutdown' });
    const url = parseUrl(req);
    if (!url) return sendJson(res, 400, { error: 'bad_request' });
    const prefix = RELAY_PATHS.clientPrefix + '/';
    if (!url.pathname.startsWith(prefix)) return sendJson(res, 404, { error: 'not_found' });

    let rest = url.pathname.slice(prefix.length);
    const slash = rest.indexOf('/');
    let code;
    try {
      code = decodeURIComponent(slash === -1 ? rest : rest.slice(0, slash));
    } catch {
      return sendJson(res, 400, { error: 'bad_code' });
    }
    const agentPath = slash === -1 ? '/' : rest.slice(slash);
    if (!CODE_RE.test(code)) return sendJson(res, 400, { error: 'bad_code', message: 'invalid relay code' });

    const tunnel = this._agents.get(code);
    if (!tunnel || !tunnel.ready) {
      if (!this._seenCodes.has(code)) {
        return sendJson(res, 404, { error: 'relay_unknown_code', message: 'no agent ever registered this relay code' });
      }
      return sendJson(res, 503, { error: 'relay_offline', message: 'the agent is not connected to this relay' });
    }
    if (tunnel.inflightHttp >= MAX_INFLIGHT_HTTP) {
      return sendJson(res, 429, { error: 'relay_busy', message: 'too many concurrent requests' });
    }

    const id = this._nextId++;
    const pending = {
      id,
      tunnel,
      req,
      res,
      method: String(req.method || 'GET').toUpperCase(),
      responseHeaders: {},
      responded: false,
      done: false,
      timer: null,
    };
    tunnel.pendingHttp.set(id, pending);
    this._touchPending(pending);

    const headers = headerObject(req.headers, FORWARDED_REQUEST_HEADERS);
    tunnel.sendText({
      t: 'http.request',
      id,
      method: pending.method,
      path: agentPath + (url.search || ''),
      headers,
    });

    let uploadClosed = false;
    const finishUpload = () => {
      if (uploadClosed) return;
      uploadClosed = true;
      tunnel.sendText({ t: 'http.end', id });
    };

    req.on('data', (chunk) => {
      if (pending.done) return;
      let offset = 0;
      while (offset < chunk.length) {
        const part = chunk.subarray(offset, offset + MAX_HTTP_CHUNK);
        offset += part.length;
        tunnel.sendBinary({ t: 'http.body', id }, part);
      }
      this._touchPending(pending);
      this._pauseUploadWhileBuffered(tunnel, req);
    });
    req.on('end', finishUpload);
    req.on('aborted', () => {
      if (pending.done) return;
      tunnel.sendText({ t: 'http.abort', id });
      this._abortPending(pending, 'client aborted');
    });
    req.on('error', () => {
      if (pending.done) return;
      tunnel.sendText({ t: 'http.abort', id });
      this._abortPending(pending, 'client request error');
    });
  }

  handleAgentUpgrade(req, socket, head) {
    if (this._closed) return rejectUpgrade(socket, 503, 'Service Unavailable', 'relay is shutting down');
    const url = parseUrl(req);
    if (!url) return rejectUpgrade(socket, 400, 'Bad Request', 'malformed request URL');

    const code = String(url.searchParams.get('code') || '');
    if (!CODE_RE.test(code)) {
      return rejectUpgrade(socket, 400, 'Bad Request', 'missing or invalid relay code');
    }
    if (this.relayToken) {
      const supplied = Buffer.from(String(url.searchParams.get('token') || ''), 'utf8');
      const expected = Buffer.from(this.relayToken, 'utf8');
      const ok = supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
      if (!ok) return rejectUpgrade(socket, 403, 'Forbidden', 'invalid relay token');
    }
    if (!this._agents.has(code) && this._agents.size >= this.maxAgents) {
      return rejectUpgrade(socket, 503, 'Service Unavailable', 'relay is full');
    }

    const conn = acceptWebSocket(req, socket, head);
    if (!conn) return;

    const previous = this._agents.get(code);
    if (previous) {
      this._agents.delete(code);
      previous.close(4000, 'replaced by a new agent connection');
    }
    const tunnel = new AgentTunnel(this, code, conn);
    this._agents.set(code, tunnel);

    conn.sendText(JSON.stringify({ t: 'relay.ready', protocol: RELAY_PROTOCOL }));
  }

  handleClientUpgrade(req, socket, head) {
    if (this._closed) return rejectUpgrade(socket, 503, 'Service Unavailable', 'relay is shutting down');
    const url = parseUrl(req);
    if (!url) return rejectUpgrade(socket, 400, 'Bad Request', 'malformed request URL');

    const code = String(url.searchParams.get('code') || '');
    if (!CODE_RE.test(code)) return rejectUpgrade(socket, 400, 'Bad Request', 'missing or invalid relay code');
    const tunnel = this._agents.get(code);
    if (!tunnel || !tunnel.ready) {
      return rejectUpgrade(socket, 404, 'Not Found', 'the agent is not connected to this relay');
    }
    if (tunnel.bridges.size >= MAX_CLIENTS_PER_AGENT) {
      return rejectUpgrade(socket, 429, 'Too Many Requests', 'too many browser sessions for this agent');
    }
    const token = String(url.searchParams.get('token') || '');
    if (!token) return rejectUpgrade(socket, 401, 'Unauthorized', 'missing agent token');

    const browser = acceptWebSocket(req, socket, head);
    if (!browser) return;

    const id = this._nextId++;
    const bridge = new WsBridge(tunnel, id, browser, `/ws?token=${encodeURIComponent(token)}`);
    tunnel.bridges.set(id, bridge);
    tunnel.sendText({ t: 'ws.open', id, path: bridge.tokenPath });
    this._log(`client connected code=${code} id=${id} clients=${tunnel.bridges.size}`);
  }

  // ---- pending HTTP lifecycle ---------------------------------------------

  _touchPending(pending) {
    if (pending.done) return;
    clearTimeout(pending.timer);
    pending.timer = setTimeout(() => {
      this._abortPending(pending, 'relay request timeout');
      pending.tunnel.sendText({ t: 'http.abort', id: pending.id });
    }, HTTP_IDLE_TIMEOUT_MS);
    pending.timer.unref?.();
  }

  _finishPending(pending) {
    if (!pending || pending.done) return;
    pending.done = true;
    clearTimeout(pending.timer);
    pending.timer = null;
    if (pending.pausedTunnel && typeof pending.resumeTunnel === 'function') {
      pending.resumeTunnel();
    }
    pending.tunnel.pendingHttp.delete(pending.id);
  }

  _abortPending(pending, reason) {
    if (!pending || pending.done) return;
    const tunnel = pending.tunnel;
    if (!pending.res.headersSent) {
      try {
        sendJson(pending.res, 504, { error: 'relay_timeout', message: reason });
      } catch {
        /* response is already gone */
      }
    } else {
      try {
        pending.res.destroy();
      } catch {
        /* ignore */
      }
    }
    this._finishPending(pending);
    if (tunnel && !tunnel._closed) tunnel.sendText({ t: 'http.abort', id: pending.id });
  }

  _pauseUploadWhileBuffered(tunnel, req) {
    let paused = false;
    try {
      if (tunnel.conn.bufferedAmount > UPLOAD_HIGH_WATER) {
        paused = true;
        req.pause();
      }
    } catch {
      /* ignore */
    }
    if (!paused) return;
    const tick = setInterval(() => {
      try {
        if (tunnel._closed || tunnel.conn.bufferedAmount <= UPLOAD_HIGH_WATER / 2) {
          clearInterval(tick);
          try {
            req.resume();
          } catch {
            /* ignore */
          }
        }
      } catch {
        clearInterval(tick);
      }
    }, 20);
    tick.unref?.();
  }

  // ---- lifecycle -----------------------------------------------------------

  _rememberCode(code) {
    if (this._seenCodes.has(code)) return;
    this._seenCodes.set(code, now());
    if (this._seenCodes.size > this._seenCodesLimit) {
      const oldest = this._seenCodes.keys().next().value;
      this._seenCodes.delete(oldest);
    }
  }

  _removeTunnel(tunnel) {
    if (this._agents.get(tunnel.code) === tunnel) this._agents.delete(tunnel.code);
  }

  close() {
    if (this._closed) return;
    this._closed = true;
    for (const tunnel of Array.from(this._agents.values())) {
      tunnel.close(1001, 'relay shutdown');
    }
    this._agents.clear();
  }
}
