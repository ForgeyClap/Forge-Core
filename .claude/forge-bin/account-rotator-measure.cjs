#!/usr/bin/env node
'use strict';
/**
 * account-rotator-measure.cjs — settings resolution and usage measurement for the account rotator
 *. Split out of account-rotator.cjs for size; no other behaviour.
 *
 * SETTINGS: flag > /forge config (account-rotator, account-rotator.threshold, account-rotator.cooldown-min,
 * account-rotator.interval, account-rotator.mode) > default — same resolution and bounds discipline as usage-guard's
 * resolveGuardSettings. An unreadable config is never a silent "on" (start/watch treat it as off). MODE (owner
 * direction 2026-10-09): 'token' (default) — the watcher measures and RECOMMENDS; a new session is started with
 * `launch --auto`; the Claude login files are never written. 'file' (experimental, explicit opt-in) — the watcher swaps
 * the login files of running sessions itself (account-rotator-txn.cjs); a Codex review showed that swap cannot be made
 * race-free against Claude Code's own token refresher, so it is best-effort, detected and repaired.
 * MEASUREMENT: the official endpoint usage-guard uses; the token stays in memory; a failure is never "fine" and never
 * "full". Inactive accounts are never refreshed — their stored access token is used only while it is still valid.
 * FORGE_ACCOUNT_ROTATOR_DENY_NETWORK=1 is a deny-by-default fetch seam for spawned test processes.
 */
const fs = require('fs');
const path = require('path');
const core = require('./account-rotator-core.cjs');
const vault = require('./account-rotator-vault.cjs');
const guardRedact = require('./usage-guard-redact.cjs');

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const FETCH_TIMEOUT_MS = 30000;
const INACTIVE_REFRESH_MS = 10 * 60 * 1000;
const DEFAULTS = { threshold: 92, 'cooldown-min': 10, interval: 120 };
const BOUNDS_FALLBACK = { threshold: { min: 50, max: 99 }, 'cooldown-min': { min: 1, max: 240 }, interval: { min: 30, max: 900 } };
const ENUMS = { mode: { allowed: ['token', 'file'], default: 'token' } };
const SWITCH_KEY = 'account-rotator';
const SCHEMA_PATH = path.join(__dirname, '..', 'config', 'orchestration', 'FORGE_CONFIG_SCHEMA.json');
const SRC = { flag: 'vlag', config: 'instelling', dflt: 'standaard' };
const DISCLOSURE_FALLBACK = {
  nl: 'account-rotator leest je Claude-login-bestanden (~/.claude/.credentials.json en de oauthAccount-sleutel in ~/.claude.json) en schrijft ze ALLEEN in de experimentele bestandsmodus (account-rotator.mode = file; standaard is de token-modus, die alleen meet en aanbeveelt en waarbij je een nieuwe sessie start met `launch --auto`); bewaart een kopie van elke ingeschreven login en eventuele setup-token in ~/.claude/forge-accounts op deze computer; stuurt tokens alleen naar api.anthropic.com om het gebruik te meten; pauzeert en hervat in de bestandsmodus tijdens een wissel je Paperclip-agents en blokkeert dan tool-aanroepen in lopende sessies (hooguit 5 minuten); draait als achtergrondproces op deze computer, ook na het sluiten van de sessie. `env` laadt een setup-token in je hele shell; `launch` geeft het aan de nieuwe sessie en al haar subprocessen.',
  en: 'account-rotator reads your Claude login files (~/.claude/.credentials.json and the oauthAccount key in ~/.claude.json) and writes them ONLY in the experimental file mode (account-rotator.mode = file; the default token mode only measures and recommends, and you start a new session with `launch --auto`); keeps a vault copy of each enrolled login and any setup token under ~/.claude/forge-accounts on this machine; sends tokens only to api.anthropic.com to measure usage; in file mode pauses and resumes your Paperclip agents during a switch and then blocks tool calls in running sessions (at most 5 minutes); runs as a background process on this machine, also after the session closes. `env` loads a setup token into your whole shell; `launch` hands it to the new session and all of its child processes.',
};

function flagValue(list, name) { const i = list.indexOf('--' + name); return i >= 0 && list[i + 1] !== undefined ? list[i + 1] : undefined; }
function bounds(schemaPath) {
  let schema = null;
  try { let raw = fs.readFileSync(schemaPath || SCHEMA_PATH, 'utf8'); if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1); schema = JSON.parse(raw); } catch { schema = null; }
  const out = {};
  for (const k of Object.keys(DEFAULTS)) {
    const s = schema && schema.settings && schema.settings[SWITCH_KEY + '.' + k];
    out[k] = s && Number.isFinite(s.min) && Number.isFinite(s.max) ? { min: s.min, max: s.max } : BOUNDS_FALLBACK[k];
  }
  return out;
}
/** resolveSettings(argvList, cfg, opts) -> {threshold, 'cooldown-min', interval, enabled, warnings}. Pure. */
function resolveSettings(argvList, cfg, opts) {
  const list = Array.isArray(argvList) ? argvList : [];
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  const b = (opts && opts.bounds) || bounds(opts && opts.schemaPath);
  const out = { warnings: [] };
  for (const k of Object.keys(DEFAULTS)) {
    const ok = (n) => Number.isInteger(n) && n >= b[k].min && n <= b[k].max;
    const range = ' (' + b[k].min + '-' + b[k].max + ')';
    const raw = flagValue(list, k);
    if (raw !== undefined) {
      const n = String(raw).trim() === '' ? NaN : Number(raw);
      if (ok(n)) { out[k] = { value: n, source: SRC.flag }; continue; }
      out.warnings.push('--' + k + ' ' + raw + ' is ongeldig' + range + ' en wordt genegeerd / is invalid' + range + ' and is ignored');
    }
    const e = c[SWITCH_KEY + '.' + k];
    const v = e && typeof e === 'object' ? e.value : e;
    if (typeof v === 'number') {
      if (ok(v)) { out[k] = { value: v, source: e && e.source === 'default' ? SRC.dflt : SRC.config }; continue; }
      out.warnings.push('instelling ' + SWITCH_KEY + '.' + k + '=' + v + ' is ongeldig' + range + ' — standaard gebruikt / setting is invalid — using the default');
    }
    out[k] = { value: DEFAULTS[k], source: SRC.dflt };
  }
  for (const k of Object.keys(ENUMS)) {
    const allowed = ENUMS[k].allowed;
    const raw = flagValue(list, k);
    if (raw !== undefined) {
      const v = String(raw).trim().toLowerCase();
      if (allowed.includes(v)) { out[k] = { value: v, source: SRC.flag }; continue; }
      out.warnings.push('--' + k + ' ' + raw + ' is ongeldig (' + allowed.join('|') + ') en wordt genegeerd / is invalid and is ignored');
    }
    const e = c[SWITCH_KEY + '.' + k];
    const v = e && typeof e === 'object' ? e.value : e;
    if (typeof v === 'string' && allowed.includes(v)) { out[k] = { value: v, source: e && e.source === 'default' ? SRC.dflt : SRC.config }; continue; }
    if (v !== undefined) out.warnings.push('instelling ' + SWITCH_KEY + '.' + k + '=' + v + ' is ongeldig (' + allowed.join('|') + ') — standaard gebruikt / setting is invalid — using the default');
    out[k] = { value: ENUMS[k].default, source: SRC.dflt };
  }
  const sw = c[SWITCH_KEY];
  const swv = sw && typeof sw === 'object' ? sw.value : sw;
  out.enabled = typeof swv === 'boolean' ? { value: swv, source: sw && sw.source === 'default' ? SRC.dflt : SRC.config } : { value: true, source: SRC.dflt };
  return out;
}
/** loadConfig(opts) -> {cfg, disclosure, unreadable, note}. Never throws. */
function loadConfig(opts) {
  const o = opts || {};
  let mod = o.configModule;
  if (mod === undefined) { try { mod = require('./forge-config.cjs'); } catch { mod = null; } }
  const keys = [SWITCH_KEY, ...Object.keys(DEFAULTS).concat(Object.keys(ENUMS)).map((k) => SWITCH_KEY + '.' + k)];
  if (mod) {
    try {
      const r = mod.resolve(o.configOpts || {});
      const cfg = {};
      for (const k of keys) if (r.settings[k]) cfg[k] = { value: r.settings[k].value, source: r.settings[k].source };
      const spec = mod.SCHEMA.settings[SWITCH_KEY];
      return { cfg, disclosure: spec && spec.disclosure ? spec.disclosure : null, unreadable: !r.settings[SWITCH_KEY], note: r.settings[SWITCH_KEY] ? null : 'account-rotator ontbreekt in het instellingenschema / missing from the settings schema' };
    } catch (e) {
      return { cfg: {}, disclosure: null, unreadable: true, note: 'instellingen onleesbaar (' + String((e && e.message) || e).split('\n')[0] + ') — veilige standaard: uit / settings unreadable — safe default: off' };
    }
  }
  return { cfg: {}, disclosure: null, unreadable: true, note: 'forge-config.cjs ontbreekt — veilige standaard: uit / forge-config.cjs is missing — safe default: off' };
}
function settingsLine(S) {
  return 'modus/mode ' + S.mode.value + (S.mode.value === 'file' ? ' (experimenteel/experimental)' : '') + ' (bron: ' + S.mode.source + ') · drempel/threshold ' + S.threshold.value + '% (bron: ' + S.threshold.source
    + ') · cooldown ' + S['cooldown-min'].value + ' min (bron: ' + S['cooldown-min'].source + ') · interval ' + S.interval.value + 's (bron: ' + S.interval.source
    + ') · account-rotator ' + (S.enabled.value ? 'aan/on' : 'uit/off') + ' (bron: ' + S.enabled.source + ')';
}

function fetchImpl(deps) {
  if (deps && deps.fetch) return deps.fetch;
  if (process.env.FORGE_ACCOUNT_ROTATOR_DENY_NETWORK === '1') {
    return async () => { const e = new Error('network denied by the FORGE_ACCOUNT_ROTATOR_DENY_NETWORK test seam'); e.name = 'FetchDeniedByTestSeamError'; throw e; };
  }
  return globalThis.fetch;
}
let _normalize = null;
function normalizeWindows(j) { if (!_normalize) _normalize = require('./usage-guard.cjs').normalizeWindows; return _normalize(j); }
/** measureToken(token, deps) -> {ok:true, windows, maxPct} | {ok:false, kind, status?, error}. kind 'unauthorized' (401/403). */
async function measureToken(token, deps) {
  if (!guardRedact.validateTokenShape(token)) return { ok: false, kind: 'bad-token', error: 'token has an unexpected shape (rejected before use)' };
  vault.registerSecret(token);
  const f = fetchImpl(deps);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), (deps && deps.timeoutMs) || FETCH_TIMEOUT_MS);
  try {
    let r;
    try {
      r = await f(USAGE_URL, { headers: { authorization: 'Bearer ' + token, 'anthropic-beta': 'oauth-2025-04-20', 'content-type': 'application/json' }, signal: ac.signal });
    } catch (e) {
      return { ok: false, kind: ac.signal.aborted ? 'timeout' : 'transport', error: ac.signal.aborted ? 'usage endpoint timed out (no action)' : 'usage endpoint request failed (' + guardRedact.transportErrorCode(e) + ')' };
    }
    if (r.status === 401 || r.status === 403) return { ok: false, kind: 'unauthorized', status: r.status, error: 'usage endpoint HTTP ' + r.status };
    if (!r.ok) return { ok: false, kind: 'http', status: r.status, error: 'usage endpoint HTTP ' + r.status };
    let j;
    try { j = await r.json(); } catch (e) { return { ok: false, kind: 'parse', error: 'usage endpoint returned unparsable data (' + guardRedact.transportErrorCode(e) + ')' }; }
    const windows = core.cleanWindows(normalizeWindows(j));
    if (!windows.length) return { ok: false, kind: 'empty', error: 'usage endpoint reported no usable window' };
    return { ok: true, windows, maxPct: core.maxPct(windows) };
  } finally { clearTimeout(timer); }
}
function expiresMs(oauth) {
  const e = oauth && oauth.expiresAt;
  const ms = typeof e === 'number' ? e : typeof e === 'string' ? (Number.isFinite(Number(e)) ? Number(e) : Date.parse(e)) : NaN;
  return Number.isFinite(ms) ? ms : NaN;
}
/** liveReading(m, now, o) — o.viaSlotToken = true when the measurement used the slot's OWN stored token (the only
 *  readings that may later vouch for a new token's ownership — AR-V01). */
function liveReading(m, now, o) { return { windows: m.windows, measuredAt: new Date(now).toISOString(), source: 'live', unmeasurable: null, viaSlotToken: !!(o && o.viaSlotToken) }; }
/** refreshInactive(slots, activeName, readings, deps, now, o) — measures inactive LOGINS whose stored access token is
 *  still valid (never refreshed). Mutates `readings` (account readings; setup-token readings live elsewhere). */
async function refreshInactive(slots, activeName, readings, deps, now, o) {
  for (const s of slots) {
    if (!s || s.broken || s.name === activeName) continue;
    const prev = readings[s.name] || {};
    if (Date.parse(prev.measuredAt) > now - INACTIVE_REFRESH_MS && !(o && o.force)) continue;
    const oauth = s.credentials && s.credentials.claudeAiOauth;
    if (oauth && expiresMs(oauth) > now + 60000) {
      const m = await measureToken(oauth.accessToken, deps);
      if (m.ok) readings[s.name] = Object.assign({}, prev, liveReading(m, now, { viaSlotToken: true }));
    }
  }
}
function view(slots, readings, now, eligible) {
  return slots.filter((s) => s && !s.broken).map((s) => ({ name: s.name, eligible: eligible(s), reading: core.effectiveReading(readings[s.name], now), lastUsedAt: (readings[s.name] || {}).lastUsedAt || null }));
}
const fileEligible = (s) => !!(s && s.credentials && s.credentials.claudeAiOauth && s.oauthAccount && s.oauthAccount.accountUuid);

module.exports = {
  USAGE_URL, DEFAULTS, BOUNDS_FALLBACK, ENUMS, SWITCH_KEY, DISCLOSURE_FALLBACK, INACTIVE_REFRESH_MS,
  resolveSettings, loadConfig, settingsLine, bounds, measureToken, expiresMs, liveReading, refreshInactive, view, fileEligible,
};
