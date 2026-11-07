#!/usr/bin/env node
'use strict';
/**
 * forge-usage-source.cjs — WHICH usage reading the lane budget may trust (SA-P1-USAGE, PHASE2-PLAN A1).
 * Sibling of forge-lane-budget.cjs (it is required from there; synced next to it in ~/.claude/forge-bin). Zero
 * dependencies, read-only, never touches a login file, never calls the network, never throws.
 *
 * 1. PRESSURE FALLBACK. FORGE_USAGE_GUARD_STATE.json is only rewritten by the watcher; a failed check (HTTP 429) left it
 *    22 days old while `usage-guard status` kept writing a fresh FORGE_USAGE_PRESSURE.json {week, updated_at}. That file
 *    has a week % only, so the 5-hour side stays unknown — never invented. preferNewest() uses it only when the state
 *    reading is not trusted (stale or failed) and the pressure reading is newer.
 * 2. ROTATOR ACCOUNT. `account-rotator launch` starts a session on another account's setup token; the guard measures the
 *    DEFAULT login (another account). The rotator's token-free state (<home>/forge-accounts/state.json, written by
 *    account-rotator-token.cjs) records per account `tokenReadings[name] = {lastUsedAt, measuredAt, source, windows,
 *    unmeasurable}`. WHICH ACCOUNT comes from the session's own env (the hook inherits it), never from timestamps alone:
 *    a. env FORGE_ROTATOR_ACCOUNT=<name> (the launcher's non-secret marker) -> that account, via 'marker';
 *    b. no marker but CLAUDE_CODE_OAUTH_TOKEN PRESENT (checked with `in`; the value is never read) = an older launch ->
 *       the most recently launched, not org-blocked account of the last 7 days, LABELLED as a guess ('token-guess');
 *       none found -> account 'onbekend/unknown' with unknown usage (the default login is another account);
 *    c. neither -> null: the default-login reading applies (a plain `claude` session is never credited to a launch).
 *    Opt-out: env FORGE_LANE_BUDGET_ROTATOR=off.
 *    Only that account's OWN token reading is used: live, at most maxAgeMin old, not unmeasurable; a window whose reset
 *    time has passed is unknown. Session % = the 'session' window, week % = 'weekly_all' (else the highest weekly window).
 *
 * API readPressure({file}) · preferNewest(stateU, pressureU, now, maxAgeMin) · rotatorAccount({file, now, maxAgeMin,
 *     env}) · withPressure · rotatorFor · pressureFileFor(stateFile, env) · rotatorFileFor(stateFile, env) · LAUNCH_MAX_MS
 *     · MARKER_ENV
 */
const fs = require('fs');
const path = require('path');

const LAUNCH_MAX_MS = 7 * 24 * 60 * 60 * 1000;
const MARKER_ENV = 'FORGE_ROTATOR_ACCOUNT';
const TOKEN_ENV = 'CLAUDE_CODE_OAUTH_TOKEN';
const UNKNOWN_NAME = 'onbekend/unknown';
const NAME_RE = /^[A-Za-z0-9._-]{1,40}$/;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const pct = (v) => (isNum(v) && v >= 0 ? Math.min(v, 100) : null);
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch (_e) { return null; } };
const side = (p) => ({ pct: p, resetsAt: null });

function pressureFileFor(stateFile, env) {
  const e = env || process.env;
  return e.FORGE_USAGE_PRESSURE_FILE || path.join(path.dirname(stateFile), 'FORGE_USAGE_PRESSURE.json');
}
function rotatorFileFor(stateFile, env) {
  const e = env || process.env;
  return path.join(e.FORGE_ACCOUNT_ROTATOR_HOME ? path.resolve(e.FORGE_ACCOUNT_ROTATOR_HOME) : path.dirname(stateFile), 'forge-accounts', 'state.json');
}

/** readPressure({file}) -> {session, week, checkAt, source:'pressure'} or null (missing, damaged, no week %). */
function readPressure(opts) {
  const j = readJson((opts || {}).file);
  if (!isObj(j)) return null;
  const w = pct(j.week);
  const at = Date.parse(j.updated_at);
  if (w === null || !Number.isFinite(at)) return null;
  return { session: side(null), week: side(w), checkAt: at, source: 'pressure' };
}

/** preferNewest(stateU, p, now, maxAgeMin) -> stateU when it is trusted or p is absent/older; else a readUsage-shaped
 *  reading from the pressure file (its own age decides staleness). */
function preferNewest(stateU, p, now, maxAgeMin) {
  if (!p) return stateU;
  if (stateU && !stateU.stale) return stateU;
  const stateAt = stateU && !stateU.lastCheckFailed && isNum(stateU.checkAt) ? stateU.checkAt : -Infinity;
  if (p.checkAt <= stateAt) return stateU;
  const ageMin = Math.max(0, (now - p.checkAt) / 60000);
  const notes = ((stateU && stateU.notes) || []).concat(['week % from FORGE_USAGE_PRESSURE.json (the guard state is older or its last check failed); 5-hour % unknown']);
  return { session: p.session, week: p.week, source: 'pressure', ageMin, checkAt: p.checkAt, stale: ageMin > maxAgeMin, lastCheckFailed: false, notes };
}

function windowPct(windows, now, notes) {
  const ok = (Array.isArray(windows) ? windows : []).filter((w) => isObj(w) && pct(Number(w.pct)) !== null);
  const live = (w) => {
    const r = Date.parse(w.resetsAt);
    if (Number.isFinite(r) && r <= now) { notes.push(String(w.kind) + ' reset time has passed: that % is no longer true (unknown)'); return null; }
    return pct(Number(w.pct));
  };
  const maxOf = (list) => { const v = list.map(live); return v.includes(null) || !v.length ? null : Math.max(...v); };
  const kind = (w) => String(w.kind || '');
  const all = ok.filter((w) => kind(w) === 'weekly_all');
  const week = all.length ? maxOf(all) : maxOf(ok.filter((w) => /^weekly/.test(kind(w))));
  return { session: maxOf(ok.filter((w) => kind(w) === 'session')), week };
}

/** usageOf(r, now, maxAgeMin) -> a readUsage-shaped reading of one token reading (missing r = unknown). */
function usageOf(r, now, maxAgeMin) {
  const t = isObj(r) ? r : {};
  const notes = isObj(r) ? [] : ['no rotator reading for this account'];
  const measuredAt = Date.parse(t.measuredAt);
  const checkAt = Number.isFinite(measuredAt) ? measuredAt : null;
  const ageMin = checkAt !== null ? Math.max(0, (now - checkAt) / 60000) : null;
  const p = windowPct(t.windows, now, notes);
  if (isObj(t.unmeasurable)) notes.push('the rotator could not measure this account\'s token');
  const noData = p.session === null && p.week === null;
  const stale = noData || t.source !== 'live' || isObj(t.unmeasurable) || ageMin === null || ageMin > maxAgeMin;
  return { session: side(p.session), week: side(p.week), source: 'rotator', ageMin, checkAt, stale, lastCheckFailed: false, notes };
}

/** newestLaunch(st, now) -> {name, at} of the most recent, not org-blocked launch within LAUNCH_MAX_MS, or null. */
function newestLaunch(st, now) {
  if (!isObj(st) || !isObj(st.tokenReadings)) return null;
  const flags = isObj(st.slotFlags) ? st.slotFlags : {};
  return Object.keys(st.tokenReadings)
    .filter((n) => NAME_RE.test(n) && isObj(st.tokenReadings[n]) && !(isObj(flags[n]) && isObj(flags[n].orgBlocked)))
    .map((n) => ({ name: n, at: Date.parse(st.tokenReadings[n].lastUsedAt) }))
    .filter((x) => Number.isFinite(x.at) && x.at <= now + 60000 && now - x.at <= LAUNCH_MAX_MS)
    .sort((x, y) => y.at - x.at)[0] || null;
}

/** rotatorAccount({file, now, maxAgeMin, env}) -> null (not a rotator session) or {name, via, guess, launchedAt, usage}. */
function rotatorAccount(opts) {
  const o = opts || {};
  const env = o.env || process.env;
  if (String(env.FORGE_LANE_BUDGET_ROTATOR || '').trim().toLowerCase() === 'off') return null;
  const now = isNum(o.now) ? o.now : Date.now();
  const maxAgeMin = isNum(o.maxAgeMin) ? o.maxAgeMin : 30;
  const marker = String(env[MARKER_ENV] || '').trim();
  const hasToken = TOKEN_ENV in env; // presence only — the token value is never read
  if (!NAME_RE.test(marker) && !hasToken) return null;
  const st = readJson(o.file);
  const readings = isObj(st) && isObj(st.tokenReadings) ? st.tokenReadings : {};
  if (NAME_RE.test(marker)) {
    const at = isObj(readings[marker]) ? Date.parse(readings[marker].lastUsedAt) : NaN;
    return { name: marker, via: 'marker', guess: false, launchedAt: Number.isFinite(at) ? at : null, usage: usageOf(readings[marker], now, maxAgeMin) };
  }
  const launched = newestLaunch(st, now);
  if (!launched) return { name: UNKNOWN_NAME, via: 'token-unknown', guess: false, launchedAt: null, usage: usageOf(null, now, maxAgeMin) };
  const usage = usageOf(readings[launched.name], now, maxAgeMin);
  usage.notes.push('no ' + MARKER_ENV + ' marker in this session: the account is a guess from the newest launch');
  return { name: launched.name, via: 'token-guess', guess: true, launchedAt: launched.at, usage };
}

/** withPressure(u, o, stateFile, now, maxAgeMin) — readUsage's tail: u, or a newer pressure reading (o.pressureFile, o.env). */
function withPressure(u, o, stateFile, now, maxAgeMin) {
  return preferNewest(u, readPressure({ file: o.pressureFile || pressureFileFor(stateFile, o.env) }), now, maxAgeMin);
}
/** rotatorFor(o, stateFile, now, maxAgeMin) — budgetLine's account lookup (o.rotatorFile, o.env). */
function rotatorFor(o, stateFile, now, maxAgeMin) {
  return rotatorAccount({ file: o.rotatorFile || rotatorFileFor(stateFile, o.env), now, maxAgeMin, env: o.env });
}

module.exports = { readPressure, preferNewest, rotatorAccount, withPressure, rotatorFor, pressureFileFor, rotatorFileFor, LAUNCH_MAX_MS, MARKER_ENV };
