// "Eigen API" routes (ANY-MODEL-PLAN 2.2 D): read, add, change and remove the user's own provider
// definitions in the overlay store (providers/custom-store.mjs).
//
//   GET    /api/providers/custom        {ok, provenance, revision, providers:[entry], errors?, captured_at}
//   POST   /api/providers/custom        body {revision, provider: definition} -> 201 {ok, revision, provider, warnings}
//   PATCH  /api/providers/custom/:id    same body                             -> 200 {ok, revision, provider, warnings,
//                                                                                    key_reconfirm_required, router_entries}
//   DELETE /api/providers/custom/:id[?revision=N]                            -> 200 {ok, revision, removed, router_entries}
//
// Rules kept here:
//   - loopback peer only, judged on the socket address (never a header) BEFORE the body is read; the server's
//     method guard and the exec-token check (dashboard credential only) run before that;
//   - a key is never accepted over HTTP: a key-named field is refused with key_not_allowed and the store refuses
//     any key-shaped value; the key goes only to the desktop vault (window.forge.keys.set) under key_env_name;
//   - request bodies are never echoed: errors carry only {path, code, nl, en}, and every answer passes the
//     shared redactor once more on its way out;
//   - every write goes through custom-store (validate the whole next document, revision check, atomic write,
//     audit line). A saved entry is part of the merged registry at once, so the existing Test route
//     (POST /api/providers/:id/test) and GET /api/models see it without a restart.
// PATCH instead of the plan's PUT: the gateway's CORS preflight and method guard already know PATCH and DELETE
// for single items; PUT is refused for every path (405).
import { readJsonBody, BodyTooLargeError } from '../body.mjs';
import { sharedRedactor, redactText } from '../providers/redact-guard.mjs';
import { redact } from '../redact.mjs';
import { customMessage, customKeyEnvName, isCustomId } from '../providers/custom-rules.mjs';
import {
  readCustomProviders, createCustomProvider, updateCustomProvider, deleteCustomProvider, writeCustomProviders,
} from '../providers/custom-store.mjs';
import { loadMergedRegistry } from '../providers/custom-registry.mjs';
import { readRouterConfig } from '../app-router/chain-store.mjs';
import { getGatewayKeyStore } from '../models.mjs';
import { checkRateLimit } from './rate-limit.mjs';
import { sendJson } from './http.mjs';

export const MODULE = 'providers-custom';

export const CUSTOM_COLLECTION_PATH = '/api/providers/custom';
// The dashboard's CUSTOM_ID_RE on the path, anchored on both ends. The store still checks the id itself.
export const CUSTOM_ITEM_RE = /^\/api\/providers\/custom\/(custom-[a-z0-9][a-z0-9-]{0,40})$/;

/** True for the one POST route of this module (the server's POST write-route allowlist). */
export function isCustomWriteRoute(pathname) {
  return pathname === CUSTOM_COLLECTION_PATH;
}
/** True for an item path (the server's PATCH and DELETE allowlist). */
export function isCustomItemRoute(pathname) {
  return CUSTOM_ITEM_RE.test(pathname);
}

// 50 model ids of 200 characters plus 8 headers is about 12 KB; 32 KB leaves room without inviting a large body.
const BODY_MAX_BYTES = 32 * 1024;
const LOOPBACK_PEERS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const BODY_KEYS = new Set(['revision', 'provider']);
// Field names that would carry a key. Never stored, never accepted, whatever their value.
const KEY_FIELD_RE = /^(?:api[-_]?key|key|keys|token|access[-_]?token|secret|password|authorization|bearer|value|credential|credentials)$/i;
const PATH_SAFE_RE = /^[A-Za-z0-9_.[\]-]{0,120}$/;

const MESSAGES = Object.freeze({
  loopback_only: ['Eigen API\'s kun je alleen op deze computer beheren.', 'Own APIs can only be managed from this PC.'],
  key_not_allowed: [
    'Een sleutel wordt nooit via deze route verstuurd. Vul hem in het sleutelveld in; de app bewaart hem in de kluis.',
    'A key is never sent through this route. Enter it in the key field; the app keeps it in the vault.',
  ],
  store_unreadable: [
    'Het bestand met eigen API\'s is beschadigd. Voeg een nieuwe eigen API toe om het te vervangen; het oude bestand blijft ernaast bewaard.',
    'The own-API file is damaged. Add a new own API to replace it; the old file is kept beside it.',
  ],
  not_found: ['Deze eigen API bestaat niet (meer).', 'This own API does not exist (any more).'],
});

function msg(path, code) {
  const fixed = MESSAGES[code];
  return fixed ? { path, code, nl: fixed[0], en: fixed[1] } : customMessage(path, code);
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const nowIso = () => new Date().toISOString();

function send(res, status, body) {
  return sendJson(res, status, sharedRedactor.redactDeep(body));
}

/** A path that names a field the user typed (an unknown key) is dropped when it could carry a secret. */
function safeErrors(errors) {
  return (Array.isArray(errors) ? errors : []).map((e) => {
    const p = typeof e.path === 'string' ? e.path : '';
    const keep = PATH_SAFE_RE.test(p) && redact(p) === p && redactText(p) === p;
    return { path: keep ? p : '', code: e.code, nl: e.nl, en: e.en };
  });
}

export function isLoopbackPeer(req) {
  const addr = req && req.socket ? req.socket.remoteAddress : null;
  return typeof addr === 'string' && LOOPBACK_PEERS.has(addr);
}

function refuseRemote(req, res) {
  if (isLoopbackPeer(req)) return false;
  const m = msg('', 'loopback_only');
  send(res, 403, { ok: false, error: 'loopback_only', code: 'loopback_only', nl: m.nl, en: m.en });
  return true;
}

/** Reads a JSON body without ever echoing it or the parser's message (that message quotes the input). */
async function readBodyQuiet(req) {
  try {
    return { body: await readJsonBody(req, { maxBytes: BODY_MAX_BYTES }) };
  } catch (err) {
    if (err instanceof BodyTooLargeError) return { status: 413, error: 'request body too large' };
    return { status: 400, error: 'request body is not valid JSON' };
  }
}

/** Key-named fields at the top level, in the definition and in its auth block. */
function keyFieldErrors(body) {
  const hits = [];
  const scan = (obj, base) => {
    if (!isPlainObject(obj)) return;
    for (const k of Object.keys(obj)) if (KEY_FIELD_RE.test(k)) hits.push(msg(base, 'key_not_allowed'));
  };
  scan(body, '');
  scan(body.provider, '');
  if (isPlainObject(body.provider)) scan(body.provider.auth, 'auth');
  return hits.slice(0, 1);
}

/**
 * Parses and checks the write body {revision, provider}. Returns {revision, provider} or {status, body} to send.
 * The revision itself is judged by the store (bad_revision), so a missing one gets the store's message.
 */
function parseWriteBody(body) {
  if (!isPlainObject(body)) return { status: 400, body: { ok: false, error: 'invalid', errors: [msg('', 'bad_shape')] } };
  const keyHits = keyFieldErrors(body);
  if (keyHits.length > 0) return { status: 400, body: { ok: false, error: 'key_not_allowed', errors: keyHits } };
  if (Object.keys(body).some((k) => !BODY_KEYS.has(k))) return { status: 400, body: { ok: false, error: 'invalid', errors: [msg('', 'unknown_key')] } };
  if (!isPlainObject(body.provider)) return { status: 400, body: { ok: false, error: 'invalid', errors: [msg('provider', 'bad_shape')] } };
  return { revision: body.revision, provider: body.provider };
}

/** The usable ids and per-id problems of the merged registry; a bundled-registry failure leaves both empty. */
function mergedState() {
  try {
    const reg = loadMergedRegistry();
    const problems = {};
    for (const p of reg.custom.problems) if (p.id) (problems[p.id] ||= []).push({ path: '', code: p.code, nl: p.nl, en: p.en });
    return { usable: new Set(reg.custom.ids), problems };
  } catch {
    return { usable: new Set(), problems: {} };
  }
}

function publicEntry(p, warnings, merged) {
  return {
    ...p,
    key_env_name: p.auth && p.auth.type !== 'none' ? customKeyEnvName(p.id) : null,
    warnings: safeErrors(warnings),
    usable: merged ? merged.usable.has(p.id) : p.enabled === true,
    problems: merged ? merged.problems[p.id] || [] : [],
  };
}

function warningsFor(all, index) {
  const prefix = 'providers[' + index + ']';
  return all.filter((w) => w.path === prefix || w.path.startsWith(prefix + '.'))
    .map((w) => ({ ...w, path: w.path === prefix ? '' : w.path.slice(prefix.length + 1) }));
}

/** Answers a store failure: 400 invalid, 409 stale_revision | duplicate_id | store_unreadable, 404, 500. */
function sendStoreFailure(res, r) {
  if (r.error === 'invalid') {
    const errors = safeErrors(r.errors);
    if (errors.some((e) => e.code === 'duplicate_id')) {
      return send(res, 409, { ok: false, error: 'duplicate_id', revision: readCustomProviders().doc.revision, errors });
    }
    return send(res, 400, { ok: false, error: 'invalid', errors });
  }
  if (r.error === 'stale_revision') return send(res, 409, { ok: false, error: 'stale_revision', revision: r.doc.revision });
  if (r.error === 'unreadable') {
    return send(res, 409, { ok: false, error: 'store_unreadable', revision: r.doc.revision, errors: [msg('', 'store_unreadable'), ...safeErrors(r.errors)] });
  }
  if (r.error === 'not_found') {
    const m = msg('', 'not_found');
    return send(res, 404, { ok: false, error: 'not_found', nl: m.nl, en: m.en });
  }
  return send(res, 500, { ok: false, error: 'write_failed', detail: String(r.detail || 'error').slice(0, 40) });
}

function sendSaved(res, status, r, extra = {}) {
  const merged = mergedState();
  return send(res, status, {
    ok: true,
    revision: r.doc.revision,
    provider: publicEntry(r.provider, r.warnings, merged),
    warnings: safeErrors(r.warnings),
    ...extra,
  });
}

// ---- GET /api/providers/custom ----------------------------------------------------------------------------

export async function list(req, res) {
  if (refuseRemote(req, res)) return undefined;
  const read = readCustomProviders();
  const merged = mergedState();
  const providers = read.doc.providers.map((p, i) => publicEntry(p, warningsFor(read.warnings, i), merged));
  return send(res, 200, {
    ok: true,
    provenance: read.provenance,
    revision: read.doc.revision,
    providers,
    ...(read.provenance === 'UNREADABLE' ? { errors: [msg('', 'store_unreadable'), ...safeErrors(read.errors)] } : {}),
    captured_at: nowIso(),
  });
}

// ---- POST /api/providers/custom -----------------------------------------------------------------------------

export async function create(req, res) {
  if (refuseRemote(req, res)) return undefined;
  if (!checkRateLimit('appRouterWrite', res)) return undefined;
  const read = await readBodyQuiet(req);
  if (read.error) return send(res, read.status, { ok: false, error: read.error });
  const parsed = parseWriteBody(read.body);
  if (parsed.status) return send(res, parsed.status, parsed.body);
  let revision = parsed.revision;
  // A damaged file reads as empty (GET shows provenance UNREADABLE). The first add replaces it, exactly like
  // the app router's next save: the store first keeps the damaged file beside it as custom.json.unreadable-<time>.
  if (readCustomProviders().provenance === 'UNREADABLE') {
    const reset = writeCustomProviders({ providers: [] }, { expectRevision: revision });
    if (!reset.ok) return sendStoreFailure(res, reset);
    revision = reset.doc.revision;
  }
  const r = createCustomProvider(parsed.provider, { expectRevision: revision });
  if (!r.ok) return sendStoreFailure(res, r);
  return sendSaved(res, 201, r);
}

// ---- PATCH /api/providers/custom/:id -------------------------------------------------------------------------

export async function update(req, res, { match } = {}) {
  if (refuseRemote(req, res)) return undefined;
  if (!checkRateLimit('appRouterWrite', res)) return undefined;
  const id = match && match[1];
  if (!isCustomId(id)) return sendStoreFailure(res, { ok: false, error: 'not_found' });
  const read = await readBodyQuiet(req);
  if (read.error) return send(res, read.status, { ok: false, error: read.error });
  const parsed = parseWriteBody(read.body);
  if (parsed.status) return send(res, parsed.status, parsed.body);
  // Read synchronously right before the write: the revision check makes this the definition the write replaces.
  const before = readCustomProviders().doc.providers.find((p) => p.id === id) || null;
  const r = updateCustomProvider(id, parsed.provider, { expectRevision: parsed.revision });
  if (!r.ok) return sendStoreFailure(res, r);
  const reconfirm = await keyReconfirmRequired(before, r.provider);
  // Q5-EIGEN-API: like DELETE, name the router chain entries that use this provider (turning it off makes the
  // router skip them; the dashboard can say so).
  return sendSaved(res, 200, r, { key_reconfirm_required: reconfirm, router_entries: routerEntriesUsing(id) });
}

/**
 * True when a saved change moves a keyed entry to another (normalised) address while a key is stored for it:
 * that key would now go to the new server, so the dashboard asks the user to confirm it again. Only presence is
 * asked of the gateway key store (vault hand-off first, then the plain environment variable); no value is read
 * into this route or returned.
 */
async function keyReconfirmRequired(before, after) {
  if (!before || !after || before.baseURL === after.baseURL) return false;
  if (!after.auth || after.auth.type === 'none') return false;
  const name = customKeyEnvName(after.id);
  if (!name) return false;
  try {
    const status = await getGatewayKeyStore().status(name);
    return status.present === true;
  } catch {
    return true; // presence unknown: asking once more is the safe side
  }
}

// ---- DELETE /api/providers/custom/:id[?revision=N] -----------------------------------------------------------

/**
 * Router chain entries that name this provider (informational: the dashboard can say so). An entry whose Eigen API
 * is deleted or turned off keeps router.json readable (a provider_unavailable warning, Q5-EIGEN-API), so this works
 * before and after the write; DELETE still reads it before the delete.
 */
function routerEntriesUsing(id) {
  try {
    const { config } = readRouterConfig({ registry: loadMergedRegistry() });
    const entries = Array.isArray(config.entries) ? config.entries : [];
    return entries.filter((e) => isPlainObject(e) && e.provider === id).map((e) => e.id).filter((x) => typeof x === 'string');
  } catch {
    return [];
  }
}

export async function remove(req, res, { match, searchParams } = {}) {
  if (refuseRemote(req, res)) return undefined;
  if (!checkRateLimit('appRouterWrite', res)) return undefined;
  const id = match && match[1];
  if (!isCustomId(id)) return sendStoreFailure(res, { ok: false, error: 'not_found' });
  let revision;
  const raw = searchParams ? searchParams.get('revision') : null;
  if (raw !== null && raw !== undefined) {
    if (!/^\d{1,9}$/.test(raw)) return send(res, 400, { ok: false, error: 'invalid', errors: [msg('revision', 'bad_revision')] });
    revision = Number(raw);
  } else {
    // No revision given: delete by id against the current one (the dashboard's delete button sends none).
    const current = readCustomProviders();
    if (current.provenance === 'UNREADABLE') return sendStoreFailure(res, { ok: false, error: 'unreadable', doc: current.doc, errors: current.errors });
    revision = current.doc.revision;
  }
  const usedBy = routerEntriesUsing(id);
  const r = deleteCustomProvider(id, { expectRevision: revision });
  if (!r.ok) return sendStoreFailure(res, r);
  return send(res, 200, {
    ok: true,
    revision: r.doc.revision,
    removed: { id: r.removed.id, key_env_name: r.removed.keyEnvName },
    router_entries: usedBy,
  });
}
