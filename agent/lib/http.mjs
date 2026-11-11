// HTTP API for the remote agent: authentication, agent info, filesystem access.
//
// Public API (per docs/PROTOCOL.md §2 / task-2):
//   class AuthService { verifyPassword(ip,password); verifyToken(token); isRateLimited(ip) }
//   class HttpApi { constructor({auth, fileService, infoProvider, corsOrigin='*'}); handle(req,res) }
//
// handle() returns true when it produced a response and false when the URL is
// not one of ours (the caller can then send a generic 404). It never rejects.

import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { FileError, statusForCode } from './files.mjs';

const MAX_JSON_BYTES = 1024 * 1024;
const RATE_WINDOW_MS = 60_000;
const DEFAULT_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

const HTTP_ERROR_STATUS = {
  no_token: 401,
  bad_token: 401,
  invalid_password: 401,
  rate_limited: 429,
  not_found: 404,
  is_directory: 400,
  not_directory: 400,
  exists: 409,
  permission_denied: 403,
  outside_root: 403,
  invalid_request: 400,
  too_large: 413,
  unsupported_key: 400,
  server_error: 500,
};

class HttpError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

function safeEqual(a, b) {
  const left = crypto.createHash('sha256').update(String(a), 'utf8').digest();
  const right = crypto.createHash('sha256').update(String(b), 'utf8').digest();
  return crypto.timingSafeEqual(left, right);
}

function clientIp(req) {
  const raw = (req && req.socket && req.socket.remoteAddress) || 'unknown';
  return String(raw).replace(/^::ffff:/, '');
}

function readJsonBody(req, limit = MAX_JSON_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    req.on('data', (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > limit) {
        fail(new HttpError(413, 'too_large', `request body exceeds ${limit} bytes`));
        try {
          req.removeAllListeners('data');
          req.resume();
        } catch {
          /* ignore */
        }
        const timer = setTimeout(() => {
          try {
            req.destroy();
          } catch {
            /* ignore */
          }
        }, 100);
        timer.unref?.();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.trim() === '') {
        resolve({});
        return;
      }
      let value;
      try {
        value = JSON.parse(raw);
      } catch {
        reject(new HttpError(400, 'invalid_request', 'invalid JSON body'));
        return;
      }
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        reject(new HttpError(400, 'invalid_request', 'JSON body must be an object'));
        return;
      }
      resolve(value);
    });

    req.on('error', () => fail(new HttpError(400, 'invalid_request', 'request aborted')));
    req.on('aborted', () => fail(new HttpError(400, 'invalid_request', 'request aborted')));
  });
}

const CONTENT_DISPOSITION_UNSAFE = /["\\\r\n]/g;

function contentDisposition(filename) {
  const name = filename || 'download';
  const fallback = name.replace(/[^\x20-\x7e]/g, '_').replace(CONTENT_DISPOSITION_UNSAFE, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export class AuthService {
  constructor({ password = null, tokenTtlMs = DEFAULT_TOKEN_TTL_MS, maxFailuresPerMinute = 5 } = {}) {
    this.password = typeof password === 'string' && password.length > 0 ? password : null;
    this.tokenTtlMs = Number.isFinite(Number(tokenTtlMs)) && Number(tokenTtlMs) > 0 ? Number(tokenTtlMs) : DEFAULT_TOKEN_TTL_MS;
    this.maxFailuresPerMinute = Number.isFinite(Number(maxFailuresPerMinute))
      ? Math.max(1, Math.trunc(Number(maxFailuresPerMinute)))
      : 5;
    this._tokens = new Map(); // token -> { expiresAt, ip }
    this._failures = new Map(); // ip -> number[] (failure timestamps within the window)
  }

  get passwordRequired() {
    return this.password !== null;
  }

  isRateLimited(ip) {
    return this._recentFailures(ip).length >= this.maxFailuresPerMinute;
  }

  retryAfterMs(ip) {
    const failures = this._recentFailures(ip);
    if (failures.length < this.maxFailuresPerMinute) return 0;
    const thresholdIndex = failures.length - this.maxFailuresPerMinute;
    const relevant = failures.slice(thresholdIndex);
    const oldest = relevant.length ? Math.min(...relevant) : Date.now();
    return Math.max(0, RATE_WINDOW_MS - (Date.now() - oldest));
  }

  async verifyPassword(ip, password) {
    const key = String(ip || 'unknown');
    if (this.isRateLimited(key)) return null;

    let ok;
    if (this.password === null) {
      ok = true; // insecure no-password mode
    } else {
      ok = safeEqual(typeof password === 'string' ? password : '', this.password);
    }

    if (!ok) {
      this._recordFailure(key);
      return null;
    }

    this._failures.delete(key);
    return this._issueToken(key);
  }

  verifyToken(token) {
    if (typeof token !== 'string' || token.length === 0) return false;
    const entry = this._tokens.get(token);
    if (!entry) return false;
    if (entry.expiresAt <= Date.now()) {
      this._tokens.delete(token);
      return false;
    }
    return true;
  }

  // ---- internals -----------------------------------------------------------

  _recentFailures(ip) {
    const key = String(ip || 'unknown');
    const list = this._failures.get(key);
    if (!list) return [];
    const now = Date.now();
    const recent = list.filter((ts) => now - ts < RATE_WINDOW_MS);
    if (recent.length !== list.length) {
      if (recent.length) this._failures.set(key, recent);
      else this._failures.delete(key);
    }
    return recent;
  }

  _recordFailure(ip) {
    const key = String(ip || 'unknown');
    const list = this._recentFailures(ip);
    list.push(Date.now());
    this._failures.set(key, list);
  }

  _issueToken(ip) {
    this._pruneTokens();
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + this.tokenTtlMs;
    this._tokens.set(token, { expiresAt, ip });
    return { token, expiresAt };
  }

  _pruneTokens() {
    const now = Date.now();
    for (const [token, entry] of this._tokens) {
      if (entry.expiresAt <= now) this._tokens.delete(token);
    }
  }
}

export class HttpApi {
  constructor({ auth, fileService = null, infoProvider = null, corsOrigin = '*' } = {}) {
    this.auth = auth;
    this.fileService = fileService;
    this.infoProvider = infoProvider;
    this.corsOrigin = corsOrigin || '*';
  }

  async handle(req, res) {
    this._applyCors(res);

    let url;
    try {
      url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    } catch {
      this._sendJson(res, 400, { error: 'invalid_request', message: 'malformed request URL' });
      return true;
    }

    let pathname = url.pathname || '/';
    if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);

    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return true;
      }

      if (pathname === '/health') {
        this._requireMethod(req, 'GET');
        this._sendJson(res, 200, { ok: true, protocol: 1 });
        return true;
      }

      if (pathname === '/') {
        this._requireMethod(req, 'GET');
        const info = await this._info();
        const agent = (info && info.agent) || {};
        this._sendJson(res, 200, {
          ok: true,
          protocol: 1,
          agent: { name: agent.name, version: agent.version, platform: agent.platform },
          endpoints: { health: '/health', auth: '/api/auth', info: '/api/info', fs: '/api/fs/' },
        });
        return true;
      }

      if (pathname === '/api/auth') {
        this._requireMethod(req, 'POST');
        await this._handleAuth(req, res);
        return true;
      }

      if (pathname === '/api/info') {
        this._requireMethod(req, 'GET');
        this._requireAuth(req);
        this._sendJson(res, 200, await this._info());
        return true;
      }

      if (pathname.startsWith('/api/fs/')) {
        return await this._handleFiles(req, res, url, pathname);
      }

      return false;
    } catch (err) {
      this._sendError(res, err);
      return true;
    }
  }

  // ---- handlers ------------------------------------------------------------

  async _handleAuth(req, res) {
    if (!this.auth) throw new HttpError(500, 'server_error', 'authentication is not configured');
    const body = await readJsonBody(req);
    const password = body.password === undefined || body.password === null ? '' : body.password;
    if (typeof password !== 'string') {
      throw new HttpError(400, 'invalid_request', 'password must be a string');
    }
    const ip = clientIp(req);
    if (this.auth.isRateLimited(ip)) {
      const retryAfterMs = typeof this.auth.retryAfterMs === 'function' ? this.auth.retryAfterMs(ip) : RATE_WINDOW_MS;
      this._sendJson(res, 429, { error: 'rate_limited', retryAfterMs: Math.max(0, retryAfterMs) });
      return;
    }
    const result = await this.auth.verifyPassword(ip, password);
    if (!result) {
      this._sendJson(res, 401, { error: 'invalid_password', message: 'invalid password' });
      return;
    }
    const info = await this._info();
    const agent = (info && info.agent) || {};
    this._sendJson(res, 200, {
      token: result.token,
      expiresAt: result.expiresAt,
      agent: {
        version: typeof agent.version === 'string' ? agent.version : '1.0.0',
        name: typeof agent.name === 'string' ? agent.name : os.hostname(),
      },
    });
  }

  async _handleFiles(req, res, url, pathname) {
    if (!this.fileService) {
      throw new HttpError(403, 'permission_denied', 'files API is disabled on this agent');
    }

    if (pathname === '/api/fs/list') {
      this._requireMethod(req, 'GET');
      this._requireAuth(req);
      const p = this._queryPath(url);
      const result = await this.fileService.list(p);
      this._sendJson(res, 200, { path: result.path, parent: result.parent, entries: result.entries });
      return true;
    }

    if (pathname === '/api/fs/download') {
      this._requireMethod(req, 'GET');
      this._requireAuth(req);
      const p = this._queryPath(url);
      const info = await this.fileService.stat(p);
      if (info.type === 'dir') {
        throw new FileError('is_directory', `cannot download a directory: ${p}`);
      }
      const stream = await this.fileService.createReadStream(p);
      const filename = path.basename(info.path || p) || 'download';
      const headers = {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': contentDisposition(filename),
      };
      if (Number.isFinite(info.size) && info.size >= 0) headers['Content-Length'] = String(info.size);
      res.writeHead(200, headers);
      try {
        await pipeline(stream, res);
      } catch {
        if (!res.writableEnded) res.destroy();
      }
      return true;
    }

    if (pathname === '/api/fs/upload') {
      this._requireMethod(req, 'PUT');
      this._requireAuth(req);
      const p = this._queryPath(url);
      const result = await this.fileService.writeStream(p, req);
      this._sendJson(res, 200, { path: result.path, size: result.size });
      return true;
    }

    if (pathname === '/api/fs/mkdir') {
      this._requireMethod(req, 'POST');
      this._requireAuth(req);
      const body = await readJsonBody(req);
      const p = this._bodyPath(body.path);
      const result = await this.fileService.mkdir(p);
      this._sendJson(res, 200, { path: result.path });
      return true;
    }

    if (pathname === '/api/fs/rename') {
      this._requireMethod(req, 'POST');
      this._requireAuth(req);
      const body = await readJsonBody(req);
      if (typeof body.from !== 'string' || typeof body.to !== 'string') {
        throw new HttpError(400, 'invalid_request', 'from and to are required strings');
      }
      const result = await this.fileService.rename(body.from, body.to);
      this._sendJson(res, 200, { from: result.from, to: result.to });
      return true;
    }

    if (pathname === '/api/fs/remove') {
      this._requireMethod(req, 'POST');
      this._requireAuth(req);
      const body = await readJsonBody(req);
      const p = this._bodyPath(body.path);
      const result = await this.fileService.remove(p, Boolean(body.recursive));
      this._sendJson(res, 200, { removed: result.removed });
      return true;
    }

    return false;
  }

  // ---- helpers -------------------------------------------------------------

  _requireMethod(req, method) {
    if (req.method !== method) {
      throw new HttpError(405, 'invalid_request', `method ${req.method} not allowed`);
    }
  }

  _requireAuth(req) {
    if (!this.auth) throw new HttpError(500, 'server_error', 'authentication is not configured');
    const header = req.headers.authorization;
    if (typeof header !== 'string' || header.trim() === '') {
      throw new HttpError(401, 'no_token', 'missing Authorization: Bearer token');
    }
    const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
    if (!match) throw new HttpError(401, 'no_token', 'missing Authorization: Bearer token');
    let valid = false;
    try {
      valid = this.auth.verifyToken(match[1]);
    } catch {
      valid = false;
    }
    if (!valid) throw new HttpError(401, 'bad_token', 'invalid or expired token');
  }

  _queryPath(url) {
    const p = url.searchParams.get('path');
    if (p === null) throw new HttpError(400, 'invalid_request', 'path query parameter is required');
    return p;
  }

  _bodyPath(p) {
    if (typeof p !== 'string' || p.length === 0) {
      throw new HttpError(400, 'invalid_request', 'path is required');
    }
    return p;
  }

  async _info() {
    if (typeof this.infoProvider === 'function') {
      const value = await this.infoProvider();
      if (value && typeof value === 'object') return value;
    } else if (this.infoProvider && typeof this.infoProvider === 'object') {
      return this.infoProvider;
    }
    return {
      agent: { name: os.hostname(), version: '1.0.0', platform: process.platform },
      screen: null,
      capabilities: {
        screen: false,
        input: false,
        shell: false,
        files: Boolean(this.fileService),
        text: false,
      },
      fsRoot: null,
      protocol: 1,
    };
  }

  _applyCors(res) {
    res.setHeader('Access-Control-Allow-Origin', this.corsOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Max-Age', '600');
  }

  _sendJson(res, status, payload) {
    if (res.headersSent || res.writableEnded) return;
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': String(body.length),
    });
    res.end(body);
  }

  _sendError(res, err) {
    let status = 500;
    let code = 'server_error';
    let message = 'internal error';

    if (err instanceof HttpError) {
      status = err.status;
      code = err.code;
      message = err.message;
    } else if (err instanceof FileError || (err && typeof err.code === 'string' && HTTP_ERROR_STATUS[err.code])) {
      code = err.code;
      status = STATUS_BY_CODE_OR_HTTP(err.code);
      message = err.message || code;
    } else if (err && Number.isInteger(err.status) && err.status >= 400 && err.status <= 599) {
      status = err.status;
      code = typeof err.code === 'string' ? err.code : 'server_error';
      message = err.message || code;
    }

    if (res.headersSent || res.writableEnded) {
      try {
        res.destroy();
      } catch {
        /* ignore */
      }
      return;
    }
    if (code === 'too_large') {
      try {
        res.setHeader('Connection', 'close');
      } catch {
        /* ignore */
      }
    }
    this._sendJson(res, status, { error: code, message });
  }
}

function STATUS_BY_CODE_OR_HTTP(code) {
  if (HTTP_ERROR_STATUS[code]) return HTTP_ERROR_STATUS[code];
  const fromFiles = statusForCode(code);
  return fromFiles === 400 ? 400 : fromFiles;
}
