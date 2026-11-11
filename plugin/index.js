/**
 * Host half of the remote-desktop bundle.
 *
 * The feature is browser-side: the panel talks to the remote agent directly over
 * WebSocket/HTTP, so the Host only needs this row to exist so the profile selects
 * the bundle and serves its client module.
 */
export function apply() {}
