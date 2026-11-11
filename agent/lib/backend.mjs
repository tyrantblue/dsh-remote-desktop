// Platform backend factory.
//
// docs/WINDOWS.md §1:
//   export async function createBackend(options) -> Backend
//
// options: { display, noScreen, noInput, env, platform?, helperCommand? }
//   - platform defaults to process.platform; pass 'win32' in tests to exercise
//     the Windows backend on another host.
//   - helperCommand (string or argv array) overrides the Windows helper; when
//     absent env.RDA_HELPER_CMD is used, then the PowerShell default.
//
// A screen-less backend is returned for noScreen (capabilities.screen=false,
// grab() throws); real backend start-up failures are propagated so the caller
// can degrade to that state without crashing the agent.

function normalizePlatform(platform) {
  return platform === 'win32' ? 'win32' : 'linux';
}

function createNullBackend(platform) {
  return {
    platform: normalizePlatform(platform),
    capabilities: { screen: false, input: false, text: false, shell: false, files: false },
    info: { screen: null },
    encoding: 'tiles',
    async grab() {
      throw new Error('screen capture is not available on this backend');
    },
    handleInput() {
      return { ok: false, error: 'no_screen' };
    },
    async close() {
      /* nothing to release */
    },
  };
}

export async function createBackend(options = {}) {
  const platform = options.platform || process.platform;
  if (options.noScreen) return createNullBackend(platform);

  if (normalizePlatform(platform) === 'win32') {
    const { createWin32Backend } = await import('./backend-win32.mjs');
    return createWin32Backend(options);
  }

  const { createX11Backend } = await import('./backend-x11.mjs');
  const backend = await createX11Backend(options);
  // Keep the exported platform within the contract's two values.
  backend.platform = 'linux';
  return backend;
}

export { createNullBackend };
