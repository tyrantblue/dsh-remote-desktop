/**
 * Independent pixel reference for the remote-desktop tests.
 *
 * We shell out to the system `xwd` (X Window Dump) and parse the XWD v7 file
 * ourselves. This deliberately shares no code with the Agent's X11 client: if
 * both agree on a pixel, the Agent's GetImage/ZPixmap decoding is confirmed
 * against a second, independent implementation.
 *
 * Wire facts verified against `xwd` 1.0.9 on this host (Xvfb 21.1.11):
 *  - The XWD *file header* is written big-endian (the first u32 is 0x6b = 107,
 *    not 0x6b000000). We therefore auto-detect the header byte order by
 *    locating file_version == 7 at offset 4.
 *  - The `byte_order` header field (offset 28) describes the *pixel data*:
 *    0 = LSBFirst (little-endian pixels), 1 = MSBFirst. Xvfb emits 32bpp
 *    LSBFirst pixels, e.g. raw bytes `cc 66 33 00` for #3366cc.
 *  - Layout: [100 byte XWDFileHeader][window name padding, up to
 *    header_size][ncolors * 12 byte XWDColor colormap][pixel data].
 *    Pixel data starts at header_size + ncolors*12; rows are bytes_per_line
 *    apart (may include scanline padding), each pixel is ceil(bits_per_pixel/8)
 *    bytes (24bpp -> 3 bytes on the wire, still LSBFirst).
 */

import { spawnSync } from 'node:child_process';

export const XWD_HEADER_BYTES = 100;
export const XWD_COLOR_BYTES = 12;
export const XWD_FILE_VERSION = 7;

const XWD_HEADER_FIELDS = [
  'header_size',
  'file_version',
  'pixmap_format',
  'pixmap_depth',
  'pixmap_width',
  'pixmap_height',
  'xoffset',
  'byte_order',
  'bitmap_unit',
  'bitmap_bit_order',
  'bitmap_pad',
  'bits_per_pixel',
  'bytes_per_line',
  'visual_class',
  'red_mask',
  'green_mask',
  'blue_mask',
  'bits_per_rgb',
  'colormap_entries',
  'ncolors',
  'window_width',
  'window_height',
  'window_x',
  'window_y',
  'window_bdrwidth',
];

const VISUAL_CLASSES = {
  0: 'StaticGray',
  1: 'GrayScale',
  2: 'StaticColor',
  3: 'PseudoColor',
  4: 'TrueColor',
  5: 'DirectColor',
};

/**
 * Run xwd and return the raw XWD file bytes.
 *
 * @param {string} display e.g. ":100"
 * @param {{windowId?: number|string|null}} [options] capture a window instead of the root
 * @returns {Buffer}
 */
export function runXwd(display, { windowId = null } = {}) {
  if (!display) throw new Error('runXwd: display is required');
  const args = ['-silent', '-display', String(display)];
  if (windowId != null) args.push('-id', String(windowId));
  else args.push('-root');

  const result = spawnSync('xwd', args, {
    encoding: null,
    timeout: 30000,
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) {
    throw new Error(`xwd failed to run: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = result.stderr ? result.stderr.toString('utf8').trim() : '';
    throw new Error(`xwd ${args.join(' ')} exited with status ${result.status}: ${stderr}`);
  }
  const stdout = result.stdout;
  if (!Buffer.isBuffer(stdout) || stdout.length < XWD_HEADER_BYTES) {
    throw new Error(
      `xwd returned ${Buffer.isBuffer(stdout) ? stdout.length : 0} bytes, expected at least ` +
        `${XWD_HEADER_BYTES}: ${result.stderr ? result.stderr.toString('utf8').trim() : ''}`,
    );
  }
  return stdout;
}

function channelFromMask(mask) {
  if (!mask) return null;
  let shift = 0;
  while (shift < 32 && ((mask >>> shift) & 1) === 0) shift += 1;
  const shifted = mask >>> shift;
  return { mask, shift, max: shifted >>> 0 };
}

function channelValue(pixelValue, channel) {
  if (!channel) return 0;
  const component = (pixelValue & channel.mask) >>> channel.shift;
  return Math.round((component * 255) / channel.max);
}

/**
 * Parse an XWD v7 buffer into a normalised RGBA pixel buffer.
 *
 * @param {Buffer} buffer raw XWD bytes
 * @returns {{width:number,height:number,rgba:Buffer,header:Record<string,number>,
 *   fileByteOrder:'LE'|'BE', pixelByteOrder:'LSBFirst'|'MSBFirst', bytesPerPixel:number,
 *   stride:number, visualClass:string|number, colormapEntries:number}}
 */
export function parseXwd(buffer) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
  if (buffer.length < XWD_HEADER_BYTES) {
    throw new Error(`XWD buffer is only ${buffer.length} bytes, header needs ${XWD_HEADER_BYTES}`);
  }
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  // Auto-detect the header byte order from the file_version field.
  let littleEndianHeader;
  if (view.getUint32(4, false) === XWD_FILE_VERSION) littleEndianHeader = false;
  else if (view.getUint32(4, true) === XWD_FILE_VERSION) littleEndianHeader = true;
  else {
    throw new Error(
      `not an XWD v7 file: file_version is 0x${view
        .getUint32(4, false)
        .toString(16)} (BE) / 0x${view.getUint32(4, true).toString(16)} (LE)`,
    );
  }

  const header = {};
  XWD_HEADER_FIELDS.forEach((name, index) => {
    header[name] = view.getUint32(index * 4, littleEndianHeader);
  });

  if (header.header_size < XWD_HEADER_BYTES || header.header_size > buffer.length) {
    throw new Error(
      `XWD header_size=${header.header_size} is outside the buffer (${buffer.length} bytes)`,
    );
  }
  if (header.pixmap_format !== 2) {
    throw new Error(
      `unsupported XWD pixmap_format=${header.pixmap_format} ` +
        `(only ZPixmap=2 can be converted to RGBA)`,
    );
  }

  const width = header.pixmap_width;
  const height = header.pixmap_height;
  const bitsPerPixel = header.bits_per_pixel;
  const bytesPerPixel = Math.max(1, Math.ceil(bitsPerPixel / 8));
  const stride = header.bytes_per_line;
  if (width <= 0 || height <= 0) {
    throw new Error(`XWD image has invalid size ${width}x${height}`);
  }
  if (stride < width * bytesPerPixel) {
    throw new Error(
      `XWD bytes_per_line=${stride} is smaller than width*bytesPerPixel=${width * bytesPerPixel}`,
    );
  }

  const pixelOffset = header.header_size + header.ncolors * XWD_COLOR_BYTES;
  const pixelBytes = stride * height;
  if (pixelOffset + pixelBytes > buffer.length) {
    throw new Error(
      `truncated XWD: pixel data ends at ${pixelOffset + pixelBytes} but buffer is ` +
        `${buffer.length} bytes (pixel offset ${pixelOffset}, stride ${stride}, height ${height})`,
    );
  }

  if (header.byte_order !== 0 && header.byte_order !== 1) {
    throw new Error(`unsupported XWD byte_order=${header.byte_order}`);
  }
  const pixelLittleEndian = header.byte_order === 0; // 0 = LSBFirst

  // Indexed visuals carry no channel masks; read the colormap instead. The
  // colormap entries were written with the same byte order as the header.
  let colormap = null;
  const hasMasks =
    header.red_mask !== 0 || header.green_mask !== 0 || header.blue_mask !== 0;
  if (!hasMasks) {
    colormap = new Map();
    for (let i = 0; i < header.ncolors; i += 1) {
      const base = header.header_size + i * XWD_COLOR_BYTES;
      const index = view.getUint32(base, littleEndianHeader);
      const red = view.getUint16(base + 4, littleEndianHeader);
      const green = view.getUint16(base + 6, littleEndianHeader);
      const blue = view.getUint16(base + 8, littleEndianHeader);
      colormap.set(index, [red >>> 8, green >>> 8, blue >>> 8]);
    }
  }

  const channels = {
    r: channelFromMask(header.red_mask),
    g: channelFromMask(header.green_mask),
    b: channelFromMask(header.blue_mask),
  };

  const rgba = Buffer.allocUnsafe(width * height * 4);
  let out = 0;
  for (let y = 0; y < height; y += 1) {
    let src = pixelOffset + y * stride;
    for (let x = 0; x < width; x += 1) {
      let value = 0;
      switch (bytesPerPixel) {
        case 1:
          value = buffer[src];
          break;
        case 2:
          value = pixelLittleEndian
            ? buffer[src] | (buffer[src + 1] << 8)
            : (buffer[src] << 8) | buffer[src + 1];
          break;
        case 3:
          value = pixelLittleEndian
            ? buffer[src] | (buffer[src + 1] << 8) | (buffer[src + 2] << 16)
            : (buffer[src] << 16) | (buffer[src + 1] << 8) | buffer[src + 2];
          break;
        case 4:
          value = pixelLittleEndian
            ? (buffer[src] |
                (buffer[src + 1] << 8) |
                (buffer[src + 2] << 16) |
                (buffer[src + 3] << 24)) >>>
              0
            : ((buffer[src] << 24) |
                (buffer[src + 1] << 16) |
                (buffer[src + 2] << 8) |
                buffer[src + 3]) >>>
              0;
          break;
        default:
          throw new Error(`unsupported XWD bits_per_pixel=${bitsPerPixel}`);
      }

      const base = out;
      if (colormap) {
        const rgb = colormap.get(value) ?? [0, 0, 0];
        rgba[base] = rgb[0];
        rgba[base + 1] = rgb[1];
        rgba[base + 2] = rgb[2];
      } else {
        rgba[base] = channelValue(value, channels.r);
        rgba[base + 1] = channelValue(value, channels.g);
        rgba[base + 2] = channelValue(value, channels.b);
      }
      rgba[base + 3] = 255;
      out += 4;
      src += bytesPerPixel;
    }
  }

  return {
    width,
    height,
    rgba,
    header,
    fileByteOrder: littleEndianHeader ? 'LE' : 'BE',
    pixelByteOrder: pixelLittleEndian ? 'LSBFirst' : 'MSBFirst',
    bytesPerPixel,
    stride,
    visualClass: VISUAL_CLASSES[header.visual_class] ?? header.visual_class,
    colormapEntries: header.colormap_entries,
  };
}

/**
 * Capture the root window of `display` and convert it to RGBA.
 * @returns {{width:number,height:number,rgba:Buffer,header:object}}
 */
export function captureRootPixels(display) {
  return parseXwd(runXwd(display));
}

/** Capture one X window (by id) and convert it to RGBA. */
export function captureWindowPixels(display, windowId) {
  return parseXwd(runXwd(display, { windowId }));
}

/**
 * Read one pixel.
 * @param {{width:number,height:number,rgba:Buffer}} pixels
 * @returns {[number,number,number,number]} [r,g,b,a]
 */
export function pixelAt(pixels, x, y) {
  if (!pixels || !Buffer.isBuffer(pixels.rgba)) {
    throw new Error('pixelAt: expected the result of captureRootPixels()/parseXwd()');
  }
  const px = Math.round(x);
  const py = Math.round(y);
  if (px < 0 || py < 0 || px >= pixels.width || py >= pixels.height) {
    throw new Error(`pixelAt(${x},${y}) is outside the ${pixels.width}x${pixels.height} image`);
  }
  const offset = (py * pixels.width + px) * 4;
  return [
    pixels.rgba[offset],
    pixels.rgba[offset + 1],
    pixels.rgba[offset + 2],
    pixels.rgba[offset + 3],
  ];
}

/** Convenience: "#rrggbb" for the pixel at (x,y). */
export function pixelHex(pixels, x, y) {
  const [r, g, b] = pixelAt(pixels, x, y);
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b
    .toString(16)
    .padStart(2, '0')}`;
}

/**
 * Count pixels whose colour is within `tolerance` of target, optionally inside
 * a rectangle. Useful for "some pixel in this region must be #3366cc".
 *
 * @param {{width:number,height:number,rgba:Buffer}} pixels
 * @param {[number,number,number]} target
 * @param {{x?:number,y?:number,width?:number,height?:number,tolerance?:number}} [options]
 */
export function countColor(pixels, target, options = {}) {
  const {
    x = 0,
    y = 0,
    width = pixels.width - x,
    height = pixels.height - y,
    tolerance = 0,
  } = options;
  const [tr, tg, tb] = target;
  let count = 0;
  const x2 = Math.min(pixels.width, x + width);
  const y2 = Math.min(pixels.height, y + height);
  for (let py = Math.max(0, y); py < y2; py += 1) {
    for (let px = Math.max(0, x); px < x2; px += 1) {
      const offset = (py * pixels.width + px) * 4;
      if (
        Math.abs(pixels.rgba[offset] - tr) <= tolerance &&
        Math.abs(pixels.rgba[offset + 1] - tg) <= tolerance &&
        Math.abs(pixels.rgba[offset + 2] - tb) <= tolerance
      ) {
        count += 1;
      }
    }
  }
  return count;
}

/** Parse a "#rrggbb" colour into [r,g,b]. */
export function parseColor(hex) {
  const match = /^#?([0-9a-fA-F]{6})$/.exec(String(hex).trim());
  if (!match) throw new Error(`invalid colour "${hex}" (expected #rrggbb)`);
  const value = Number.parseInt(match[1], 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}
