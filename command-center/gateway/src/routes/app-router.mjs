// App router routes (APP-ROUTER-DESIGN.md 6.1, part P3): read and save the router chain, the per-entry
// status, adding an extra Claude account (an empty profile folder + a chain entry) and the user-clicked
// Test of one entry.
//
// Rules kept here:
//   - the gateway never reads, copies or stores a login: an extra account is only an empty folder the
//     user signs in to inside the official `claude` program; the copy commands carry that folder path;
//   - GET routes are pure reads: no probe, no network, no CLI child;
//   - the only route that can start anything is POST .../targets/:id/test, one click = one probe, at
//     most one quota-using probe per target per 5 minutes (LIMITS.TEST_INTERVAL_MS) and one at a time;
//   - request bodies are never echoed back (a pasted key in a label must not come back in an error);
//     validation errors carry only {path, code, nl, en};
//   - every write goes through chain-store (validate, revision check, atomic write, audit line).
import { safeConvIdOk } from '../security.mjs';
import { readJsonBody, BodyTooLargeError } from '../body.mjs';
import { redact } from '../redact.mjs';
import { conversationExists } from '../conversations.mjs';
import { readRouterConfig, writeRouterConfig, checkRouterConfigForWrite } from '../app-router/chain-store.mjs';
import { describeChain, unusableEntryReasons, unusableEntryText, validateRouterConfig } from '../app-router/chain-schema.mjs';
import {
  readReadings, targetState, recordReading, recordLimitHit, markNeedsLogin, markDown,
} from '../app-router/usage-readings.mjs';
import { profilesRoot, ensureProfileDir, loginCommands, slugFromLabel, displayPath } from '../app-router/profiles.mjs';
import { appendRouterEvent, readRouterEvents } from '../app-router/router-log.mjs';
import {
  CAPABILITY_BY_KIND, LIMITS, ROUTER_TERMS_CHECKED_AT, ROUTER_TERMS_SOURCES, OUTCOMES,
} from '../app-router/contract.mjs';
import { routerPreview } from '../app-router/turn-router.mjs';
import { runTargetProbe } from '../app-router/probe.mjs';
import { checkRateLimit } from './rate-limit.mjs';
import { sendJson } from './http.mjs';

export const MODULE = 'app-router';

export const APP_ROUTER_PATH = '/api/app-router';
export const APP_ROUTER_STATUS_PATH = '/api/app-router/status';
export const APP_ROUTER_PROFILES_PATH = '/api/app-router/profiles';
// Target ids follow the chain id rule (contract ID_RE). Anchored on both ends.
export const APP_ROUTER_TEST_RE = /^\/api\/app-router\/targets\/([a-z0-9][a-z0-9-]{0,31})\/test$/;

/** True for the three POST routes of this module (for the server's write-route allowlist). */
export function isAppRouterWriteRoute(pathname) {
  return pathname === APP_ROUTER_PATH || pathname === APP_ROUTER_PROFILES_PATH || APP_ROUTER_TEST_RE.test(pathname);
}

// A full config with 12 entries is a few KB; 32 KB leaves room without inviting a large body.
const CONFIG_BODY_MAX_BYTES = 32 * 1024;
const SMALL_BODY_MAX_BYTES = 4 * 1024;
/** The route never waits longer than this for a probe (the probe has its own, shorter timeout). */
const PROBE_ROUTE_TIMEOUT_MS = 120_000;
const DETAIL_MAX = 200;
const MAX_WINDOWS = 8;
const DOWN_CODES = new Set(['ollama_down', 'model_not_pulled', 'offline']);
// Outcomes after which a probe really used quota (a turn ran): only those start the 5-minute window.
// A logged-out, down or failed probe costs nothing, so the user may test again right after fixing it.
const QUOTA_OUTCOMES = new Set(['ok', 'rate_limited']);

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const nowIso = () => new Date().toISOString();

/** Reads a JSON body without ever echoing it or the parser's message (that message quotes the input). */
async function readBodyQuiet(req, maxBytes) {
  try {
    return { body: await readJsonBody(req, { maxBytes }) };
  } catch (err) {
    if (err instanceof BodyTooLargeError) return { status: 413, error: 'request body too large' };
    return { status: 400, error: 'request body is not valid JSON' };
  }
}

// ---- GET /api/app-router -------------------------------------------------------------------------

export async function get(req, res) {
  const read = readRouterConfig();
  return sendJson(res, 200, {
    ok: true,
    provenance: read.provenance,
    config: read.config,
    // Q5-EIGEN-API: e.g. a chain entry whose Eigen API is gone ({path, code: 'provider_unavailable', nl, en, entry_id, provider}).
    warnings: read.warnings,
    terms: { checked_at: ROUTER_TERMS_CHECKED_AT, sources: ROUTER_TERMS_SOURCES.map((s) => ({ title: s.title, url: s.url })) },
    profiles_root_display: displayPath(profilesRoot()),
    captured_at: nowIso(),
  });
}

// ---- POST /api/app-router --------------------------------------------------------------------------

/** Answers a chain-store write failure (400 invalid, 409 stale revision, 500 write failed). */
function sendWriteFailure(res, result) {
  if (result.error === 'invalid') return sendJson(res, 400, { ok: false, errors: result.errors });
  if (result.error === 'stale_revision') return sendJson(res, 409, { ok: false, error: 'stale_revision', config: result.config });
  return sendJson(res, 500, { ok: false, error: 'write_failed', detail: String(result.detail || 'error').slice(0, 40) });
}

export async function save(req, res) {
  if (!checkRateLimit('appRouterWrite', res)) return undefined;
  const read = await readBodyQuiet(req, CONFIG_BODY_MAX_BYTES);
  if (read.error) return sendJson(res, read.status, { ok: false, error: read.error });
  // The body is the full config incl. `revision`; chain-store validates every key and value and checks
  // that `revision` is the stored one (optimistic concurrency), so no field is trusted here.
  const result = writeRouterConfig(read.body, { expectRevision: isPlainObject(read.body) ? read.body.revision : undefined });
  if (!result.ok) return sendWriteFailure(res, result);
  // Q6 C3: the warnings of the just-stored config, computed exactly as GET /api/app-router does (readRouterConfig),
  // so the dashboard shows a fixed or a new warning right after the save without a second request.
  const fresh = validateRouterConfig(result.config, { allowUnavailable: true });
  return sendJson(res, 200, { ok: true, config: result.config, warnings: fresh.warnings || [] });
}

// ---- GET /api/app-router/status --------------------------------------------------------------------

const HARD_STATES = new Set(['exhausted', 'needs-login', 'down']);

/**
 * One status row (design 6.1). near-limit stays usable: it still has room (last-resort tier). An entry whose Eigen
 * API is gone or unconfirmed (Q5-EIGEN-API) is in the chain but never eligible: the turn router skips it
 * (ineligible_reason provider_unavailable / paid_ack_required).
 */
function statusRow(item, readings, defaults, now, unusable) {
  const { entry, in_chain: inChain, excluded_reason: excluded } = item;
  const st = targetState(entry, readings[entry.id] || null, {
    now, defaultThresholdPct: Number.isInteger(defaults.threshold_pct) ? defaults.threshold_pct : LIMITS.THRESHOLD_DEFAULT,
  });
  let ineligible = null;
  if (!inChain) ineligible = excluded;
  else if (unusable.has(entry.id)) ineligible = unusable.get(entry.id);
  else if (HARD_STATES.has(st.state)) ineligible = st.state;
  return {
    id: entry.id,
    kind: entry.kind,
    label: entry.label,
    enabled: entry.enabled === true,
    eligible: ineligible === null,
    ineligible_reason: ineligible,
    state: st.state,
    max_pct: st.max_pct,
    windows: st.windows,
    measured_at: st.measured_at,
    source: st.source,
    resume_at: st.resume_at,
    capability: CAPABILITY_BY_KIND[entry.kind] || null,
  };
}

/** The `next` object of /status from a RouteDecision: only ids, labels and reasons leave the gateway. */
export function publicDecision(d) {
  if (!isPlainObject(d) || d.kind === 'off') return null;
  if (d.kind === 'exhausted') {
    const free = isPlainObject(d.first_free)
      ? { target_id: d.first_free.target_id ?? null, label: d.first_free.label ?? null, resume_at: d.first_free.resume_at ?? d.resume_at ?? null }
      : null;
    return { kind: 'exhausted', resume_at: d.resume_at ?? null, first_free: free };
  }
  if (d.kind !== 'target') return null;
  const e = d.entry;
  const entry = isPlainObject(e)
    ? { id: e.id ?? null, label: e.label ?? null, kind: e.kind ?? null }
    : { id: typeof e === 'string' ? e : null, label: null, kind: null };
  return { kind: 'target', entry, reason: d.reason ?? null, switched: d.switched === true, from: isPlainObject(d.from) ? d.from : null };
}

function lastSwitch(convId) {
  const events = readRouterEvents({ limit: 500 });
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (!e || e.kind !== 'router_switch') continue;
    if (convId && e.conv_id !== convId) continue;
    return { conv_id: e.conv_id ?? null, turn_id: e.turn_id ?? null, from: e.from ?? null, to: e.to ?? null, reason: e.reason ?? null, at: e.at ?? null };
  }
  return null;
}

export async function status(req, res, { searchParams } = {}) {
  const raw = searchParams ? searchParams.get('conversation') : null;
  const convId = raw ? raw : null;
  if (convId !== null) {
    if (!safeConvIdOk(convId)) return sendJson(res, 400, { ok: false, error: 'invalid conversation id' });
    if (!conversationExists(convId)) return sendJson(res, 404, { ok: false, error: 'conversation not found' });
  }
  const now = Date.now();
  const { config } = readRouterConfig();
  const readings = readReadings();
  const defaults = isPlainObject(config.defaults) ? config.defaults : {};
  const unusable = unusableEntryReasons(config);
  const entries = describeChain(config).map((item) => statusRow(item, readings, defaults, now, unusable));
  let next = null;
  if (config.mode !== 'off') {
    try {
      next = publicDecision(routerPreview({ convId }));
    } catch {
      next = null; // a preview is advisory; it never turns the status into a 500
    }
  }
  return sendJson(res, 200, {
    ok: true,
    mode: config.mode,
    entries,
    next,
    last_switch: lastSwitch(convId),
    captured_at: nowIso(),
  });
}

// ---- POST /api/app-router/profiles -----------------------------------------------------------------

function refuseLabel(res, errors) {
  return sendJson(res, 400, {
    ok: false,
    error: 'invalid label',
    errors: errors && errors.length ? errors : [{ path: 'label', code: 'bad_label', nl: 'Kies een naam van 1 tot 40 tekens.', en: 'Choose a name of 1 to 40 characters.' }],
  });
}

export async function createProfile(req, res) {
  if (!checkRateLimit('appRouterWrite', res)) return undefined;
  const read = await readBodyQuiet(req, SMALL_BODY_MAX_BYTES);
  if (read.error) return sendJson(res, read.status, { ok: false, error: read.error });
  const body = read.body;
  if (!isPlainObject(body)) return sendJson(res, 400, { ok: false, error: 'body must be a JSON object' });
  if (Object.keys(body).some((k) => k !== 'label')) return sendJson(res, 400, { ok: false, error: 'only the field "label" is accepted' });
  if (typeof body.label !== 'string') return refuseLabel(res);
  const label = body.label.trim();
  const slug = slugFromLabel(label);
  if (!slug) return refuseLabel(res);

  const current = readRouterConfig();
  if (current.provenance === 'UNREADABLE') {
    return sendJson(res, 503, { ok: false, error: 'de router-instellingen zijn onleesbaar; sla ze eerst opnieuw op (the router settings are unreadable; save them first)' });
  }
  const config = current.config;
  const entries = Array.isArray(config.entries) ? config.entries : [];
  if (entries.some((e) => e && (e.id === slug || e.profile === slug))) {
    return sendJson(res, 409, { ok: false, error: 'exists', code: 'duplicate_id' });
  }
  if (entries.filter((e) => e && e.kind === 'claude-account').length >= LIMITS.MAX_CLAUDE) {
    return sendJson(res, 409, { ok: false, error: 'too many Claude accounts (at most ' + LIMITS.MAX_CLAUDE + ')', code: 'too_many_claude' });
  }
  if (entries.length >= LIMITS.MAX_ENTRIES) {
    return sendJson(res, 409, { ok: false, error: 'too many entries (at most ' + LIMITS.MAX_ENTRIES + ')', code: 'too_many_entries' });
  }
  const entry = { id: slug, kind: 'claude-account', label, profile: slug, enabled: true, threshold_pct: null };
  const next = { ...config, entries: [...entries, entry] };
  // Validate BEFORE the folder is made: a secret-shaped or otherwise bad label never creates anything. The same
  // check as the save itself, so a kept entry whose Eigen API is gone does not block adding an account.
  const check = checkRouterConfigForWrite(next, { current });
  if (!check.ok) return refuseLabel(res, check.errors);

  const made = ensureProfileDir(slug);
  if (!made.ok) {
    return sendJson(res, 500, { ok: false, error: 'could not prepare the account folder (' + made.code + ')' });
  }
  const login = loginCommands(slug);
  if (!login) return sendJson(res, 500, { ok: false, error: 'could not build the sign-in command for this folder' });
  const written = writeRouterConfig(next, { expectRevision: config.revision });
  if (!written.ok) return sendWriteFailure(res, written);
  const stored = written.config.entries.find((e) => e.id === slug) || entry;
  return sendJson(res, 201, { ok: true, entry: stored, config: written.config, login, dir_display: displayPath(made.dir) });
}

// ---- POST /api/app-router/targets/:id/test ---------------------------------------------------------

let probeImpl = runTargetProbe;
const lastQuotaProbeAt = new Map(); // target id -> ms when its last quota-using probe started
const probing = new Set(); // target ids with a probe running now

/** Test seam: replaces the probe (null restores the real one) and clears the per-target windows. */
export function _setProbeForTests(fn) {
  probeImpl = typeof fn === 'function' ? fn : runTargetProbe;
  lastQuotaProbeAt.clear();
  probing.clear();
}

function cleanWindow(w) {
  if (!isPlainObject(w)) return null;
  const str = (v, max) => (typeof v === 'string' && v.length > 0 ? redact(v).slice(0, max) : null);
  return {
    type: str(w.type, 40) || 'other',
    pct: typeof w.pct === 'number' && Number.isFinite(w.pct) ? w.pct : null,
    resets_at: str(w.resets_at, 40),
    status: str(w.status, 40),
  };
}

function cleanReading(r) {
  if (!isPlainObject(r) || !Array.isArray(r.windows)) return null;
  return {
    windows: r.windows.slice(0, MAX_WINDOWS).map(cleanWindow).filter(Boolean),
    status: typeof r.status === 'string' ? redact(r.status).slice(0, 40) : null,
  };
}

/** The probe's answer in one shape; anything unexpected reads as an honest 'error'. */
export function normalizeProbeResult(raw) {
  const r = isPlainObject(raw) ? raw : {};
  const said = typeof r.outcome === 'string' ? r.outcome : typeof r.state === 'string' ? r.state : null;
  let outcome = OUTCOMES.includes(said) && said !== 'stopped' ? said : 'error';
  const code = typeof r.code === 'string' ? r.code : DOWN_CODES.has(said) ? said : null;
  if (DOWN_CODES.has(said)) outcome = 'down';
  if (said === 'ready') outcome = 'ok';
  return {
    outcome,
    code,
    reading: cleanReading(r.reading),
    detail: typeof r.detail === 'string' && r.detail.length > 0 ? redact(r.detail).slice(0, DETAIL_MAX) : null,
    recorded: r.recorded === true,
  };
}

/** The `state` word the dashboard shows for a finished test (it knows each of these). */
function testState(n) {
  if (n.outcome === 'ok') return 'ready';
  if (n.outcome === 'down') return DOWN_CODES.has(n.code) ? n.code : 'down';
  return n.outcome; // rate_limited | logged_out | error
}

/** Stores what the probe proved, like a turn would (design 3.3 step 3, 4.4). */
function recordProbe(entryId, n) {
  if (n.outcome === 'ok') {
    recordReading(entryId, n.reading || { windows: [], status: null }, { source: 'test' });
  } else if (n.outcome === 'rate_limited') {
    const hit = n.reading ? n.reading.windows.find((w) => w.status === 'rejected') || null : null;
    recordLimitHit(entryId, { resets_at: hit ? hit.resets_at : null, window: hit ? hit.type : null });
  } else if (n.outcome === 'logged_out') {
    markNeedsLogin(entryId);
  } else if (n.outcome === 'down') {
    markDown(entryId);
  }
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ outcome: 'error', detail: 'the test took too long and was abandoned' }), ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

export async function testTarget(req, res, { match } = {}) {
  if (!checkRateLimit('appRouterTest', res)) return undefined;
  const id = match && match[1];
  const read = await readBodyQuiet(req, SMALL_BODY_MAX_BYTES);
  if (read.error) return sendJson(res, read.status, { ok: false, error: read.error });
  if (!isPlainObject(read.body) || Object.keys(read.body).length > 0) {
    return sendJson(res, 400, { ok: false, error: 'this route takes an empty JSON object as its body' });
  }
  const { config } = readRouterConfig();
  const entry = (Array.isArray(config.entries) ? config.entries : []).find((e) => e && e.id === id);
  if (!entry) return sendJson(res, 404, { ok: false, error: 'unknown target' });
  // Q6 C2: an entry the turn router skips (its Eigen API is gone, or keyed without a cost confirmation) is never
  // probed: a Test must not send a request, and spend, where a real turn would not.
  const unusable = unusableEntryReasons(config).get(id);
  if (unusable) {
    const text = unusableEntryText(unusable);
    return sendJson(res, 409, { ok: false, error: 'entry_unusable', reason: unusable, nl: text.nl, en: text.en });
  }
  if (probing.has(id)) return sendJson(res, 409, { ok: false, error: 'a test for this target is already running' });
  const startedAt = Date.now();
  const last = lastQuotaProbeAt.get(id);
  if (last !== undefined && startedAt - last < LIMITS.TEST_INTERVAL_MS) {
    const retryAfterS = Math.max(1, Math.ceil((LIMITS.TEST_INTERVAL_MS - (startedAt - last)) / 1000));
    return sendJson(res, 429, { ok: false, error: 'rate_limited', retry_after_s: retryAfterS }, { 'Retry-After': String(retryAfterS) });
  }

  probing.add(id);
  let raw;
  try {
    raw = await withTimeout(probeImpl(structuredClone(entry)), PROBE_ROUTE_TIMEOUT_MS);
  } catch {
    raw = { outcome: 'error', detail: 'the test could not run' };
  } finally {
    probing.delete(id);
  }
  const n = normalizeProbeResult(raw);
  if (QUOTA_OUTCOMES.has(n.outcome)) lastQuotaProbeAt.set(id, startedAt);
  if (!n.recorded) recordProbe(id, n);
  appendRouterEvent('router_test', { target_id: id, outcome: n.outcome });
  return sendJson(res, 200, { ok: true, state: testState(n), reading: n.reading, detail: n.detail });
}
