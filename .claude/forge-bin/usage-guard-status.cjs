'use strict';
/**
 * usage-guard-status.cjs — what `usage-guard status` may write back into FORGE_USAGE_GUARD_STATE.json (SA-P1-USAGE,
 * PHASE2-PLAN A1, 2026-11-04). status reads REAL usage; before this it wrote only FORGE_USAGE_PRESSURE.json, so the state
 * kept a 22-day-old failed check (HTTP 429) and the lane budget said "usage onbekend". PURE, zero dependencies.
 *
 * statusPersistTransform(fresh, u, ident, nowIso, detectAccountSwitch) -> the state to write, or null = write nothing:
 *  - only mode 'ok' (or no mode): a paused state belongs to the watcher (forge-autonomy judges a stale pause by its
 *    lastCheckAt, so a status run must never make a dead watcher's pause look fresh); corrupt stays corrupt;
 *  - never for another account (detectAccountSwitch(fresh, ident).switched — the next watch tick resets that state);
 *  - only when at least one % is a real number; a NaN side is stored as null, never as a guess;
 *  - writes percents + lastCheckAt (+ lastStatusAt); clears lastError ONLY when it described a failed measurement
 *    (a partial-resume error is the watcher's business and stays); never touches heartbeatAt, account or pause fields.
 *  The input object is never mutated.
 */
const MEASUREMENT_ERROR_RE = /^(usage endpoint|usage fetch|credentials file|no OAuth|account switched mid-check|credential rotated mid-check)/i;
const pctOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(v, 100) : null);

function statusPersistTransform(fresh, u, ident, nowIso, detectAccountSwitch) {
  if (!fresh || typeof fresh !== 'object' || Array.isArray(fresh)) return null;
  if (fresh.mode !== undefined && fresh.mode !== 'ok') return null;
  if (typeof detectAccountSwitch !== 'function' || detectAccountSwitch(fresh, ident).switched) return null;
  const session = pctOrNull(u && u.session && u.session.pct);
  const week = pctOrNull(u && u.week && u.week.pct);
  if (session === null && week === null) return null;
  const next = Object.assign({}, fresh, { percents: { session, week }, lastCheckAt: nowIso, lastStatusAt: nowIso });
  if (typeof next.lastError === 'string' && MEASUREMENT_ERROR_RE.test(next.lastError)) delete next.lastError;
  return next;
}

module.exports = { statusPersistTransform, MEASUREMENT_ERROR_RE };
