// Zero-dependency RFC6455 WebSocket server + client.
//
// Public API (per docs/PROTOCOL.md / task-2):
//   attachWebSocketServer(httpServer, {path='/ws', authorize(req), onConnection(conn,req)}) -> {close()}
//   class WebSocketConnection { sendText(str); sendBinary(buf); close(code,reason);
//                               onMessage(fn); onClose(fn); readonly bufferedAmount }
//   async connectWebSocket(url, {timeoutMs}) -> WebSocketConnection
//
// onMessage(fn) is called as fn(data, isBinary) where `data` is a string for
// text frames and a Buffer for binary frames. onClose(fn) is called once as
// fn(code, reason). Server->client frames are never masked; client->server
// frames are always masked (both directions are enforced by the parser).
//
// Fragmented messages (opcode 0 continuation frames) are assembled with a hard
// 16 MiB cap. Larger messages fail the connection with close code 1009.

import crypto from 'node:crypto';
import net from 'node:net';
import { TextDecoder } from 'node:util';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const WS_VERSION = '13';
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
const MAX_CONTROL_BYTES = 125;
const CLOSE_GRACE_MS = 2000;

const OP_CONT = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

function computeAccept(key) {
  return crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
}

function isValidCloseCode(code) {
  if (code >= 1000 && code <= 1003) return true;
  if (code >= 1007 && code <= 1011) return true;
  if (code >= 3000 && code <= 4999) return true;
  return false;
}

function closePayload(code, reason) {
  const text = Buffer.from(String(reason || ''), 'utf8').subarray(0, 123);
  const buf = Buffer.allocUnsafe(2 + text.length);
  buf.writeUInt16BE(code, 0);
  text.copy(buf, 2);
  return buf;
}

function encodeFrame(opcode, payload, { masked, fin = true }) {
  const data = payload && payload.length ? payload : Buffer.alloc(0);
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.allocUnsafe(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.allocUnsafe(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = (fin ? 0x80 : 0x00) | opcode;
  if (!masked) {
    return Buffer.concat([header, data]);
  }
  header[1] |= 0x80;
  const mask = crypto.randomBytes(4);
  const body = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) body[i] = data[i] ^ mask[i & 3];
  return Buffer.concat([header, mask, body]);
}

function isThenable(value) {
  return value != null && typeof value.then === 'function';
}

export class WebSocketConnection {
  constructor(socket, { isClient = false, maxMessageSize = MAX_MESSAGE_BYTES } = {}) {
    this.socket = socket;
    this.isClient = Boolean(isClient);
    this.maxMessageSize = maxMessageSize;

    this._buffer = Buffer.alloc(0);
    this._closed = false;
    this._closeSent = false;
    this._closeReceived = false;
    this._closeCode = 1000;
    this._closeReason = '';
    this._closeTimer = null;
    this._finishTimer = null;

    this._fragOpcode = 0;
    this._fragParts = [];
    this._fragLen = 0;

    this._messageHandlers = [];
    this._closeHandlers = [];

    this._onData = (chunk) => this._receive(chunk);
    this._onError = (err) => this._fail(err);
    this._onClose = () => this._finish(this._closeReceived ? this._closeCode : 1006, this._closeReceived ? this._closeReason : 'connection closed');
    this._onEnd = () => {
      // Peer half-closed TCP without a close frame: finish the connection.
      if (!this._closed) {
        this._finish(this._closeReceived ? this._closeCode : 1006, this._closeReceived ? this._closeReason : 'connection closed');
      }
    };

    socket.setNoDelay?.(true);
    socket.on('data', this._onData);
    socket.on('error', this._onError);
    socket.on('close', this._onClose);
    socket.on('end', this._onEnd);
  }

  get bufferedAmount() {
    try {
      return this.socket.writableLength || 0;
    } catch {
      return 0;
    }
  }

  get closed() {
    return this._closed;
  }

  sendText(str) {
    return this._sendFrame(OP_TEXT, Buffer.from(String(str), 'utf8'));
  }

  sendBinary(buf) {
    let payload;
    if (Buffer.isBuffer(buf)) payload = buf;
    else if (ArrayBuffer.isView(buf)) payload = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
    else if (buf instanceof ArrayBuffer) payload = Buffer.from(buf);
    else if (typeof buf === 'string') payload = Buffer.from(buf, 'utf8');
    else payload = Buffer.from(buf);
    return this._sendFrame(OP_BINARY, payload);
  }

  close(code = 1000, reason = '') {
    if (this._closed || this._closeSent) return;
    if (!isValidCloseCode(code)) code = 1000;
    this._closeSent = true;
    this._closeCode = code;
    this._closeReason = String(reason || '');
    this._sendFrame(OP_CLOSE, closePayload(code, reason));
    try {
      this.socket.end();
    } catch {
      /* ignore */
    }
    this._armCloseTimer();
  }

  onMessage(fn) {
    if (typeof fn === 'function') this._messageHandlers.push(fn);
    return this;
  }

  onClose(fn) {
    if (typeof fn !== 'function') return this;
    if (this._closed) {
      queueMicrotask(() => fn(this._closeCode, this._closeReason));
      return this;
    }
    this._closeHandlers.push(fn);
    return this;
  }

  // ---- internals -----------------------------------------------------------

  _armCloseTimer() {
    if (this._closeTimer) return;
    this._closeTimer = setTimeout(() => {
      this._closeTimer = null;
      try {
        this.socket.destroy();
      } catch {
        /* ignore */
      }
      this._finish(this._closeCode, this._closeReason);
    }, CLOSE_GRACE_MS);
    this._closeTimer.unref?.();
  }

  _sendFrame(opcode, payload) {
    if (this._closed) return false;
    try {
      const frame = encodeFrame(opcode, payload, { masked: this.isClient });
      return this.socket.write(frame);
    } catch (err) {
      this._fail(err);
      return false;
    }
  }

  _receive(chunk) {
    if (this._closed) return;
    try {
      this._buffer = this._buffer.length ? Buffer.concat([this._buffer, chunk]) : chunk;
      this._parse();
    } catch (err) {
      this._protocolError(1002, err && err.message ? err.message : 'protocol error');
    }
  }

  _parse() {
    let offset = 0;
    while (!this._closed) {
      const buf = this._buffer;
      const available = buf.length - offset;
      if (available < 2) break;

      const b0 = buf[offset];
      const b1 = buf[offset + 1];
      const fin = (b0 & 0x80) !== 0;
      const rsv = b0 & 0x70;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;

      if (rsv !== 0) {
        this._protocolError(1002, 'reserved bits set');
        return;
      }

      // Directional mask rule: clients mask, servers do not.
      if (this.isClient && masked) {
        this._protocolError(1002, 'server frame must not be masked');
        return;
      }
      if (!this.isClient && !masked) {
        this._protocolError(1002, 'client frame must be masked');
        return;
      }

      let headerLen = 2;
      if (len === 126) {
        if (available < 4) break;
        len = buf.readUInt16BE(offset + 2);
        headerLen = 4;
      } else if (len === 127) {
        if (available < 10) break;
        const hi = buf.readUInt32BE(offset + 2);
        const lo = buf.readUInt32BE(offset + 6);
        if (hi & 0x80000000) {
          this._protocolError(1002, 'invalid 64-bit frame length');
          return;
        }
        len = hi * 4294967296 + lo;
        headerLen = 10;
      }

      const isControl = opcode >= 0x8;
      if (isControl) {
        if (!fin) {
          this._protocolError(1002, 'fragmented control frame');
          return;
        }
        if (len > MAX_CONTROL_BYTES) {
          this._protocolError(1002, 'control frame too large');
          return;
        }
      }
      if (len > this.maxMessageSize) {
        this._protocolError(1009, 'frame too large');
        return;
      }

      const maskOffset = headerLen;
      if (masked) headerLen += 4;
      if (available < headerLen + len) break;

      let payload = buf.subarray(offset + headerLen, offset + headerLen + len);
      if (masked) {
        const mask = buf.subarray(offset + maskOffset, offset + maskOffset + 4);
        const unmasked = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i++) unmasked[i] = payload[i] ^ mask[i & 3];
        payload = unmasked;
      }

      offset += headerLen + len;
      this._handleFrame(opcode, fin, payload);
      if (this._closed) return;
    }

    if (offset > 0) this._buffer = this._buffer.subarray(offset);
    if (this._buffer.length > this.maxMessageSize + 1024) {
      this._protocolError(1009, 'message too large');
    }
  }

  _handleFrame(opcode, fin, payload) {
    switch (opcode) {
      case OP_TEXT:
      case OP_BINARY: {
        if (this._fragOpcode !== 0) {
          this._protocolError(1002, 'new data frame during fragmented message');
          return;
        }
        if (fin) {
          this._dispatch(opcode, payload);
          return;
        }
        this._fragOpcode = opcode;
        this._fragParts = [payload];
        this._fragLen = payload.length;
        return;
      }
      case OP_CONT: {
        if (this._fragOpcode === 0) {
          this._protocolError(1002, 'unexpected continuation frame');
          return;
        }
        this._fragLen += payload.length;
        if (this._fragLen > this.maxMessageSize) {
          this._protocolError(1009, 'message too large');
          return;
        }
        this._fragParts.push(payload);
        if (!fin) return;
        const op = this._fragOpcode;
        const parts = this._fragParts;
        this._fragOpcode = 0;
        this._fragParts = [];
        this._fragLen = 0;
        this._dispatch(op, Buffer.concat(parts));
        return;
      }
      case OP_PING: {
        this._sendFrame(OP_PONG, payload);
        return;
      }
      case OP_PONG:
        return;
      case OP_CLOSE: {
        let code = 1000;
        let reason = '';
        if (payload.length >= 2) {
          code = payload.readUInt16BE(0);
          reason = payload.subarray(2).toString('utf8');
          if (!isValidCloseCode(code)) code = 1002;
        } else if (payload.length === 1) {
          this._protocolError(1002, 'invalid close payload');
          return;
        }
        this._closeReceived = true;
        this._closeCode = code;
        this._closeReason = reason;
        if (!this._closeSent) {
          this._closeSent = true;
          this._sendFrame(OP_CLOSE, closePayload(code, reason));
        }
        try {
          this.socket.end();
        } catch {
          /* ignore */
        }
        this._finish(code, reason);
        return;
      }
      default:
        this._protocolError(1002, `unsupported opcode ${opcode}`);
    }
  }

  _dispatch(opcode, payload) {
    let data;
    let isBinary;
    if (opcode === OP_TEXT) {
      try {
        data = utf8Decoder.decode(payload);
      } catch {
        this._protocolError(1007, 'invalid UTF-8 in text frame');
        return;
      }
      isBinary = false;
    } else {
      data = Buffer.from(payload);
      isBinary = true;
    }
    for (const handler of this._messageHandlers.slice()) {
      try {
        const result = handler(data, isBinary);
        if (isThenable(result)) {
          result.catch((err) => {
            // Never let a subscriber's async failure crash the process.
            process.emitWarning?.(`websocket message handler failed: ${err && err.message ? err.message : err}`);
          });
        }
      } catch (err) {
        process.emitWarning?.(`websocket message handler failed: ${err && err.message ? err.message : err}`);
      }
    }
  }

  _protocolError(code, message) {
    if (this._closed) return;
    if (!this._closeSent) {
      this._closeSent = true;
      this._closeCode = code;
      this._closeReason = message;
      this._sendFrame(OP_CLOSE, closePayload(code, message));
    }
    try {
      this.socket.end();
    } catch {
      /* ignore */
    }
    this._finish(code, message);
  }

  _fail(err) {
    if (this._closed) return;
    try {
      this.socket.destroy();
    } catch {
      /* ignore */
    }
    this._finish(1006, err && err.message ? err.message : 'socket error');
  }

  _finish(code, reason) {
    if (this._closed) return;
    this._closed = true;
    this._closeCode = code;
    this._closeReason = reason == null ? '' : String(reason);
    if (this._closeTimer) {
      clearTimeout(this._closeTimer);
      this._closeTimer = null;
    }
    try {
      this.socket.removeListener('data', this._onData);
      this.socket.removeListener('error', this._onError);
      this.socket.removeListener('close', this._onClose);
      this.socket.removeListener('end', this._onEnd);
    } catch {
      /* ignore */
    }
    if (!this.socket.destroyed) {
      try {
        this.socket.destroy();
      } catch {
        /* ignore */
      }
    }
    const handlers = this._closeHandlers;
    this._closeHandlers = [];
    for (const handler of handlers) {
      try {
        handler(this._closeCode, this._closeReason);
      } catch {
        /* ignore close handler errors */
      }
    }
  }
}

function writeHttpResponse(socket, status, statusText, headers, body) {
  let head = `HTTP/1.1 ${status} ${statusText}\r\n`;
  for (const [name, value] of Object.entries(headers || {})) {
    head += `${name}: ${value}\r\n`;
  }
  head += `Content-Length: ${Buffer.byteLength(body || '')}\r\n`;
  head += 'Connection: close\r\n\r\n';
  try {
    socket.write(head + (body || ''));
  } catch {
    /* ignore */
  }
  try {
    socket.end();
  } catch {
    /* ignore */
  }
  setTimeout(() => {
    try {
      socket.destroy();
    } catch {
      /* ignore */
    }
  }, 250).unref?.();
}

function rejectUpgrade(socket, status, statusText, extraHeaders, errorCode, message) {
  const body = JSON.stringify({ error: errorCode || 'bad_request', message: message || statusText });
  writeHttpResponse(
    socket,
    status,
    statusText,
    {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      ...(extraHeaders || {}),
    },
    body,
  );
}

export function attachWebSocketServer(httpServer, options = {}) {
  const path = options.path || '/ws';
  const authorize = typeof options.authorize === 'function' ? options.authorize : null;
  const onConnection = typeof options.onConnection === 'function' ? options.onConnection : null;
  const connections = new Set();

  const upgradeHandler = (req, socket, head) => {
    socket.on('error', () => {
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
    });

    let url;
    try {
      url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    } catch {
      rejectUpgrade(socket, 400, 'Bad Request', null, 'invalid_request', 'malformed request URL');
      return;
    }

    if (url.pathname !== path) {
      rejectUpgrade(socket, 404, 'Not Found', null, 'not_found', 'no websocket endpoint here');
      return;
    }
    if (req.method !== 'GET' || !/websocket/i.test(String(req.headers.upgrade || ''))) {
      rejectUpgrade(socket, 400, 'Bad Request', null, 'invalid_request', 'expected a websocket upgrade');
      return;
    }
    const key = req.headers['sec-websocket-key'];
    if (!key || typeof key !== 'string') {
      rejectUpgrade(socket, 400, 'Bad Request', null, 'invalid_request', 'missing Sec-WebSocket-Key');
      return;
    }
    if (String(req.headers['sec-websocket-version'] || '') !== WS_VERSION) {
      rejectUpgrade(socket, 426, 'Upgrade Required', { 'Sec-WebSocket-Version': WS_VERSION }, 'invalid_request', 'unsupported websocket version');
      return;
    }

    const proceed = (allowed) => {
      if (!allowed) {
        rejectUpgrade(socket, 401, 'Unauthorized', null, 'bad_token', 'invalid or missing token');
        return;
      }
      const accept = computeAccept(key);
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
        return;
      }

      const conn = new WebSocketConnection(socket, { isClient: false });
      connections.add(conn);
      conn.onClose(() => connections.delete(conn));
      if (head && head.length) conn._receive(head);
      try {
        const result = onConnection ? onConnection(conn, req) : undefined;
        if (isThenable(result)) result.catch(() => conn.close(1011, 'internal error'));
      } catch {
        conn.close(1011, 'internal error');
      }
    };

    if (!authorize) {
      proceed(true);
      return;
    }
    let pending;
    try {
      pending = authorize(req);
    } catch {
      proceed(false);
      return;
    }
    if (isThenable(pending)) {
      pending.then(proceed, () => proceed(false));
    } else {
      proceed(Boolean(pending));
    }
  };

  httpServer.on('upgrade', upgradeHandler);

  return {
    close() {
      httpServer.off('upgrade', upgradeHandler);
      for (const conn of Array.from(connections)) {
        try {
          conn.close(1001, 'server shutdown');
        } catch {
          /* ignore */
        }
      }
      connections.clear();
    },
  };
}

export async function connectWebSocket(urlStr, { timeoutMs = 5000 } = {}) {
  const url = new URL(String(urlStr));
  if (url.protocol !== 'ws:') {
    throw new Error(`unsupported websocket scheme: ${url.protocol}`);
  }
  const host = url.hostname.startsWith('[') && url.hostname.endsWith(']') ? url.hostname.slice(1, -1) : url.hostname;
  const port = url.port ? Number(url.port) : 80;
  const key = crypto.randomBytes(16).toString('base64');

  const socket = net.connect({ host, port });
  socket.setNoDelay?.(true);

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      socket.destroy();
      reject(new Error(`websocket connect timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
    const onConnect = () => {
      cleanup();
      resolve();
    };
    const onError = (err) => {
      cleanup();
      socket.destroy();
      reject(err);
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeListener('connect', onConnect);
      socket.removeListener('error', onError);
    };
    socket.once('connect', onConnect);
    socket.once('error', onError);
  });

  const requestPath = `${url.pathname || '/'}${url.search || ''}`;
  const request =
    `GET ${requestPath} HTTP/1.1\r\n` +
    `Host: ${url.host}\r\n` +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Key: ${key}\r\n` +
    `Sec-WebSocket-Version: ${WS_VERSION}\r\n` +
    '\r\n';
  socket.write(request);

  const { head, rest } = await new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => {
      cleanup();
      socket.destroy();
      reject(new Error(`websocket handshake timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
    const onData = (chunk) => {
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
      const idx = buffer.indexOf('\r\n\r\n');
      if (idx === -1) {
        if (buffer.length > 64 * 1024) {
          cleanup();
          socket.destroy();
          reject(new Error('websocket handshake response too large'));
        }
        return;
      }
      cleanup();
      resolve({ head: buffer.subarray(0, idx).toString('latin1'), rest: buffer.subarray(idx + 4) });
    };
    const onError = (err) => {
      cleanup();
      socket.destroy();
      reject(err);
    };
    const onClose = () => {
      cleanup();
      reject(new Error('websocket handshake closed by peer'));
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
    };
    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
  });

  const lines = head.split('\r\n');
  const statusLine = lines.shift() || '';
  const statusMatch = /^HTTP\/\d\.\d\s+(\d{3})/.exec(statusLine);
  if (!statusMatch || Number(statusMatch[1]) !== 101) {
    socket.destroy();
    const status = statusMatch ? Number(statusMatch[1]) : 0;
    const err = new Error(`websocket handshake failed with HTTP status ${status || 'unknown'}`);
    err.status = status;
    err.body = lines.join('\r\n');
    throw err;
  }
  const headers = new Map();
  for (const line of lines) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    headers.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim());
  }
  const expected = computeAccept(key);
  if (headers.get('sec-websocket-accept') !== expected) {
    socket.destroy();
    throw new Error('websocket handshake failed: bad Sec-WebSocket-Accept');
  }
  if (!/websocket/i.test(headers.get('upgrade') || '')) {
    socket.destroy();
    throw new Error('websocket handshake failed: missing Upgrade header');
  }

  const conn = new WebSocketConnection(socket, { isClient: true });
  if (rest && rest.length) conn._receive(rest);
  return conn;
}
