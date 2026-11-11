/**
 * capture.mjs — root-window screen capture with tile diffing.
 *
 * One grab() reads the whole root window with GetImage (ZPixmap), converts it
 * to tightly packed RGBA (row-major, R,G,B,A per pixel), reads the pointer with
 * QueryPointer and compares the new frame against the previous one.  Only the
 * tiles that actually changed are returned, so the network layer can send a
 * small incremental frame.
 *
 * Buffers are reused between frames: grab() never allocates a full frame
 * buffer, only the RGBA payload of the changed tiles.
 */

/** @typedef {{x: number, y: number, w: number, h: number, data: Buffer}} Tile */
/** @typedef {{changed: boolean, tiles: Tile[], cursor: {x: number, y: number, mask: number}}} GrabResult */

export class ScreenCapture {
  /**
   * @param {import('./x11.mjs').X11Display} x11
   * @param {{tile?: number}} [options]
   */
  constructor(x11, options = {}) {
    if (!x11 || typeof x11.getImage !== 'function') {
      throw new TypeError('ScreenCapture requires an X11Display instance');
    }
    this.x11 = x11;
    const requestedTile = options && options.tile != null ? Number(options.tile) : 64;
    this.tile = Number.isFinite(requestedTile) && requestedTile > 0
      ? Math.max(8, Math.trunc(requestedTile))
      : 64;

    this.width = 0;
    this.height = 0;
    this.cols = 0;
    this.rows = 0;

    // Colour masks / conversion info are derived locally so the capture module
    // only relies on the documented X11Display fields.
    this._masks = {
      r: (x11.masks && x11.masks.r) || 0,
      g: (x11.masks && x11.masks.g) || 0,
      b: (x11.masks && x11.masks.b) || 0,
    };
    this._rInfo = maskInfo(this._masks.r);
    this._gInfo = maskInfo(this._masks.g);
    this._bInfo = maskInfo(this._masks.b);

    this._prev = null; // previous frame, RGBA
    this._curr = null; // frame being built, RGBA
    this._hasPrev = false;
    this._forceKeyframe = false;

    this._reset(x11.width, x11.height);
  }

  /** Ask the next grab() to return every tile (full keyframe). */
  forceKeyframe() {
    this._forceKeyframe = true;
  }

  _reset(width, height) {
    this.width = width;
    this.height = height;
    this.cols = Math.ceil(width / this.tile);
    this.rows = Math.ceil(height / this.tile);
    this._prev = Buffer.alloc(width * height * 4);
    this._curr = Buffer.alloc(width * height * 4);
    this._hasPrev = false;
    this._forceKeyframe = false;
  }

  /**
   * Capture one frame.
   * @returns {Promise<GrabResult>}
   */
  async grab() {
    const width = this.x11.width;
    const height = this.x11.height;
    if (width !== this.width || height !== this.height || this._curr === null) {
      // Screen geometry changed (or first capture): start over, next frame is
      // necessarily a full keyframe.
      this._reset(width, height);
    }

    const raw = await this.x11.getImage({ x: 0, y: 0, width, height });
    const pointer = await this.x11.queryPointer();

    const expected = this.x11.bytesPerLine * height;
    if (!Buffer.isBuffer(raw) || raw.length < expected) {
      throw new Error(
        `ScreenCapture: getImage returned ${raw && raw.length} bytes, expected at least ${expected}`,
      );
    }
    this._toRGBA(raw, width, height);

    const keyframe = !this._hasPrev || this._forceKeyframe;
    this._forceKeyframe = false;

    /** @type {Tile[]} */
    const tiles = [];
    const stride = width * 4;
    for (let row = 0; row < this.rows; row += 1) {
      const y = row * this.tile;
      const h = Math.min(this.tile, height - y);
      for (let col = 0; col < this.cols; col += 1) {
        const x = col * this.tile;
        const w = Math.min(this.tile, width - x);
        if (!keyframe && !this._tileChanged(x, y, w, h, stride)) continue;
        const data = Buffer.allocUnsafe(w * h * 4);
        for (let line = 0; line < h; line += 1) {
          const from = (y + line) * stride + x * 4;
          this._curr.copy(data, line * w * 4, from, from + w * 4);
        }
        tiles.push({ x, y, w, h, data });
      }
    }

    // Swap frame buffers: _prev becomes the frame we just captured and _curr
    // becomes the reusable scratch buffer for the next grab.
    const scratch = this._prev;
    this._prev = this._curr;
    this._curr = scratch;
    this._hasPrev = true;

    return {
      changed: tiles.length > 0,
      tiles,
      cursor: { x: pointer.x, y: pointer.y, mask: pointer.mask },
    };
  }

  _tileChanged(x, y, w, h, stride) {
    const len = w * 4;
    const curr = this._curr;
    const prev = this._prev;
    for (let line = 0; line < h; line += 1) {
      const offset = (y + line) * stride + x * 4;
      // Buffer.compare(target) compares this[sourceStart,sourceEnd) with
      // target[targetStart,targetEnd); 0 means identical.
      if (curr.compare(prev, offset, offset + len, offset, offset + len) !== 0) {
        return true;
      }
    }
    return false;
  }

  _toRGBA(raw, width, height) {
    const x11 = this.x11;
    const out = this._curr;
    const stride = x11.bytesPerLine;
    const bpp = x11.bpp;
    const little = x11.imageByteOrder !== 'MSBFirst';
    const masks = this._masks;
    const rInfo = this._rInfo;
    const gInfo = this._gInfo;
    const bInfo = this._bInfo;
    const hasColor = masks.r !== 0 || masks.g !== 0 || masks.b !== 0;

    if (!hasColor) {
      // Monochrome/odd visual: produce a black/white image from the raw value.
      for (let y = 0; y < height; y += 1) {
        const rowStart = y * stride;
        let o = y * width * 4;
        for (let x = 0; x < width; x += 1) {
          let px;
          if (bpp === 32) px = little ? raw.readUInt32LE(rowStart + x * 4) : raw.readUInt32BE(rowStart + x * 4);
          else if (bpp === 24) px = this._read24(raw, rowStart + x * 3, little);
          else px = little ? raw.readUInt16LE(rowStart + x * 2) : raw.readUInt16BE(rowStart + x * 2);
          const v = px === 0 ? 0 : 255;
          out[o] = v;
          out[o + 1] = v;
          out[o + 2] = v;
          out[o + 3] = 255;
          o += 4;
        }
      }
      return;
    }

    // Fast path for the overwhelmingly common Xvfb/Xorg truecolour layout:
    // 32bpp little endian with 0x00RRGGBB pixels (byte order B,G,R,0).
    const fastTrueColor = bpp === 32
      && little
      && masks.r === 0xff0000
      && masks.g === 0x00ff00
      && masks.b === 0x0000ff;
    if (fastTrueColor) {
      for (let y = 0; y < height; y += 1) {
        let source = y * stride;
        let o = y * width * 4;
        const end = o + width * 4;
        while (o < end) {
          out[o] = raw[source + 2];
          out[o + 1] = raw[source + 1];
          out[o + 2] = raw[source];
          out[o + 3] = 255;
          o += 4;
          source += 4;
        }
      }
      return;
    }

    for (let y = 0; y < height; y += 1) {
      const rowStart = y * stride;
      let o = y * width * 4;
      for (let x = 0; x < width; x += 1) {
        let px;
        if (bpp === 32) {
          px = little ? raw.readUInt32LE(rowStart + x * 4) : raw.readUInt32BE(rowStart + x * 4);
        } else if (bpp === 24) {
          px = this._read24(raw, rowStart + x * 3, little);
        } else {
          px = little ? raw.readUInt16LE(rowStart + x * 2) : raw.readUInt16BE(rowStart + x * 2);
        }
        out[o] = scaleChannel(px, masks.r, rInfo);
        out[o + 1] = scaleChannel(px, masks.g, gInfo);
        out[o + 2] = scaleChannel(px, masks.b, bInfo);
        out[o + 3] = 255;
        o += 4;
      }
    }
  }

  _read24(raw, offset, little) {
    if (little) {
      return (raw[offset] | (raw[offset + 1] << 8) | (raw[offset + 2] << 16)) >>> 0;
    }
    return (raw[offset + 2] | (raw[offset + 1] << 8) | (raw[offset] << 16)) >>> 0;
  }
}

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

function scaleChannel(pixel, mask, info) {
  if (mask === 0 || info.bits === 0) return 0;
  const value = (pixel & mask) >>> info.shift;
  return info.scale ? Math.round((value * 255) / info.max) : value;
}

export default ScreenCapture;
