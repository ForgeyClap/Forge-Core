#!/usr/bin/env node
'use strict';
/**
 * forge-lane-budget.test.cjs — tests for forge-lane-budget.cjs (owner wish P-000096). Everything runs against a
 * fresh folder in the OS temp directory (removed at exit) with env overrides set BEFORE anything runs
 * (FORGE_USAGE_GUARD_STATE, FORGE_LANE_BUDGET_HINT, FORGE_CONFIG_HOME, FORGE_PROJECT_ROOT), so the real ~/.claude
 * state, hint and config files are never read or written. Zero dependencies; run: node forge-lane-budget.test.cjs
 * The last line is the tally '<n> passed, <m> failed'; exit 1 when anything failed.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const TOOL = path.join(__dirname, 'forge-lane-budget.cjs');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-lanebudget-'));
process.on('exit', () => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* best effort */ } });
const CFG_HOME = path.join(ROOT, 'home');
const PROJ = path.join(ROOT, 'proj');
fs.mkdirSync(CFG_HOME, { recursive: true });
fs.mkdirSync(path.join(PROJ, '.claude'), { recursive: true });
Object.assign(process.env, {
  FORGE_USAGE_GUARD_STATE: path.join(ROOT, 'no-state.json'), FORGE_LANE_BUDGET_HINT: path.join(ROOT, 'hint-default.json'),
  FORGE_CONFIG_HOME: CFG_HOME, FORGE_PROJECT_ROOT: PROJ,
});
delete process.env.FORGE_LANE_BUDGET_GUARD;
const lb = require(TOOL);

let passed = 0, failed = 0;
const results = [];
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function eq(a, b, msg) { if (a !== b) throw new Error((msg || 'not equal') + ': got ' + JSON.stringify(a) + ', expected ' + JSON.stringify(b)); }
function t(name, fn) {
  try { fn(); passed++; results.push('  ok   ' + name); } catch (e) { failed++; results.push('  FAIL ' + name + '\n       ' + (e && e.message)); }
}

const NOW = Date.parse('2026-11-02T12:00:00Z');
const DAY = 24 * 3600 * 1000;
const ROOMY = { ramUsedPct: 40, freeDiskGB: 200, cpus: 32 };
const at = (p, extra) => lb.computeBudget(Object.assign({ session: { pct: p, resetsAt: null }, week: { pct: 0, resetsAt: null }, now: NOW, resources: ROOMY }, extra || {}));
let seq = 0;
function stateFile(obj) {
  const f = path.join(ROOT, 'state-' + (++seq) + '.json');
  fs.writeFileSync(f, typeof obj === 'string' ? obj : JSON.stringify(obj));
  return f;
}
const freshHint = () => path.join(ROOT, 'hint-' + (++seq) + '.json');
const ABS_CMD = 'node "' + TOOL.split(path.sep).join('/') + '" --refresh';
function cli(args, env) {
  const r = spawnSync(process.execPath, [TOOL, ...args], {
    encoding: 'utf8', timeout: 30000,
    env: Object.assign({}, process.env, { FORGE_CONFIG_HOME: CFG_HOME, FORGE_PROJECT_ROOT: PROJ }, env || {}),
  });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

// ---- taper ---------------------------------------------------------------------------------------------------
t('taper table at the defaults: 0-20 full, 40 -> 7-8, 60 -> 4-5, 70 -> 2-3, 80+ -> 1', () => {
  eq(at(0).lanes, 10, '0 %'); eq(at(20).lanes, 10, '20 %');
  assert([7, 8].includes(at(40).lanes), '40 % gave ' + at(40).lanes);
  assert([4, 5].includes(at(60).lanes), '60 % gave ' + at(60).lanes);
  assert([2, 3].includes(at(70).lanes), '70 % gave ' + at(70).lanes);
  eq(at(80).lanes, 1, '80 %'); eq(at(100).lanes, 1, '100 %');
  eq(at(0).level, 'full'); eq(at(50).level, 'taper'); eq(at(90).level, 'serial');
  eq(at(50).driver, 'session'); eq(at(50).pressure, 50);
});
t('monotonic non-increasing across 0..100 and always an integer in [min, max]', () => {
  let prev = Infinity;
  for (let p = 0; p <= 100; p += 0.5) {
    const b = at(p);
    assert(Number.isInteger(b.lanes) && b.lanes >= 1 && b.lanes <= 10, 'p=' + p + ' lanes=' + b.lanes);
    assert(b.lanes <= prev, 'rose at p=' + p + ' (' + prev + ' -> ' + b.lanes + ')');
    prev = b.lanes;
  }
});
t('the higher of week and session drives the pressure', () => {
  const b = lb.computeBudget({ session: { pct: 10, resetsAt: null }, week: { pct: 65, resetsAt: null }, now: NOW, resources: ROOMY });
  eq(b.driver, 'week'); eq(b.pressure, 65);
  const one = lb.computeBudget({ session: { pct: null, resetsAt: null }, week: { pct: 30, resetsAt: null }, now: NOW, resources: ROOMY });
  eq(one.driver, 'week'); eq(one.lanes, 9);
});
t('weekly pace: week 40 % on day 2 of 7 gives fewer lanes than week 40 % on day 6', () => {
  const day2 = lb.computeBudget({ session: { pct: 0 }, week: { pct: 40, resetsAt: new Date(NOW + 5 * DAY).toISOString() }, now: NOW, resources: ROOMY });
  const day6 = lb.computeBudget({ session: { pct: 0 }, week: { pct: 40, resetsAt: new Date(NOW + 1 * DAY).toISOString() }, now: NOW, resources: ROOMY });
  assert(day2.lanes < day6.lanes, 'day2 ' + day2.lanes + ' vs day6 ' + day6.lanes);
  assert(day2.pressure > 40 && day6.pressure === 40, 'pressures ' + day2.pressure + ' / ' + day6.pressure);
  assert(day2.reasons.some((r) => /ahead of pace/.test(r)), day2.reasons.join('|'));
});
t('session that resets within 20 minutes counts half; not when at or above stop-at', () => {
  const soon = new Date(NOW + 10 * 60000).toISOString();
  const later = new Date(NOW + 3 * 3600000).toISOString();
  const a = lb.computeBudget({ session: { pct: 70, resetsAt: soon }, week: { pct: 0 }, now: NOW, resources: ROOMY });
  const b = lb.computeBudget({ session: { pct: 70, resetsAt: later }, week: { pct: 0 }, now: NOW, resources: ROOMY });
  eq(a.pressure, 35); assert(a.lanes > b.lanes, a.lanes + ' vs ' + b.lanes);
  const c = lb.computeBudget({ session: { pct: 85, resetsAt: soon }, week: { pct: 0 }, now: NOW, resources: ROOMY });
  eq(c.lanes, 1, 'at/above stop-at no relief');
});

// ---- resources -----------------------------------------------------------------------------------------------
t('RAM at or above 95 % forces the minimum (driver ram)', () => {
  const b = at(0, { resources: { ramUsedPct: 96, freeDiskGB: 200, cpus: 32 } });
  eq(b.lanes, 1); eq(b.driver, 'ram');
});
t('free disk below 14 GB forces the minimum (driver disk)', () => {
  const b = at(0, { resources: { ramUsedPct: 40, freeDiskGB: 9.5, cpus: 32 } });
  eq(b.lanes, 1); eq(b.driver, 'disk');
});
t('CPU cap: lanes <= cores - 2 (driver cpu only when it bites)', () => {
  const b = at(0, { resources: { ramUsedPct: 40, freeDiskGB: 200, cpus: 6 } });
  eq(b.lanes, 4); eq(b.driver, 'cpu');
  const c = at(70, { resources: { ramUsedPct: 40, freeDiskGB: 200, cpus: 6 } });
  eq(c.driver, 'session');
  const d = at(0, { resources: { ramUsedPct: 40, freeDiskGB: 200, cpus: 2 } });
  eq(d.lanes, 1);
});
t('unmeasurable resources (null) apply no cap', () => {
  eq(at(0, { resources: { ramUsedPct: null, freeDiskGB: null, cpus: null } }).lanes, 10);
  eq(at(0, { resources: undefined }).lanes, 10);
});

// ---- unknown / stale -----------------------------------------------------------------------------------------
t('unknown usage: unknownLanes, level unknown, line names age; refresh command only when given, as a one-time action', () => {
  const b = lb.computeBudget({ session: { pct: null }, week: { pct: null }, now: NOW, resources: ROOMY, ageMin: 19 * 1440, refreshCmd: 'node "X" --refresh' });
  eq(b.lanes, 4); eq(b.level, 'unknown'); eq(b.driver, 'unknown'); eq(b.pressure, null);
  assert(/usage onbekend \(laatste meting 19 dagen oud\)/.test(b.line_nl), b.line_nl);
  assert(b.line_nl.endsWith('— 4 lanes; eenmalig verversen: node "X" --refresh; mislukt dat, blijf op 4 lanes.'), b.line_nl);
  assert(b.line_en.endsWith('— 4 lanes; refresh once: node "X" --refresh; if that fails, stay at 4 lanes.'), b.line_en);
  const bare = lb.computeBudget({ session: { pct: null }, week: { pct: null }, now: NOW, resources: ROOMY, ageMin: 5 });
  assert(bare.line_nl.endsWith('— 4 lanes.') && !/verversen|refresh/.test(bare.line_nl + bare.line_en), bare.line_nl + ' | ' + bare.line_en);
  const capped = lb.computeBudget({ session: { pct: null }, week: { pct: null }, now: NOW, resources: { ramUsedPct: 10, freeDiskGB: 100, cpus: 4 } });
  eq(capped.lanes, 2, 'unknown lanes still capped by resources');
});
t('readUsage: fresh state gives guard-state, old state is stale, failed last check is stale', () => {
  const fresh = lb.readUsage({ stateFile: stateFile({ percents: { session: 22, week: 34 }, lastCheckAt: new Date(NOW - 5 * 60000).toISOString() }), now: NOW });
  eq(fresh.source, 'guard-state'); eq(fresh.stale, false); eq(fresh.week.pct, 34); eq(fresh.session.pct, 22); eq(fresh.week.resetsAt, null);
  const old = lb.readUsage({ stateFile: stateFile({ percents: { session: 7, week: 92 }, lastCheckAt: '2026-10-14T05:29:36.307Z' }), now: NOW });
  eq(old.stale, true); assert(old.ageMin > 19 * 1440, String(old.ageMin));
  const bad = lb.readUsage({ stateFile: stateFile({ percents: { session: 7, week: 50 }, lastCheckAt: new Date(NOW - 60000).toISOString(), lastError: 'usage endpoint HTTP 429' }), now: NOW });
  eq(bad.stale, true); eq(bad.lastCheckFailed, true);
  const withResets = lb.readUsage({ stateFile: stateFile({ percents: { session: 1, week: 2 }, resets: { session: '2026-11-02T13:00:00Z', week: 'garbage' }, lastCheckAt: new Date(NOW).toISOString() }), now: NOW });
  eq(withResets.session.resetsAt, '2026-11-02T13:00:00Z'); eq(withResets.week.resetsAt, null);
});
t('readUsage: missing, garbage and wrong-shape state files never throw and give source none', () => {
  for (const f of [path.join(ROOT, 'nope.json'), stateFile('{not json'), stateFile('[1,2]'), stateFile('null'), stateFile({ percents: 'x' })]) {
    const u = lb.readUsage({ stateFile: f, now: NOW });
    eq(u.source, 'none', f); eq(u.stale, true); eq(u.session.pct, null);
  }
  const weird = lb.readUsage({ stateFile: stateFile({ percents: { session: -5, week: 'high' }, lastCheckAt: 'yesterday' }), now: NOW });
  eq(weird.source, 'none'); eq(weird.ageMin, null);
});

// ---- config --------------------------------------------------------------------------------------------------
t('cfg overrides change the taper (max 6, stop-at 60)', () => {
  const b = lb.computeBudget({ session: { pct: 0 }, week: { pct: 0 }, now: NOW, resources: ROOMY, cfg: { max: 6, stopAt: 60 } });
  eq(b.lanes, 6); eq(b.max, 6);
  eq(lb.computeBudget({ session: { pct: 60 }, week: { pct: 0 }, now: NOW, resources: ROOMY, cfg: { max: 6, stopAt: 60 } }).lanes, 1);
});
t('invalid cfg combinations are rejected as a whole (defaults + reason)', () => {
  for (const bad of [{ min: 12, max: 5 }, { fullUntil: 80, stopAt: 80 }, { max: 0 }, { max: 'ten' }, { min: 2.5 }]) {
    const b = lb.computeBudget({ session: { pct: 0 }, week: { pct: 0 }, now: NOW, resources: ROOMY, cfg: bad });
    eq(b.max, 10, JSON.stringify(bad)); eq(b.min, 1, JSON.stringify(bad));
    assert(b.reasons.some((r) => /config rejected/.test(r)), JSON.stringify(bad) + ' ' + b.reasons.join('|'));
  }
});
t('loadConfig reads lanes.* from the Forge config file (temp home) and survives a damaged file', () => {
  const home = path.join(ROOT, 'cfg-ok');
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, 'FORGE_CONFIG.json'), JSON.stringify({ version: 1, settings: { 'lanes.max': { value: 6 }, 'lanes.stop-at': { value: 70 } } }));
  const r = lb.loadConfig({ configHome: home, projectRoot: PROJ });
  eq(r.cfg.max, 6); eq(r.cfg.stopAt, 70); eq(r.cfg.min, 1); eq(r.cfg.unknownLanes, 4);
  const broken = path.join(ROOT, 'cfg-bad');
  fs.mkdirSync(broken);
  fs.writeFileSync(path.join(broken, 'FORGE_CONFIG.json'), JSON.stringify({ version: 1, settings: { 'lanes.max': { value: 500 } } }));
  const r2 = lb.loadConfig({ configHome: broken, projectRoot: PROJ });
  eq(r2.cfg.max, undefined); assert(r2.notes.length === 1, r2.notes.join('|'));
});

// ---- budgetLine ----------------------------------------------------------------------------------------------
t('budgetLine: one Dutch line for fresh data, never throws on bad input', () => {
  const f = stateFile({ percents: { session: 22, week: 34 }, lastCheckAt: new Date(NOW - 60000).toISOString() });
  const line = lb.budgetLine({ now: NOW, stateFile: f, cfg: {}, resources: ROOMY });
  eq(line, 'Lane-budget nu: 9 lanes (week 34 %, 5 uur 22 %; vanaf 80 % 1 lane (serieel), pauze pas bij de usage-guard-grens).');
  for (const o of [undefined, null, { stateFile: 42 }, { now: 'x', stateFile: path.join(ROOT, 'none.json') }, { cfg: { max: -1 }, stateFile: stateFile('{') }]) {
    const l = lb.budgetLine(o);
    assert(typeof l === 'string' && !/[\r\n]/.test(l), JSON.stringify(o) + ' -> ' + JSON.stringify(l));
  }
  const stale = lb.budgetLine({ now: NOW, stateFile: stateFile({ percents: { session: 7, week: 92 }, lastCheckAt: '2026-10-14T05:29:36.307Z', lastError: 'usage endpoint HTTP 429' }), cfg: {}, resources: ROOMY, hintFile: freshHint() });
  assert(stale.startsWith('Lane-budget: usage onbekend (laatste meting 19 dagen oud — laatste check mislukt) — 4 lanes; eenmalig verversen: '), stale);
});

// ---- CLI -----------------------------------------------------------------------------------------------------
t('CLI --json shape with --session/--week overrides', () => {
  const r = cli(['--json', '--session', '10', '--week', '50'], { FORGE_USAGE_GUARD_STATE: path.join(ROOT, 'absent.json') });
  eq(r.code, 0, r.err);
  const j = JSON.parse(r.out);
  for (const k of ['lanes', 'max', 'min', 'level', 'driver', 'pressure', 'reasons', 'line_nl', 'line_en', 'usage', 'resources', 'notes']) assert(k in j, 'missing ' + k);
  eq(j.driver === 'week' || ['ram', 'disk', 'cpu'].includes(j.driver), true, 'driver ' + j.driver);
  eq(j.pressure, 50); eq(j.usage.source, 'argv');
});
t('CLI plain output is the Dutch line; stale state says usage onbekend; bad args exit 2', () => {
  const f = stateFile({ percents: { session: 7, week: 92 }, lastCheckAt: '2026-10-14T05:29:36.307Z' });
  const r = cli([], { FORGE_USAGE_GUARD_STATE: f });
  eq(r.code, 0, r.err); assert(/Lane-budget: usage onbekend/.test(r.out), r.out);
  eq(cli(['--week', 'abc']).code, 2);
  eq(cli(['--session', '150']).code, 2);
  const h = cli(['--help']);
  eq(h.code, 0); assert(/x\^1\.25/.test(h.out) && /lanes {5}10 {3}9/.test(h.out), h.out);
});
t('CLI --refresh: a failing live reading is reported plainly and falls back (stub guard, no network)', () => {
  const stub = path.join(ROOT, 'stub-fail.cjs');
  fs.writeFileSync(stub, "module.exports = { fetchUsage: async () => { throw new Error('usage endpoint HTTP 429'); } };\n");
  const f = stateFile({ percents: { session: 7, week: 92 }, lastCheckAt: '2026-10-14T05:29:36.307Z' });
  const r = cli(['--refresh'], { FORGE_USAGE_GUARD_STATE: f, FORGE_LANE_BUDGET_GUARD: stub });
  eq(r.code, 0, r.err);
  assert(/Live meting mislukt: usage endpoint HTTP 429/.test(r.out) && /usage onbekend/.test(r.out), r.out);
  assert(!/eenmalig verversen/.test(r.out), 'after a failed --refresh the line must not ask for another refresh: ' + r.out);
});
t('CLI --refresh: a good live reading is used (stub guard, no network)', () => {
  const stub = path.join(ROOT, 'stub-ok.cjs');
  fs.writeFileSync(stub, "module.exports = { fetchUsage: async () => ({ session: { pct: 10, resetsAt: null }, week: { pct: 30, resetsAt: null } }) };\n");
  const r = cli(['--refresh', '--json'], { FORGE_USAGE_GUARD_STATE: path.join(ROOT, 'absent.json'), FORGE_LANE_BUDGET_GUARD: stub });
  eq(r.code, 0, r.err);
  const j = JSON.parse(r.out);
  eq(j.usage.source, 'live'); eq(j.pressure, 30);
});

// ---- review fix round 2026-11-02 (HIGH stale resets, MEDIUM standalone config, LOW wording + hint) -----------
t('HIGH regression: an old PAST resets.session no longer halves a fresh 70 % (3 lanes, not 8)', () => {
  const f = stateFile({ percents: { session: 70, week: 0 }, resets: { session: new Date(NOW - 3 * 3600e3).toISOString(), week: null }, lastCheckAt: new Date(NOW - 5 * 60000).toISOString() });
  const line = lb.budgetLine({ now: NOW, stateFile: f, cfg: {}, resources: ROOMY, hintFile: freshHint() });
  assert(line.startsWith('Lane-budget nu: 3 lanes '), line);
  const u = lb.readUsage({ stateFile: f, now: NOW });
  eq(u.session.resetsAt, null, 'past session reset must be dropped'); eq(u.stale, false);
  assert(u.notes.some((n) => /^5-hour reset time .* ignored: already passed/.test(n)), JSON.stringify(u.notes));
});
t('HIGH: computeBudget gives no session relief for a past reset or one not after the last check', () => {
  const past = lb.computeBudget({ session: { pct: 70, resetsAt: new Date(NOW - 3 * 3600e3).toISOString() }, week: { pct: 0 }, now: NOW, resources: ROOMY });
  eq(past.pressure, 70, 'past reset'); eq(past.lanes, 3);
  const soon = new Date(NOW + 10 * 60000).toISOString();
  eq(lb.computeBudget({ session: { pct: 70, resetsAt: soon }, week: { pct: 0 }, now: NOW, checkAt: NOW + 12 * 60000, resources: ROOMY }).pressure, 70, 'check after reset');
  eq(lb.computeBudget({ session: { pct: 70, resetsAt: soon }, week: { pct: 0 }, now: NOW, checkAt: NOW - 5 * 60000, resources: ROOMY }).pressure, 35, 'genuine soon reset still counts half');
});
t('HIGH (b): week reset in the past or more than 7 days away -> no pace effect, no error', () => {
  const past = lb.computeBudget({ session: { pct: 0 }, week: { pct: 40, resetsAt: new Date(NOW - DAY).toISOString() }, now: NOW, resources: ROOMY });
  eq(past.pressure, 40); assert(!past.reasons.some((r) => /ahead of pace/.test(r)), past.reasons.join('|'));
  const far = lb.computeBudget({ session: { pct: 0 }, week: { pct: 40, resetsAt: new Date(NOW + 30 * DAY).toISOString() }, now: NOW, resources: ROOMY });
  eq(far.pressure, 40, 'a reset 30 days away is impossible for a 7-day window');
  const u = lb.readUsage({ stateFile: stateFile({ percents: { session: 0, week: 40 }, resets: { session: new Date(NOW + 6 * 3600e3).toISOString(), week: new Date(NOW - DAY).toISOString() }, lastCheckAt: new Date(NOW - 60000).toISOString() }), now: NOW });
  eq(u.week.resetsAt, null, 'past week reset'); eq(u.session.resetsAt, null, 'session reset 6 h away (> 5 h window)'); eq(u.stale, false);
  assert(u.notes.length === 2 && u.notes.every((n) => / ignored: /.test(n)), JSON.stringify(u.notes));
});
t('LOW wording: no "stopt bij"; serial (1 lane) from stop-at, pause belongs to the usage guard', () => {
  const b = at(50);
  assert(!/stopt bij|stops at/.test(b.line_nl + b.line_en), b.line_nl + ' | ' + b.line_en);
  assert(b.line_nl.includes('vanaf 80 % 1 lane (serieel), pauze pas bij de usage-guard-grens'), b.line_nl);
  assert(b.line_en.includes('serial (1 lane) from 80 %, pause only at the usage guard limit'), b.line_en);
  const m = lb.computeBudget({ session: { pct: 50 }, week: { pct: 0 }, now: NOW, resources: ROOMY, cfg: { min: 2 } });
  assert(m.line_nl.includes('vanaf 80 % 2 lanes (minimum)'), m.line_nl);
});
t('LOW hint: refresh command (absolute path) at most once per hour, stamp file holds only a time', () => {
  const f = stateFile({ percents: { session: 7, week: 92 }, lastCheckAt: '2026-10-14T05:29:36.307Z' });
  const hint = freshHint();
  const one = lb.budgetLine({ now: NOW, stateFile: f, cfg: {}, resources: ROOMY, hintFile: hint });
  assert(one.endsWith('— 4 lanes; eenmalig verversen: ' + ABS_CMD + '; mislukt dat, blijf op 4 lanes.'), one);
  eq(JSON.stringify(Object.keys(JSON.parse(fs.readFileSync(hint, 'utf8')))), '["lastShownAt"]');
  const two = lb.budgetLine({ now: NOW + 10 * 60000, stateFile: f, cfg: {}, resources: ROOMY, hintFile: hint });
  assert(two.endsWith('— 4 lanes.') && !/verversen/.test(two), 'second prompt within the hour: ' + two);
  const three = lb.budgetLine({ now: NOW + 61 * 60000, stateFile: f, cfg: {}, resources: ROOMY, hintFile: hint });
  assert(three.includes('eenmalig verversen: '), 'after an hour again: ' + three);
  const unwritable = lb.budgetLine({ now: NOW, stateFile: f, cfg: {}, resources: ROOMY, hintFile: path.join(ROOT, 'no-such-dir', 'x', 'hint.json') });
  assert(!/verversen/.test(unwritable), 'a stamp that cannot be written must not show the command on every prompt: ' + unwritable);
});
t('LOW hint: default stamp file sits next to the guard state (env FORGE_LANE_BUDGET_HINT unset)', () => {
  const dir = path.join(ROOT, 'statedir'); fs.mkdirSync(dir);
  const f = path.join(dir, 'FORGE_USAGE_GUARD_STATE.json'); fs.writeFileSync(f, '{}');
  const saved = process.env.FORGE_LANE_BUDGET_HINT; delete process.env.FORGE_LANE_BUDGET_HINT;
  try { lb.budgetLine({ now: NOW, stateFile: f, cfg: {}, resources: ROOMY }); } finally { process.env.FORGE_LANE_BUDGET_HINT = saved; }
  assert(fs.existsSync(path.join(dir, 'FORGE_LANE_BUDGET_HINT.json')), fs.readdirSync(dir).join(','));
});

// standalone: the module as ONE file in a folder without forge-config.cjs / usage-guard.cjs (global install shape)
const SOLO = path.join(ROOT, 'solo'); fs.mkdirSync(SOLO);
fs.copyFileSync(TOOL, path.join(SOLO, 'forge-lane-budget.cjs'));
const solo = require(path.join(SOLO, 'forge-lane-budget.cjs'));
const NOPROJ = path.join(ROOT, 'plain-folder'); fs.mkdirSync(NOPROJ);
const SOLO_HOME = path.join(ROOT, 'solo-home'); fs.mkdirSync(SOLO_HOME);
fs.writeFileSync(path.join(SOLO_HOME, 'FORGE_CONFIG.json'), JSON.stringify({ version: 1, settings: { 'lanes.max': { value: 6 }, 'usage-guard.pause-at': { value: 98 } } }));
const freshState0 = () => stateFile({ percents: { session: 0, week: 0 }, lastCheckAt: new Date(NOW - 60000).toISOString() });
function withEnv(k, v, fn) { const saved = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; try { return fn(); } finally { if (saved === undefined) delete process.env[k]; else process.env[k] = saved; } }
t('MEDIUM standalone: single-file copy honours lanes.max 6 from the global FORGE_CONFIG.json', () => {
  const r = solo.loadConfig({ cwd: NOPROJ, configHome: SOLO_HOME });
  eq(r.source, 'global-file'); eq(r.cfg.max, 6); eq(r.notes.length, 0, r.notes.join('|'));
  const line = withEnv('FORGE_CONFIG_HOME', SOLO_HOME, () => solo.budgetLine({ now: NOW, cwd: NOPROJ, resources: ROOMY, stateFile: freshState0() }));
  assert(line.startsWith('Lane-budget nu: 6 lanes '), line);
});
t('MEDIUM standalone: no config file = defaults silently; damaged/out-of-range = defaults said plainly', () => {
  const empty = path.join(ROOT, 'solo-empty'); fs.mkdirSync(empty);
  const none = solo.loadConfig({ cwd: NOPROJ, configHome: empty });
  eq(none.source, 'defaults'); eq(none.notes.length, 0); eq(none.cfg.max, undefined);
  for (const [name, body] of [['bad-json', '{oops'], ['bad-range', JSON.stringify({ version: 1, settings: { 'lanes.max': { value: 500 } } })], ['bad-shape', JSON.stringify({ version: 1, settings: { 'lanes.max': 6 } })]]) {
    const d = path.join(ROOT, 'solo-' + name); fs.mkdirSync(d); fs.writeFileSync(path.join(d, 'FORGE_CONFIG.json'), body);
    const r = solo.loadConfig({ cwd: NOPROJ, configHome: d });
    eq(r.source, 'defaults', name); eq(r.cfg.max, undefined, name); assert(r.notes.length === 1 && /lane defaults used/.test(r.notes[0]), name + ': ' + r.notes.join('|'));
    const line = withEnv('FORGE_CONFIG_HOME', d, () => solo.budgetLine({ now: NOW, cwd: NOPROJ, resources: ROOMY, stateFile: freshState0() }));
    assert(line.startsWith('Lane-budget nu: 10 lanes ') && line.endsWith('Let op: lane-instellingen onleesbaar, standaardwaarden gebruikt.'), name + ': ' + line);
  }
});
t('MEDIUM standalone: an expired one-off lanes value is ignored, a live one applies', () => {
  const d = path.join(ROOT, 'solo-once'); fs.mkdirSync(d);
  const now = Date.now();
  fs.writeFileSync(path.join(d, 'FORGE_CONFIG.json'), JSON.stringify({ version: 1, settings: {
    'lanes.max': { value: 5, set_at: new Date(now - 20 * 60000).toISOString(), expires_at: new Date(now - 10 * 60000).toISOString() },
    'lanes.min': { value: 2, set_at: new Date(now - 60000).toISOString(), expires_at: new Date(now + 5 * 60000).toISOString() } } }));
  const r = solo.loadConfig({ cwd: NOPROJ, configHome: d });
  eq(r.cfg.max, undefined, 'expired'); eq(r.cfg.min, 2, 'live');
});
t('MEDIUM standalone: no usage guard reachable -> the unknown line names no refresh command and writes no stamp', () => {
  const hint = freshHint();
  const line = solo.budgetLine({ now: NOW, cwd: NOPROJ, cfg: {}, resources: ROOMY, stateFile: path.join(ROOT, 'absent-solo.json'), hintFile: hint });
  assert(line.startsWith('Lane-budget: usage onbekend (geen meting gevonden) — 4 lanes.') && !/verversen/.test(line), line);
  eq(fs.existsSync(hint), false);
});
t('MEDIUM: loadConfig resolves the project at the session cwd (walks up to the folder with .claude/config)', () => {
  const proj2 = path.join(ROOT, 'proj2'); fs.mkdirSync(path.join(proj2, '.claude', 'config'), { recursive: true });
  const deep = path.join(proj2, 'src', 'lib'); fs.mkdirSync(deep, { recursive: true });
  const r = withEnv('FORGE_PROJECT_ROOT', undefined, () => lb.loadConfig({ cwd: deep, configHome: SOLO_HOME }));
  eq(r.source, 'forge-config'); eq(r.projectRoot, proj2); eq(r.cfg.max, 6);
});
// SA-P1B (review note): a BROKEN forge-usage-source.cjs sibling must not be swallowed like a missing one
const BROKEN = path.join(ROOT, 'broken-sibling'); fs.mkdirSync(BROKEN);
fs.copyFileSync(TOOL, path.join(BROKEN, 'forge-lane-budget.cjs'));
fs.writeFileSync(path.join(BROKEN, 'forge-usage-source.cjs'), "'use strict';\nmodule.exports = {( // damaged on purpose\n");
const SIB_RE = /forge-usage-source\.cjs/;
t('SA-P1B broken usage-source sibling: ONE visible warning (CLI stderr once, the line names it); missing or healthy = silent', () => {
  const run = (dir) => spawnSync(process.execPath, [path.join(dir, 'forge-lane-budget.cjs'), '--session', '10', '--week', '10'], { encoding: 'utf8', timeout: 30000, cwd: NOPROJ, env: Object.assign({}, process.env, { FORGE_CONFIG_HOME: SOLO_HOME }) });
  const b = run(BROKEN);
  eq(b.status, 0, 'exit');
  const warn = (b.stderr || '').split(/\r?\n/).filter((l) => SIB_RE.test(l));
  eq(warn.length, 1, 'stderr warnings: ' + b.stderr);
  assert(/kapot|broken/i.test(warn[0]), warn[0]);
  assert(!SIB_RE.test(b.stdout), 'not doubled on stdout: ' + b.stdout);
  assert(/Lane-budget nu: /.test(b.stdout), b.stdout);
  const brokenMod = require(path.join(BROKEN, 'forge-lane-budget.cjs'));
  const line = brokenMod.budgetLine({ now: NOW, cwd: NOPROJ, cfg: {}, resources: ROOMY, stateFile: freshState0() });
  assert(line.startsWith('Lane-budget nu: ') && (line.match(/forge-usage-source\.cjs/g) || []).length === 1, line);
  for (const dir of [SOLO, __dirname]) {
    const r = run(dir);
    eq(r.status, 0, dir); assert(!SIB_RE.test(r.stderr + r.stdout), dir + ': ' + r.stderr + r.stdout);
  }
  assert(!SIB_RE.test(solo.budgetLine({ now: NOW, cwd: NOPROJ, cfg: {}, resources: ROOMY, stateFile: freshState0() })), 'missing sibling stays silent');
});
t('standalone value ranges mirror the Forge config schema (drift guard)', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'orchestration', 'FORGE_CONFIG_SCHEMA.json'), 'utf8'));
  for (const [k, key] of Object.entries(lb.CONFIG_KEYS)) {
    const spec = schema.settings[key];
    eq(JSON.stringify(lb.STANDALONE_RANGES[k]), JSON.stringify([spec.min, spec.max]), key);
    eq(spec.type, 'int', key);
  }
});

for (const line of results) console.log(line);
console.log(passed + ' passed, ' + failed + ' failed');
process.exitCode = failed ? 1 : 0;
