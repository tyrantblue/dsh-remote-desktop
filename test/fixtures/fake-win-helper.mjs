#!/usr/bin/env node
/**
 * Fake Windows capture/input helper for testing `backend-win32` on Linux.
 *
 * Implements the JSON Lines helper protocol from docs/WINDOWS.md §2:
 *
 *   helper → stdout (startup):  {"ok":true,"hello":{...,"format":"jpeg","width":800,"height":600,...}}
 *   stdin  {"id":1,"cmd":"info"}      → {"id":1,"ok":true,"width":...,"height":...,"cursor":...,"buttons":...}
 *   stdin  {"id":2,"cmd":"capture","quality":65}
 *                                     → {"id":2,"ok":true,"width":...,"height":...,"format":"jpeg",
 *                                        "data":"<base64 JPEG>","cursor":...,"buttons":...,"encodeMs":n}
 *   stdin  {"cmd":"mouse"|"wheel"|"key"|"text"|"releaseAll"}  → no response, appended to $FAKE_HELPER_LOG
 *   stdin  {"cmd":"shutdown"}         → {"ok":true} then exit(0)
 *   stdin EOF                         → exit(0)
 *
 * The capture payload is the committed real JPEG fixture
 * test/fixtures/fake-800x600.jpg (generated once with Pillow): FFD8…FFD9,
 * 800x600, baseline, JPEG-decodable — the test suite validates it structurally
 * and the fixture is proven decodable offline.
 *
 * Environment:
 *   FAKE_HELPER_LOG=path          append every received request line (JSONL)
 *   FAKE_HELPER_CRASH_AFTER=n     exit(1) right after responding to the n-th capture
 *   FAKE_HELPER_BAD_JSON=1        emit one malformed JSON line before the first capture response
 *   FAKE_HELPER_DELAY_MS=n        delay every capture response by n ms (Agent timeout test)
 *   FAKE_HELPER_JPEG=path         override capture image (default fake-800x600.jpg)
 *   FAKE_HELPER_CURSOR_X/Y=n      cursor coordinates reported in info/capture
 *   FAKE_HELPER_BUTTONS=n         cursor button mask reported in info/capture
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

import { parseJpeg } from '../lib/jpeg.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_JPEG = path.join(HERE, 'fake-800x600.jpg');

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) {
    process.stderr.write(`[fake-win-helper] invalid ${name}=${JSON.stringify(raw)}\n`);
    process.exit(2);
  }
  return value;
}

const config = {
  logPath: process.env.FAKE_HELPER_LOG || null,
  crashAfter: envInt('FAKE_HELPER_CRASH_AFTER', 0),
  badJson: process.env.FAKE_HELPER_BAD_JSON === '1',
  delayMs: envInt('FAKE_HELPER_DELAY_MS', 0),
  jpegPath: process.env.FAKE_HELPER_JPEG || DEFAULT_JPEG,
  cursorX: envInt('FAKE_HELPER_CURSOR_X', 100),
  cursorY: envInt('FAKE_HELPER_CURSOR_Y', 200),
  buttons: envInt('FAKE_HELPER_BUTTONS', 0),
  screens: envInt('FAKE_HELPER_SCREENS', 1),
  dpi: envInt('FAKE_HELPER_DPI', 96),
};

function writeLine(text) {
  // Synchronous write: a response must be on the pipe before a crash exit.
  fs.writeSync(1, `${text}\n`);
}

function diag(...parts) {
  process.stderr.write(`[fake-win-helper] ${parts.join(' ')}\n`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---- load and validate the JPEG capture fixture ----------------------------

let jpeg;
try {
  jpeg = fs.readFileSync(config.jpegPath);
} catch (err) {
  diag(`cannot read JPEG fixture ${config.jpegPath}: ${err.message}`);
  process.exit(2);
}
const jpegInfo = parseJpeg(jpeg);
if (!jpegInfo.valid) {
  diag(`capture fixture is not a valid JPEG: ${JSON.stringify(jpegInfo)}`);
  process.exit(2);
}
const width = jpegInfo.width;
const height = jpegInfo.height;
const jpegBase64 = jpeg.toString('base64');

// Optional explicit dimensions must match the fixture, so a test can never
// silently assert against a size the helper does not actually send.
const expectedWidth = envInt('FAKE_HELPER_WIDTH', width);
const expectedHeight = envInt('FAKE_HELPER_HEIGHT', height);
if (expectedWidth !== width || expectedHeight !== height) {
  diag(
    `FAKE_HELPER_WIDTH/HEIGHT=${expectedWidth}x${expectedHeight} does not match fixture ${width}x${height}`,
  );
  process.exit(2);
}

let captureCount = 0;
let badJsonSent = false;

function logRequest(rawLine) {
  if (!config.logPath) return;
  try {
    fs.appendFileSync(config.logPath, `${rawLine}\n`);
  } catch (err) {
    diag(`cannot append to FAKE_HELPER_LOG: ${err.message}`);
  }
}

function respond(request, payload) {
  const body = request && Number.isInteger(request.id) ? { id: request.id, ...payload } : payload;
  writeLine(JSON.stringify(body));
}

async function handleRequest(rawLine) {
  const trimmed = String(rawLine).replace(/\r$/, '');
  if (trimmed.length === 0) return;
  logRequest(trimmed);

  let request;
  try {
    request = JSON.parse(trimmed);
  } catch {
    diag(`ignoring malformed request line: ${trimmed.slice(0, 200)}`);
    return;
  }
  if (!request || typeof request !== 'object' || typeof request.cmd !== 'string') {
    respond(Number.isInteger(request?.id) ? request : null, {
      ok: false,
      error: 'bad_request',
      message: 'missing cmd',
    });
    return;
  }

  switch (request.cmd) {
    case 'info': {
      respond(request, {
        ok: true,
        width,
        height,
        screens: config.screens,
        cursor: { x: config.cursorX, y: config.cursorY },
        buttons: config.buttons,
      });
      return;
    }
    case 'capture': {
      if (config.badJson && !badJsonSent) {
        // Deliberately truncated JSON: the Agent must report/log this without
        // crashing; a valid response follows so the session can recover.
        badJsonSent = true;
        writeLine('{"id":0,"ok":true,"width":800,"height":600,"format":"jpeg","data":"AAAA');
      }
      if (config.delayMs > 0) await sleep(config.delayMs);
      captureCount += 1;
      respond(request, {
        ok: true,
        width,
        height,
        format: 'jpeg',
        data: jpegBase64,
        cursor: { x: config.cursorX, y: config.cursorY },
        buttons: config.buttons,
        encodeMs: 1,
      });
      if (config.crashAfter > 0 && captureCount >= config.crashAfter) {
        diag(`crashing after capture #${captureCount} as requested by FAKE_HELPER_CRASH_AFTER`);
        setImmediate(() => process.exit(1));
      }
      return;
    }
    case 'mouse':
    case 'wheel':
    case 'key':
    case 'text':
    case 'releaseAll':
      // Fire-and-forget input commands: the request line is already logged.
      return;
    case 'selftest': {
      respond(request, {
        ok: true,
        tests: ['hello', 'info', 'capture', 'input', 'shutdown'],
      });
      return;
    }
    case 'shutdown': {
      respond(request, { ok: true });
      diag('shutdown requested, exiting');
      process.exit(0);
    // break; unreachable
    }
    default: {
      respond(request, {
        ok: false,
        error: 'unknown_command',
        message: `unknown cmd: ${request.cmd}`,
      });
      return;
    }
  }
}

// ---- startup: hello, then serial request loop -----------------------------

writeLine(
  JSON.stringify({
    ok: true,
    hello: {
      helper: 'fake-win-helper-1.0.0',
      width,
      height,
      screens: config.screens,
      format: 'jpeg',
      dpi: config.dpi,
    },
  }),
);
diag(
  `ready ${width}x${height} ${jpeg.length}B jpeg` +
    (config.logPath ? ` log=${config.logPath}` : '') +
    (config.crashAfter ? ` crashAfter=${config.crashAfter}` : '') +
    (config.delayMs ? ` delay=${config.delayMs}ms` : '') +
    (config.badJson ? ' badJson=1' : ''),
);

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let queue = Promise.resolve();
rl.on('line', (line) => {
  queue = queue.then(() => handleRequest(line)).catch((err) => {
    diag(`request handler failed: ${err && err.stack ? err.stack : err}`);
  });
});
rl.on('close', () => {
  // stdin EOF: the Agent closed the pipe (or exited) -> stop.
  process.exit(0);
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => process.exit(0));
}
