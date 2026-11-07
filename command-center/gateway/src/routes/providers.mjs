// Provider routes (WP B2 part 2): the Accounts cards, the Test button, key status and the sign-in hint.
// Handlers have the A11 module shape (req, res, ctx); the Lead registers them from
// _scratch/b2/patches-gw.md. Contract: _scratch/b2/contract-providers.md.
//
// Rules kept here:
//   - GET routes make no outbound call to a paid API (see providers/provider-hub.mjs);
//   - POST .../test is the only outbound route, and only on the user's click;
//   - no route ever accepts, returns or logs a key value (status, source and last4 only); every
//     response passes the shared redactor once more on its way out;
//   - the gateway never runs a sign-in: login-hint only RETURNS the official CLI command.
import { getProviderHub } from '../models.mjs';
import { sharedRedactor } from '../providers/redact-guard.mjs';
import { MODEL_ID_RE } from '../providers/provider-hub.mjs';
import { readJsonBody, BodyTooLargeError } from '../body.mjs';
import { sendJson } from './http.mjs';

export const MODULE = 'providers';

// Provider ids are registry ids: lowercase letters, digits and dashes. Anchored on both ends.
export const PROVIDER_TEST_RE = /^\/api\/providers\/([a-z0-9][a-z0-9-]{0,62})\/test$/;
export const PROVIDER_LOGIN_HINT_RE = /^\/api\/providers\/([a-z0-9][a-z0-9-]{0,62})\/login-hint$/;
export const KEYS_RELOAD_PATH = '/api/providers/keys/reload';

/** True for the two POST routes of this module (for the server's method allowlist). */
export function isProvidersWriteRoute(pathname) {
  return pathname === KEYS_RELOAD_PATH || PROVIDER_TEST_RE.test(pathname);
}

const BODY_MAX_BYTES = 4096;
const LOOPBACK_PEERS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function send(res, status, body) {
  return sendJson(res, status, sharedRedactor.redactDeep(body));
}

function nowIso() {
  return new Date().toISOString();
}

function registryUnavailable(res, hub) {
  return send(res, 503, { ok: false, error: 'provider registry invalid', problems: hub.registryState().problems });
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Reads a small JSON body. Never echoes the body or the parser's message (Node's JSON.parse message
// quotes the input, which could be a pasted key). Returns { body } or { status, error }.
async function readSmallBody(req) {
  try {
    return { body: await readJsonBody(req, { maxBytes: BODY_MAX_BYTES }) };
  } catch (err) {
    if (err instanceof BodyTooLargeError) return { status: 413, error: 'request body too large' };
    return { status: 400, error: 'request body is not valid JSON' };
  }
}

function isLoopbackPeer(req) {
  const addr = req && req.socket ? req.socket.remoteAddress : null;
  return typeof addr === 'string' && LOOPBACK_PEERS.has(addr);
}

function latestDate(rows) {
  return rows.map((r) => r.verified_on).filter((d) => typeof d === 'string').sort().pop() || null;
}

// GET /api/providers[?fresh=1]
export async function list(req, res, { searchParams } = {}) {
  const hub = getProviderHub();
  const fresh = !!(searchParams && searchParams.get('fresh') === '1');
  const r = await hub.listProviders({ fresh });
  if (!r.ok) return registryUnavailable(res, hub);
  return send(res, 200, {
    ok: true, providers: r.providers, counts: r.counts, vault: r.vault,
    tos_checked_on: latestDate(r.providers), captured_at: nowIso(), provenance: 'DERIVED',
  });
}

// POST /api/providers/:id/test   body: {} | { "model": "<id>" }
export async function test(req, res, { match } = {}) {
  const hub = getProviderHub();
  if (!hub.registryState().ok) return registryUnavailable(res, hub);
  const id = match && match[1];
  if (!id || !hub.hasProvider(id)) return send(res, 404, { ok: false, error: 'unknown provider' });
  const read = await readSmallBody(req);
  if (read.error) return send(res, read.status, { ok: false, error: read.error });
  const body = read.body;
  if (!isPlainObject(body)) return send(res, 400, { ok: false, error: 'body must be a JSON object' });
  const unknown = Object.keys(body).filter((k) => k !== 'model');
  if (unknown.length > 0) return send(res, 400, { ok: false, error: 'unknown field(s): ' + unknown.slice(0, 5).map((k) => k.slice(0, 40)).join(', ') });
  let model = null;
  if (body.model !== undefined && body.model !== null && body.model !== '') {
    if (typeof body.model !== 'string' || !MODEL_ID_RE.test(body.model)) return send(res, 400, { ok: false, error: 'model must be a model id (letters, digits and . _ : / @ + -, max 200)' });
    model = body.model;
  }
  const out = await hub.testProvider(id, { model });
  if (!out) return send(res, 404, { ok: false, error: 'unknown provider' });
  return send(res, 200, { ok: true, ...out });
}

// GET /api/providers/keys
export async function keys(req, res) {
  const hub = getProviderHub();
  const r = await hub.keyStatuses();
  if (!r.ok) return registryUnavailable(res, hub);
  return send(res, 200, { ok: true, keys: r.keys, vault: r.vault, captured_at: nowIso() });
}

// POST /api/providers/keys/reload   body: none or {}. Never accepts key material.
export async function keysReload(req, res) {
  if (!isLoopbackPeer(req)) return send(res, 403, { ok: false, error: 'reload is only accepted from this PC' });
  const hub = getProviderHub();
  if (!hub.registryState().ok) return registryUnavailable(res, hub);
  const read = await readSmallBody(req);
  if (read.error) return send(res, read.status, { ok: false, error: read.error });
  if (!isPlainObject(read.body) || Object.keys(read.body).length > 0) {
    return send(res, 400, { ok: false, error: 'this route takes no body: keys are never accepted over HTTP (the desktop app restarts the gateway with the new keys)' });
  }
  const reloaded = hub.reloadKeys();
  const k = await hub.keyStatuses();
  return send(res, 200, { ok: true, reloaded, keys: k.keys, vault: k.vault, captured_at: nowIso() });
}

// GET /api/providers/:id/login-hint
export async function loginHint(req, res, { match } = {}) {
  const hub = getProviderHub();
  if (!hub.registryState().ok) return registryUnavailable(res, hub);
  const id = match && match[1];
  const hint = id ? hub.loginHintFor(id) : null;
  if (!hint) return send(res, 404, { ok: false, error: 'unknown provider' });
  return send(res, 200, { ok: true, ...hint });
}
