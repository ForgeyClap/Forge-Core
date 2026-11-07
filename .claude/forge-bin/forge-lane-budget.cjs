#!/usr/bin/env node
'use strict';
/**
 * forge-lane-budget.cjs — how many parallel lanes Forge may use RIGHT NOW (owner wish P-000096).
 * Many lanes at low weekly / 5-hour usage, fewer and fewer as usage rises, one lane from stop-at. Turns the last
 * real usage measurement plus the machine's resources into ONE lane number. Zero-dependency CommonJS; never reads
 * the Claude login file, never calls the network itself (only --refresh asks usage-guard.cjs, in a child process,
 * for one live reading). Works as ONE file (global ~/.claude/forge-bin; optional sibling: see DATA) and in a project.
 * FORMULA (cfg defaults max=10 min=1 stopAt=80 fullUntil=20 unknownLanes=4) — full text in HELP below: p = max(5h%
 * (x 0.5 just before its reset), week% + 0.5 x pace overshoot); taper p% 0-20 30 40 50 60 70 75 80+ -> 10 9 8 6 5 3 2 1;
 * RAM >= 95 % / disk < 14 GB -> min; lanes <= max(1, cores - 2); no trusted % (stale > 30 min, failed check) -> unknownLanes.
 * Pausing is NOT this file's job: from stopAt the line says "1 lane (serial)"; usage-guard.cjs pauses at its own level.
 * DATA: the usage-guard state (~/.claude/FORGE_USAGE_GUARD_STATE.json, env FORGE_USAGE_GUARD_STATE): `percents`,
 * `lastCheckAt`, `lastError`, `resets {session, week}`. A reset time counts only when in the future, after lastCheckAt and
 * at most one window away (5 h / 7 days + 5 min slack), else dropped with a reason. A failed last check (lastError)
 * makes the percentages unknown. SIBLING forge-usage-source.cjs (A1, 2026-11-04; missing = the old single-file
 * behaviour; present but BROKEN = the same plus ONE warning, CLI stderr / a note in the line): an untrusted state falls
 * back to a newer FORGE_USAGE_PRESSURE.json week %, and a session whose OWN env names a rotator account
 * (FORGE_ROTATOR_ACCOUNT, set by `account-rotator launch`) uses (and NAMES) that account's fresh reading.
 * CONFIG lanes.max/min/stop-at/full-until/unknown (FORGE_CONFIG_SCHEMA.json), from the session cwd: forge-config.cjs
 * next to this file, else the cwd Forge project's (has .claude/forge-dashboard), else <FORGE_CONFIG_HOME | ~/.claude>/
 * FORGE_CONFIG.json read as DATA (scope global; STANDALONE_RANGES pinned to the schema by the test; expired one-offs
 * skipped). Missing = defaults; damaged / resolver throw = defaults + a note in the line; a broken cross-key combination
 * (min <= max, full-until < stop-at) = the defaults as a whole.
 * REFRESH HINT: the unknown line names `node "<this file>" --refresh` (one live reading, no retry) only when a usage
 * guard is reachable (env FORGE_LANE_BUDGET_GUARD, next to this file, or the cwd Forge project), never for a rotator
 * account, at most once per hour (token-free stamp {lastShownAt} in FORGE_LANE_BUDGET_HINT.json next to the guard state,
 * env FORGE_LANE_BUDGET_HINT / opts.hintFile; a stamp that cannot be written = no command).
 * API  computeBudget(input) PURE · readUsage · budgetLine({now, stateFile, cwd, cfg, hintFile}) · loadConfig({cwd})
 *      · readResources · normalizeCfg · projectRootOf · findGuard · DEFAULTS · CONFIG_KEYS · STANDALONE_RANGES
 * CLI  node .claude/forge-bin/forge-lane-budget.cjs [--json] [--session N --week N] [--refresh] [--help]; exit 0 / 2.
 */
const fs = require('fs'); const os = require('os'); const path = require('path');
const { spawnSync } = require('child_process');
let usageSource = null; // optional sibling (A1): missing = silent single-file mode; present but BROKEN = one warning
let siblingWarning = '';
try { usageSource = require('./forge-usage-source.cjs'); } catch (e) {
  if (fs.existsSync(path.join(__dirname, 'forge-usage-source.cjs'))) siblingWarning = 'Let op: forge-usage-source.cjs kapot (' + String((e && e.message) || e).split(/\r?\n/)[0].slice(0, 80) + '), standaard-login gebruikt / broken, default login used.';
}

const DEFAULTS = Object.freeze({ max: 10, min: 1, stopAt: 80, fullUntil: 20, unknownLanes: 4, ramCapPct: 95, minFreeDiskGB: 14 });
const CURVE = 1.25; const PACE_WEIGHT = 0.5;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000; const SESSION_WINDOW_MS = 5 * 60 * 60 * 1000;
const RESET_SLACK_MS = 5 * 60 * 1000; const RESET_SOON_MS = 20 * 60 * 1000;
const HINT_EVERY_MS = 60 * 60 * 1000; const DEFAULT_MAX_AGE_MIN = 30;
const CONFIG_KEYS = Object.freeze({ max: 'lanes.max', min: 'lanes.min', stopAt: 'lanes.stop-at', fullUntil: 'lanes.full-until', unknownLanes: 'lanes.unknown' });
const STANDALONE_RANGES = Object.freeze({ max: [1, 32], min: [1, 32], stopAt: [10, 100], fullUntil: [0, 99], unknownLanes: [1, 32] });
const ONCE_MAX_MS = 10 * 60 * 1000; // forge-config-once.cjs ONCE_MS: a one-off value can never last longer
// a lastError text that means the last measurement itself failed (usage-guard.cjs tick(): CHECK FAILED,
// account switched mid-check, credential rotated mid-check) — percents are then older than lastCheckAt.
const FAILED_CHECK_RE = /usage endpoint|fetch|HTTP \d|timed out|unparsable|account switched|credential rotated|no login|ENOTFOUND|ECONN/i;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const pctOrNull = (v) => (isNum(v) && v >= 0 ? Math.min(v, 100) : null);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const exists = (p) => { try { return fs.existsSync(p); } catch (_e) { return false; } };
const errText = (e) => (e && e.message ? e.message : String(e));

/** normalizeCfg(cfg) -> { cfg, errors[] }: defaults filled in; an invalid value or combination falls back to
 *  the defaults for the lane keys (never a half-applied mix), with the reason in errors. */
function normalizeCfg(cfg) {
  const c = Object.assign({}, DEFAULTS);
  const errors = [];
  const src = isObj(cfg) ? cfg : {};
  for (const k of Object.keys(DEFAULTS)) {
    if (src[k] === undefined || src[k] === null) continue;
    if (!isNum(src[k]) || src[k] < 0) { errors.push(k + ' must be a non-negative number (got ' + JSON.stringify(src[k]) + ')'); continue; }
    c[k] = src[k];
  }
  for (const k of ['max', 'min', 'unknownLanes']) if (!Number.isInteger(c[k]) || c[k] < 1) errors.push(k + ' must be a whole number >= 1');
  if (c.min > c.max) errors.push('min (' + c.min + ') may not be higher than max (' + c.max + ')');
  if (!(c.fullUntil < c.stopAt)) errors.push('full-until (' + c.fullUntil + ') must be lower than stop-at (' + c.stopAt + ')');
  if (errors.length) return { cfg: Object.assign({}, DEFAULTS, { ramCapPct: c.ramCapPct, minFreeDiskGB: c.minFreeDiskGB }), errors };
  return { cfg: c, errors };
}

/** taperLanes(p, cfg) -> integer lanes from the pressure alone (see FORMULA). */
function taperLanes(p, cfg) {
  if (p <= cfg.fullUntil) return cfg.max;
  if (p >= cfg.stopAt) return cfg.min;
  const x = (p - cfg.fullUntil) / (cfg.stopAt - cfg.fullUntil);
  return clamp(Math.round(cfg.min + (cfg.max - cfg.min) * (1 - Math.pow(x, CURVE))), cfg.min, cfg.max);
}

/** usableReset(resetsAt, windowMs, now, checkAt) -> reset ms, or null when it is not a believable upcoming reset
 *  (unreadable, already passed, not after the last check, or further away than one window + slack). */
function usableReset(resetsAt, windowMs, now, checkAt) {
  const ms = typeof resetsAt === 'string' ? Date.parse(resetsAt) : NaN;
  if (!Number.isFinite(ms) || !isNum(now) || ms <= now) return null;
  if (isNum(checkAt) && ms <= checkAt) return null;
  return ms - now > windowMs + RESET_SLACK_MS ? null : ms;
}

function weekEffective(week, now, checkAt, reasons) {
  const pct = pctOrNull(week && week.pct);
  if (pct === null) return null;
  if (!(week && week.resetsAt) || !isNum(now)) return pct;
  const resetMs = usableReset(week.resetsAt, WEEK_MS, now, checkAt);
  if (resetMs === null) { reasons.push('week reset time is not within the coming 7 days: no pace effect'); return pct; }
  const expected = clamp(1 - (resetMs - now) / WEEK_MS, 0, 1) * 100;
  const ahead = Math.max(0, pct - expected);
  if (ahead > 0) reasons.push('week ' + pct + ' % is ahead of pace (expected ' + Math.round(expected) + ' %): +' + Math.round(PACE_WEIGHT * ahead * 10) / 10);
  return pct + PACE_WEIGHT * ahead;
}

function sessionEffective(session, now, checkAt, stopAt, reasons) {
  const pct = pctOrNull(session && session.pct);
  if (pct === null) return null;
  if (!(session && session.resetsAt) || !isNum(now)) return pct;
  const resetMs = usableReset(session.resetsAt, SESSION_WINDOW_MS, now, checkAt);
  if (resetMs === null) { reasons.push('5-hour reset time is not a believable upcoming reset: no relief'); return pct; }
  if (resetMs - now <= RESET_SOON_MS && pct < stopAt) {
    reasons.push('5-hour window resets within 20 minutes: session counts half');
    return pct * 0.5;
  }
  return pct;
}

/** resourceCap(resources, cfg, reasons) -> { cap, driver|null } — the most lanes the machine can carry. */
function resourceCap(resources, cfg, reasons) {
  const r = resources || {};
  if (isNum(r.ramUsedPct) && r.ramUsedPct >= cfg.ramCapPct) { reasons.push('RAM ' + Math.round(r.ramUsedPct) + ' % used (>= ' + cfg.ramCapPct + ' %): minimum lanes'); return { cap: cfg.min, driver: 'ram' }; }
  if (isNum(r.freeDiskGB) && r.freeDiskGB < cfg.minFreeDiskGB) { reasons.push('free disk ' + Math.round(r.freeDiskGB * 10) / 10 + ' GB (< ' + cfg.minFreeDiskGB + ' GB): minimum lanes'); return { cap: cfg.min, driver: 'disk' }; }
  if (isNum(r.cpus) && r.cpus >= 1) return { cap: Math.max(1, Math.floor(r.cpus) - 2), driver: 'cpu' };
  return { cap: Infinity, driver: null };
}

function levelOf(lanes, cfg) { return lanes >= cfg.max ? 'full' : lanes <= cfg.min ? 'serial' : 'taper'; }

/** computeBudget(input) PURE -> { lanes, max, min, level, driver, pressure, reasons, line_nl, line_en }.
 *  input: { session, week, now, checkAt, resources, cfg, stale, ageMin, lastCheckFailed, notes[], refreshCmd, account, accountGuess }. */
function computeBudget(input) {
  const inp = input || {};
  const { cfg, errors } = normalizeCfg(inp.cfg);
  const reasons = errors.map((e) => 'config rejected, defaults used: ' + e)
    .concat(Array.isArray(inp.notes) ? inp.notes.filter((n) => typeof n === 'string') : []);
  const now = isNum(inp.now) ? inp.now : null;
  const checkAt = isNum(inp.checkAt) ? inp.checkAt : null;
  const sEff = inp.stale ? null : sessionEffective(inp.session, now, checkAt, cfg.stopAt, reasons);
  const wEff = inp.stale ? null : weekEffective(inp.week, now, checkAt, reasons);
  const res = resourceCap(inp.resources, cfg, reasons);
  const finish = (lanes0, base) => {
    let lanes = lanes0;
    let driver = base.driver;
    if (res.cap < lanes) {
      lanes = res.cap;
      driver = res.driver;
      if (res.driver === 'cpu') reasons.push('CPU cap: ' + res.cap + ' lanes (cores - 2)');
    }
    lanes = clamp(lanes, cfg.min, cfg.max);
    const level = base.level || levelOf(lanes, cfg);
    const out = { lanes, max: cfg.max, min: cfg.min, level, driver, pressure: base.pressure, reasons };
    return Object.assign(out, lineFor(out, cfg, inp));
  };
  if (sEff === null && wEff === null) {
    reasons.push('usage unknown: ' + cfg.unknownLanes + ' lanes until a fresh measurement');
    if (inp.stale && (isNum(inp.week && inp.week.pct) || isNum(inp.session && inp.session.pct))) {
      reasons.push('last stored reading is NOT trusted (stale or failed check): week ' + fmtPct(inp.week && inp.week.pct) + ' %, 5 hours ' + fmtPct(inp.session && inp.session.pct) + ' %');
    }
    return finish(cfg.unknownLanes, { driver: 'unknown', level: 'unknown', pressure: null });
  }
  const useWeek = sEff === null || (wEff !== null && wEff > sEff);
  const pressure = Math.round((useWeek ? wEff : sEff) * 10) / 10;
  return finish(taperLanes(pressure, cfg), { driver: useWeek ? 'week' : 'session', pressure });
}

function fmtPct(v) { return v === null || v === undefined || !isNum(v) ? '?' : String(Math.round(v)); }
function pctWord(v, lang) { return isNum(v) ? Math.round(v) + ' %' : (lang === 'nl' ? 'onbekend' : 'unknown'); }
function ageText(min, lang) {
  if (!isNum(min)) return lang === 'nl' ? 'geen meting gevonden' : 'no measurement found';
  const head = lang === 'nl' ? 'laatste meting ' : 'last measurement ';
  if (min < 90) return head + Math.round(min) + ' min ' + (lang === 'nl' ? 'oud' : 'old');
  if (min < 48 * 60) return head + Math.round(min / 60) + (lang === 'nl' ? ' uur oud' : ' hours old');
  return head + Math.round(min / 1440) + (lang === 'nl' ? ' dagen oud' : ' days old');
}

function lineFor(b, cfg, inp) {
  const word = (n) => n + (n === 1 ? ' lane' : ' lanes');
  const who = (en) => (typeof inp.account === 'string' && inp.account ? ' (' + (inp.accountGuess ? (en ? 'probably ' : 'vermoedelijk ') : '') + 'account ' + inp.account + ' via rotator)' : '');
  if (b.level === 'unknown') {
    const cmd = typeof inp.refreshCmd === 'string' && inp.refreshCmd ? inp.refreshCmd : '';
    const nl = 'Lane-budget' + who(false) + ': usage onbekend (' + ageText(inp.ageMin, 'nl') + (inp.lastCheckFailed ? ' — laatste check mislukt' : '') + ') — ' + word(b.lanes);
    const en = 'Lane budget' + who(true) + ': usage unknown (' + ageText(inp.ageMin, 'en') + (inp.lastCheckFailed ? ' — last check failed' : '') + ') — ' + word(b.lanes);
    return {
      line_nl: nl + (cmd ? '; eenmalig verversen: ' + cmd + '; mislukt dat, blijf op ' + word(b.lanes) + '.' : '.'),
      line_en: en + (cmd ? '; refresh once: ' + cmd + '; if that fails, stay at ' + word(b.lanes) + '.' : '.'),
    };
  }
  const s = inp.session && inp.session.pct;
  const w = inp.week && inp.week.pct;
  const cap = b.driver === 'ram' ? ' (RAM bijna vol)' : b.driver === 'disk' ? ' (weinig schijfruimte)' : b.driver === 'cpu' ? ' (CPU-limiet)' : '';
  const capEn = b.driver === 'ram' ? ' (RAM nearly full)' : b.driver === 'disk' ? ' (low disk space)' : b.driver === 'cpu' ? ' (CPU limit)' : '';
  const floorNl = cfg.min === 1 ? '1 lane (serieel)' : word(cfg.min) + ' (minimum)';
  const floorEn = cfg.min === 1 ? 'serial (1 lane)' : word(cfg.min) + ' (minimum)';
  return {
    line_nl: 'Lane-budget nu' + who(false) + ': ' + word(b.lanes) + cap + ' (week ' + pctWord(w, 'nl') + ', 5 uur ' + pctWord(s, 'nl') + '; vanaf ' + cfg.stopAt + ' % ' + floorNl + ', pauze pas bij de usage-guard-grens).',
    line_en: 'Lane budget now' + who(true) + ': ' + word(b.lanes) + capEn + ' (week ' + pctWord(w, 'en') + ', 5 hours ' + pctWord(s, 'en') + '; ' + floorEn + ' from ' + cfg.stopAt + ' %, pause only at the usage guard limit).',
  };
}

function defaultStateFile() {
  return process.env.FORGE_USAGE_GUARD_STATE || path.join(os.homedir(), '.claude', 'FORGE_USAGE_GUARD_STATE.json');
}

/** trustedReset — the readUsage side of usableReset: the raw ISO string when believable, else null + a note. */
function trustedReset(raw, windowMs, now, checkAt, label, notes) {
  if (raw === undefined || raw === null) return null;
  const ms = typeof raw === 'string' ? Date.parse(raw) : NaN;
  if (usableReset(raw, windowMs, now, checkAt) !== null) return raw;
  const why = !Number.isFinite(ms) ? 'unreadable' : ms <= now ? 'already passed (stale, from an earlier pause/resume)'
    : isNum(checkAt) && ms <= checkAt ? 'not later than the last check (stale)' : 'further away than the window length (impossible)';
  notes.push(label + ' reset time ' + JSON.stringify(String(raw).slice(0, 40)) + ' ignored: ' + why);
  return null;
}

/** readUsage({stateFile, now, maxAgeMin, env, pressureFile}) -> {session, week, source, ageMin, checkAt, stale, ...}. */
function readUsage(opts) {
  const o = opts || {};
  const now = isNum(o.now) ? o.now : Date.now();
  const maxAgeMin = isNum(o.maxAgeMin) ? o.maxAgeMin : DEFAULT_MAX_AGE_MIN;
  const u = readGuardState(o, now, maxAgeMin);
  return usageSource ? usageSource.withPressure(u, o, o.stateFile || defaultStateFile(), now, maxAgeMin) : u;
}
// {name, via, guess, usage} when the SESSION env names a rotator account / carries a setup token (o.env), else null
const rotatorFor = (o, now) => (usageSource ? usageSource.rotatorFor(o, o.stateFile || defaultStateFile(), now, DEFAULT_MAX_AGE_MIN) : null);

function readGuardState(o, now, maxAgeMin) {
  const none = { session: { pct: null, resetsAt: null }, week: { pct: null, resetsAt: null }, source: 'none', ageMin: null, checkAt: null, stale: true, lastCheckFailed: false, notes: [] };
  let st;
  try {
    st = JSON.parse(fs.readFileSync(o.stateFile || defaultStateFile(), 'utf8'));
  } catch (_e) {
    return none; // missing or damaged state file = no measurement; the caller reports it as unknown
  }
  if (!isObj(st)) return none;
  const p = isObj(st.percents) ? st.percents : {};
  const r = isObj(st.resets) ? st.resets : {};
  const at = Date.parse(st.lastCheckAt);
  const checkAt = Number.isFinite(at) ? at : null;
  const notes = [];
  const session = { pct: pctOrNull(p.session), resetsAt: trustedReset(r.session, SESSION_WINDOW_MS, now, checkAt, '5-hour', notes) };
  const week = { pct: pctOrNull(p.week), resetsAt: trustedReset(r.week, WEEK_MS, now, checkAt, 'week', notes) };
  const ageMin = checkAt !== null ? Math.max(0, (now - checkAt) / 60000) : null;
  const lastCheckFailed = typeof st.lastError === 'string' && FAILED_CHECK_RE.test(st.lastError);
  const noData = session.pct === null && week.pct === null;
  const stale = noData || ageMin === null || ageMin > maxAgeMin || lastCheckFailed;
  return { session, week, source: noData ? 'none' : 'guard-state', ageMin, checkAt, stale, lastCheckFailed, notes };
}

/** projectRootOf(cwd) -> nearest folder (cwd or above, never the home folder itself: ~/.claude is the GLOBAL
 *  folder) holding .claude/config or .claude/forge-dashboard; null when there is none. */
function projectRootOf(cwd) {
  if (typeof cwd !== 'string' || !cwd) return null;
  const norm = (d) => (process.platform === 'win32' ? d.toLowerCase() : d);
  const home = norm(path.resolve(os.homedir()));
  let d = path.resolve(cwd);
  for (let i = 0; i < 40; i++) {
    if (norm(d) === home) return null;
    if (exists(path.join(d, '.claude', 'config')) || exists(path.join(d, '.claude', 'forge-dashboard'))) return d;
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
  return null;
}
const isForgeProject = (root) => !!root && exists(path.join(root, '.claude', 'forge-dashboard'));

/** onceLive(ent, now) — a one-off (`--once`) entry counts only inside its own short window (forge-config-once.cjs). */
function onceLive(ent, now) {
  if (ent.consumed_at) return false;
  const set = typeof ent.set_at === 'string' ? Date.parse(ent.set_at) : NaN;
  const exp = typeof ent.expires_at === 'string' ? Date.parse(ent.expires_at) : NaN;
  return Number.isFinite(set) && Number.isFinite(exp) && set <= now && now < exp && exp <= set + ONCE_MAX_MS;
}

/** readGlobalLanes(o) — standalone mode: the global FORGE_CONFIG.json read as data, lanes.* only, fail-closed. */
function readGlobalLanes(o) {
  const file = path.join(path.resolve(o.configHome || process.env.FORGE_CONFIG_HOME || path.join(os.homedir(), '.claude')), 'FORGE_CONFIG.json');
  const bad = (why) => ({ cfg: {}, notes: ['Forge config ' + file + ' unreadable (' + why + '), lane defaults used'], source: 'defaults' });
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) {
    return e && e.code === 'ENOENT' ? { cfg: {}, notes: [], source: 'defaults' } : bad(e && e.code ? e.code : errText(e));
  }
  let j;
  try { j = JSON.parse(raw.replace(/^\ufeff/, '')); } catch (_e) { return bad('not valid JSON'); }
  if (!isObj(j) || !isObj(j.settings)) return bad('expected {"settings": {...}}');
  const out = {};
  const now = Date.now();
  for (const [k, key] of Object.entries(CONFIG_KEYS)) {
    const ent = j.settings[key];
    if (ent === undefined) continue;
    if (!isObj(ent) || !Object.prototype.hasOwnProperty.call(ent, 'value')) return bad('"' + key + '" must look like {"value": ...}');
    if (Object.prototype.hasOwnProperty.call(ent, 'expires_at') && !onceLive(ent, now)) continue;
    const [lo, hi] = STANDALONE_RANGES[k];
    if (!Number.isInteger(ent.value) || ent.value < lo || ent.value > hi) return bad('"' + key + '" must be a whole number ' + lo + '-' + hi);
    out[k] = ent.value;
  }
  return { cfg: out, notes: [], source: 'global-file' };
}

/** loadConfig({cwd, configHome, projectRoot, ...}) -> { cfg, notes[], source, projectRoot } (see CONFIG). Never throws. */
function loadConfig(opts) {
  const o = Object.assign({}, opts || {});
  const root = (o.projectRoot || process.env.FORGE_PROJECT_ROOT) ? null : projectRootOf(o.cwd); // explicit root given -> no walk
  if (root) o.projectRoot = root;
  const resolver = [path.join(__dirname, 'forge-config.cjs'), isForgeProject(root) ? path.join(root, '.claude', 'forge-bin', 'forge-config.cjs') : null]
    .find((p) => p && exists(p));
  if (!resolver) return Object.assign(readGlobalLanes(o), { projectRoot: root });
  try {
    const r = require(resolver).resolve(o);
    const out = {};
    for (const [k, key] of Object.entries(CONFIG_KEYS)) if (r.settings[key]) out[k] = r.settings[key].value;
    return { cfg: out, notes: [], source: 'forge-config', projectRoot: root };
  } catch (e) {
    return { cfg: {}, notes: ['Forge config unreadable, lane defaults used: ' + errText(e)], source: 'defaults', projectRoot: root };
  }
}

/** readResources(dir) -> { ramUsedPct, freeDiskGB, cpus } — any part that cannot be measured is null. */
function readResources(dir) {
  const tryNum = (fn) => { try { const v = fn(); return isNum(v) ? v : null; } catch (_e) { return null; } };
  const ramUsedPct = tryNum(() => { const t = os.totalmem(); return t > 0 ? Math.round(((t - os.freemem()) / t) * 1000) / 10 : null; });
  const cpus = tryNum(() => os.cpus().length || null);
  const freeDiskGB = tryNum(() => {
    if (typeof fs.statfsSync !== 'function') return null;
    const s = fs.statfsSync(dir || process.cwd());
    return Math.round(((s.bavail * s.bsize) / 1073741824) * 10) / 10;
  });
  return { ramUsedPct, freeDiskGB, cpus };
}

/** findGuard(cwd) -> absolute path of a usage-guard.cjs to read live usage through, or null. */
function findGuard(cwd) {
  const root = projectRootOf(cwd);
  const c = [process.env.FORGE_LANE_BUDGET_GUARD, path.join(__dirname, 'usage-guard.cjs'), isForgeProject(root) ? path.join(root, '.claude', 'forge-bin', 'usage-guard.cjs') : null];
  return c.find((p) => typeof p === 'string' && p && exists(p)) || null;
}
const refreshCmdFor = (guard) => (guard ? 'node "' + __filename.split(path.sep).join('/') + '" --refresh' : null);

function hintFileFor(o) {
  if (typeof o.hintFile === 'string' && o.hintFile) return o.hintFile;
  if (process.env.FORGE_LANE_BUDGET_HINT) return process.env.FORGE_LANE_BUDGET_HINT;
  return path.join(path.dirname(typeof o.stateFile === 'string' && o.stateFile ? o.stateFile : defaultStateFile()), 'FORGE_LANE_BUDGET_HINT.json');
}

/** claimHint(file, now) -> true when the refresh command may be shown now (not in the last hour) AND the stamp was
 *  written; a stamp that cannot be written means "do not show" — never the command on every prompt. */
function claimHint(file, now) {
  try {
    const last = Date.parse(JSON.parse(fs.readFileSync(file, 'utf8')).lastShownAt);
    if (Number.isFinite(last) && last <= now && now - last < HINT_EVERY_MS) return false;
  } catch (_e) { /* no or unreadable stamp: the command may be shown */ }
  const tmp = file + '.' + process.pid + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify({ lastShownAt: new Date(now).toISOString() }) + '\n');
    fs.renameSync(tmp, file);
    return true;
  } catch (_e) {
    try { fs.unlinkSync(tmp); } catch (_e2) { /* nothing was written */ }
    return false;
  }
}

function budgetFrom(u, now, cfgIn, resources, refreshCmd, acct) {
  return computeBudget({
    session: u.session, week: u.week, now, checkAt: u.checkAt, resources, cfg: cfgIn, notes: u.notes,
    stale: u.stale, ageMin: u.ageMin, lastCheckFailed: u.lastCheckFailed, refreshCmd, account: (acct && acct.name) || null, accountGuess: !!(acct && acct.guess),
  });
}

/** budgetLine({now, stateFile, cwd, cfg, configOpts, resources, dir, hintFile, env, rotatorFile}) -> NL line | ''. */
function budgetLine(opts) {
  try {
    const o = opts || {};
    const now = isNum(o.now) ? o.now : Date.now();
    const cwd = typeof o.cwd === 'string' && o.cwd ? o.cwd : process.cwd();
    const acct = rotatorFor(o, now);
    const u = acct ? acct.usage : readUsage({ stateFile: o.stateFile, now, env: o.env });
    const lc = o.cfg ? { cfg: o.cfg, notes: [] } : loadConfig(Object.assign({ cwd }, o.configOpts || {}));
    const resources = o.resources || readResources(o.dir || cwd);
    let b = budgetFrom(u, now, lc.cfg, resources, null, acct);
    if (b.level === 'unknown' && !acct) {
      const guard = findGuard(cwd);
      if (guard && claimHint(hintFileFor(o), now)) b = budgetFrom(u, now, lc.cfg, resources, refreshCmdFor(guard));
    }
    const note = lc.notes.length ? ' Let op: lane-instellingen onleesbaar, standaardwaarden gebruikt.' : '';
    return String(b.line_nl + note + (siblingWarning ? ' ' + siblingWarning : '')).replace(/[\r\n]+/g, ' ');
  } catch (_e) {
    return '';
  }
}

/** One live reading through usage-guard.cjs's own fetchUsage(), in a child process (the guard's own login-file
 *  and guard-switch rules apply there). No retry. -> { ok, session, week, error }. */
function refreshLive(cwd) {
  const guard = findGuard(cwd || process.cwd());
  if (!guard) return { ok: false, error: 'no usage guard (usage-guard.cjs) found next to this file or in this Forge project' };
  const env = Object.assign({}, process.env, { FORGE_LANE_BUDGET_GUARD: guard });
  const r = spawnSync(process.execPath, [__filename, '--_refresh-child'], { encoding: 'utf8', timeout: 30000, windowsHide: true, env });
  if (r.error) return { ok: false, error: r.error.code === 'ETIMEDOUT' ? 'timed out after 30 s' : r.error.message };
  const line = String(r.stdout || '').trim().split(/\r?\n/).pop() || '';
  try {
    const j = JSON.parse(line);
    if (j && j.ok) return { ok: true, session: j.session, week: j.week };
    return { ok: false, error: (j && j.error) || 'no reading' };
  } catch (_e) {
    return { ok: false, error: 'unreadable answer from usage-guard (exit ' + r.status + ')' };
  }
}

async function refreshChild() {
  try {
    const guardPath = process.env.FORGE_LANE_BUDGET_GUARD || findGuard(process.cwd());
    if (!guardPath) throw new Error('no usage guard found');
    const u = await require(guardPath).fetchUsage({ force: false });
    const pick = (w) => ({ pct: pctOrNull(Number(w && w.pct)), resetsAt: (w && w.resetsAt) || null });
    process.stdout.write(JSON.stringify({ ok: true, session: pick(u.session), week: pick(u.week) }) + '\n');
  } catch (e) {
    process.stdout.write(JSON.stringify({ ok: false, error: errText(e) }) + '\n');
  }
}

const HELP = [
  'forge-lane-budget.cjs — hoeveel parallelle lanes Forge nu mag gebruiken / how many parallel lanes now',
  '',
  'Gebruik / usage: node .claude/forge-bin/forge-lane-budget.cjs [--json] [--session N --week N] [--refresh] [--help]',
  '  --json            het volledige resultaat als JSON / the full result as JSON',
  '  --session N       rekenen met dit 5-uurspercentage i.p.v. de laatste meting / use this 5-hour % instead',
  '  --week N          rekenen met dit weekpercentage / use this weekly % instead',
  '  --refresh         één live meting via usage-guard.cjs (geen herhaalpogingen) / one live reading, no retry',
  '',
  'Formule / formula:',
  '  weekEff    = week% + 0.5 x max(0, week% - verwacht%)   (verwacht = verstreken deel van de week; alleen met resetsAt)',
  '  sessionEff = 5-uur% (x 0.5 als die binnen 20 min reset en onder stop-at ligt)',
  '  resetsAt telt alleen als hij in de toekomst ligt, na de laatste meting, binnen het venster (5 uur / 7 dagen)',
  '  druk p = max(sessionEff, weekEff); p <= full-until -> max · p >= stop-at -> min · daartussen',
  '  round(min + (max-min) x (1 - x^1.25)), x = (p - full-until) / (stop-at - full-until).',
  '  RAM >= 95 % of schijf < 14 GB -> min; lanes <= cores - 2. Onbekend / ouder dan 30 min / check mislukt -> 4.',
  '  Vanaf stop-at serieel (1 lane); pauzeren doet alleen de usage guard, op zijn eigen grens.',
  'Tabel bij de standaardwaarden / table at the defaults (max 10, min 1, full-until 20, stop-at 80):',
  '  druk %  0-20  30  40  50  60  70  75  80+',
  '  lanes     10   9   8   6   5   3   2   1',
  'Instellen / configure: /forge config set lanes.max 12  (ook lanes.min, lanes.stop-at, lanes.full-until, lanes.unknown)',
].join('\n');

function parsePctArg(argv, name) {
  const i = argv.indexOf(name);
  const raw = i < 0 ? undefined : argv[i + 1];
  if (raw === undefined) return { given: false };
  const n = Number(raw);
  if (raw === '' || !Number.isFinite(n) || n < 0 || n > 100) return { given: true, error: name + ' needs a number 0-100 (got ' + JSON.stringify(raw) + ')' };
  return { given: true, value: n };
}

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) { process.stdout.write(HELP + '\n'); return 0; }
  const sArg = parsePctArg(argv, '--session');
  const wArg = parsePctArg(argv, '--week');
  for (const a of [sArg, wArg]) if (a.error) { process.stderr.write(a.error + '\n'); return 2; }
  if (siblingWarning) process.stderr.write(siblingWarning + '\n');
  const now = Date.now();
  const cwd = process.cwd();
  const acct = rotatorFor({}, now);
  let u = acct ? acct.usage : readUsage({ now });
  const notes = [];
  const refreshTried = argv.includes('--refresh');
  const reading = (session, week, source) => ({ session, week, source, ageMin: 0, checkAt: now, stale: false, lastCheckFailed: false, notes: [] });
  if (refreshTried && acct) notes.push('--refresh meet de standaard-login, niet ' + acct.name + ' — niet gebruikt / measures the default login, not ' + acct.name + ' — not used.');
  else if (refreshTried) {
    const live = refreshLive(cwd);
    if (live.ok) u = reading(live.session, live.week, 'live');
    else notes.push('Live meting mislukt: ' + live.error + ' — terugval op de laatst opgeslagen meting / live reading failed, falling back to the stored measurement.');
  }
  if (sArg.given || wArg.given) u = reading({ pct: sArg.given ? sArg.value : null, resetsAt: null }, { pct: wArg.given ? wArg.value : null, resetsAt: null }, 'argv');
  const lc = loadConfig({ cwd });
  notes.push(...lc.notes);
  const resources = readResources(cwd);
  const shown = sArg.given || wArg.given ? null : acct;
  const b = budgetFrom(u, now, lc.cfg, resources, refreshTried || shown ? null : refreshCmdFor(findGuard(cwd)), shown);
  if (argv.includes('--json')) {
    process.stdout.write(JSON.stringify(Object.assign({}, b, { account: shown ? shown.name : null, account_source: shown ? shown.via : null, usage: u, resources, notes, config_source: lc.source }), null, 2) + '\n');
    return 0;
  }
  for (const n of notes) process.stdout.write(n + '\n');
  process.stdout.write(b.line_nl + '\n');
  return 0;
}

if (require.main === module) {
  if (process.argv.includes('--_refresh-child')) refreshChild();
  else process.exitCode = main(process.argv.slice(2));
}

module.exports = {
  computeBudget, readUsage, budgetLine, loadConfig, readResources, normalizeCfg, taperLanes, refreshLive, main,
  projectRootOf, findGuard, DEFAULTS, CONFIG_KEYS, STANDALONE_RANGES,
};
