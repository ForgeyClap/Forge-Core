// App router — the router.json store (design sections 2.1 and D7).
// <data dir>/app-router/router.json. The gateway is the only writer. A write validates first, checks
// the revision (optimistic concurrency), then writes a temp file and renames it over the target, so
// a reader sees the old or the new file, never half of one. The whole read-check-write runs
// synchronously, so within this process the event loop is the lock: two writes can never interleave.
// A missing file reads as the defaults (DEFAULT); a broken or no-longer-valid file reads as the
// defaults with provenance UNREADABLE (router off, fail-safe), never as a crash.
// Q5-EIGEN-API: an entry whose "Eigen API" (custom-*) was deleted, turned off or refused, or whose Eigen API
// now needs a key while the entry never confirmed the cost, does NOT make the file invalid: it reads as STORED
// with a provider_unavailable / paid_ack_required warning (the turn router skips that entry). A save may keep
// such an already-stored state (same entry id, same provider, and for the cost: already unconfirmed when
// stored), never create one.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { defaultRouterConfig, validateRouterConfig } from './chain-schema.mjs';
import { appendRouterEvent, routerDataDir, _setRouterDataDirForTests } from './router-log.mjs';

const FILE_NAME = 'router.json';

export function routerConfigFile() {
  return path.join(routerDataDir(), FILE_NAME);
}

/** Test seam: points the whole router folder (router.json, usage.json, the log) at `dir`. */
export function _setRouterDirForTests(dir) {
  _setRouterDataDirForTests(dir);
}

/**
 * @returns {{provenance: 'DEFAULT'|'STORED'|'UNREADABLE', config: object, errors: Array<{path,code,nl,en}>,
 *   warnings: Array<{path,code,nl,en,entry_id,provider}>}}  warnings is always an array ([] unless STORED).
 */
export function readRouterConfig({ registry } = {}) {
  let text;
  try {
    text = fs.readFileSync(routerConfigFile(), 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return { provenance: 'DEFAULT', config: defaultRouterConfig(), errors: [], warnings: [] };
    return unreadable(null, [{ path: '', code: 'bad_shape', nl: 'De router-instellingen kunnen niet gelezen worden.', en: 'The router settings cannot be read.' }]);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return unreadable(null, [{ path: '', code: 'bad_shape', nl: 'Het bestand met router-instellingen is beschadigd.', en: 'The router settings file is damaged.' }]);
  }
  const v = validateRouterConfig(parsed, { registry, allowUnavailable: true });
  if (!v.ok) return unreadable(parsed, v.errors);
  return { provenance: 'STORED', config: parsed, errors: [], warnings: v.warnings };
}

function unreadable(parsed, errors) {
  const config = defaultRouterConfig();
  // Keep the stored revision so the next save can replace the broken file without a 409 loop.
  if (parsed && Number.isInteger(parsed.revision) && parsed.revision >= 0) config.revision = parsed.revision;
  return { provenance: 'UNREADABLE', config, errors, warnings: [] };
}

const referenceKey = (e) => JSON.stringify([e.id, e.provider]);

/** (entry id, provider) -> the stored entry, for a STORED router.json: only those may keep an unusable state. */
function storedReferences(current) {
  if (!current || current.provenance !== 'STORED' || !Array.isArray(current.config.entries)) return new Map();
  return new Map(current.config.entries
    .filter((e) => e && e.kind === 'provider-model' && typeof e.id === 'string' && typeof e.provider === 'string')
    .map((e) => [referenceKey(e), e]));
}

/**
 * Validates `next` as a save: validateRouterConfig, except that an entry keeping an already-stored reference
 * (same entry id, same provider) to an Eigen API that is no longer usable passes with a warning, so the user can
 * still change every other setting. A NEW reference to such a provider stays unknown_provider; an unconfirmed
 * cost (paid_ack) may stay only when the stored entry was already unconfirmed, so a save never creates that state.
 * @param {object} next
 * @param {{registry?: object, current?: object}} [opts] current: a readRouterConfig() answer already in hand
 * @returns {{ok: boolean, errors: Array<{path,code,nl,en}>, warnings: Array<object>}}
 */
export function checkRouterConfigForWrite(next, { registry, current } = {}) {
  const kept = storedReferences(current || readRouterConfig({ registry }));
  const allowUnavailable = (e, reason) => {
    const stored = typeof e.id === 'string' && typeof e.provider === 'string' ? kept.get(referenceKey(e)) : undefined;
    if (!stored) return false;
    return reason !== 'paid_ack_required' || stored.paid_ack !== true;
  };
  return validateRouterConfig(next, { registry, allowUnavailable });
}

/**
 * Validates and stores `next`. The stored revision becomes current + 1 and updated_at is set.
 * @param {object} next  the full config incl. `revision`
 * @param {{expectRevision?: number, now?: number, registry?: object}} [opts]
 *   expectRevision defaults to next.revision; it must equal the current stored revision.
 * @returns {{ok: true, config: object}
 *   | {ok: false, error: 'invalid', errors: Array<{path,code,nl,en}>}
 *   | {ok: false, error: 'stale_revision', config: object}
 *   | {ok: false, error: 'write_failed', detail: string}}
 */
export function writeRouterConfig(next, { expectRevision, now = Date.now(), registry } = {}) {
  const current = readRouterConfig({ registry });
  const v = checkRouterConfigForWrite(next, { registry, current });
  if (!v.ok) return { ok: false, error: 'invalid', errors: v.errors };
  const expected = expectRevision === undefined ? next.revision : expectRevision;
  if (expected !== current.config.revision) return { ok: false, error: 'stale_revision', config: current.config };

  const stored = { ...structuredClone(next), revision: current.config.revision + 1, updated_at: new Date(now).toISOString() };
  const file = routerConfigFile();
  const tmp = file + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(stored, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* nothing was written */ }
    return { ok: false, error: 'write_failed', detail: (e && e.code) || 'error' };
  }
  appendRouterEvent('router_config_changed', {
    revision: stored.revision,
    mode: stored.mode,
    entries: stored.entries.map((e) => ({ id: e.id, kind: e.kind, enabled: e.enabled })),
  }, { now });
  return { ok: true, config: stored };
}
