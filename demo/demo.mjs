#!/usr/bin/env node
/**
 * Remote-desktop demo.
 *
 * Boots a REAL remote-desktop stack and captures a REAL remote screen frame:
 *
 *   dedicated Xvfb  →  real xterm running an interactive bash
 *   →  real agent process (agent/remote-agent.mjs)
 *   →  this demo client over the real protocol (WS + HTTP)
 *
 * The client focuses the terminal, types commands through the Agent's keyboard
 * injection path, waits for the output to render, requests a fresh keyframe and
 * writes the decoded RGBA frame — not an xwd screenshot, not a mock — to
 * demo/screenshot.png.
 *
 * Usage:
 *   node demo/demo.mjs
 *   bash demo/run.sh [--display :99] [--port 38090]
 *
 * Environment:
 *   DISPLAY / E2E_DISPLAY  preferred X display (occupied numbers are skipped)
 *   PORT                   preferred agent port (occupied ports are skipped)
 */

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { startXvfb } from '../test/lib/xvfb.mjs';
import { captureRootPixels, pixelAt, countColor } from '../test/lib/xwd.mjs';
import { writePng, readPngHeader } from '../test/lib/png.mjs';
import { startXterm, setRootColor, getWindowGeometry } from '../test/lib/x11-fixtures.mjs';
import { waitFor, sleep, assert } from '../test/lib/wait.mjs';
import { connectWebSocket } from '../agent/lib/ws.mjs';

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AGENT_ENTRY = path.join(REPO_DIR, 'agent', 'remote-agent.mjs');
const SCREENSHOT_PATH = path.join(REPO_DIR, 'demo', 'screenshot.png');
const PASSWORD = 'demo-pass';
const ROOT_COLOR = '#151521';
const TERM_COLOR = '#1e1e2e';

const COMMANDS = [
  'echo hello-from-remote',
  'uname -a',
  'whoami',
  'date',
];

// ---- small protocol client -------------------------------------------------

class DemoClient {
  constructor(conn) {
    this.conn = conn;
    this.messages = [];
    this.frames = [];
    this.canvas = null;
    this.width = 0;
    this.height = 0;
    this.closed = false;
    conn.onMessage((data, isBinary) => {
      if (!isBinary) {
        try {
          this.messages.push(JSON.parse(data));
        } catch {
          /* ignore malformed server text */
        }
        return;
      }
      this._handleBinary(data);
    });
    conn.onClose(() => {
      this.closed = true;
    });
  }

  static async connect(url) {
    return new DemoClient(await connectWebSocket(url, { timeoutMs: 8000 }));
  }

  _handleBinary(data) {
    const headerLength = data.readUInt32LE(0);
    const header = JSON.parse(data.subarray(4, 4 + headerLength).toString('utf8'));
    const payload = data.subarray(4 + headerLength);
    if (header.t === 'shell.data') return;

    const width = Number(header.width);
    const height = Number(header.height);
    if (!this.canvas || this.width !== width || this.height !== height) {
      this.canvas = Buffer.alloc(width * height * 4);
      this.width = width;
      this.height = height;
    }
    let tileArea = 0;
    for (const tile of header.tiles) {
      const raw = zlib.inflateSync(payload.subarray(tile.off, tile.off + tile.len));
      assert(raw.length === tile.w * tile.h * 4, 'tile decompressed to the wrong RGBA size');
      for (let row = 0; row < tile.h; row += 1) {
        raw.copy(
          this.canvas,
          ((tile.y + row) * width + tile.x) * 4,
          row * tile.w * 4,
          row * tile.w * 4 + tile.w * 4,
        );
      }
      tileArea += tile.w * tile.h;
    }
    this.frames.push({
      seq: header.seq,
      keyframe: Boolean(header.keyframe),
      tiles: header.tiles.length,
      tileArea,
      cursor: header.cursor,
    });
  }

  send(message) {
    this.conn.sendText(JSON.stringify(message));
  }

  waitForMessage(predicate, { timeoutMs = 8000, label = 'message', from = 0 } = {}) {
    return waitFor(
      () => {
        for (let i = from; i < this.messages.length; i += 1) {
          if (predicate(this.messages[i])) return this.messages[i];
        }
        return false;
      },
      { timeoutMs, intervalMs: 25, label },
    );
  }

  waitForFrame(predicate, { timeoutMs = 10000, label = 'frame', from = 0 } = {}) {
    return waitFor(
      () => {
        for (let i = from; i < this.frames.length; i += 1) {
          if (predicate(this.frames[i])) return this.frames[i];
        }
        return false;
      },
      { timeoutMs, intervalMs: 25, label },
    );
  }

  close() {
    try {
      this.conn.close(1000, 'demo finished');
    } catch {
      /* ignore */
    }
  }
}

// ---- keyboard helper: type a string through the Agent key path ------------

const NAMED_KEYS = {
  ' ': { code: 'Space', key: ' ' },
  '-': { code: 'Minus', key: '-' },
  '/': { code: 'Slash', key: '/' },
  '.': { code: 'Period', key: '.' },
  ',': { code: 'Comma', key: ',' },
  '=': { code: 'Equal', key: '=' },
  ';': { code: 'Semicolon', key: ';' },
  "'": { code: 'Quote', key: "'" },
  _: { code: 'Minus', key: '_', shift: true },
  ':': { code: 'Semicolon', key: ':', shift: true },
  '"': { code: 'Quote', key: '"', shift: true },
};

function keyForChar(char) {
  if (/^[a-z]$/.test(char)) return { code: `Key${char.toUpperCase()}`, key: char };
  if (/^[A-Z]$/.test(char)) return { code: `Key${char}`, key: char, shift: true };
  if (/^[0-9]$/.test(char)) return { code: `Digit${char}`, key: char };
  const named = NAMED_KEYS[char];
  if (named) return named;
  throw new Error(`demo typing helper has no key mapping for ${JSON.stringify(char)}`);
}

async function typeString(client, text, { delayMs = 12 } = {}) {
  for (const char of text) {
    const mapped = keyForChar(char);
    const mods = { shift: Boolean(mapped.shift), ctrl: false, alt: false, meta: false };
    client.send({ t: 'key', code: mapped.code, key: mapped.key, down: true, mods });
    client.send({ t: 'key', code: mapped.code, key: mapped.key, down: false, mods });
    await sleep(delayMs);
  }
}

async function pressEnter(client) {
  const mods = { shift: false, ctrl: false, alt: false, meta: false };
  client.send({ t: 'key', code: 'Enter', key: 'Enter', down: true, mods });
  client.send({ t: 'key', code: 'Enter', key: 'Enter', down: false, mods });
}

// ---- helpers ---------------------------------------------------------------

function tailFile(filePath, maxChars = 2500) {
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    return text.length > maxChars ? `…${text.slice(-maxChars)}` : text;
  } catch {
    return '';
  }
}

async function findFreePort(startPort) {
  for (let port = startPort; port < startPort + 100; port += 1) {
    const free = await new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
    });
    if (free) return port;
  }
  throw new Error(`no free port in ${startPort}..${startPort + 99}`);
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

function waitForExit(proc, timeoutMs) {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      proc.removeListener('exit', onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    proc.once('exit', onExit);
  });
}

// ---- main ------------------------------------------------------------------

async function main() {
  const startedAt = Date.now();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rdtest-demo-'));
  const fsRoot = path.join(tmpDir, 'fsroot');
  fs.mkdirSync(fsRoot, { recursive: true });
  const agentLogPath = path.join(tmpDir, 'agent.log');

  let xvfb = null;
  let xterm = null;
  let agent = null;
  let client = null;

  const preferredDisplay = process.env.E2E_DISPLAY || process.env.DISPLAY || ':99';
  const preferredPort = Number(process.env.PORT) || 38090;

  try {
    console.log('[demo] starting Xvfb (1280x800, -noreset)…');
    xvfb = await startXvfb({
      display: preferredDisplay,
      width: 1280,
      height: 800,
      depth: 24,
      logDir: tmpDir,
    });
    console.log(`[demo] display ${xvfb.display} pid ${xvfb.pid}`);
    setRootColor(xvfb.display, ROOT_COLOR);

    console.log('[demo] starting real xterm with an interactive bash…');
    const bashrcPath = path.join(tmpDir, 'demo.bashrc');
    fs.writeFileSync(
      bashrcPath,
      "PS1='remote@demo $ '\nPS2='> '\nHISTFILE=/dev/null\n",
      'utf8',
    );
    xterm = await startXterm(xvfb.display, {
      geometry: '96x24+60+50',
      bg: TERM_COLOR,
      fg: '#e8e8f0',
      title: 'remote-demo-terminal',
      fontFace: 'DejaVu Sans Mono',
      fontSize: 13,
      command: `exec bash --noprofile --rcfile '${bashrcPath}' -i`,
      logDir: tmpDir,
    });
    const termGeometry = getWindowGeometry(xvfb.display, xterm.windowId);
    console.log(
      `[demo] xterm window ${xterm.windowId} ${termGeometry.width}x${termGeometry.height}` +
        `+${termGeometry.x}+${termGeometry.y}`,
    );

    const port = await findFreePort(preferredPort);
    console.log(`[demo] starting agent on 127.0.0.1:${port} (display ${xvfb.display})…`);
    const logFd = fs.openSync(agentLogPath, 'a');
    agent = spawn(
      process.execPath,
      [
        AGENT_ENTRY,
        '--port',
        String(port),
        '--bind',
        '127.0.0.1',
        '--password',
        PASSWORD,
        '--display',
        xvfb.display,
        '--fs-root',
        fsRoot,
      ],
      {
        cwd: REPO_DIR,
        env: { ...process.env, DISPLAY: xvfb.display },
        stdio: ['ignore', logFd, logFd],
      },
    );
    fs.closeSync(logFd);
    console.log(`[demo] agent pid ${agent.pid}`);

    const baseUrl = `http://127.0.0.1:${port}`;
    await waitFor(
      async () => {
        if (agent.exitCode !== null || agent.signalCode !== null) {
          throw new Error(`agent exited early; log:\n${tailFile(agentLogPath)}`);
        }
        try {
          const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1500) });
          return response.status === 200;
        } catch {
          return false;
        }
      },
      { timeoutMs: 20000, intervalMs: 100, label: 'agent /health' },
    );

    const authResponse = await fetch(`${baseUrl}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    });
    assert(authResponse.status === 200, `auth failed with HTTP ${authResponse.status}`);
    const { token } = await authResponse.json();
    assert(typeof token === 'string' && token.length > 0, 'auth returned no token');

    client = await DemoClient.connect(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);
    client.send({ t: 'hello', client: 'remote-desktop-demo', version: 1 });
    const welcome = await client.waitForMessage((message) => message.t === 'welcome', { label: 'welcome' });
    console.log(
      `[demo] connected: session ${welcome.session}, screen ${welcome.screen.width}x${welcome.screen.height}, ` +
        `capabilities ${JSON.stringify(welcome.capabilities)}`,
    );

    const screenStartMark = client.frames.length;
    client.send({ t: 'screen.start', fps: 20, tile: 64 });
    await client.waitForMessage((message) => message.t === 'screen.started', {
      label: 'screen.started',
      from: client.messages.length,
    });
    await client.waitForFrame((frame) => frame.keyframe, { label: 'first keyframe', from: screenStartMark });
    console.log(`[demo] screen streaming, initial keyframe received (${client.frames.at(-1)?.tiles} tiles)`);

    // Focus the terminal and type the commands through the Agent's key path.
    const termCenter = [
      termGeometry.x + Math.floor(termGeometry.width / 2),
      termGeometry.y + Math.floor(termGeometry.height / 2),
    ];
    client.send({ t: 'mouse', action: 'move', x: termCenter[0], y: termCenter[1] });
    await sleep(150);
    client.send({ t: 'mouse', action: 'down', x: termCenter[0], y: termCenter[1], button: 0 });
    client.send({ t: 'mouse', action: 'up', x: termCenter[0], y: termCenter[1], button: 0 });
    await sleep(400);

    for (const command of COMMANDS) {
      console.log(`[demo] typing: ${command}`);
      await typeString(client, command);
      await pressEnter(client);
      await sleep(500);
    }
    // Let bash render all output before grabbing the final full frame.
    await sleep(1500);

    // Ask for a fresh full keyframe and save exactly that decoded frame.
    const refreshMark = client.frames.length;
    client.send({ t: 'screen.refresh' });
    const finalFrame = await client.waitForFrame((frame) => frame.keyframe, {
      label: 'final keyframe for screenshot',
      from: refreshMark,
    });
    assert(client.canvas, 'client decoded no frame');
    assert(
      finalFrame.tileArea === client.width * client.height,
      'final keyframe does not cover the whole screen',
    );

    // Independent cross-checks: root margin colour via xwd, and real rendered
    // terminal content inside the xterm region (proves the commands ran).
    const reference = captureRootPixels(xvfb.display);
    const rootPoint = [1200, 750];
    const agentRoot = [
      client.canvas[(rootPoint[1] * client.width + rootPoint[0]) * 4],
      client.canvas[(rootPoint[1] * client.width + rootPoint[0]) * 4 + 1],
      client.canvas[(rootPoint[1] * client.width + rootPoint[0]) * 4 + 2],
    ];
    const referenceRoot = pixelAt(reference, rootPoint[0], rootPoint[1]).slice(0, 3);
    assert(
      JSON.stringify(agentRoot) === JSON.stringify(referenceRoot),
      `decoded root pixel ${JSON.stringify(agentRoot)} != xwd reference ${JSON.stringify(referenceRoot)}`,
    );

    fs.mkdirSync(path.dirname(SCREENSHOT_PATH), { recursive: true });
    const png = writePng(SCREENSHOT_PATH, { width: client.width, height: client.height, rgba: client.canvas });
    const header = readPngHeader(fs.readFileSync(SCREENSHOT_PATH));
    const fileInfo = spawnSync('file', ['-b', SCREENSHOT_PATH], { encoding: 'utf8' }).stdout.trim();

    // Count non-background pixels inside the terminal to prove real output.
    const textPixels = countColor(
      { width: client.width, height: client.height, rgba: client.canvas },
      [0x1e, 0x1e, 0x2e],
      {
        x: termGeometry.x,
        y: termGeometry.y,
        width: termGeometry.width,
        height: termGeometry.height,
        tolerance: 6,
      },
    );
    const termArea = termGeometry.width * termGeometry.height;
    const backgroundShare = textPixels / termArea;
    assert(backgroundShare > 0.5, `terminal should mostly show its background, got ${(backgroundShare * 100).toFixed(1)}%`);
    const nonBackground = termArea - textPixels;
    assert(nonBackground > 1000, `terminal must contain rendered text, found ${nonBackground} non-background pixels`);

    console.log('[demo] screenshot captured from a real decoded Agent frame:');
    console.log(`       path:     ${SCREENSHOT_PATH}`);
    console.log(`       size:     ${png.width}x${png.height}, ${png.bytes} bytes, ${header.chunks.join('/')}`);
    console.log(`       file(1):  ${fileInfo}`);
    console.log(`       terminal: ${nonBackground} rendered (non-background) pixels inside the xterm region`);
    console.log(`       duration: ${((Date.now() - startedAt) / 1000).toFixed(2)}s`);
    process.exitCode = 0;
  } finally {
    if (client) client.close();
    if (agent && pidAlive(agent.pid)) {
      try {
        process.kill(agent.pid, 'SIGINT');
      } catch {
        /* ignore */
      }
      if (!(await waitForExit(agent, 8000))) {
        try {
          process.kill(agent.pid, 'SIGKILL');
        } catch {
          /* ignore */
        }
        await waitForExit(agent, 2000);
      }
    }
    if (xterm) {
      try {
        await xterm.stop();
      } catch {
        /* ignore */
      }
    }
    if (xvfb) {
      try {
        await xvfb.stop();
      } catch {
        /* ignore */
      }
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

main().catch((err) => {
  console.error('[demo] FAILED:', err && err.stack ? err.stack : err);
  process.exit(1);
});
