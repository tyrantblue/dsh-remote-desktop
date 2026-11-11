/**
 * Minimal, dependency-free JPEG structure parser.
 *
 * Used to validate that the Windows helper (real or fake) hands the Agent a
 * genuine JPEG: SOI/EOI markers present and the SOF dimensions match the
 * header the helper/Agent reports. We deliberately do not decode pixels — the
 * test only needs structural validity, and the fixture is additionally decoded
 * once with Python/Pillow to prove it is a real image.
 */

/**
 * @param {Buffer} buffer
 * @returns {{valid:boolean, hasSOI:boolean, hasEOI:boolean, width:number|null,
 *   height:number|null, precision:number|null, format:string|null,
 *   components:number|null, markerCount:number, size:number}}
 */
export function parseJpeg(buffer) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
  const result = {
    valid: false,
    hasSOI: false,
    hasEOI: false,
    width: null,
    height: null,
    precision: null,
    format: null,
    components: null,
    markerCount: 0,
    size: buffer.length,
  };
  if (buffer.length < 4) return result;
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8) return result;
  result.hasSOI = true;

  let offset = 2;
  while (offset + 1 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    // Skip 0xFF fill bytes.
    while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
    if (offset >= buffer.length) break;
    const marker = buffer[offset];
    offset += 1;
    result.markerCount += 1;

    if (marker === 0xd9) {
      result.hasEOI = true;
      break;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue; // standalone marker, no length field
    }
    if (offset + 2 > buffer.length) break;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) break;
    const segmentData = offset + 2;
    const segmentEnd = offset + length;

    // SOF0..SOF15 except DHT(C4)/JPG(C8)/DAC(CC) carry frame dimensions.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (segmentData + 6 <= buffer.length) {
        result.precision = buffer[segmentData];
        result.height = buffer.readUInt16BE(segmentData + 1);
        result.width = buffer.readUInt16BE(segmentData + 3);
        result.components = buffer[segmentData + 5];
        result.format =
          marker === 0xc0 ? 'baseline' : marker === 0xc2 ? 'progressive' : `sof${marker - 0xc0}`;
      }
    }

    if (marker === 0xda) {
      // Start of scan: entropy-coded data follows until the next real marker
      // (0xFF00 is a stuffed byte, 0xFFD0..D7 are restart markers).
      offset = segmentEnd;
      while (offset + 1 < buffer.length) {
        if (buffer[offset] === 0xff) {
          const next = buffer[offset + 1];
          if (next !== 0x00 && next !== 0xff && !(next >= 0xd0 && next <= 0xd7)) break;
        }
        offset += 1;
      }
      continue;
    }

    offset = segmentEnd;
  }

  result.valid =
    result.hasSOI &&
    result.hasEOI &&
    Number.isInteger(result.width) &&
    Number.isInteger(result.height) &&
    result.width > 0 &&
    result.height > 0;
  return result;
}

/** True when buffer starts with FFD8 and ends with FFD9. */
export function looksLikeJpeg(buffer) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
  return (
    buffer.length >= 4 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[buffer.length - 2] === 0xff &&
    buffer[buffer.length - 1] === 0xd9
  );
}
