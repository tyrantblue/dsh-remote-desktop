/**
 * x11.mjs — zero-dependency pure-JS X11 protocol client (subset).
 *
 * Implements just enough of the X11 core protocol for a remote-desktop agent:
 *   - connect over unix socket (/tmp/.X11-unix/X<n>) or TCP (host:6000+n)
 *   - parse the connection setup (vendor, pixmap formats, screens, depths, visuals)
 *   - QueryExtension("XTEST") + GetKeyboardMapping
 *   - GetImage (ZPixmap), QueryPointer
 *   - XTest FakeInput for pointer motion, button and key events
 *
 * All requests are strictly serial: one request is written, its reply is read
 * completely before the next request is issued, so the reply stream can never
 * be misinterpreted.  The only asynchronous messages a server may send to this
 * connection are events (MappingNotify after an external client changes the
 * keyboard mapping); those are skipped while waiting for a reply.
 *
 * Wire format references: /usr/include/X11/Xproto.h and
 * /usr/include/X11/extensions/xtestproto.h.
 */

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';

/** X11 opcodes used by this client. */
export const X11_OPCODE = Object.freeze({
  GetImage: 73,
  QueryPointer: 38,
  QueryExtension: 98,
  GetKeyboardMapping: 101,
});

/** X11 event codes used by XTest FakeInput. */
export const X11_EVENT = Object.freeze({
  KeyPress: 2,
  KeyRelease: 3,
  ButtonPress: 4,
  ButtonRelease: 5,
  MotionNotify: 6,
});

const ZPIXMAP = 2;
const LSB_FIRST = 0;

/** Xauthority family codes (/usr/include/X11/Xauth.h). */
const XAUTH_FAMILY_INTERNET = 0;
const XAUTH_FAMILY_INTERNET6 = 6;
const XAUTH_FAMILY_LOCAL_HOST = 252;
const XAUTH_FAMILY_LOCAL = 256; // 0x0100
const XAUTH_FAMILY_WILD = 65535; // 0xffff
const XAUTH_NAME = 'MIT-MAGIC-COOKIE-1';

const X_ERROR_NAMES = {
  1: 'Request',
  2: 'Value',
  3: 'Window',
  4: 'Pixmap',
  5: 'Atom',
  6: 'Cursor',
  7: 'Font',
  8: 'Match',
  9: 'Drawable',
  10: 'Access',
  11: 'Alloc',
  12: 'Colormap',
  13: 'GContext',
  14: 'IDChoice',
  15: 'Name',
  16: 'Length',
  17: 'Implementation',
  18: 'Range',
};

/** Error type used for every X11-level failure. */
export class X11Error extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'X11Error';
    this.code = details.code;
    this.op = details.op;
  }
}

function align4(n) {
  return (n + 3) & ~3;
}

/** Split an X display string into a transport target. */
export function parseDisplay(display) {
  const raw = String(display == null ? ':0' : display).trim();
  if (raw === '') {
    throw new X11Error('empty DISPLAY value');
  }
  // Accept bare numbers ("99") as ":99" for convenience.
  const normalized = /^\d+$/.test(raw) ? `:${raw}` : raw;
  const match = /^(?:(.*))?:(\d+)(?:\.(\d+))?$/.exec(normalized);
  if (!match) {
    throw new X11Error(`invalid DISPLAY "${display}" (expected ":N", "host:N" or "unix:N")`);
  }
  const host = match[1] ?? '';
  const number = Number.parseInt(match[2], 10);
  const screen = match[3] == null ? 0 : Number.parseInt(match[3], 10);
  if (!Number.isInteger(number) || number < 0) {
    throw new X11Error(`invalid display number in "${display}"`);
  }
  return { host, number, screen };
}

/** Build the connection target for a DISPLAY string / explicit socket path. */
export function resolveTarget(display, socketPath) {
  const parsed = parseDisplay(display ?? (process.env.DISPLAY || ':0'));
  if (socketPath != null && socketPath !== '') {
    const path = String(socketPath);
    let screen = parsed.screen;
    const socketMatch = /\/X(\d+)$/.exec(path);
    return {
      kind: 'unix',
      path,
      number: socketMatch ? Number.parseInt(socketMatch[1], 10) : parsed.number,
      screen,
      host: '',
      display: display != null ? String(display) : deriveDisplayFromSocket(path) || ':0',
      label: path,
    };
  }
  if (parsed.host === '' || parsed.host === 'unix') {
    const path = `/tmp/.X11-unix/X${parsed.number}`;
    return {
      kind: 'unix',
      path,
      number: parsed.number,
      screen: parsed.screen,
      host: '',
      display: `${parsed.host === 'unix' ? 'unix' : ''}:${parsed.number}${parsed.screen ? `.${parsed.screen}` : ''}`,
      label: path,
    };
  }
  const port = 6000 + parsed.number;
  return {
    kind: 'tcp',
    host: parsed.host,
    port,
    number: parsed.number,
    screen: parsed.screen,
    display: `${parsed.host}:${parsed.number}${parsed.screen ? `.${parsed.screen}` : ''}`,
    label: `${parsed.host}:${port}`,
  };
}

function deriveDisplayFromSocket(path) {
  const m = /\/X(\d+)$/.exec(String(path));
  return m ? `:${m[1]}` : '';
}

/** Decompose a colour mask into shift and maximum raw value. */
function maskInfo(mask) {
  let value = mask >>> 0;
  if (value === 0) return { shift: 0, bits: 0, max: 0, scale: false };
  let shift = 0;
  while (shift < 32 && (value & 1) === 0) {
    value >>>= 1;
    shift += 1;
  }
  let bits = 0;
  while (bits < 32 && (value & 1) === 1) {
    value >>>= 1;
    bits += 1;
  }
  const max = bits >= 31 ? 0xffffffff : ((1 << bits) - 1);
  return { shift, bits, max, scale: bits !== 8 };
}

// ---------------------------------------------------------------------------
// Xauthority (MIT-MAGIC-COOKIE-1) support
// ---------------------------------------------------------------------------

/**
 * Parse a binary Xauthority file into its entries.  The format is big-endian:
 * for every entry, family(u16), then four (length u16 + raw bytes) fields:
 * address, display number, auth name, auth data.
 * @param {Buffer} buffer
 * @returns {{family: number, address: Buffer, number: string, name: string, data: Buffer}[]}
 */
function parseXauthority(buffer) {
  const entries = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const family = buffer.readUInt16BE(offset);
    offset += 2;
    const fields = [];
    for (let i = 0; i < 4; i += 1) {
      if (offset + 2 > buffer.length) throw new Error('truncated length field');
      const length = buffer.readUInt16BE(offset);
      offset += 2;
      if (offset + length > buffer.length) throw new Error('truncated field data');
      fields.push(buffer.subarray(offset, offset + length));
      offset += length;
    }
    entries.push({
      family,
      address: fields[0],
      number: fields[1].toString('latin1'),
      name: fields[2].toString('latin1'),
      data: fields[3],
    });
  }
  return entries;
}

/** Does an Xauthority display-number field apply to our display number? */
function xauthDisplayMatches(numberText, displayNumber) {
  const text = String(numberText == null ? '' : numberText).trim();
  if (text === '') return true; // wildcard entry
  const match = /^(\d+)(?:\.[^.]*)?$/.exec(text);
  if (!match) return false;
  return Number.parseInt(match[1], 10) === displayNumber;
}

/**
 * Pick the best MIT-MAGIC-COOKIE-1 entry for the connection target.
 * FamilyLocal entries for this hostname are preferred for unix sockets,
 * FamilyInternet entries for TCP, and FamilyWild entries are accepted too.
 */
function selectXauthCookie(entries, target) {
  const hostname = os.hostname();
  const targetHost = target.kind === 'tcp' ? String(target.host || '') : '';
  const localAddresses = new Set();
  if (target.kind === 'tcp') {
    if (targetHost === 'localhost' || targetHost === '127.0.0.1' || targetHost === '::1') {
      localAddresses.add('127.0.0.1');
      localAddresses.add('::1');
    }
    try {
      for (const list of Object.values(os.networkInterfaces())) {
        for (const item of list || []) localAddresses.add(item.address);
      }
    } catch {
      /* ignore */
    }
  }

  const candidates = [];
  for (const entry of entries) {
    if (entry.name !== XAUTH_NAME || entry.data.length === 0) continue;
    if (!xauthDisplayMatches(entry.number, target.number)) continue;
    const addressText = entry.address.toString('latin1');
    let score = 0;
    switch (entry.family) {
      case XAUTH_FAMILY_WILD:
        score = 50;
        break;
      case XAUTH_FAMILY_LOCAL:
      case XAUTH_FAMILY_LOCAL_HOST:
        // FamilyLocal carries the local hostname; accept an empty address too.
        score = addressText === '' || addressText === hostname ? 110 : 90;
        if (target.kind === 'unix') score += 30;
        break;
      case XAUTH_FAMILY_INTERNET:
      case XAUTH_FAMILY_INTERNET6:
        score = localAddresses.has(addressText) ? 100 : 60;
        if (target.kind === 'tcp') score += 20;
        break;
      default:
        // Any other family: accepted but least preferred.
        score = 40;
        break;
    }
    candidates.push({ entry, score });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0].entry;
}

/**
 * A connection to one X11 server / screen.
 *
 * Create instances with `await X11Display.connect()`; the constructor only
 * initialises defaults.
 */
export class X11Display {
  /**
   * Connect to an X server and finish the setup handshake.
   * @param {{display?: string, socketPath?: string}} [options]
   * @returns {Promise<X11Display>}
   */
  static async connect(options = {}) {
    const opts = options == null ? {} : options;
    const target = resolveTarget(
      opts.display == null ? (process.env.DISPLAY || ':0') : opts.display,
      opts.socketPath,
    );
    const display = new X11Display();
    display.display = target.display;
    display.screenNumber = target.screen;
    display.socketPath = target.kind === 'unix' ? target.path : `tcp://${target.host}:${target.port}`;
    await display._establish(target);
    return display;
  }

  constructor() {
    /** Server screen width in pixels. */
    this.width = 0;
    /** Server screen height in pixels. */
    this.height = 0;
    /** Root window depth (24 for typical Xvfb). */
    this.depth = 0;
    /** Bits per pixel of the pixmap format matching the root depth. */
    this.bpp = 0;
    /** Root window id. */
    this.root = 0;
    /** Root visual id. */
    this.visual = 0;
    /** Colour masks of the root visual. */
    this.masks = { r: 0, g: 0, b: 0 };
    /** Padded number of bytes per scanline of a root-depth GetImage. */
    this.bytesPerLine = 0;
    /** Scanline padding of the root pixmap format, in bits. */
    this.scanlinePad = 32;
    /** Minimum keycode reported by the server. */
    this.minKeycode = 8;
    /** Maximum keycode reported by the server. */
    this.maxKeycode = 255;
    /** keysym -> keycode map for group-1 column 0 (unshifted). */
    this.keymap = new Map();

    // Extra parsed setup facts (useful for diagnostics / cross-checks).
    this.vendor = '';
    this.releaseNumber = 0;
    this.protocolMajor = 0;
    this.protocolMinor = 0;
    this.imageByteOrder = 'LSBFirst';
    this.pixmapFormats = [];
    this.screens = [];
    this.maxRequestSize = 0;
    this.xtestOpcode = 0;
    this.display = '';

    // Xauthority diagnostics: auth name, its length and the file used.  The
    // cookie *value* is deliberately never stored on the instance.
    this.authName = '';
    this.authDataLength = 0;
    this.authSource = 'none';
    this.authError = null;

    // keysym -> { keycode, shift } covering the first two columns of group 1
    // (used by the ASCII text fallback to press Shift when required).
    this._keymapShift = new Map();

    // io state
    this.socket = null;
    this._chunks = [];
    this._chunkBytes = 0;
    this._pending = null;
    this._closed = false;
    this._error = null;
    this._seq = 0;

    this._rInfo = maskInfo(0);
    this._gInfo = maskInfo(0);
    this._bInfo = maskInfo(0);
  }

  // -------------------------------------------------------------------------
  // Connection / setup
  // -------------------------------------------------------------------------

  async _establish(target) {
    await this._connectSocket(target);
    const cookie = this._resolveAuthCookie(target);
    this._writeSetupRequest(cookie);
    // xConnSetupPrefix: success(1) reasonLen(1) major(2) minor(2) length(2).
    const prefix = await this._read(8);
    const status = prefix[0];
    const reasonLen = prefix[1];
    const major = prefix.readUInt16LE(2);
    const minor = prefix.readUInt16LE(4);
    const extraLength = prefix.readUInt16LE(6); // in 4-byte units
    if (status === 0) {
      const body = extraLength > 0 ? await this._read(extraLength * 4) : Buffer.alloc(0);
      const reason = body.subarray(0, Math.min(reasonLen, body.length)).toString('latin1');
      const authHint = this.authName
        ? `auth ${this.authName} (${this.authDataLength} bytes, source ${this.authSource})`
        : `no ${XAUTH_NAME} cookie found${this.authError ? ` (${this.authError})` : ''}`;
      throw new X11Error(
        `X server refused the connection: ${reason || 'unknown reason'} `
        + `(protocol ${major}.${minor}; ${authHint})`,
      );
    }
    if (status !== 1) {
      // X11 also defines status 2 = Authenticate, which is not implemented by
      // real servers.  Treat anything else as a hard failure.
      if (extraLength > 0) await this._read(extraLength * 4);
      throw new X11Error(`X server returned unsupported handshake status ${status}`);
    }
    const body = extraLength > 0 ? await this._read(extraLength * 4) : Buffer.alloc(0);
    this.protocolMajor = major;
    this.protocolMinor = minor;
    this._parseSetup(body);

    const xtest = await this.queryExtension('XTEST');
    this.xtestOpcode = xtest.present ? xtest.majorOpcode : 0;
    await this.buildKeymap();
  }

  _connectSocket(target) {
    return new Promise((resolve, reject) => {
      let socket;
      try {
        socket = target.kind === 'unix'
          ? net.connect({ path: target.path })
          : net.connect({ host: target.host, port: target.port });
      } catch (err) {
        reject(new X11Error(`cannot connect to X server at ${target.label}: ${err.message}`));
        return;
      }
      const onConnectError = (err) => {
        socket.destroy();
        reject(new X11Error(
          `cannot connect to X server at ${target.label}: ${err.code || err.message}`,
          { code: err.code },
        ));
      };
      socket.once('error', onConnectError);
      socket.once('connect', () => {
        socket.removeListener('error', onConnectError);
        socket.on('data', (chunk) => this._onData(chunk));
        socket.on('error', (err) => this._onSocketError(err));
        socket.on('close', () => this._onSocketClose());
        this.socket = socket;
        resolve(socket);
      });
    });
  }

  /**
   * Send the connection setup request.  When a MIT-MAGIC-COOKIE-1 entry was
   * found, the auth name and data are appended (each padded to 4 bytes); with
   * no cookie the request is the unauthenticated 12-byte form.
   */
  _writeSetupRequest(cookie) {
    const authName = cookie ? Buffer.from(cookie.name, 'latin1') : Buffer.alloc(0);
    const authData = cookie ? cookie.data : Buffer.alloc(0);
    const namePad = align4(authName.length) - authName.length;
    const dataPad = align4(authData.length) - authData.length;
    const req = Buffer.alloc(12 + authName.length + namePad + authData.length + dataPad);
    req[0] = 0x6c; // 'l' = little endian
    req[1] = 0; // unused
    req.writeUInt16LE(11, 2); // protocol major version
    req.writeUInt16LE(0, 4); // protocol minor version
    req.writeUInt16LE(authName.length, 6);
    req.writeUInt16LE(authData.length, 8);
    req.writeUInt16LE(0, 10); // pad
    authName.copy(req, 12);
    authData.copy(req, 12 + authName.length + namePad);
    this._rawWrite(req);
  }

  /**
   * Resolve the MIT-MAGIC-COOKIE-1 cookie for this connection.
   * Priority: $XAUTHORITY, then ~/.Xauthority (when it exists).  Any read or
   * parse failure, or a file without a matching entry, falls back to an empty
   * auth request exactly like the unauthenticated behaviour.
   * @returns {{name: string, data: Buffer}|null}
   */
  _resolveAuthCookie(target) {
    this.authName = '';
    this.authDataLength = 0;
    this.authSource = 'none';
    this.authError = null;

    const explicit = process.env.XAUTHORITY;
    let path = null;
    if (explicit != null && explicit !== '') {
      path = explicit;
    } else {
      const home = os.homedir();
      if (home) {
        const candidate = `${home}/.Xauthority`;
        try {
          if (fs.existsSync(candidate)) path = candidate;
        } catch {
          /* treat as absent */
        }
      }
    }
    if (!path) return null;

    let raw;
    try {
      raw = fs.readFileSync(path);
    } catch (err) {
      this.authError = `cannot read ${path}: ${err && err.code ? err.code : err}`;
      return null;
    }
    let entries;
    try {
      entries = parseXauthority(raw);
    } catch (err) {
      this.authError = `cannot parse ${path}: ${err && err.message ? err.message : err}`;
      return null;
    }
    if (!Number.isInteger(target.number)) {
      this.authError = 'no display number available for Xauthority lookup';
      return null;
    }
    const entry = selectXauthCookie(entries, target);
    if (!entry) {
      this.authError = `no ${XAUTH_NAME} entry for display :${target.number} in ${path}`;
      return null;
    }
    this.authName = XAUTH_NAME;
    this.authDataLength = entry.data.length;
    this.authSource = path;
    return { name: XAUTH_NAME, data: entry.data };
  }

  _parseSetup(body) {
    // xConnSetup (32 bytes on the wire)
    if (body.length < 32) {
      throw new X11Error(`truncated connection setup (${body.length} bytes)`);
    }
    this.releaseNumber = body.readUInt32LE(0);
    const nbytesVendor = body.readUInt16LE(16);
    this.maxRequestSize = body.readUInt16LE(18);
    const numRoots = body[20];
    const numFormats = body[21];
    this.imageByteOrder = body[22] === LSB_FIRST ? 'LSBFirst' : 'MSBFirst';
    this.minKeycode = body[26];
    this.maxKeycode = body[27];

    let offset = 32;
    if (offset + nbytesVendor > body.length) {
      throw new X11Error('truncated vendor string in connection setup');
    }
    this.vendor = body.subarray(offset, offset + nbytesVendor).toString('latin1');
    offset += align4(nbytesVendor);

    this.pixmapFormats = [];
    for (let i = 0; i < numFormats; i += 1) {
      if (offset + 8 > body.length) {
        throw new X11Error('truncated pixmap format list in connection setup');
      }
      this.pixmapFormats.push({
        depth: body[offset],
        bitsPerPixel: body[offset + 1],
        scanlinePad: body[offset + 2],
      });
      offset += 8;
    }

    this.screens = [];
    for (let i = 0; i < numRoots; i += 1) {
      if (offset + 40 > body.length) {
        throw new X11Error('truncated screen (xWindowRoot) in connection setup');
      }
      const screen = {
        root: body.readUInt32LE(offset),
        defaultColormap: body.readUInt32LE(offset + 4),
        whitePixel: body.readUInt32LE(offset + 8),
        blackPixel: body.readUInt32LE(offset + 12),
        currentInputMask: body.readUInt32LE(offset + 16),
        width: body.readUInt16LE(offset + 20),
        height: body.readUInt16LE(offset + 22),
        mmWidth: body.readUInt16LE(offset + 24),
        mmHeight: body.readUInt16LE(offset + 26),
        minInstalledMaps: body.readUInt16LE(offset + 28),
        maxInstalledMaps: body.readUInt16LE(offset + 30),
        rootVisual: body.readUInt32LE(offset + 32),
        backingStore: body[offset + 36],
        saveUnders: body[offset + 37],
        rootDepth: body[offset + 38],
        nDepths: body[offset + 39],
        depths: [],
      };
      offset += 40;
      for (let d = 0; d < screen.nDepths; d += 1) {
        if (offset + 8 > body.length) {
          throw new X11Error('truncated depth list in connection setup');
        }
        const depth = body[offset];
        const nVisuals = body.readUInt16LE(offset + 2);
        offset += 8;
        const visuals = [];
        for (let v = 0; v < nVisuals; v += 1) {
          if (offset + 24 > body.length) {
            throw new X11Error('truncated visual list in connection setup');
          }
          visuals.push({
            visualID: body.readUInt32LE(offset),
            class: body[offset + 4],
            bitsPerRGB: body[offset + 5],
            colormapEntries: body.readUInt16LE(offset + 6),
            redMask: body.readUInt32LE(offset + 8),
            greenMask: body.readUInt32LE(offset + 12),
            blueMask: body.readUInt32LE(offset + 16),
          });
          offset += 24;
        }
        screen.depths.push({ depth, visuals });
      }
      this.screens.push(screen);
    }

    const selected = this.screens[this.screenNumber] ?? this.screens[0];
    if (!selected) {
      throw new X11Error('X server reports no screens');
    }
    this.root = selected.root;
    this.visual = selected.rootVisual;
    this.width = selected.width;
    this.height = selected.height;
    this.depth = selected.rootDepth;

    const format = this.pixmapFormats.find((f) => f.depth === this.depth);
    if (!format) {
      throw new X11Error(`X server reports no pixmap format for root depth ${this.depth}`);
    }
    this.bpp = format.bitsPerPixel;
    this.scanlinePad = format.scanlinePad || 32;
    this.bytesPerLine = (Math.ceil((this.width * this.bpp) / this.scanlinePad) * this.scanlinePad) / 8;

    const depthInfo = selected.depths.find((d) => d.depth === this.depth);
    const visual = depthInfo && depthInfo.visuals.find((v) => v.visualID === this.visual);
    if (!visual) {
      throw new X11Error(
        `X server reports no visual ${this.visual} for root depth ${this.depth}`,
      );
    }
    this.masks = {
      r: visual.redMask,
      g: visual.greenMask,
      b: visual.blueMask,
    };
    this._rInfo = maskInfo(this.masks.r);
    this._gInfo = maskInfo(this.masks.g);
    this._bInfo = maskInfo(this.masks.b);

    if (this.bpp !== 32 && this.bpp !== 24 && this.bpp !== 16) {
      throw new X11Error(`unsupported bits-per-pixel ${this.bpp} (expected 24, 32 or 16)`);
    }
  }

  // -------------------------------------------------------------------------
  // Byte stream plumbing
  // -------------------------------------------------------------------------

  _onData(chunk) {
    this._chunks.push(chunk);
    this._chunkBytes += chunk.length;
    if (this._pending && this._chunkBytes >= this._pending.n) {
      const pending = this._pending;
      this._pending = null;
      pending.resolve();
    }
  }

  _onSocketError(err) {
    if (this._closed) return;
    this._error = new X11Error(
      `X11 connection to ${this.socketPath} failed: ${err.code || err.message}`,
      { code: err.code },
    );
    this._rejectPending();
  }

  _onSocketClose() {
    if (this._closed) return;
    this._closed = true;
    this._error = this._error || new X11Error(
      `X11 connection to ${this.socketPath} closed unexpectedly`,
    );
    this._rejectPending();
  }

  _rejectPending() {
    if (!this._pending) return;
    const pending = this._pending;
    this._pending = null;
    pending.reject(this._error || new X11Error('X11 connection closed'));
  }

  _assertOpen() {
    if (this._closed) {
      throw this._error || new X11Error('X11 connection is closed');
    }
  }

  _waitFor(n) {
    if (this._closed) return Promise.reject(this._error || new X11Error('X11 connection is closed'));
    if (this._chunkBytes >= n) return Promise.resolve();
    if (this._pending) {
      return Promise.reject(new X11Error('internal error: concurrent X11 reads are not supported'));
    }
    return new Promise((resolve, reject) => {
      this._pending = { n, resolve, reject };
    });
  }

  async _read(n) {
    if (n <= 0) return Buffer.alloc(0);
    await this._waitFor(n);
    // Materialise the queued chunks exactly once per read instead of
    // concatenating on every socket data event (which is O(n^2) for the
    // multi-megabyte GetImage replies).
    const all = this._chunks.length === 1
      ? this._chunks[0]
      : Buffer.concat(this._chunks, this._chunkBytes);
    this._chunks = [];
    this._chunkBytes = 0;
    const out = all.subarray(0, n);
    if (all.length > n) {
      this._chunks.push(all.subarray(n));
      this._chunkBytes = all.length - n;
    }
    return out;
  }

  _rawWrite(buf) {
    this._assertOpen();
    this.socket.write(buf);
  }

  _nextSequence() {
    this._seq = (this._seq + 1) & 0xffff;
    return this._seq;
  }

  /**
   * Write one request and return its reply header (32 bytes).
   * Server events interleaved with replies (MappingNotify is the only one this
   * connection can receive, since no event mask is ever selected) are skipped.
   */
  async _request(req, opName) {
    this._rawWrite(req);
    this._nextSequence();
    let guard = 0;
    for (;;) {
      guard += 1;
      if (guard > 1024) {
        throw new X11Error(`${opName}: too many interleaved events while waiting for reply`);
      }
      const header = await this._read(32);
      const type = header[0];
      if (type === 0) {
        const code = header[1];
        throw new X11Error(
          `${opName}: X11 error ${X_ERROR_NAMES[code] || code} (code ${code})`,
          { code, op: opName },
        );
      }
      if (type === 1) return header; // Reply
      // Any other type is an event.  GenericEvent (35) carries extra data.
      if (type === 35) {
        const extra = header.readUInt32LE(4);
        if (extra > 0) await this._read(extra * 4);
      }
      // Ordinary events have no extra body; keep reading for the reply.
    }
  }

  async _readExtra(header, opName) {
    const length = header.readUInt32LE(4);
    const bytes = length * 4;
    if (bytes <= 0) return Buffer.alloc(0);
    try {
      return await this._read(bytes);
    } catch (err) {
      throw new X11Error(`${opName}: failed to read reply data: ${err.message}`);
    }
  }

  // -------------------------------------------------------------------------
  // Requests
  // -------------------------------------------------------------------------

  /**
   * Query one extension by name.
   * @param {string} name
   * @returns {Promise<{present: boolean, majorOpcode: number, firstEvent: number, firstError: number}>}
   */
  async queryExtension(name) {
    const nameBuf = Buffer.from(String(name), 'latin1');
    const total = 8 + align4(nameBuf.length);
    const req = Buffer.alloc(total);
    req[0] = X11_OPCODE.QueryExtension;
    req[1] = 0;
    req.writeUInt16LE(total / 4, 2);
    req.writeUInt16LE(nameBuf.length, 4);
    // req[6], req[7] are padding
    nameBuf.copy(req, 8);
    const header = await this._request(req, `QueryExtension(${name})`);
    // Generic reply header is 8 bytes (type, detail, sequence, length); the
    // extension fields follow at offsets 8..11:
    // present(1) majorOpcode(1) firstEvent(1) firstError(1) + 20 pad bytes.
    const result = {
      present: header[8] === 1,
      majorOpcode: header[9],
      firstEvent: header[10],
      firstError: header[11],
    };
    const extra = await this._readExtra(header, `QueryExtension(${name})`);
    if (extra.length > 0) {
      // Not expected; consume it anyway so the stream stays aligned.
    }
    return result;
  }

  /**
   * Fetch and rebuild the keysym -> keycode map from the server.
   * @returns {Promise<Map<number, number>>}
   */
  async buildKeymap() {
    const count = this.maxKeycode - this.minKeycode + 1;
    if (count <= 0) {
      this.keymap = new Map();
      this._keymapShift = new Map();
      return this.keymap;
    }
    const req = Buffer.alloc(8);
    req[0] = X11_OPCODE.GetKeyboardMapping;
    req[1] = 0;
    req.writeUInt16LE(2, 2);
    req[4] = this.minKeycode;
    req[5] = count & 0xff;
    const header = await this._request(req, 'GetKeyboardMapping');
    const keysymsPerKeycode = header[1] >>> 0;
    const extra = await this._readExtra(header, 'GetKeyboardMapping');
    const expected = count * keysymsPerKeycode * 4;
    if (extra.length < expected) {
      throw new X11Error(
        `GetKeyboardMapping: short reply (${extra.length} bytes, expected ${expected})`,
      );
    }
    const keymap = new Map();
    const shifted = new Map();
    for (let i = 0; i < count; i += 1) {
      const keycode = this.minKeycode + i;
      for (let col = 0; col < keysymsPerKeycode && col < 2; col += 1) {
        const keysym = extra.readUInt32LE((i * keysymsPerKeycode + col) * 4);
        if (keysym === 0) continue;
        // Unshifted (col 0) mapping asked for by the contract; when the same
        // keysym exists on several keycodes keep the lowest keycode.
        if (col === 0) {
          const previous = keymap.get(keysym);
          if (previous === undefined || keycode < previous) {
            keymap.set(keysym, keycode);
          }
        }
        // Extended mapping used by the ASCII text fallback.
        const isShifted = col === 1;
        const current = shifted.get(keysym);
        const better = current === undefined
          || (current.shift && !isShifted)
          || (current.shift === isShifted && keycode < current.keycode);
        if (better) {
          shifted.set(keysym, { keycode, shift: isShifted });
        }
      }
    }
    this.keymap = keymap;
    this._keymapShift = shifted;
    return this.keymap;
  }

  /**
   * Look up the keycode that produces a keysym with the group-1 unshifted column.
   * @param {number} keysym
   * @returns {number|null}
   */
  keycodeForKeysym(keysym) {
    const keycode = this.keymap.get(keysym);
    return keycode === undefined ? null : keycode;
  }

  /**
   * Look up any keycode producing the keysym, including shifted columns.
   * @param {number} keysym
   * @returns {{keycode: number, shift: boolean}|null}
   */
  resolveKeysym(keysym) {
    const direct = this.keymap.get(keysym);
    if (direct !== undefined) return { keycode: direct, shift: false };
    const entry = this._keymapShift.get(keysym);
    return entry === undefined ? null : { keycode: entry.keycode, shift: entry.shift };
  }

  /**
   * Read the pointer position/button mask relative to the root window.
   * @returns {Promise<{x: number, y: number, mask: number}>}
   */
  async queryPointer() {
    const req = Buffer.alloc(8);
    req[0] = X11_OPCODE.QueryPointer;
    req[1] = 0;
    req.writeUInt16LE(2, 2);
    req.writeUInt32LE(this.root, 4);
    const header = await this._request(req, 'QueryPointer');
    // type(1) sameScreen(1) sequence(2) length(4) root(4) child(4)
    // rootX i16 @16, rootY i16 @18, winX @20, winY @22, mask u16 @24
    const extra = await this._readExtra(header, 'QueryPointer');
    if (extra.length > 0) {
      // Not expected; consumed to keep the stream aligned.
    }
    return {
      x: header.readInt16LE(16),
      y: header.readInt16LE(18),
      mask: header.readUInt16LE(24),
    };
  }

  /**
   * Read a rectangle from the root window as raw ZPixmap bytes.
   * Rows are padded to the server's scanline_pad for the requested width; the
   * returned Buffer has exactly `ceil(width*bpp/scanlinePad)*scanlinePad/8 *
   * height` bytes.
   * @param {{x: number, y: number, width: number, height: number}} rect
   * @returns {Promise<Buffer>}
   */
  async getImage({ x = 0, y = 0, width = this.width, height = this.height } = {}) {
    const ix = Math.trunc(Number(x));
    const iy = Math.trunc(Number(y));
    const iw = Math.trunc(Number(width));
    const ih = Math.trunc(Number(height));
    if (![ix, iy, iw, ih].every(Number.isFinite)) {
      throw new X11Error('getImage: x/y/width/height must be finite numbers');
    }
    if (iw <= 0 || ih <= 0) {
      throw new X11Error(`getImage: invalid size ${iw}x${ih}`);
    }
    if (ix < 0 || iy < 0 || ix + iw > this.width || iy + ih > this.height) {
      throw new X11Error(
        `getImage: rectangle ${ix},${iy} ${iw}x${ih} is outside the ${this.width}x${this.height} screen`,
      );
    }
    // xGetImageReq: reqType(1) format(1) length(2) drawable(4) x(2) y(2)
    //               width(2) height(2) planeMask(4)  => 20 bytes, length 5.
    const req = Buffer.alloc(20);
    req[0] = X11_OPCODE.GetImage;
    req[1] = ZPIXMAP;
    req.writeUInt16LE(5, 2);
    req.writeUInt32LE(this.root, 4);
    req.writeInt16LE(ix, 8);
    req.writeInt16LE(iy, 10);
    req.writeUInt16LE(iw, 12);
    req.writeUInt16LE(ih, 14);
    req.writeUInt32LE(0xffffffff, 16); // planeMask: all planes
    const header = await this._request(req, 'GetImage');
    const extra = await this._readExtra(header, 'GetImage');
    // The reply rows are padded for the *requested* width, not the drawable
    // width, so derive the scanline size from `iw`.
    const requestBytesPerLine = (Math.ceil((iw * this.bpp) / this.scanlinePad) * this.scanlinePad) / 8;
    const expected = requestBytesPerLine * ih;
    if (extra.length < expected) {
      throw new X11Error(`GetImage: short pixel data (${extra.length} bytes, expected ${expected})`);
    }
    return extra.length === expected ? extra : extra.subarray(0, expected);
  }

  // -------------------------------------------------------------------------
  // XTest input injection
  // -------------------------------------------------------------------------

  _assertXtest(opName) {
    if (this.xtestOpcode === 0) {
      throw new X11Error(`${opName}: XTEST extension is not available on this X server`);
    }
  }

  _fakeInputBuffer(eventType, detail, rootX = 0, rootY = 0) {
    const buf = Buffer.alloc(36);
    buf[0] = this.xtestOpcode;
    buf[1] = 2; // X_XTestFakeInput
    buf.writeUInt16LE(9, 2);
    buf[4] = eventType;
    buf[5] = detail & 0xff;
    // time = CurrentTime at offset 8
    buf.writeUInt32LE(0, 8);
    if (eventType === X11_EVENT.MotionNotify) {
      buf.writeUInt32LE(this.root, 12);
      buf.writeInt16LE(rootX, 24);
      buf.writeInt16LE(rootY, 26);
    }
    // pad1 @16, pad2 @20, pad3 @28, pad4 @30, pad5 @32, deviceid @33 = 0
    return buf;
  }

  /** Move the core pointer to absolute root coordinates. */
  moveMouse(x, y) {
    this._assertXtest('moveMouse');
    const px = Math.max(0, Math.min(this.width - 1, Math.round(Number(x) || 0)));
    const py = Math.max(0, Math.min(this.height - 1, Math.round(Number(y) || 0)));
    this._rawWrite(this._fakeInputBuffer(X11_EVENT.MotionNotify, 0, px, py));
  }

  /** Press/release a pointer button (1=left, 2=middle, 3=right, 4/5 wheel, 6/7 hwheel). */
  sendButton(button, press) {
    this._assertXtest('sendButton');
    const btn = Math.trunc(Number(button));
    if (!Number.isFinite(btn) || btn < 1 || btn > 255) {
      throw new X11Error(`sendButton: invalid button ${button}`);
    }
    const type = press ? X11_EVENT.ButtonPress : X11_EVENT.ButtonRelease;
    this._rawWrite(this._fakeInputBuffer(type, btn));
  }

  /** Press/release a keyboard key by X11 keycode. */
  sendKey(keycode, press) {
    this._assertXtest('sendKey');
    const kc = Math.trunc(Number(keycode));
    if (!Number.isFinite(kc) || kc < 8 || kc > 255) {
      throw new X11Error(`sendKey: invalid keycode ${keycode}`);
    }
    const type = press ? X11_EVENT.KeyPress : X11_EVENT.KeyRelease;
    this._rawWrite(this._fakeInputBuffer(type, kc));
  }

  /**
   * Wait until every buffered request has been handed to the socket.
   * @returns {Promise<void>}
   */
  async flush() {
    const socket = this.socket;
    if (this._closed || !socket) return;
    if (socket.writableLength === 0) return;
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        socket.removeListener('drain', finish);
        socket.removeListener('close', finish);
        socket.removeListener('error', finish);
        resolve();
      };
      socket.once('drain', finish);
      socket.once('close', finish);
      socket.once('error', finish);
      // The buffer may have drained between the check and listener setup.
      if (socket.writableLength === 0) finish();
    });
  }

  /** Close the connection. Safe to call more than once. */
  close() {
    if (this._closed) return;
    this._closed = true;
    this._rejectPending();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try {
        socket.destroy();
      } catch {
        /* ignore teardown errors */
      }
    }
  }
}

export default X11Display;
