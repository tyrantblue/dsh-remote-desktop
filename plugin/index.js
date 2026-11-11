/**
 * Host half of the remote-desktop bundle.
 *
 * The panel itself is browser-side, but on a normal NAT network it cannot dial
 * the controlled machine directly. This row therefore also runs the cross-NAT
 * relay hub on the Harness web server (see docs/RELAY.md):
 *
 *   - agents open an outbound WebSocket to /api/auth/remote-desktop/relay/agent
 *   - the panel reaches those agents through /api/auth/remote-desktop/relay/... on this origin
 *     (that public prefix is the only one the web-startup-auth plugin lets through
 *     without a Harness session; the relay still requires the random agent code,
 *     the agent's own password/WS token, and optionally DSH_REMOTE_RELAY_TOKEN)
 *
 * No files, passcodes or payloads are written to disk; the relay is process-memory
 * only and every agent still enforces its own password and WS token.
 */

import { RELAY_PATHS, RelayHub } from './relay-host.mjs';

/** @type {string[]} */
export const inject = ['webServer'];

/**
 * @param {any} ctx
 */
export function apply(ctx) {
  const relay = new RelayHub({
    relayToken: typeof process.env.DSH_REMOTE_RELAY_TOKEN === 'string' ? process.env.DSH_REMOTE_RELAY_TOKEN : undefined,
  });

  ctx.effect(() => {
    const disposers = [
      ctx.webServer.register({
        kind: 'exact',
        path: RELAY_PATHS.info,
        handler: relay.handleInfo,
      }),
      ctx.webServer.register({
        kind: 'prefix',
        path: RELAY_PATHS.clientPrefix,
        handler: relay.handleHttp,
      }),
      ctx.webServer.registerUpgrade({
        path: RELAY_PATHS.agent,
        handler: relay.handleAgentUpgrade,
      }),
      ctx.webServer.registerUpgrade({
        path: RELAY_PATHS.ws,
        handler: relay.handleClientUpgrade,
      }),
    ];
    console.log(`[remote-desktop relay] routes registered (${RELAY_PATHS.info})`);
    return () => {
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          /* ignore */
        }
      }
      relay.close();
    };
  }, 'remote-desktop relay routes');
}
