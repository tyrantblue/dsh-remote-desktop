/**
 * input.mjs — turns browser input events into XTest input on an X11Display.
 *
 * Responsibilities:
 *   - browser KeyboardEvent.code -> X11 keysym table (PROTOCOL.md §4/§5)
 *   - idempotent modifier handling (press missing modifiers, never stick them)
 *   - mouse move/down/up with 0/1/2 -> X11 buttons 1/2/3
 *   - wheel pixel deltas -> X11 buttons 4/5 (vertical) and 6/7 (horizontal)
 *   - text injection: xdotool first, ASCII keysym fallback
 *   - releaseAll()/dispose() to guarantee no key or button stays pressed
 */

import { spawnSync } from 'node:child_process';

const SHIFT = 0xffe1;
const CONTROL = 0xffe3;
const ALT = 0xffe9;
const META = 0xffeb;
const CAPS_LOCK = 0xffe5;

/** keysyms used by the modifier state machine. */
export const MODIFIER_KEYSYMS = Object.freeze({
  shift: SHIFT,
  ctrl: CONTROL,
  alt: ALT,
  meta: META,
});

const MODIFIER_CODE_TO_KEYSYM = {
  ShiftLeft: SHIFT,
  ShiftRight: SHIFT,
  ControlLeft: CONTROL,
  ControlRight: CONTROL,
  AltLeft: ALT,
  AltRight: ALT,
  MetaLeft: META,
  MetaRight: META,
};

/** Build the browser `code` -> keysym table (PROTOCOL.md §5). */
function buildCodeToKeysym() {
  const table = Object.create(null);

  for (let i = 0; i < 26; i += 1) {
    table[`Key${String.fromCharCode(65 + i)}`] = 0x61 + i; // a..z
  }
  for (let i = 0; i <= 9; i += 1) {
    table[`Digit${i}`] = 0x30 + i; // 0..9
  }

  Object.assign(table, {
    Minus: 0x2d,
    Equal: 0x3d,
    BracketLeft: 0x5b,
    BracketRight: 0x5d,
    Backslash: 0x5c,
    Semicolon: 0x3b,
    Quote: 0x27,
    Backquote: 0x60,
    Comma: 0x2c,
    Period: 0x2e,
    Slash: 0x2f,
    Space: 0x20,
    IntlBackslash: 0x5c,
    IntlRo: 0x2f,

    Enter: 0xff0d,
    NumpadEnter: 0xff8d,
    Backspace: 0xff08,
    Tab: 0xff09,
    Escape: 0xff1b,
    Delete: 0xffff,
    Insert: 0xff63,

    ArrowLeft: 0xff51,
    ArrowUp: 0xff52,
    ArrowRight: 0xff53,
    ArrowDown: 0xff54,
    Home: 0xff50,
    End: 0xff57,
    PageUp: 0xff55,
    PageDown: 0xff56,

    CapsLock: CAPS_LOCK,
    NumLock: 0xff7f,
    ScrollLock: 0xff14,
    PrintScreen: 0xff61,
    Pause: 0xff13,
    ContextMenu: 0xff67,

    NumpadAdd: 0xffab,
    NumpadSubtract: 0xffad,
    NumpadMultiply: 0xffaa,
    NumpadDivide: 0xffaf,
    NumpadDecimal: 0xffae,
    NumpadEqual: 0xffbd,
    NumpadComma: 0xffac,
  });

  for (let i = 1; i <= 12; i += 1) {
    table[`F${i}`] = 0xffbe + (i - 1); // F1..F12
  }
  for (let i = 0; i <= 9; i += 1) {
    table[`Numpad${i}`] = 0xffb0 + i; // KP_0..KP_9
  }

  return table;
}

const CODE_TO_KEYSYM = buildCodeToKeysym();

/** Fallback table for `key` values when `code` is missing/unknown. */
const KEY_NAME_TO_KEYSYM = {
  Shift: SHIFT,
  Control: CONTROL,
  Alt: ALT,
  AltGraph: ALT,
  Meta: META,
  CapsLock: CAPS_LOCK,
  NumLock: 0xff7f,
  ScrollLock: 0xff14,
  PrintScreen: 0xff61,
  Pause: 0xff13,
  ContextMenu: 0xff67,
  Enter: 0xff0d,
  Backspace: 0xff08,
  Tab: 0xff09,
  Escape: 0xff1b,
  Delete: 0xffff,
  Insert: 0xff63,
  Home: 0xff50,
  End: 0xff57,
  PageUp: 0xff55,
  PageDown: 0xff56,
  ArrowLeft: 0xff51,
  ArrowUp: 0xff52,
  ArrowRight: 0xff53,
  ArrowDown: 0xff54,
  ' ': 0x20,
  Space: 0x20,
};

/**
 * Resolve one keyboard event to a keysym (and whether it is a modifier key).
 * @returns {{keysym: number, modifierKeysym?: number}|null}
 */
function resolveKeyEvent(code, key) {
  const codeString = code == null ? '' : String(code);
  if (codeString) {
    const modifierKeysym = MODIFIER_CODE_TO_KEYSYM[codeString];
    if (modifierKeysym !== undefined) {
      return { keysym: modifierKeysym, modifierKeysym };
    }
    const keysym = CODE_TO_KEYSYM[codeString];
    if (keysym !== undefined) return { keysym };
  }

  if (key != null) {
    const keyString = String(key);
    if (keyString.length === 1) {
      const cp = keyString.codePointAt(0);
      if (cp < 0x80) return { keysym: cp };
      return null; // non-ASCII fallback by keysym is not supported
    }
    const named = KEY_NAME_TO_KEYSYM[keyString];
    if (named !== undefined) {
      return { keysym: named, modifierKeysym: MODIFIER_CODE_TO_KEYSYM[keyString] };
    }
    const fn = /^F(\d{1,2})$/.exec(keyString);
    if (fn) {
      const n = Number.parseInt(fn[1], 10);
      if (n >= 1 && n <= 12) return { keysym: 0xffbe + (n - 1) };
    }
  }
  return null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function mouseButtonNumber(button) {
  const raw = button == null ? 0 : Number(button);
  if (!Number.isInteger(raw) || raw < 0 || raw > 2) return null;
  return raw + 1; // 0=left -> 1, 1=middle -> 2, 2=right -> 3
}

/** Number of X11 wheel clicks for one pixel delta (at most 10 per message). */
function wheelClicks(delta) {
  const value = Number(delta);
  if (!Number.isFinite(value) || value === 0) return 0;
  return Math.min(10, Math.max(1, Math.round(Math.abs(value) / 120)));
}

export class InputController {
  /** @param {import('./x11.mjs').X11Display} x11 */
  constructor(x11) {
    if (!x11 || typeof x11.sendKey !== 'function') {
      throw new TypeError('InputController requires an X11Display instance');
    }
    this.x11 = x11;

    /** Keycodes currently held down (modifier keys included). @type {Set<number>} */
    this._downKeys = new Set();
    /** Modifier keysym -> keycode currently held. @type {Map<number, number>} */
    this._mods = new Map();
    /** X11 button numbers currently held down. @type {Set<number>} */
    this._pressedButtons = new Set();
    /** Keycodes pressed while a temporary Shift was synthesised for them. @type {Set<number>} */
    this._tempShiftKeys = new Set();
    /** Last pointer position we moved/pressed at, or null when unknown. */
    this._lastPointer = null;

    this._disposed = false;
    /** Undefined = not probed yet, true/false = xdotool usable or not. */
    this._xdotoolAvailable = undefined;
  }

  // -------------------------------------------------------------------------
  // Mouse
  // -------------------------------------------------------------------------

  /**
   * @param {{action?: string, x?: number, y?: number, button?: number}} event
   * @returns {{ok: boolean, error?: string}}
   */
  handleMouse(event = {}) {
    if (this._disposed) return { ok: false, error: 'disposed' };
    const action = typeof event.action === 'string' ? event.action.toLowerCase() : '';

    const x = Number(event.x);
    const y = Number(event.y);
    const hasTarget = Number.isFinite(x) && Number.isFinite(y);
    let targetX = this._lastPointer ? this._lastPointer.x : null;
    let targetY = this._lastPointer ? this._lastPointer.y : null;
    if (hasTarget) {
      targetX = clamp(Math.round(x), 0, this.x11.width - 1);
      targetY = clamp(Math.round(y), 0, this.x11.height - 1);
    }

    if (action === 'move') {
      if (targetX === null || targetY === null) {
        return { ok: false, error: 'bad_coordinates' };
      }
      this.x11.moveMouse(targetX, targetY);
      this._lastPointer = { x: targetX, y: targetY };
      return { ok: true };
    }

    if (action === 'down' || action === 'up') {
      const press = action === 'down';
      const button = mouseButtonNumber(event.button);
      if (button === null) return { ok: false, error: 'bad_button' };

      if (press && targetX !== null && targetY !== null) {
        // Make sure the press happens where the client expects it.  The client
        // normally sends a move right before, so this is usually a no-op.
        if (
          !this._lastPointer
          || this._lastPointer.x !== targetX
          || this._lastPointer.y !== targetY
        ) {
          this.x11.moveMouse(targetX, targetY);
          this._lastPointer = { x: targetX, y: targetY };
        }
      }
      this.x11.sendButton(button, press);
      if (press) this._pressedButtons.add(button);
      else this._pressedButtons.delete(button);
      return { ok: true };
    }

    return { ok: false, error: 'bad_action' };
  }

  /**
   * @param {{dx?: number, dy?: number}} event pixel deltas; positive = down/right
   * @returns {{ok: boolean, clicks?: number, error?: string}}
   */
  handleWheel(event = {}) {
    if (this._disposed) return { ok: false, error: 'disposed' };
    const vertical = wheelClicks(event.dy);
    const horizontal = wheelClicks(event.dx);
    let sent = 0;
    // Vertical first: dy > 0 scrolls down -> button 5, dy < 0 -> button 4.
    for (let i = 0; i < vertical && sent < 10; i += 1) {
      const button = Number(event.dy) > 0 ? 5 : 4;
      this.x11.sendButton(button, true);
      this.x11.sendButton(button, false);
      sent += 1;
    }
    // Horizontal: dx > 0 scrolls right -> button 7, dx < 0 -> button 6.
    for (let i = 0; i < horizontal && sent < 10; i += 1) {
      const button = Number(event.dx) > 0 ? 7 : 6;
      this.x11.sendButton(button, true);
      this.x11.sendButton(button, false);
      sent += 1;
    }
    return { ok: true, clicks: sent };
  }

  // -------------------------------------------------------------------------
  // Keyboard
  // -------------------------------------------------------------------------

  /**
   * @param {{code?: string, key?: string, down?: boolean, mods?: {shift?: boolean, ctrl?: boolean, alt?: boolean, meta?: boolean}}} event
   * @returns {{ok: boolean, error?: string, keysym?: number}}
   */
  handleKey(event = {}) {
    if (this._disposed) return { ok: false, error: 'disposed' };
    const resolved = resolveKeyEvent(event.code, event.key);
    if (!resolved) {
      return { ok: false, error: 'unsupported_key' };
    }
    const down = Boolean(event.down);
    const mods = event.mods && typeof event.mods === 'object' ? event.mods : null;

    if (resolved.modifierKeysym !== undefined) {
      const keysym = resolved.modifierKeysym;
      const keycode = this.x11.keycodeForKeysym(keysym);
      if (keycode === null) {
        return { ok: false, error: 'unsupported_key', keysym };
      }
      if (down) {
        // Idempotent: a repeated modifier-down is ignored.
        if (!this._mods.has(keysym)) {
          this.x11.sendKey(keycode, true);
          this._downKeys.add(keycode);
          this._mods.set(keysym, keycode);
        }
      } else {
        const held = this._mods.get(keysym);
        if (held !== undefined) {
          this.x11.sendKey(held, false);
          this._downKeys.delete(held);
          this._mods.delete(keysym);
        }
      }
      this._afterKeyEvent(mods);
      return { ok: true };
    }

    const keysym = resolved.keysym;
    let keycode = this.x11.keycodeForKeysym(keysym);
    let needShift = false;
    if (keycode === null) {
      // Not in the unshifted column: try shifted columns (used by the `key`
      // fallback for characters such as uppercase letters and symbols).
      const alternative = this.x11.resolveKeysym(keysym);
      if (!alternative) {
        return { ok: false, error: 'unsupported_key', keysym };
      }
      keycode = alternative.keycode;
      needShift = alternative.shift;
    }

    if (down) {
      this._applyMods(mods);
      if (needShift && !this._mods.has(SHIFT)) {
        this._ensureModifier(SHIFT);
        this._tempShiftKeys.add(keycode);
      }
      if (!this._downKeys.has(keycode)) {
        this.x11.sendKey(keycode, true);
        this._downKeys.add(keycode);
      }
    } else {
      if (this._downKeys.has(keycode)) {
        this.x11.sendKey(keycode, false);
        this._downKeys.delete(keycode);
      }
      if (this._tempShiftKeys.delete(keycode)) {
        this._releaseModifier(SHIFT);
      }
      this._afterKeyEvent(mods);
    }
    return { ok: true };
  }

  _applyMods(mods) {
    if (!mods) return;
    if (mods.shift) this._ensureModifier(SHIFT);
    if (mods.ctrl) this._ensureModifier(CONTROL);
    if (mods.alt) this._ensureModifier(ALT);
    if (mods.meta) this._ensureModifier(META);
  }

  _ensureModifier(keysym) {
    if (this._mods.has(keysym)) return;
    const keycode = this.x11.keycodeForKeysym(keysym);
    if (keycode === null) return; // modifier not available in this layout
    this.x11.sendKey(keycode, true);
    this._downKeys.add(keycode);
    this._mods.set(keysym, keycode);
  }

  _releaseModifier(keysym) {
    const keycode = this._mods.get(keysym);
    if (keycode === undefined) return;
    this.x11.sendKey(keycode, false);
    this._downKeys.delete(keycode);
    this._mods.delete(keysym);
  }

  _releaseAllModifiers() {
    for (const [, keycode] of this._mods) {
      this.x11.sendKey(keycode, false);
      this._downKeys.delete(keycode);
    }
    this._mods.clear();
  }

  /**
   * After a key event: once nothing is held any more and the browser reports no
   * modifier pressed, release every modifier we may have synthesised.  This is
   * the anti-stuck-key rule from PROTOCOL.md §4.
   */
  _afterKeyEvent(mods) {
    if (this._downKeys.size !== 0) return;
    if (mods && (mods.shift || mods.ctrl || mods.alt || mods.meta)) return;
    this._releaseAllModifiers();
  }

  // -------------------------------------------------------------------------
  // Text
  // -------------------------------------------------------------------------

  /**
   * Inject a text string.  xdotool is preferred (handles any Unicode the
   * running X keymap can produce); without it only printable ASCII is injected
   * through keysyms, pressing Shift where the layout needs it.
   * @param {string} text
   * @returns {{ok: boolean, mode: string, typed?: number, skipped?: number, error?: string}}
   */
  handleText(text) {
    if (this._disposed) return { ok: false, error: 'disposed', mode: 'none' };
    const value = text == null ? '' : String(text);
    if (value.length === 0) return { ok: true, mode: 'none', typed: 0 };
    if (this._tryXdotool(value)) {
      return { ok: true, mode: 'xdotool', typed: value.length };
    }
    return this._typeAscii(value);
  }

  _tryXdotool(text) {
    if (this._xdotoolAvailable === undefined) {
      this._xdotoolAvailable = false;
      try {
        const probe = spawnSync('xdotool', ['--version'], { stdio: 'ignore' });
        if (!probe.error && probe.status === 0) this._xdotoolAvailable = true;
      } catch {
        this._xdotoolAvailable = false;
      }
    }
    if (!this._xdotoolAvailable) return false;
    const env = { ...process.env };
    if (this.x11.display) env.DISPLAY = this.x11.display;
    try {
      const result = spawnSync(
        'xdotool',
        ['type', '--clearmodifiers', '--delay', '0', '--', text],
        { env, stdio: 'ignore', timeout: 30000 },
      );
      if (!result.error && result.status === 0) return true;
    } catch {
      /* fall through to the ASCII injector */
    }
    return false;
  }

  _typeAscii(text) {
    let typed = 0;
    let skipped = 0;
    const shiftKeycode = this.x11.keycodeForKeysym(SHIFT);
    for (const char of text) {
      const cp = char.codePointAt(0);
      let keysym;
      if (cp === 0x0d || cp === 0x0a) {
        keysym = 0xff0d; // Return
      } else if (cp === 0x09) {
        keysym = 0xff09; // Tab
      } else if (cp >= 0x20 && cp <= 0x7e) {
        keysym = cp;
      } else {
        skipped += 1;
        continue;
      }

      let keycode = this.x11.keycodeForKeysym(keysym);
      let needShift = false;
      if (keycode === null) {
        const alternative = this.x11.resolveKeysym(keysym);
        if (!alternative) {
          skipped += 1;
          continue;
        }
        keycode = alternative.keycode;
        needShift = alternative.shift;
      }

      const shiftHeld = this._mods.has(SHIFT);
      const pressShift = needShift && !shiftHeld && shiftKeycode !== null;
      if (pressShift) this.x11.sendKey(shiftKeycode, true);
      this.x11.sendKey(keycode, true);
      this.x11.sendKey(keycode, false);
      if (pressShift) this.x11.sendKey(shiftKeycode, false);
      typed += 1;
    }
    return {
      ok: typed > 0 || skipped === 0,
      mode: 'ascii',
      typed,
      skipped,
    };
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Release every key, modifier and mouse button we are holding. */
  releaseAll() {
    // Non-modifier keys first, modifiers last.
    const modifierKeycodes = new Set(this._mods.values());
    for (const keycode of this._downKeys) {
      if (!modifierKeycodes.has(keycode)) this.x11.sendKey(keycode, false);
    }
    for (const keycode of modifierKeycodes) this.x11.sendKey(keycode, false);
    for (const button of this._pressedButtons) this.x11.sendButton(button, false);

    this._downKeys.clear();
    this._mods.clear();
    this._pressedButtons.clear();
    this._tempShiftKeys.clear();
    return { ok: true };
  }

  /** Release everything and make the controller inert. Safe to call twice. */
  dispose() {
    if (this._disposed) return { ok: true };
    this.releaseAll();
    this._disposed = true;
    return { ok: true };
  }
}

export default InputController;
