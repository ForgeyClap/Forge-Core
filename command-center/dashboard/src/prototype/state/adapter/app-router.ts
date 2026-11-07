/**
 * Forge Command Center — gateway adapter, app router slice (APP-ROUTER-DESIGN.md §2, §6.1, part P4).
 *
 * Talks to the gateway's own router store, never to a login file:
 *   GET  /api/app-router                         the stored chain (or the defaults) + the terms sources
 *   POST /api/app-router                         the FULL config incl. `revision` (optimistic concurrency)
 *   GET  /api/app-router/status[?conversation=]  per-entry state + the next choice (pure read, polled)
 *   POST /api/app-router/profiles  {label}       makes an empty profile folder + a chain entry
 *   POST /api/app-router/targets/:id/test  {}    one user-clicked probe (rate-limited to 1 per 5 min)
 *
 * Strict parsing, like `account-rotation.ts`: the config keeps ONLY the allowlisted wire keys (§2.2), so a
 * POST can never echo a key the server would refuse, and an entry this build cannot read is counted in
 * `problems` instead of being dropped silently (the section then refuses to save, rather than deleting it).
 * Nothing here stores, reads or forwards a credential: the router config has none by construction (§2.3).
 */

/* Split into three files (Q6-UI, files under 500 lines); every public name is still exported from here. */
export * from './app-router-parse';
export * from './app-router-calls';
export * from './app-router-hooks';
