// X11/Linux platform backend: wraps X11Display + ScreenCapture + InputController
// behind the platform-neutral Backend interface from docs/WINDOWS.md §1.
//
// Frames use `encoding: 'tiles'` and carry RGBA tile data (`w*h*4` bytes per
// tile). `cursor.buttons` is the raw X11 button mask, exactly as before.

import fs from 'node:fs';

const XDOTOOL_CANDIDATES = ['/usr/bin/xdotool', '/usr/local/bin/xdotool'];

function hasXdotool() {
  for (const candidate of XDOTOOL_CANDIDATES) {
    try {
      if (fs.existsSync(candidate)) return true;
    } catch {
      /* ignore */
    }
  }
  return false;
}

export async function createX11Backend(options = {}) {
  const { display, noInput = false } = options;
  const { X11Display } = await import('./x11.mjs');
  const { ScreenCapture } = await import('./capture.mjs');
  const { InputController } = await import('./input.mjs');

  const x11 = await X11Display.connect({ display });
  let input = null;
  if (!noInput && x11.xtestOpcode !== 0) {
    try {
      input = new InputController(x11);
    } catch {
      input = null;
    }
  }
  const textCapable = Boolean(input) && hasXdotool();

  let tile = 64;
  let capture = new ScreenCapture(x11, { tile });
  let closed = false;

  const backend = {
    platform: 'linux',
    capabilities: {
      screen: true,
      input: Boolean(input),
      text: textCapable,
      shell: false, // filled in by the main program
      files: false,
    },
    info: {
      screen: { width: x11.width, height: x11.height, depth: x11.depth },
      display: x11.display || display || null,
      helper: null,
    },
    encoding: 'tiles',

    async grab(grabOptions = {}) {
      if (closed) throw new Error('X11 backend is closed');
      const requestedTile = Number(grabOptions.tile);
      if (Number.isFinite(requestedTile) && requestedTile > 0) {
        const nextTile = Math.max(8, Math.trunc(requestedTile));
        if (nextTile !== tile) {
          tile = nextTile;
          capture = new ScreenCapture(x11, { tile });
        }
      }
      if (grabOptions.forceKeyframe) capture.forceKeyframe();
      const result = await capture.grab();
      return {
        encoding: 'tiles',
        width: x11.width,
        height: x11.height,
        cursor: { x: result.cursor.x, y: result.cursor.y, buttons: result.cursor.mask },
        tiles: result.tiles,
        changed: Boolean(result.changed),
      };
    },

    handleInput(message) {
      if (!message || typeof message !== 'object') return { ok: false, error: 'bad_request' };
      if (!input) return { ok: false, error: 'no_input' };
      let result;
      try {
        switch (message.t) {
          case 'mouse':
            result = input.handleMouse(message);
            break;
          case 'wheel':
            result = input.handleWheel(message);
            break;
          case 'key':
            result = input.handleKey(message);
            break;
          case 'text':
            result = input.handleText(message.text);
            break;
          case 'releaseAll':
            result = input.releaseAll();
            break;
          default:
            return { ok: false, error: 'bad_request' };
        }
      } catch (err) {
        return { ok: false, error: (err && (err.code || err.message)) || 'internal' };
      }
      // InputController writes synchronously; hand the bytes to the socket.
      try {
        const flushed = x11.flush();
        if (flushed && typeof flushed.catch === 'function') flushed.catch(() => {});
      } catch {
        /* ignore */
      }
      return {
        ok: !(result && result.ok === false),
        error: result && result.error ? String(result.error) : undefined,
      };
    },

    async close() {
      if (closed) return;
      closed = true;
      if (input) {
        try {
          input.dispose();
        } catch {
          /* ignore */
        }
        input = null;
      }
      try {
        if (typeof x11.flush === 'function') await x11.flush();
      } catch {
        /* ignore */
      }
      try {
        x11.close();
      } catch {
        /* ignore */
      }
    },
  };

  return backend;
}
