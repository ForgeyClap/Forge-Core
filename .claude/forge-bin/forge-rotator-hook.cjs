#!/usr/bin/env node
'use strict';
/**
 * forge-rotator-hook.cjs - `StopFailure` hook for the account rotator, PATH A (work packages R.2+R.3).
 *
 * WHAT: when a turn ends because of a usage limit (`error` = rate_limit) or an overloaded API (`error` = overloaded),
 * this hook writes ONE token-free marker file that forge-rotator-supervisor.cjs (and later the dashboard) reads:
 *   <runs>/_rotator/pending-resume.json      <runs> = forge-paths.resolveExisting(root, 'runs')
 *   { schema, ts, event, session_id, matcher, resume_after, resume_after_source, payload_fields, error_details_type }
 * `resume_after` is the reset time when one can be read from the payload (a reset field, or the reset clock time in
 * the limit message, parsed in memory only), else null. NEVER message text, never error_details content, never a
 * path, never a token: `payload_fields` holds the raw top-level field NAMES only (the payload shape is still a
 * documented-but-unobserved contract on this machine, so the names are the probe).
 *
 * PATH A ONLY: one account, no account switching. This module never reads the account vault, never reads or sets
 * any login variable, and does not require any account-rotator-*.cjs module.
 *
 * LIVE-SESSION CONTRACT: never throws, never blocks (StopFailure output and exit code are ignored by Claude Code
 * anyway), always exit 0, NEVER writes stdout, own 2 s failsafe. Acts only when ALL hold: env FORGE_ROTATOR_HOOK is
 * not off, the owner setting `rotator-auto-resume` is on (default OFF), the project has a .claude folder, no
 * forge-sync maintenance lock, the payload's `error` is rate_limit|overloaded (a missing or other value = no action).
 *
 * Shared helpers (exported for the supervisor and a future Path B): parseResetText, findResumeAfter, readMarker,
 * markerPath, rotatorDir, MATCHERS.
 */
const fs = require('fs');
const path = require('path');
const toolhook = require('./forge-toolhook.cjs');
const forgePaths = require('./forge-paths.cjs');

const FAILSAFE_MS = 2000;
const HEAD_BYTES = 65536;
const MATCHERS = Object.freeze(['rate_limit', 'overloaded']);
const ROTATOR_DIRNAME = '_rotator';
const MARKER_NAME = 'pending-resume.json';
const MARKER_SCHEMA = 'forge-rotator-marker/1';
const MAX_MARKER_BYTES = 16384;
const MAX_FIELDS = 40;
const MAX_AHEAD_MS = 8 * 24 * 3600 * 1000;   // a reset further away than 8 days is not believed
const TEXT_SCAN_CHARS = 4000;
const ABS_FIELDS = ['resets_at', 'reset_at', 'resetsAt', 'resetAt', 'resume_after', 'resumeAfter'];
const REL_FIELDS = ['retry_after', 'retryAfter', 'retry_after_seconds'];
const DAYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const SOURCES = ['payload-field', 'message-text'];

function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function offBy(name, env) { return /^(off|0|false|no)$/i.test(String((env || process.env)[name] || '')); }
function inWindow(t, now) { return Number.isFinite(t) && t > now && t <= now + MAX_AHEAD_MS ? t : null; }

// ---- reset-time parsing (pure; text is read in memory, only the derived instant ever leaves) ----------------------
function validTz(tz) { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } }
function partsIn(t, tz) {
  const o = {};
  for (const p of new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short' }).formatToParts(t)) o[p.type] = p.value;
  return { y: +o.year, mo: +o.month - 1, d: +o.day, h: +o.hour % 24, mi: +o.minute, s: +o.second, wd: DAYS[String(o.weekday).toLowerCase().slice(0, 3)] };
}
/** wallToInstant - the instant at which the wall clock in `tz` shows y-mo-d h:mi (two-pass offset fix-up). */
function wallToInstant(y, mo, d, h, mi, tz) {
  const guess = Date.UTC(y, mo, d, h, mi);
  const off = (t) => { const p = partsIn(t, tz); return Date.UTC(p.y, p.mo, p.d, p.h, p.mi, p.s) - Math.floor(t / 1000) * 1000; };
  const first = guess - off(guess);
  return guess - off(first);
}
/** nextWallTime - the first instant after `now` whose wall clock (local, or `tz`) reads h:mi (on weekday wd if given). */
function nextWallTime(now, h, mi, wd, tz) {
  for (let add = 0; add <= 8; add++) {
    let t;
    if (tz) { const p = partsIn(now, tz); const c = new Date(Date.UTC(p.y, p.mo, p.d + add)); t = wallToInstant(c.getUTCFullYear(), c.getUTCMonth(), c.getUTCDate(), h, mi, tz); } else {
      const n = new Date(now); t = new Date(n.getFullYear(), n.getMonth(), n.getDate() + add, h, mi, 0, 0).getTime();
    }
    const day = tz ? partsIn(t, tz).wd : new Date(t).getDay();
    if (t > now && (wd === null || wd === undefined || day === wd)) return t;
  }
  return null;
}
/** parseResetText(text, now) -> ms|null. Recognises "|<epoch seconds>" (older CLIs), "resets <ISO>", and the
 *  documented "resets 3:45pm" / "resets Mon 12:00am" wall-clock forms (optionally "(Area/City)"). */
function parseResetText(text, now) {
  if (typeof text !== 'string' || !text) return null;
  const s = text.slice(0, TEXT_SCAN_CHARS);
  let m = /\|\s*(\d{10})(?!\d)/.exec(s);
  if (m) return inWindow(Number(m[1]) * 1000, now);
  m = /\bresets?\b[^0-9\n]{0,12}(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2}))/i.exec(s);
  if (m) return inWindow(Date.parse(m[1]), now);
  m = /\bresets?\s+(?:at\s+)?(?:(sun|mon|tue|wed|thu|fri|sat)[a-z]*\.?,?\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([^)\n]{1,64})\))?/i.exec(s);
  if (!m) return null;
  let h = Number(m[2]);
  const mi = m[3] ? Number(m[3]) : 0;
  const ap = m[4] ? m[4].toLowerCase() : null;
  if (mi > 59) return null;
  if (ap) { if (h < 1 || h > 12) return null; h = (h % 12) + (ap === 'pm' ? 12 : 0); } else if (h > 23 || !m[3]) return null;
  const tz = m[5] && validTz(m[5].trim()) ? m[5].trim() : null;
  const wd = m[1] ? DAYS[m[1].toLowerCase().slice(0, 3)] : null;
  return inWindow(nextWallTime(now, h, mi, wd, tz), now);
}
function absInstant(v, now) {
  if (typeof v === 'number') return inWindow(v >= 1e12 ? v : v >= 1e9 ? v * 1000 : NaN, now);
  if (typeof v !== 'string') return null;
  if (/^\d{10}$/.test(v)) return inWindow(Number(v) * 1000, now);
  if (/^\d{13}$/.test(v)) return inWindow(Number(v), now);
  return /^\d{4}-\d{2}-\d{2}T/.test(v) ? inWindow(Date.parse(v), now) : null;
}
function relInstant(v, now) {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && /^\d{1,7}$/.test(v) ? Number(v) : NaN);
  return Number.isFinite(n) && n > 0 ? inWindow(now + n * 1000, now) : null;
}
function fieldInstant(o, now) {
  if (!isObj(o)) return null;
  for (const k of ABS_FIELDS) { const t = absInstant(o[k], now); if (t) return t; }
  for (const k of REL_FIELDS) { const t = relInstant(o[k], now); if (t) return t; }
  return null;
}
/** findResumeAfter(payload, now) -> {at, source}. Structured fields first, then message text. */
function findResumeAfter(payload, now) {
  const p = isObj(payload) ? payload : {};
  const f = fieldInstant(p, now) || fieldInstant(p.error_details, now);
  if (f) return { at: f, source: 'payload-field' };
  for (const v of [p.error_details, p.last_assistant_message]) {
    const t = parseResetText(typeof v === 'string' ? v : null, now);
    if (t) return { at: t, source: 'message-text' };
  }
  return { at: null, source: null };
}

// ---- marker ---------------------------------------------------------------------------------------------------
function rotatorDir(root, env) { return path.join(forgePaths.resolveExisting(root, 'runs', { env: env || process.env }), ROTATOR_DIRNAME); }
function markerPath(root, env) { return path.join(rotatorDir(root, env), MARKER_NAME); }
/** safeName - a field NAME shaped like an identifier (<= 32 chars, every _-segment <= 24 chars and with at most 2
 *  digits, so a token pasted in as a key never qualifies) that the shared secret scrubber leaves unchanged, else null. */
function safeName(n) {
  if (typeof n !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(n)) return null;
  if (n.split('_').some((seg) => seg.length > 24 || (seg.match(/\d/g) || []).length > 2)) return null;
  try { const r = toolhook.scrubRecord({ v: n }); return r && r.v === n ? n : null; } catch { return null; }
}
function fieldNames(o) { return Object.keys(isObj(o) ? o : {}).map(safeName).filter(Boolean).sort().slice(0, MAX_FIELDS); }
function buildMarker(payload, opts) {
  const now = Number.isFinite(opts && opts.now) ? opts.now : Date.now();
  const r = findResumeAfter(payload, now);
  const det = payload.error_details;
  return {
    schema: MARKER_SCHEMA,
    ts: new Date(now).toISOString(),
    event: 'StopFailure',
    session_id: toolhook.sessionBucket(payload.session_id),
    matcher: payload.error,
    resume_after: r.at ? new Date(r.at).toISOString() : null,
    resume_after_source: r.source,
    payload_fields: fieldNames(payload),
    error_details_type: det === undefined ? 'absent' : det === null ? 'null' : Array.isArray(det) ? 'array' : typeof det,
  };
}
/** writeAtomic - tmp file + rename; a rename blocked by a reader falls back to a direct write. Never throws. */
function writeAtomic(file, text) {
  const tmp = file + '.' + process.pid + '.tmp';
  try { fs.writeFileSync(tmp, text, 'utf8'); fs.renameSync(tmp, file); return true; } catch {
    try { fs.writeFileSync(file, text, 'utf8'); try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ } return true; } catch { return false; }
  }
}
/** readMarker(root, env) -> normalized marker or null (schema, matcher, ts and session validated). Never throws. */
function readMarker(root, env) {
  try {
    const f = markerPath(root, env);
    const st = fs.statSync(f);
    if (!st.isFile() || st.size > MAX_MARKER_BYTES) return null;
    const m = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (!isObj(m) || m.schema !== MARKER_SCHEMA || !MATCHERS.includes(m.matcher) || !Number.isFinite(Date.parse(m.ts))) return null;
    if (typeof m.session_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(m.session_id)) return null;
    const at = m.resume_after === null ? null : Date.parse(m.resume_after);
    return { ts: Date.parse(m.ts), session_id: m.session_id, matcher: m.matcher, resume_after: Number.isFinite(at) ? at : null, resume_after_source: SOURCES.includes(m.resume_after_source) ? m.resume_after_source : null };
  } catch { return null; }
}

/** run(raw, opts) -> {ok, wrote, path, reason, marker?}. NEVER throws. opts: root, env, now, configModule. */
function run(raw, opts) {
  opts = opts || {};
  const env = opts.env || process.env;
  try {
    if (offBy('FORGE_ROTATOR_HOOK', env)) return { ok: true, wrote: false, skipped: true, reason: 'FORGE_ROTATOR_HOOK=off', path: null };
    let payload = null;
    try { payload = JSON.parse(typeof raw === 'string' ? raw : ''); } catch { payload = null; }
    if (!isObj(payload)) return { ok: true, wrote: false, reason: 'unparseable', path: null };
    if (payload.hook_event_name !== undefined && payload.hook_event_name !== 'StopFailure') return { ok: true, wrote: false, reason: 'not-StopFailure', path: null };
    if (!MATCHERS.includes(payload.error)) return { ok: true, wrote: false, reason: 'unrecognised-error', path: null };
    const root = toolhook.resolveProjectRoot(opts);
    if (!fs.existsSync(path.join(root, '.claude'))) return { ok: true, wrote: false, reason: 'no-forge-project', path: null };
    if (toolhook.syncMaintenance(root)) return { ok: true, wrote: false, skipped: true, reason: 'maintenance mode', path: null };
    const gate = toolhook.configRead('rotator-auto-resume', false, { projectRoot: root, configModule: opts.configModule });
    if (gate.value !== true) return { ok: true, wrote: false, skipped: true, reason: 'owner config rotator-auto-resume=off', path: null };
    const dir = rotatorDir(root, env);
    const file = path.join(dir, MARKER_NAME);
    if (!path.resolve(file).startsWith(path.resolve(root) + path.sep)) return { ok: false, wrote: false, reason: 'containment-refused', path: null };
    const marker = toolhook.scrubRecord(buildMarker(payload, opts));
    fs.mkdirSync(dir, { recursive: true });
    const wrote = writeAtomic(file, JSON.stringify(marker, null, 2) + '\n');
    return { ok: wrote, wrote, reason: wrote ? null : 'write-failed', path: wrote ? file : null, marker };
  } catch (e) {
    return { ok: false, wrote: false, reason: 'error: ' + ((e && e.code) || 'unknown'), path: null };
  }
}

module.exports = {
  run, buildMarker, readMarker, markerPath, rotatorDir, parseResetText, findResumeAfter, nextWallTime, fieldNames, writeAtomic,
  MATCHERS, MARKER_SCHEMA, MARKER_NAME, ROTATOR_DIRNAME, FAILSAFE_MS, MAX_AHEAD_MS,
};

if (require.main === module) {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stderr.write('Usage: node forge-rotator-hook.cjs < <StopFailure hook JSON on stdin>\n  Claude Code runs this as a StopFailure hook (matcher rate_limit|overloaded). It writes one token-free\n  marker (_rotator/pending-resume.json) when rotator-auto-resume is on; it never blocks and always exits 0.\n');
    process.exit(0);
  }
  let finished = false;
  const finish = () => { if (finished) return; finished = true; process.exit(0); };
  const failsafe = setTimeout(finish, FAILSAFE_MS);
  if (failsafe.unref) failsafe.unref();
  const chunks = [];
  let stored = 0;
  try {
    process.stdin.on('data', (c) => { if (stored < HEAD_BYTES) { chunks.push(c); stored += c.length; } });
    process.stdin.on('error', finish);
    process.stdin.on('end', () => {
      try { run(Buffer.concat(chunks).subarray(0, HEAD_BYTES).toString('utf8')); } catch { /* never fail the turn */ }
      clearTimeout(failsafe);
      finish();
    });
    process.stdin.resume();
  } catch { finish(); }
}
