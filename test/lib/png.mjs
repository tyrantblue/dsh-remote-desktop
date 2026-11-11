/**
 * Minimal, dependency-free PNG encoder (8-bit RGB or RGBA).
 *
 * Used by the E2E test and the demo to persist real screenshots captured from
 * the Agent / X server. Implemented by hand (IHDR/IDAT/IEND + CRC32) so the
 * test suite needs no npm package; the output is a spec-conformant PNG that
 * `file(1)`, browsers and image viewers accept.
 */

import fs from 'node:fs';
import zlib from 'node:zlib';

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let crcTableCache = null;
function crcTable() {
  if (crcTableCache) return crcTableCache;
  crcTableCache = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    crcTableCache[n] = c;
  }
  return crcTableCache;
}

/** CRC-32 as required by the PNG chunk format. */
export function crc32(buffer) {
  const table = crcTable();
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = (crc >>> 8) ^ table[(crc ^ buffer[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crcInput = Buffer.concat([typeBuffer, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

/**
 * Encode raw pixels as a PNG buffer.
 *
 * @param {object} input
 * @param {number} input.width
 * @param {number} input.height
 * @param {Buffer} input.rgba row-major RGBA, width*height*4 bytes
 * @param {6|2} [input.colorType=6] 6 = RGBA, 2 = RGB (alpha dropped)
 * @returns {Buffer}
 */
export function encodePng({ width, height, rgba, colorType = 6 }) {
  if (!Number.isInteger(width) || width <= 0) throw new Error(`encodePng: bad width ${width}`);
  if (!Number.isInteger(height) || height <= 0)
    throw new Error(`encodePng: bad height ${height}`);
  if (!Buffer.isBuffer(rgba)) throw new Error('encodePng: rgba must be a Buffer');
  if (colorType !== 6 && colorType !== 2) {
    throw new Error(`encodePng: colorType must be 6 (RGBA) or 2 (RGB), got ${colorType}`);
  }
  const expected = width * height * 4;
  if (rgba.length < expected) {
    throw new Error(`encodePng: expected ${expected} RGBA bytes, got ${rgba.length}`);
  }

  const channels = colorType === 6 ? 4 : 3;
  const rowBytes = width * channels;
  // Every scanline is prefixed with filter type 0 ("None").
  const raw = Buffer.alloc((rowBytes + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rawOffset = y * (rowBytes + 1);
    raw[rawOffset] = 0;
    let source = y * width * 4;
    let target = rawOffset + 1;
    if (channels === 4) {
      rgba.copy(raw, target, source, source + rowBytes);
    } else {
      for (let x = 0; x < width; x += 1) {
        raw[target] = rgba[source];
        raw[target + 1] = rgba[source + 1];
        raw[target + 2] = rgba[source + 2];
        source += 4;
        target += 3;
      }
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = colorType;
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter method: adaptive
  ihdr[12] = 0; // interlace: none

  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Encode and write a PNG file.
 * @param {string} filePath
 * @param {{width:number,height:number,rgba:Buffer,colorType?:6|2}} pixels
 * @returns {{path:string, bytes:number, width:number, height:number}}
 */
export function writePng(filePath, pixels) {
  const buffer = encodePng(pixels);
  fs.writeFileSync(filePath, buffer);
  return { path: filePath, bytes: buffer.length, width: pixels.width, height: pixels.height };
}

/**
 * Parse the PNG chunks back out of a buffer (used by the infrastructure
 * self-check; the test suite itself does not need a decoder).
 * @returns {{width:number,height:number,bitDepth:number,colorType:number,chunks:string[]}}
 */
export function readPngHeader(buffer) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('not a PNG file (bad signature)');
  }
  const chunks = [];
  let offset = 8;
  let ihdr = null;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    chunks.push(type);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buffer.length) throw new Error(`truncated PNG chunk ${type}`);
    if (type === 'IHDR') {
      ihdr = {
        width: buffer.readUInt32BE(dataStart),
        height: buffer.readUInt32BE(dataStart + 4),
        bitDepth: buffer[dataStart + 8],
        colorType: buffer[dataStart + 9],
      };
    }
    offset = dataEnd + 4;
  }
  if (!ihdr) throw new Error('PNG has no IHDR chunk');
  return { ...ihdr, chunks };
}
