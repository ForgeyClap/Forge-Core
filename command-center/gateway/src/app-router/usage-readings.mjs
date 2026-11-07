// App router — usage readings (design section 4.4) and the per-target state (the table in 4.2).
//
// Usage is measured passively from the rate_limit_event lines every real Claude Code turn already
// emits (stream-json), or from a user-clicked Test turn. Nothing here reads a login file or calls a
// usage endpoint. A missing utilization stays null (never 0): the CLI seems to report a number only
// from its own warning level (inferred; spike S3 checks it).
//
// usage.json keeps per target id: measured_at, source, windows, limit_hit, needs_login_at, down_at,
// last_used_at. Numbers, window types and timestamps only (token-free by construction: every value
// is rebuilt from a whitelist, nothing from the stream line is copied through as free text).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { routerDataDir } from './router-log.mjs';
import { LIMITS, ID_RE } from './contract.mjs';

const FILE_NAME = 'usage.json';
const TYPE_RE = /^[a-z0-9_]{1,40}$/;
const STATUS_RE = /^[a-z_]{1,32}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

// ---- parsing ----------------------------------------------------------------------------------------

function toIso(v) {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
    const ms = v < 1e12 ? v * 1000 : v; // epoch seconds (CLI) or milliseconds
    const d = new Date(ms);
    return Number.isFinite(d.getTime()) ? d.toISOString() : null;
  }
  if (typeof v === 'string' && ISO_RE.test(v) && Number.isFinite(Date.parse(v))) return new Date(Date.parse(v)).toISOString();
  return null;
}
/** utilization is a 0..1 fraction; anything else is not a number we trust -> null. */
function toPct(v) {
  const n = typeof v === 'number' ? v : NaN;
  if (!Number.isFinite(n) || n < 0 || n > 1) return null;
  return Math.round(n * 1000) / 10;
}
const cleanType = (v) => (typeof v === 'string' && TYPE_RE.test(v) ? v : 'other');
const cleanStatus = (v) => (typeof v === 'string' && STATUS_RE.test(v) ? v : null);

/**
 * Reads one parsed stream-json line. Accepts both observed shapes:
 *  (a) rate_limit_info: { status, resetsAt, rateLimitType, utilization? }
 *  (b) rate_limit_info.unifiedWindows.{five_hour,seven_day}.{utilization,resetsAt}
 * @returns {null | {status: string|null, windows: Array<{type:string, pct:number|null, resets_at:string|null, status:string|null}>}}
 */
export function readingFromStreamLine(parsed) {
  if (!parsed || typeof parsed !== 'object' || parsed.type !== 'rate_limit_event') return null;
  const info = parsed.rate_limit_info;
  if (!info || typeof info !== 'object' || Array.isArray(info)) return null;
  const status = cleanStatus(info.status);
  const windows = [];
  const uw = info.unifiedWindows;
  if (uw && typeof uw === 'object' && !Array.isArray(uw)) {
    for (const [type, w] of Object.entries(uw).slice(0, 8)) {
      if (!w || typeof w !== 'object') continue;
      windows.push({ type: cleanType(type), pct: toPct(w.utilization), resets_at: toIso(w.resetsAt), status: cleanStatus(w.status) || status });
    }
  }
  if (windows.length === 0 && (info.rateLimitType !== undefined || info.resetsAt !== undefined || info.utilization !== undefined)) {
    windows.push({ type: cleanType(info.rateLimitType), pct: toPct(info.utilization), resets_at: toIso(info.resetsAt), status });
  }
  if (windows.length === 0 && status === null) return null;
  return { status, windows };
}

// ---- store ------------------------------------------------------------------------------------------

function usageFile() { return path.join(routerDataDir(), FILE_NAME); }

function emptyRecord() {
  return { measured_at: null, source: null, windows: [], limit_hit: null, needs_login_at: null, down_at: null, last_used_at: null };
}
const isoOrNull = (v) => (typeof v === 'string' && ISO_RE.test(v) ? v : null);

function cleanWindows(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 8).filter((w) => w && typeof w === 'object').map((w) => ({
    type: cleanType(w.type),
    pct: typeof w.pct === 'number' && Number.isFinite(w.pct) && w.pct >= 0 && w.pct <= 100 ? w.pct : null,
    resets_at: isoOrNull(w.resets_at),
    status: cleanStatus(w.status),
  }));
}

function cleanRecord(r) {
  const base = emptyRecord();
  if (!r || typeof r !== 'object') return base;
  const hit = r.limit_hit && typeof r.limit_hit === 'object' && isoOrNull(r.limit_hit.at)
    ? { at: r.limit_hit.at, resets_at: isoOrNull(r.limit_hit.resets_at), window: typeof r.limit_hit.window === 'string' ? cleanType(r.limit_hit.window) : null }
    : null;
  return {
    measured_at: isoOrNull(r.measured_at),
    source: r.source === 'turn' || r.source === 'test' ? r.source : null,
    windows: cleanWindows(r.windows),
    limit_hit: hit,
    needs_login_at: isoOrNull(r.needs_login_at),
    down_at: isoOrNull(r.down_at),
    last_used_at: isoOrNull(r.last_used_at),
  };
}

/** @returns {Record<string, import('./contract.mjs').UsageRecord>} every stored target; {} when missing or broken */
export function readReadings() {
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(usageFile(), 'utf8')); } catch { return {}; }
  const targets = parsed && typeof parsed === 'object' && parsed.targets && typeof parsed.targets === 'object' ? parsed.targets : {};
  const out = {};
  for (const [id, rec] of Object.entries(targets)) if (ID_RE.test(id)) out[id] = cleanRecord(rec);
  return out;
}

/** Read-modify-write of one target's record, atomically. Returns the new record, or null. */
function update(targetId, fn) {
  if (typeof targetId !== 'string' || !ID_RE.test(targetId)) return null;
  const all = readReadings();
  const next = cleanRecord(fn({ ...(all[targetId] || emptyRecord()) }));
  all[targetId] = next;
  const file = usageFile();
  const tmp = file + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, targets: all }, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, file);
    return next;
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* nothing was written */ }
    return null;
  }
}

/**
 * Stores a reading for a target (call at most once per turn, with that turn's last reading).
 * A rejected window also records a limit hit; a non-rejected reading clears an earlier limit hit and
 * a needs-login mark (a reading proves the account answered).
 * @returns {object|null} the stored record, or null for a bad id / no reading / a failed write
 */
export function recordReading(targetId, reading, { source = 'turn', now = Date.now() } = {}) {
  if (!reading || !Array.isArray(reading.windows)) return null;
  const at = new Date(now).toISOString();
  const rejected = reading.windows.find((w) => w && w.status === 'rejected') || (reading.status === 'rejected' ? reading.windows[0] || {} : null);
  return update(targetId, (r) => ({
    ...r,
    measured_at: at,
    source: source === 'test' ? 'test' : 'turn',
    windows: reading.windows,
    limit_hit: rejected ? { at, resets_at: rejected.resets_at || null, window: rejected.type || null } : null,
    needs_login_at: null,
  }));
}

/** A turn ended with rate_limited: the target is exhausted until resets_at (or 60 min when unknown). */
export function recordLimitHit(targetId, { resets_at = null, window = null, now = Date.now() } = {}) {
  return update(targetId, (r) => ({ ...r, limit_hit: { at: new Date(now).toISOString(), resets_at: toIso(resets_at) || isoOrNull(resets_at), window } }));
}
export function markNeedsLogin(targetId, { now = Date.now() } = {}) {
  return update(targetId, (r) => ({ ...r, needs_login_at: new Date(now).toISOString() }));
}
export function markDown(targetId, { now = Date.now() } = {}) {
  return update(targetId, (r) => ({ ...r, down_at: new Date(now).toISOString() }));
}
export function markUsed(targetId, { now = Date.now() } = {}) {
  return update(targetId, (r) => ({ ...r, last_used_at: new Date(now).toISOString() }));
}

// ---- state ------------------------------------------------------------------------------------------

/** seven_day_opus counts only when the asked model is an Opus model (or no model is asked). */
function windowApplies(type, requestedModel) {
  const m = /^seven_day_([a-z0-9]+)$/.exec(type || '');
  if (!m) return true;
  if (!requestedModel) return true;
  return String(requestedModel).toLowerCase().includes(m[1]);
}
const ts = (iso) => (iso ? Date.parse(iso) : NaN);

/**
 * The state of one chain entry right now (design 4.2 table). Pure.
 * @param {object} entry   a chain entry
 * @param {object|null} record  its usage record (readReadings()[entry.id]) or null
 * @param {{now?: number, defaultThresholdPct?: number, requestedModel?: string|null}} [opts]
 * @returns {{state: string, eligible: boolean, max_pct: number|null, max_window: string|null,
 *   windows: Array, resume_at: string|null, measured_at: string|null, source: string|null, stale: boolean}}
 */
export function targetState(entry, record, { now = Date.now(), defaultThresholdPct = LIMITS.THRESHOLD_DEFAULT, requestedModel = null } = {}) {
  const rec = record ? cleanRecord(record) : emptyRecord();
  const threshold = entry && Number.isInteger(entry.threshold_pct) ? entry.threshold_pct : defaultThresholdPct;
  const measuredMs = ts(rec.measured_at);
  const stale = Number.isFinite(measuredMs) && now - measuredMs > LIMITS.STALE_MS;
  const live = rec.measured_at && !stale
    ? rec.windows.filter((w) => windowApplies(w.type, requestedModel) && !(Number.isFinite(ts(w.resets_at)) && ts(w.resets_at) <= now))
    : [];
  let max = null;
  for (const w of live) if (w.pct !== null && (max === null || w.pct > max.pct)) max = w;
  const out = (state, extra = {}) => ({
    state,
    eligible: state === 'ready' || state === 'unknown',
    max_pct: max ? max.pct : null,
    max_window: max ? max.type : null,
    windows: rec.windows,
    resume_at: null,
    measured_at: rec.measured_at,
    source: rec.source,
    stale,
    ...extra,
  });

  const hit = rec.limit_hit;
  if (hit && windowApplies(hit.window, requestedModel)) {
    const resetMs = ts(hit.resets_at);
    if (Number.isFinite(resetMs) ? resetMs > now : now - ts(hit.at) < LIMITS.UNKNOWN_RESET_HOLD_MS) {
      return out('exhausted', { resume_at: Number.isFinite(resetMs) ? hit.resets_at : null });
    }
  }
  const isExtraProfile = entry && entry.kind === 'claude-account' && typeof entry.profile === 'string';
  if (isExtraProfile && rec.needs_login_at) return out('needs-login');
  if (rec.down_at && now - ts(rec.down_at) < LIMITS.DOWN_HOLD_MS) return out('down');
  if (entry && entry.kind === 'provider-model') return out('ready');
  if (max && max.pct >= threshold) return out('near-limit');
  if (live.length > 0) return out('ready');
  return out('unknown');
}
