// "Eigen API" overlay store (ANY-MODEL-PLAN 2.2 A): <data dir>/providers/custom.json, the user's own
// provider definitions. Same pattern and boundary as the app router store (APP-ROUTER-DESIGN D7):
//   - the gateway is the only writer; every write validates the WHOLE next document first;
//   - optimistic concurrency through `revision` (the caller passes the revision it read);
//   - atomic: a temp file in the same folder, then rename over the target (a reader sees old or new);
//   - the read-check-write runs synchronously, so inside this process the event loop is the lock;
//   - one audit line per write in custom-events.jsonl: ids and codes only, never the address, a header
//     value or a label (capped at 2 MB, one .1 rotation; logging never fails a write);
//   - no key, token or absolute path is ever stored: keys live in the desktop vault under the derived
//     name CUSTOM_<SLUG>_API_KEY (custom-rules.mjs), the definition only says HOW the key is sent.
// A missing file reads as an empty document (DEFAULT). A damaged or no-longer-valid file reads as empty
// with provenance UNREADABLE (its revision kept) and blocks entry edits until a full replacement, which
// first keeps the damaged file beside it as custom.json.unreadable-<time>.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { COMMAND_CENTER_DATA_DIR } from '../paths.mjs';
import { redact } from '../redact.mjs';
import {
  validateCustomDocument, emptyCustomDocument, checkCustomURL, customKeyEnvName, uniqueCustomId, customMessage,
  CUSTOM_ENTRY_KEYS,
} from './custom-rules.mjs';

const FILE_NAME = 'custom.json';
const LOG_NAME = 'custom-events.jsonl';
const LOG_MAX_BYTES = 2 * 1024 * 1024;
const EDITABLE_KEYS = new Set(CUSTOM_ENTRY_KEYS.filter((k) => !['id', 'created_at', 'updated_at'].includes(k)));
const STORE_OWNED_KEYS = new Set(['created_at', 'updated_at']);
export const CUSTOM_EVENT_KINDS = Object.freeze(['custom_provider_created', 'custom_provider_updated', 'custom_provider_deleted', 'custom_providers_replaced']);

let dirOverride = null;
let generation = 0;

/** <COMMAND_CENTER_DATA_DIR>/providers (follows FORGE_DATA_DIR). */
export function customProvidersDir() {
  return dirOverride || path.join(COMMAND_CENTER_DATA_DIR, 'providers');
}
export function customProvidersFile() {
  return path.join(customProvidersDir(), FILE_NAME);
}
/** Test seam: points the store folder at `dir` (null restores the data dir). */
export function _setCustomProvidersDirForTests(dir) {
  dirOverride = dir || null;
  generation += 1;
}

/**
 * A cheap fingerprint of the store: changes on every write in this process and on any outside edit of the
 * file (size or modification time). The merged registry is rebuilt only when it changes.
 */
export function customStoreStamp() {
  let st = 'missing';
  try {
    const s = fs.statSync(customProvidersFile());
    st = s.size + ':' + s.mtimeMs;
  } catch { /* no file: the empty document */ }
  return customProvidersDir() + '|' + generation + '|' + st;
}

/**
 * @returns {{provenance: 'DEFAULT'|'STORED'|'UNREADABLE', doc: object, errors: Array<{path,code,nl,en}>, warnings: Array<{path,code,nl,en}>}}
 */
export function readCustomProviders() {
  let text;
  try {
    text = fs.readFileSync(customProvidersFile(), 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return { provenance: 'DEFAULT', doc: emptyCustomDocument(), errors: [], warnings: [] };
    return unreadable(null, [customMessage('', 'bad_shape')]);
  }
  let parsed;
  try { parsed = JSON.parse(text); } catch { return unreadable(null, [customMessage('', 'bad_shape')]); }
  const v = validateCustomDocument(parsed);
  if (!v.ok) return unreadable(parsed, v.errors);
  return { provenance: 'STORED', doc: parsed, errors: [], warnings: v.warnings };
}

function unreadable(parsed, errors) {
  const doc = emptyCustomDocument();
  // Keep the stored revision so the next full save can replace the broken file without a 409 loop.
  if (parsed && Number.isInteger(parsed.revision) && parsed.revision >= 0) doc.revision = parsed.revision;
  return { provenance: 'UNREADABLE', doc, errors, warnings: [] };
}

function invalid(errors) {
  return { ok: false, error: 'invalid', errors };
}

function revisionProblem(expectRevision) {
  return Number.isInteger(expectRevision) && expectRevision >= 0 ? null : invalid([customMessage('revision', 'bad_revision')]);
}

function appendEvent(kind, data, now) {
  const clean = (v) => (typeof v === 'string' ? redact(v).slice(0, 64) : (typeof v === 'number' || typeof v === 'boolean' || v === null ? v : null));
  const record = { at: new Date(now).toISOString(), kind };
  for (const k of ['id', 'revision', 'format', 'auth_type', 'models_mode', 'enabled', 'url_class']) if (k in data) record[k] = clean(data[k]);
  const line = JSON.stringify(record) + '\n';
  try {
    const file = path.join(customProvidersDir(), LOG_NAME);
    let size = 0;
    try { size = fs.statSync(file).size; } catch { size = 0; }
    if (size > 0 && size + Buffer.byteLength(line) > LOG_MAX_BYTES) fs.renameSync(file, file + '.1');
    fs.appendFileSync(file, line, 'utf8');
    return true;
  } catch {
    return false; // the audit line is best-effort; the write itself already succeeded
  }
}

function eventFields(p, revision) {
  const url = checkCustomURL(p.baseURL);
  return {
    id: p.id, revision, format: p.format, auth_type: p.auth && p.auth.type, models_mode: p.models && p.models.mode,
    enabled: p.enabled, url_class: url.ok ? url.urlClass : null,
  };
}

function atomicWrite(doc) {
  const file = customProvidersFile();
  const tmp = file + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, file);
    generation += 1;
    return null;
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* nothing was written */ }
    return { ok: false, error: 'write_failed', detail: (e && e.code) || 'error' };
  }
}

// Validates and stores `nextProviders` as revision current+1. Shared by every write below.
function commit(current, nextProviders, now) {
  const stamp = new Date(now).toISOString();
  const doc = { version: current.doc.version, revision: current.doc.revision + 1, providers: nextProviders, updated_at: stamp };
  const v = validateCustomDocument(doc);
  if (!v.ok) return invalid(v.errors);
  const failed = atomicWrite(doc);
  if (failed) return failed;
  return { ok: true, doc, warnings: v.warnings };
}

// Copies the editable fields of `input`; undefined values count as absent. created_at/updated_at are store-
// owned and ignored; any other key is kept so the validator refuses it as unknown_key.
function definitionFrom(input, base) {
  const out = { ...base };
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined || STORE_OWNED_KEYS.has(k) || k === 'id') continue;
    out[k] = v;
  }
  if (out.extraHeaders === undefined) out.extraHeaders = {};
  if (out.contextLength === undefined) out.contextLength = null;
  if (out.enabled === undefined) out.enabled = true;
  if (typeof out.baseURL === 'string') {
    const url = checkCustomURL(out.baseURL);
    if (url.ok) out.baseURL = url.url; // store the normalised address the table judged
  }
  return out;
}

function guard(expectRevision) {
  const bad = revisionProblem(expectRevision);
  if (bad) return { stop: bad };
  const current = readCustomProviders();
  if (current.provenance === 'UNREADABLE') return { stop: { ok: false, error: 'unreadable', errors: current.errors, doc: current.doc } };
  if (expectRevision !== current.doc.revision) return { stop: { ok: false, error: 'stale_revision', doc: current.doc } };
  return { current };
}

function entryWarnings(warnings, index) {
  const prefix = 'providers[' + index + ']';
  return warnings.filter((w) => w.path === prefix || w.path.startsWith(prefix + '.')).map((w) => ({ ...w, path: w.path.slice(prefix.length + 1) }));
}

/**
 * Adds one provider. `input` holds the editable fields (label, format, baseURL, auth, models, and optional
 * extraHeaders, contextLength, enabled) and optionally `id`; without one the id is made from the label.
 * @returns {{ok: true, provider, doc, warnings, keyEnvName}
 *   | {ok: false, error: 'invalid', errors} | {ok: false, error: 'stale_revision'|'unreadable', doc, errors?}
 *   | {ok: false, error: 'write_failed', detail}}
 */
export function createCustomProvider(input, { expectRevision, now = Date.now() } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid([customMessage('', 'bad_shape')]);
  const g = guard(expectRevision);
  if (g.stop) return g.stop;
  const providers = g.current.doc.providers;
  const taken = providers.map((p) => p.id);
  let id = input.id;
  if (id === undefined || id === null || id === '') id = uniqueCustomId(input.label, taken);
  else if (taken.includes(id)) return invalid([customMessage('id', 'duplicate_id')]);
  const stamp = new Date(now).toISOString();
  const provider = { id, ...definitionFrom(input, {}), created_at: stamp, updated_at: stamp };
  const r = commit(g.current, [...providers, provider], now);
  if (!r.ok) return r.error === 'invalid' ? invalid(r.errors.map((e) => stripPath(e, providers.length))) : r;
  appendEvent('custom_provider_created', eventFields(provider, r.doc.revision), now);
  return { ok: true, provider, doc: r.doc, warnings: entryWarnings(r.warnings, providers.length), keyEnvName: keyNameFor(provider) };
}

/** Replaces the editable fields of provider `id` (id and created_at stay). Same answers as create, plus not_found. */
export function updateCustomProvider(id, input, { expectRevision, now = Date.now() } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid([customMessage('', 'bad_shape')]);
  if (input.id !== undefined && input.id !== null && input.id !== id) return invalid([customMessage('id', 'bad_id')]);
  const g = guard(expectRevision);
  if (g.stop) return g.stop;
  const providers = g.current.doc.providers;
  const index = providers.findIndex((p) => p.id === id);
  if (index < 0) return { ok: false, error: 'not_found' };
  const old = providers[index];
  const provider = { id, ...definitionFrom(input, {}), created_at: old.created_at, updated_at: new Date(now).toISOString() };
  const next = providers.map((p, i) => (i === index ? provider : p));
  const r = commit(g.current, next, now);
  if (!r.ok) return r.error === 'invalid' ? invalid(r.errors.map((e) => stripPath(e, index))) : r;
  appendEvent('custom_provider_updated', eventFields(provider, r.doc.revision), now);
  return { ok: true, provider, doc: r.doc, warnings: entryWarnings(r.warnings, index), keyEnvName: keyNameFor(provider) };
}

/**
 * Removes provider `id`. `removed.keyEnvName` is the vault name the desktop app should drop with it.
 * @returns {{ok: true, removed: {id, keyEnvName}, doc} | {ok: false, error: 'not_found'|'stale_revision'|'unreadable'|'invalid'|'write_failed'}}
 */
export function deleteCustomProvider(id, { expectRevision, now = Date.now() } = {}) {
  const g = guard(expectRevision);
  if (g.stop) return g.stop;
  const providers = g.current.doc.providers;
  const target = providers.find((p) => p.id === id);
  if (!target) return { ok: false, error: 'not_found' };
  const r = commit(g.current, providers.filter((p) => p.id !== id), now);
  if (!r.ok) return r;
  appendEvent('custom_provider_deleted', { id, revision: r.doc.revision }, now);
  return { ok: true, removed: { id, keyEnvName: customKeyEnvName(id) }, doc: r.doc };
}

/**
 * Replaces the whole document (also over an UNREADABLE file, which is first kept aside). `doc.providers`
 * must be complete stored entries; version, revision and updated_at are set by the store.
 */
export function writeCustomProviders(doc, { expectRevision, now = Date.now() } = {}) {
  const bad = revisionProblem(expectRevision);
  if (bad) return bad;
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.providers)) return invalid([customMessage('providers', 'bad_shape')]);
  const current = readCustomProviders();
  if (expectRevision !== current.doc.revision) return { ok: false, error: 'stale_revision', doc: current.doc };
  const pre = validateCustomDocument({ ...doc, version: current.doc.version, revision: current.doc.revision + 1, updated_at: null });
  if (!pre.ok) return invalid(pre.errors);
  if (current.provenance === 'UNREADABLE') {
    const file = customProvidersFile();
    const aside = file + '.unreadable-' + new Date(now).toISOString().replace(/[:.]/g, '-');
    try { fs.copyFileSync(file, aside); } catch (e) { return { ok: false, error: 'write_failed', detail: (e && e.code) || 'error' }; }
  }
  const r = commit(current, doc.providers, now);
  if (!r.ok) return r;
  appendEvent('custom_providers_replaced', { revision: r.doc.revision }, now);
  return r;
}

function keyNameFor(provider) {
  return provider.auth && provider.auth.type !== 'none' ? customKeyEnvName(provider.id) : null;
}

// Errors of a single-entry write are reported relative to that entry ('label', not 'providers[3].label').
function stripPath(e, index) {
  const prefix = 'providers[' + index + ']';
  if (e.path === prefix) return { ...e, path: '' };
  if (e.path.startsWith(prefix + '.')) return { ...e, path: e.path.slice(prefix.length + 1) };
  return e;
}

export { EDITABLE_KEYS as CUSTOM_EDITABLE_KEYS };
