/**
 * Polling, sleeping and assertion helpers with informative failure messages.
 *
 * The E2E suite is asynchronous by nature (X server, Agent process, WebSocket
 * frames), so every condition is awaited with a bounded timeout instead of a
 * fixed sleep. Assertions throw ordinary Errors with the expected/actual values
 * inline so a failing test line is enough to debug.
 */

import { isDeepStrictEqual } from 'node:util';

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function preview(value, maxLength = 500) {
  if (typeof value === 'string') {
    return value.length > maxLength ? `${JSON.stringify(value.slice(0, maxLength))}…` : JSON.stringify(value);
  }
  if (Buffer.isBuffer(value)) return `<Buffer ${value.length} bytes>`;
  try {
    const text = JSON.stringify(value);
    if (text === undefined) return String(value);
    return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
  } catch {
    return String(value);
  }
}

/**
 * Await a condition.
 *
 * `fn` may return a truthy value (resolved), a falsy value (retry) or throw
 * (retry, remembering the error for the timeout message).
 *
 * @template T
 * @param {() => T | Promise<T>} fn
 * @param {{timeoutMs?:number, intervalMs?:number, label?:string}} [options]
 * @returns {Promise<T>}
 */
export async function waitFor(fn, { timeoutMs = 5000, intervalMs = 50, label = 'condition' } = {}) {
  const startedAt = Date.now();
  let attempts = 0;
  let lastValue;
  let lastError = null;

  for (;;) {
    attempts += 1;
    try {
      lastValue = await fn();
      if (lastValue) return lastValue;
    } catch (err) {
      lastError = err;
    }
    const elapsed = Date.now() - startedAt;
    if (elapsed >= timeoutMs) {
      const parts = [
        `waitFor timed out after ${timeoutMs}ms (${attempts} attempts, ${elapsed}ms elapsed): ${label}`,
      ];
      if (lastError) parts.push(`last error: ${lastError.message}`);
      else parts.push(`last value: ${preview(lastValue)}`);
      throw new Error(parts.join('; '));
    }
    await sleep(Math.max(5, intervalMs));
  }
}

/** Throw when `condition` is falsy. */
export function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

/** Deep equality for primitives, arrays and plain objects. */
export function assertEqual(actual, expected, label = 'value') {
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error(
      `Assertion failed (${label}): expected ${preview(expected)}, got ${preview(actual)}`,
    );
  }
}

/** Strict inequality. */
export function assertNotEqual(actual, expected, label = 'value') {
  if (isDeepStrictEqual(actual, expected)) {
    throw new Error(`Assertion failed (${label}): expected a value other than ${preview(expected)}`);
  }
}

/** `value` must match a RegExp (strings are coerced). */
export function assertMatch(value, pattern, label = 'value') {
  const regex = pattern instanceof RegExp ? pattern : new RegExp(pattern);
  const text = typeof value === 'string' ? value : preview(value);
  if (!regex.test(text)) {
    throw new Error(`Assertion failed (${label}): ${preview(text)} does not match ${regex}`);
  }
}

/** `haystack` must contain `needle` (array includes / string substring). */
export function assertIncludes(haystack, needle, label = 'value') {
  if (typeof haystack === 'string') {
    if (!haystack.includes(needle)) {
      throw new Error(
        `Assertion failed (${label}): ${preview(haystack)} does not contain ${preview(needle)}`,
      );
    }
    return;
  }
  if (Array.isArray(haystack)) {
    const found = haystack.some((item) => isDeepStrictEqual(item, needle));
    if (!found) {
      throw new Error(
        `Assertion failed (${label}): ${preview(haystack)} does not contain ${preview(needle)}`,
      );
    }
    return;
  }
  throw new Error(`Assertion failed (${label}): value is not a string or array`);
}

/** Numeric closeness, useful for colour values. */
export function assertClose(actual, expected, tolerance = 0, label = 'value') {
  if (typeof actual !== 'number' || Number.isNaN(actual)) {
    throw new Error(`Assertion failed (${label}): expected a number, got ${preview(actual)}`);
  }
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(
      `Assertion failed (${label}): expected ${expected} ±${tolerance}, got ${actual}`,
    );
  }
}

/**
 * Assert that all three RGB channels of one pixel are close to the expected
 * colour. Accepts `[r,g,b]` or `[r,g,b,a]` from xwd.pixelAt().
 */
export function assertPixelColor(actual, expected, tolerance = 0, label = 'pixel') {
  const expectedRgb = Array.isArray(expected) ? expected : parseExpectedColor(expected);
  if (!Array.isArray(actual) || actual.length < 3) {
    throw new Error(`Assertion failed (${label}): expected [r,g,b,a], got ${preview(actual)}`);
  }
  for (let i = 0; i < 3; i += 1) {
    if (Math.abs(actual[i] - expectedRgb[i]) > tolerance) {
      throw new Error(
        `Assertion failed (${label}): expected rgb(${expectedRgb.slice(0, 3).join(',')}) ` +
          `±${tolerance}, got rgb(${actual.slice(0, 3).join(',')})`,
      );
    }
  }
}

function parseExpectedColor(color) {
  if (typeof color === 'string') {
    const match = /^#?([0-9a-fA-F]{6})$/.exec(color.trim());
    if (!match) throw new Error(`invalid colour string ${preview(color)}`);
    const value = Number.parseInt(match[1], 16);
    return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
  }
  throw new Error(`invalid expected colour ${preview(color)}`);
}

/** Human readable one-line error for the test runner's FAIL lines. */
export function formatError(error) {
  if (!error) return 'unknown error';
  let message = error instanceof Error ? error.message : String(error);
  // Keep the runner output readable: collapse internal whitespace.
  message = message.replace(/\s*\n\s*/g, ' | ').replace(/\s{2,}/g, ' ').trim();
  if (message.length > 1200) message = `${message.slice(0, 1200)}…`;
  return message;
}
