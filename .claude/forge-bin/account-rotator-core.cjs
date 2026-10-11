#!/usr/bin/env node
'use strict';
/**
 * account-rotator-core.cjs — the PURE decision logic of the account rotator.
 * No I/O, no network, no clock reads: every function takes `now` (epoch ms) as an argument so it is testable
 * and deterministic. The CLI (account-rotator.cjs), the vault (account-rotator-vault.cjs) and the handoff
 * (account-rotator-handoff.cjs) all decide through this one file.
 *
 * Vocabulary
 *  - window   one usage window as usage-guard.cjs's normalizeWindows() reports it ({id, kind, label, pct,
 *             resetsAt}). EVERY window counts — session, weekly_all AND every scoped weekly window: a scoped
 *             window at or over the threshold makes that account "full" (owner rule 2026-10-09).
 *  - reading  what we know about one account: {windows, measuredAt, source:'live'} as stored in state.json, or
 *             nothing at all (never measured).
 *  - status   'live' (measured this round, nothing reset since) · 'estimated' (last-known numbers, possibly with
 *             windows whose resetsAt has passed counted as 0 %) · 'unknown' (never measured) · 'unmeasurable'
 *             (the endpoint refused this account's token with 401/403 — typical for an inference-only setup token).
 *             A percentage is NEVER invented: unknown and unmeasurable carry maxPct null.
 */

const HYSTERESIS = 5;                 // a target must be below threshold-5 unless nothing better exists
const MAX_AUTO_SWITCHES_PER_DAY = 6;  // committed swaps per 24 h, counted per hop (AR-09)
const MAX_FAILED_PER_DAY = 6;         // failed / rolled-back attempts per 24 h before the rotator stops trying
const BACKOFF_MAX_MIN = 60;           // 2, 4, 8, 16, 32, 60 min between failed attempts
const MAX_HOPS = 3;                   // bounded onward switches inside one event
const DAY_MS = 24 * 3600 * 1000;
const FIVE_H_MS = 5 * 3600 * 1000;    // the session window — the round-robin fallback's rest period
const LIVE_FRESH_MS = 15 * 60 * 1000; // a live reading older than this is shown as estimated
const PENDING_VERIFY_MAX_MS = 2 * 3600 * 1000; // a committed-but-unverified switch may stay pending this long (AR-V07)
const CORROBORATE_MAX_AGE_MS = 6 * 3600 * 1000; // a slot reading older than this cannot vouch for a new token (AR-V01)

const toMs = (iso) => { const ms = typeof iso === 'string' && iso ? Date.parse(iso) : NaN; return Number.isFinite(ms) ? ms : NaN; };
const isNum = (n) => typeof n === 'number' && Number.isFinite(n);

/** cleanWindows(list) -> only well-formed windows, copied (never the caller's objects). */
function cleanWindows(list) {
  return (Array.isArray(list) ? list : [])
    .filter((w) => w && isNum(Number(w.pct)))
    .map((w) => ({ id: String(w.id || w.kind || 'window'), kind: String(w.kind || 'onbekend'), label: String(w.label || w.kind || 'window'),
      pct: Number(w.pct), resetsAt: typeof w.resetsAt === 'string' && w.resetsAt ? w.resetsAt : null }));
}
/** crossed(windows, threshold) -> the windows at/over the threshold — ANY kind, scoped windows included. */
function crossed(windows, threshold) {
  if (!isNum(threshold)) return [];
  return cleanWindows(windows).filter((w) => w.pct >= threshold);
}
/** maxPct(windows) -> the highest pct, or null when there is no window at all. */
function maxPct(windows) {
  const ws = cleanWindows(windows);
  return ws.length ? Math.max(...ws.map((w) => w.pct)) : null;
}
/** soonestReset(windows, now) -> the earliest FUTURE resetsAt (ISO) among the given windows, or null. */
function soonestReset(windows, now) {
  let best = NaN;
  for (const w of cleanWindows(windows)) {
    const ms = toMs(w.resetsAt);
    if (Number.isFinite(ms) && ms > now && (!Number.isFinite(best) || ms < best)) best = ms;
  }
  return Number.isFinite(best) ? new Date(best).toISOString() : null;
}

/** effectiveReading(rec, now) -> {status, windows, maxPct, measuredAt, adjusted, unmeasurable}.
 *  rec = state.readings[name] or undefined. A window whose official resetsAt has passed counts as 0 %
 *  (estimated) — that is the endpoint's own reset contract, not a guess. */
function effectiveReading(rec, now) {
  const r = rec && typeof rec === 'object' ? rec : {};
  const unmeasurable = r.unmeasurable && typeof r.unmeasurable === 'object' ? r.unmeasurable : null;
  const ws = cleanWindows(r.windows);
  const measuredMs = toMs(r.measuredAt);
  if (!ws.length || !Number.isFinite(measuredMs)) {
    return { status: unmeasurable ? 'unmeasurable' : 'unknown', windows: [], maxPct: null, measuredAt: null, adjusted: false, unmeasurable };
  }
  let adjusted = false;
  const windows = ws.map((w) => {
    const ms = toMs(w.resetsAt);
    if (Number.isFinite(ms) && ms <= now) { adjusted = true; return Object.assign({}, w, { pct: 0, resetPassed: true }); }
    return w;
  });
  const live = r.source === 'live' && !adjusted && now - measuredMs <= LIVE_FRESH_MS;
  return { status: live ? 'live' : 'estimated', windows, maxPct: maxPct(windows), measuredAt: r.measuredAt, adjusted, unmeasurable };
}

/** judge(reading, threshold) -> {usable: true|false|null, maxPct, crossed}. null = we do not know (unknown /
 *  unmeasurable) — never treated as "fine" and never as "full". */
function judge(reading, threshold) {
  if (!reading || reading.maxPct === null || reading.maxPct === undefined) return { usable: null, maxPct: null, crossed: [] };
  const c = crossed(reading.windows, threshold);
  return { usable: c.length === 0, maxPct: reading.maxPct, crossed: c };
}

/** hasReset(lastLeft, reading, now, threshold) -> may we go back to the account we just left? Only once the
 *  window that made us leave has reset (its recorded resetsAt passed), or a live measurement taken AFTER we
 *  left shows it clearly below the threshold. */
function hasReset(lastLeft, reading, now, threshold) {
  if (!lastLeft) return true;
  const resetMs = toMs(lastLeft.resetsAt);
  if (Number.isFinite(resetMs) && now >= resetMs) return true;
  const leftMs = toMs(lastLeft.at);
  const measuredMs = reading ? toMs(reading.measuredAt) : NaN;
  return !!(reading && reading.status === 'live' && Number.isFinite(leftMs) && Number.isFinite(measuredMs)
    && measuredMs > leftMs && isNum(reading.maxPct) && reading.maxPct < threshold - HYSTERESIS);
}

/** swapTimes(swaps) -> epoch ms of every COMMITTED swap, newest first. `swaps` is state.swaps: one durable entry
 *  per committed swap, written per hop the moment it commits (AR-09) — never one entry per handoff. */
function swapTimes(swaps) {
  return (Array.isArray(swaps) ? swaps : []).map((s) => toMs(s && s.at)).filter(Number.isFinite).sort((a, b) => b - a);
}
/** allowanceLeft(swaps, now, cap) -> how many more swaps the 24 h budget allows (never below 0). */
function allowanceLeft(swaps, now, cap) {
  const c = isNum(cap) ? cap : MAX_AUTO_SWITCHES_PER_DAY;
  return Math.max(0, c - swapTimes(swaps).filter((t) => now - t < DAY_MS).length);
}
/** antiFlap({swaps, now, cooldownMin, maxPerDay}) -> {ok, reason, nextAt, left}. Every committed swap counts
 *  (auto, manual, hops, rollbacks): the cooldown runs from the last one, the cap is per 24 h. */
function antiFlap(o) {
  const now = o.now;
  const cooldownMs = Math.max(0, Number(o.cooldownMin) || 0) * 60000;
  const cap = isNum(o.maxPerDay) ? o.maxPerDay : MAX_AUTO_SWITCHES_PER_DAY;
  const times = swapTimes(o.swaps);
  if (times.length && now - times[0] < cooldownMs) {
    return { ok: false, reason: 'cooldown', nextAt: new Date(times[0] + cooldownMs).toISOString(), left: allowanceLeft(o.swaps, now, cap) };
  }
  const lastDay = times.filter((t) => now - t < DAY_MS);
  if (lastDay.length >= cap) {
    return { ok: false, reason: 'max-per-day', nextAt: new Date(lastDay[lastDay.length - 1] + DAY_MS).toISOString(), left: 0 };
  }
  return { ok: true, reason: null, nextAt: null, left: cap - lastDay.length };
}
/** failureGate({failures, consecutive, now}) -> {ok, reason, nextAt}. Failed or rolled-back attempts back off
 *  exponentially (2, 4, 8 ... max 60 min after the last one) and stop entirely after MAX_FAILED_PER_DAY in 24 h. */
function failureGate(o) {
  const now = o.now;
  const times = (Array.isArray(o.failures) ? o.failures : []).map((f) => toMs(f && f.at)).filter(Number.isFinite).sort((a, b) => b - a);
  const day = times.filter((t) => now - t < DAY_MS);
  if (day.length >= MAX_FAILED_PER_DAY) return { ok: false, reason: 'fail-cap', nextAt: new Date(day[day.length - 1] + DAY_MS).toISOString() };
  const n = Math.max(0, Number(o.consecutive) || 0);
  if (n > 0 && times.length) {
    const waitMs = Math.min(Math.pow(2, n), BACKOFF_MAX_MIN) * 60000;
    if (now - times[0] < waitMs) return { ok: false, reason: 'backoff', nextAt: new Date(times[0] + waitMs).toISOString() };
  }
  return { ok: true, reason: null, nextAt: null };
}
/** classifyLive(live, from, to, slots, proof) -> {creds, profile, pair}. Which login the two live files hold (AR-V01).
 *  creds   'from' | 'to' — the login file's refresh token is EXACTLY the one that slot stores, or it carries the
 *          token-free fingerprint the transaction recorded for that side (proof = {from, to, fpOf(token)}: the
 *          fingerprint is an HMAC with a per-vault salt, so txn.json never holds a token and a token alone cannot
 *          forge it) · 'other' — the token of a third slot · 'unknown' — a token no slot and no transaction knows.
 *  profile 'from' | 'to' | 'other' | 'none' by accountUuid.
 *  pair    'from' | 'to' (both files agree) · 'split-creds-to' | 'split-creds-from' (the deterministic half-done
 *          states of a swap: every byte is accounted for) · 'unknown' (an unknown refresh token: ownership is NOT
 *          established — never replaced, never captured on the profile uuid alone) · 'foreign' (a third account) ·
 *          'none' (unreadable). Pure, in-memory. */
function classifyLive(live, from, to, slots, proof) {
  const uuid = live && live.profile && live.profile.oauthAccount && live.profile.oauthAccount.accountUuid;
  const rt = live && live.creds && live.creds.claudeAiOauth && live.creds.claudeAiOauth.refreshToken;
  if (typeof uuid !== 'string' || !uuid || typeof rt !== 'string' || !rt) return { creds: 'none', profile: 'none', pair: 'none' };
  const rtOf = (s) => s && !s.broken && s.credentials && s.credentials.claudeAiOauth && s.credentials.claudeAiOauth.refreshToken;
  const uuidOf = (s) => s && !s.broken && s.oauthAccount && s.oauthAccount.accountUuid;
  const fp = proof && typeof proof.fpOf === 'function' ? proof.fpOf(rt) : null;
  let creds = 'unknown';
  if (rtOf(from) === rt || (fp && proof.from && fp === proof.from)) creds = 'from';
  else if (rtOf(to) === rt || (fp && proof.to && fp === proof.to)) creds = 'to';
  else if ((Array.isArray(slots) ? slots : []).some((s) => rtOf(s) === rt)) creds = 'other';
  const profile = uuidOf(from) === uuid ? 'from' : uuidOf(to) === uuid ? 'to' : 'other';
  let pair;
  if (creds === 'unknown') pair = 'unknown';
  else if (creds === 'other' || profile === 'other') pair = 'foreign';
  else if (creds === profile) pair = creds;
  else pair = creds === 'to' ? 'split-creds-to' : 'split-creds-from';
  return { creds, profile, pair };
}
/** classifyPair(live, from, to, slots, proof) -> the `pair` string of classifyLive (see there). */
function classifyPair(live, from, to, slots, proof) { return classifyLive(live, from, to, slots, proof).pair; }
/** sameAccountReading(a, b, o) -> true | false | null (AR-V09 / AR-V01). Two usage readings belong to the same
 *  account only when at least TWO windows match: same id, a NON-NULL reset time on both sides that still lies in
 *  the future (o.now; an expired window is not comparable), reset times equal within o.resetTolMs (default 1 s)
 *  and percentages within o.pctTol (default 2 points). A window whose reset times differ -> false (reset times are
 *  per-account facts). Null reset times never compare equal; fewer than two matching windows -> null (nothing is
 *  concluded — the caller treats null as "unverified", never as "same"). A heuristic, documented as such. */
function sameAccountReading(a, b, o) {
  const opts = o || {};
  const now = isNum(opts.now) ? opts.now : -Infinity;
  const pctTol = isNum(opts.pctTol) ? opts.pctTol : 2;
  const resetTol = isNum(opts.resetTolMs) ? opts.resetTolMs : 1000;
  const wa = cleanWindows(a && a.windows); const wb = cleanWindows(b && b.windows);
  let matched = 0;
  for (const x of wa) {
    const y = wb.find((w) => w.id === x.id);
    if (!y) continue;
    const rx = toMs(x.resetsAt); const ry = toMs(y.resetsAt);
    if (!Number.isFinite(rx) || !Number.isFinite(ry) || rx <= now || ry <= now) continue; // null / expired: not comparable
    if (Math.abs(rx - ry) > resetTol) return false;
    if (Math.abs(x.pct - y.pct) <= pctTol) matched++;
  }
  return matched >= 2 ? true : null;
}

const TIER_RANK = { clear: 0, near: 1, unknown: 2 };
const STATUS_RANK = { live: 0, estimated: 1, unknown: 2, unmeasurable: 3 };
/** selectTarget(o) -> {target, tier, reason, ranked, soonestResetAt}.
 *  o.accounts = [{name, eligible, reading}] (reading = effectiveReading()), o.activeName, o.threshold, o.now,
 *  o.lastLeft, o.exclude (Set of names already tried this event). Tiers: 'clear' (< threshold-5), 'near'
 *  (< threshold, only when no clear one exists), 'unknown' (never measured / unmeasurable — last resort, the
 *  caller MUST confirm it live after switching). Never picks the active account or the one we just left
 *  before it has reset. */
function selectTarget(o) {
  const threshold = o.threshold;
  const exclude = o.exclude instanceof Set ? o.exclude : new Set();
  const ranked = [];
  const skipped = [];
  for (const a of Array.isArray(o.accounts) ? o.accounts : []) {
    if (!a || a.name === o.activeName || exclude.has(a.name)) continue;
    if (!a.eligible) { skipped.push({ name: a.name, why: 'not-eligible' }); continue; }
    const rd = a.reading || { status: 'unknown', maxPct: null, windows: [] };
    if (o.lastLeft && o.lastLeft.name === a.name && !hasReset(o.lastLeft, rd, o.now, threshold)) { skipped.push({ name: a.name, why: 'just-left' }); continue; }
    const j = judge(rd, threshold);
    if (j.usable === false) { skipped.push({ name: a.name, why: 'full', maxPct: j.maxPct }); continue; }
    const tier = j.usable === null ? 'unknown' : (j.maxPct < threshold - HYSTERESIS ? 'clear' : 'near');
    ranked.push({ name: a.name, tier, status: rd.status, maxPct: j.maxPct });
  }
  const statusRank = (s) => (Object.prototype.hasOwnProperty.call(STATUS_RANK, s) ? STATUS_RANK[s] : 9); // live is 0 — never `|| 9`
  ranked.sort((x, y) => (TIER_RANK[x.tier] - TIER_RANK[y.tier])
    || (statusRank(x.status) - statusRank(y.status))
    || ((isNum(x.maxPct) ? x.maxPct : 101) - (isNum(y.maxPct) ? y.maxPct : 101))
    || (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
  const all = [];
  for (const a of Array.isArray(o.accounts) ? o.accounts : []) if (a && a.reading) all.push(...crossed(a.reading.windows, threshold));
  const soonestResetAt = soonestReset(all, o.now);
  if (!ranked.length) return { target: null, tier: null, reason: 'no-usable-account', ranked, skipped, soonestResetAt };
  const top = ranked[0];
  return { target: top.name, tier: top.tier, reason: top.tier === 'unknown' ? 'last-resort-unmeasured' : 'best-available', ranked, skipped, soonestResetAt };
}

/** roundRobin(accounts, now) -> {name, why} for accounts whose usage cannot be measured at all (launch mode's
 *  final fallback). Conservative: an account not used in the last 5 h (its session window has certainly reset)
 *  wins over one used more recently; among equals, the least recently used. Never returns a percentage. */
function roundRobin(accounts, now) {
  const list = (Array.isArray(accounts) ? accounts : []).filter((a) => a && a.name);
  if (!list.length) return null;
  const scored = list.map((a) => {
    const used = toMs(a.lastUsedAt);
    return { name: a.name, used: Number.isFinite(used) ? used : -Infinity, rested: !Number.isFinite(used) || now - used >= FIVE_H_MS };
  });
  scored.sort((x, y) => (x.rested === y.rested ? 0 : x.rested ? -1 : 1) || (x.used - y.used) || (x.name < y.name ? -1 : 1));
  const pick = scored[0];
  return { name: pick.name, why: pick.rested ? 'round-robin: not used in the last 5 h' : 'round-robin: every account was used in the last 5 h — least recently used (conservative)' };
}

/** maskEmail(email) -> "o***@g***.com" — enough to recognise, never the full address. */
function maskEmail(email) {
  if (typeof email !== 'string' || !email.includes('@')) return '(onbekend / unknown)';
  const [local, domain] = email.split('@');
  const dot = domain.lastIndexOf('.');
  const tld = dot > 0 ? domain.slice(dot) : '';
  return (local[0] || '?') + '***@' + (domain[0] || '?') + '***' + tld;
}
/** slotMode(slot) -> 'credentials' | 'token' | 'both' | 'empty'. */
function slotMode(slot) {
  const c = !!(slot && slot.credentials && slot.credentials.claudeAiOauth);
  const t = !!(slot && typeof slot.token === 'string' && slot.token);
  return c && t ? 'both' : c ? 'credentials' : t ? 'token' : 'empty';
}
/** fmtPct(n) -> "87%" or "?" (never a fabricated number). */
function fmtPct(n) { return isNum(n) ? Math.round(n * 10) / 10 + '%' : '?'; }

module.exports = {
  HYSTERESIS, MAX_AUTO_SWITCHES_PER_DAY, MAX_FAILED_PER_DAY, BACKOFF_MAX_MIN, MAX_HOPS, DAY_MS, FIVE_H_MS, LIVE_FRESH_MS,
  PENDING_VERIFY_MAX_MS, CORROBORATE_MAX_AGE_MS,
  cleanWindows, crossed, maxPct, soonestReset, effectiveReading, judge, hasReset, antiFlap, allowanceLeft, swapTimes, failureGate,
  classifyLive, classifyPair, sameAccountReading, selectTarget, roundRobin, maskEmail, slotMode, fmtPct,
};
