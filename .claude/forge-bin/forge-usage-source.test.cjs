#!/usr/bin/env node
'use strict';
/**
 * forge-usage-source.test.cjs — SA-P1-USAGE (PHASE2-PLAN A1): the lane budget must not say "usage onbekend" while a
 * newer real reading exists (FORGE_USAGE_PRESSURE.json), and must use (and NAME) the rotator account a session runs on
 * instead of the default login. Every file lives in a fresh OS-temp folder; env seams are set before require, so the
 * real ~/.claude files are never read or written. Rework 2026-11-04: the account is the one the launcher NAMED in the
 * session env (FORGE_ROTATOR_ACCOUNT), never a guess from launch timestamps; with no marker and no setup token in the
 * env the default-login reading applies. Run: node --test forge-usage-source.test.cjs (prints the "N passed, M failed"
 * tally the doctor reads).
 */
const { test: nodeTest, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

let passed = 0; let failed = 0;
function test(name, fn) { nodeTest(name, async () => { try { await fn(); passed++; } catch (e) { failed++; throw e; } }); }
after(() => { console.log(passed + ' passed, ' + failed + ' failed'); });

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-usage-source-'));
process.on('exit', () => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* best effort */ } });
const CFG_HOME = path.join(ROOT, 'cfg');
const PROJ = path.join(ROOT, 'proj');
fs.mkdirSync(CFG_HOME, { recursive: true });
fs.mkdirSync(path.join(PROJ, '.claude'), { recursive: true });
Object.assign(process.env, { FORGE_CONFIG_HOME: CFG_HOME, FORGE_PROJECT_ROOT: PROJ, FORGE_LANE_BUDGET_HINT: path.join(ROOT, 'hint.json') });
for (const k of ['FORGE_USAGE_GUARD_STATE', 'FORGE_USAGE_PRESSURE_FILE', 'FORGE_ACCOUNT_ROTATOR_HOME', 'FORGE_LANE_BUDGET_ROTATOR', 'FORGE_LANE_BUDGET_GUARD', 'FORGE_ROTATOR_ACCOUNT', 'CLAUDE_CODE_OAUTH_TOKEN']) delete process.env[k];

const src = require('./forge-usage-source.cjs');
const lb = require('./forge-lane-budget.cjs');

const NOW = Date.parse('2026-11-04T21:30:00Z');
const MIN = 60000;
const ROOMY = { ramUsedPct: 40, freeDiskGB: 200, cpus: 32 };
const CFG = { max: 10, min: 1, stopAt: 80, fullUntil: 20, unknownLanes: 4 };
const iso = (ms) => new Date(ms).toISOString();
let seq = 0;

/** home(files) -> a fresh fake ~/.claude with the given guard state / pressure / rotator state; returns paths. */
function home(files) {
  const dir = path.join(ROOT, 'home-' + (++seq));
  fs.mkdirSync(path.join(dir, 'forge-accounts'), { recursive: true });
  const stateFile = path.join(dir, 'FORGE_USAGE_GUARD_STATE.json');
  if (files.state) fs.writeFileSync(stateFile, JSON.stringify(files.state));
  if (files.pressure) fs.writeFileSync(path.join(dir, 'FORGE_USAGE_PRESSURE.json'), JSON.stringify(files.pressure));
  if (files.rotator) fs.writeFileSync(path.join(dir, 'forge-accounts', 'state.json'), JSON.stringify(files.rotator));
  return { dir, stateFile };
}
const line = (h, extra) => lb.budgetLine(Object.assign({ now: NOW, stateFile: h.stateFile, cwd: PROJ, cfg: CFG, resources: ROOMY, env: {} }, extra || {}));

// the exact shape found on this machine on 2026-11-04: STATE last checked 2026-10-14 with HTTP 429
const OLD_429_STATE = { mode: 'ok', percents: { session: 7, week: 92 }, lastCheckAt: '2026-10-14T05:29:36.307Z', lastError: 'usage endpoint HTTP 429' };
const pressureAt = (ms, week) => ({ level: 'normal', week, nvidia_shift_at: 99, pause_at: 99, updated_at: iso(ms) });
const win = (kind, pct, resetMs) => ({ id: kind + '|' + kind, kind, label: kind, pct, resetsAt: resetMs ? iso(resetMs) : null });
const tokenReading = (o) => Object.assign({ source: 'live', measuredAt: iso(NOW - 5 * MIN), windows: [win('session', 12, NOW + 120 * MIN), win('weekly_all', 60, NOW + 3 * 1440 * MIN)] }, o);
const ON = (name) => ({ FORGE_ROTATOR_ACCOUNT: name }); // the launcher's non-secret marker in the session env
const TOKEN_ONLY = { CLAUDE_CODE_OAUTH_TOKEN: 'fake-presence-only' }; // an older launch: a setup token, no marker
const FRESH = { mode: 'ok', percents: { session: 5, week: 10 }, lastCheckAt: iso(NOW - 1 * MIN) };
const rotator = (tr, flags) => ({ version: 1, readings: {}, tokenReadings: tr, slotFlags: flags || {}, history: [], swaps: [], failures: [] });

// ---- defect 1: stale STATE, newer PRESSURE -----------------------------------------------------------------------
test('readPressure: week % + updated_at as the check time; the 5-hour side stays unknown (never invented)', () => {
  const h = home({ pressure: pressureAt(NOW - 2 * MIN, 96) });
  const p = src.readPressure({ file: path.join(h.dir, 'FORGE_USAGE_PRESSURE.json') });
  assert.equal(p.week.pct, 96);
  assert.equal(p.session.pct, null);
  assert.equal(p.checkAt, NOW - 2 * MIN);
  assert.equal(p.source, 'pressure');
});

test('readPressure: level unknown / week null / damaged file -> null', () => {
  const h = home({ pressure: { level: 'unknown', week: null, updated_at: iso(NOW) } });
  assert.equal(src.readPressure({ file: path.join(h.dir, 'FORGE_USAGE_PRESSURE.json') }), null);
  const bad = path.join(h.dir, 'bad.json');
  fs.writeFileSync(bad, '{not json');
  assert.equal(src.readPressure({ file: bad }), null);
  assert.equal(src.readPressure({ file: path.join(h.dir, 'missing.json') }), null);
});

test('RED A1: a 22-day-old failed STATE plus a fresh PRESSURE reading -> the real week %, not "usage onbekend"', () => {
  const h = home({ state: OLD_429_STATE, pressure: pressureAt(NOW - 2 * MIN, 96) });
  const l = line(h);
  assert.doesNotMatch(l, /usage onbekend/);
  assert.match(l, /week 96 %/);
  assert.match(l, /5 uur onbekend/, 'the pressure file has no 5-hour %, so the line must not show one');
  assert.match(l, /1 lane/);
});

test('readUsage: falls back to the newest source and reports its source + age', () => {
  const h = home({ state: OLD_429_STATE, pressure: pressureAt(NOW - 2 * MIN, 50) });
  const u = lb.readUsage({ stateFile: h.stateFile, now: NOW });
  assert.equal(u.source, 'pressure');
  assert.equal(u.stale, false);
  assert.equal(Math.round(u.ageMin), 2);
  assert.equal(u.week.pct, 50);
});

test('stale PRESSURE (2 hours) and no STATE -> unknown, and the line says how old the reading is', () => {
  const h = home({ pressure: pressureAt(NOW - 120 * MIN, 40) });
  const l = line(h);
  assert.match(l, /usage onbekend \(laatste meting 2 uur oud\)/);
  assert.doesNotMatch(l, /40 %/, 'a stale number is never shown as the current one');
});

test('a fresh, trusted STATE wins over a newer PRESSURE (keeps the real 5-hour %)', () => {
  const st = { mode: 'ok', percents: { session: 30, week: 40 }, lastCheckAt: iso(NOW - 10 * MIN) };
  const h = home({ state: st, pressure: pressureAt(NOW - 1 * MIN, 41) });
  const l = line(h);
  assert.match(l, /week 40 %, 5 uur 30 %/);
});

// ---- defect 2: the session runs on a rotator account --------------------------------------------------------------
test('RED A1: a rotator-launched account with a fresh live reading is used AND named in the line', () => {
  const h = home({ state: OLD_429_STATE, pressure: pressureAt(NOW - 2 * MIN, 96), rotator: rotator({ oac: tokenReading({ lastUsedAt: iso(NOW - 3 * 60 * MIN) }), zeeco: tokenReading({ lastUsedAt: iso(NOW - 2 * 1440 * MIN), windows: [win('weekly_all', 96)] }) }) });
  const l = line(h, { env: ON('oac') });
  assert.match(l, /account oac via rotator/);
  assert.match(l, /week 60 %, 5 uur 12 %/);
  assert.match(l, /5 lanes/, 'p = 60 % -> 5 lanes at the defaults');
  assert.doesNotMatch(l, /96/, 'the default login reading must not leak into a rotator session line');
});

test('older launch (setup token, no marker): the newest launch is a LABELLED guess, readUsage shape', () => {
  const h = home({ rotator: rotator({ a1: tokenReading({ lastUsedAt: iso(NOW - 60 * MIN) }), b2: tokenReading({ lastUsedAt: iso(NOW - 10 * MIN), windows: [win('weekly_all', 33)] }) }) });
  const r = src.rotatorAccount({ file: path.join(h.dir, 'forge-accounts', 'state.json'), now: NOW, env: TOKEN_ONLY });
  assert.equal(r.name, 'b2');
  assert.equal(r.via, 'token-guess');
  assert.equal(r.guess, true);
  assert.match(line(h, { env: TOKEN_ONLY }), /\(vermoedelijk account b2 via rotator\)/);
  assert.equal(r.usage.week.pct, 33);
  assert.equal(r.usage.session.pct, null);
  assert.equal(r.usage.source, 'rotator');
  assert.equal(r.usage.stale, false);
});

test('a stale rotator reading says so with its age, names the account, shows no number and no refresh command', () => {
  const h = home({ state: { mode: 'ok', percents: { session: 5, week: 10 }, lastCheckAt: iso(NOW - 1 * MIN) }, rotator: rotator({ oac: tokenReading({ lastUsedAt: iso(NOW - 3 * 60 * MIN), measuredAt: iso(NOW - 120 * MIN) }) }) });
  const guard = path.join(ROOT, 'fake-guard.cjs');
  fs.writeFileSync(guard, 'module.exports = {};\n');
  process.env.FORGE_LANE_BUDGET_GUARD = guard; // a reachable guard: the default-login refresh hint WOULD be offered
  let l;
  try { l = line(h, { env: ON('oac'), hintFile: path.join(ROOT, 'hint-' + (++seq) + '.json') }); } finally { delete process.env.FORGE_LANE_BUDGET_GUARD; }
  assert.match(l, /account oac via rotator/);
  assert.match(l, /usage onbekend \(laatste meting 2 uur oud\)/);
  assert.doesNotMatch(l, /60 %|10 %/);
  assert.doesNotMatch(l, /--refresh/, 'the refresh measures the DEFAULT login, never offered for a rotator account');
});

test('an unmeasurable token reading is unknown, never a number', () => {
  const h = home({ rotator: rotator({ oac: tokenReading({ lastUsedAt: iso(NOW - 5 * MIN), unmeasurable: { at: iso(NOW - 5 * MIN), status: 401 } }) }) });
  const l = line(h, { env: ON('oac') });
  assert.match(l, /account oac via rotator/);
  assert.match(l, /usage onbekend/);
});

test('guess path: an org-blocked latest launch is skipped (same rule as the rotator itself)', () => {
  const h = home({ rotator: rotator({ blk: tokenReading({ lastUsedAt: iso(NOW - 1 * MIN), windows: [win('weekly_all', 1)] }), oac: tokenReading({ lastUsedAt: iso(NOW - 30 * MIN) }) }, { blk: { orgBlocked: { at: iso(NOW - 100 * MIN), reason: 'x' } } }) });
  assert.match(line(h, { env: TOKEN_ONLY }), /vermoedelijk account oac via rotator/);
});

test('guess path never names: a launch older than 7 days, an unsafe account name; opt-out and an unsafe marker are ignored', () => {
  const old = home({ state: FRESH, rotator: rotator({ oac: tokenReading({ lastUsedAt: iso(NOW - 8 * 1440 * MIN) }) }) });
  assert.doesNotMatch(line(old, { env: TOKEN_ONLY }), /oac/);
  const odd = home({ state: FRESH, rotator: rotator({ 'bad name;x': tokenReading({ lastUsedAt: iso(NOW - 5 * MIN) }) }) });
  assert.doesNotMatch(line(odd, { env: TOKEN_ONLY }), /bad name/);
  const off = home({ state: FRESH, rotator: rotator({ oac: tokenReading({ lastUsedAt: iso(NOW - 5 * MIN) }) }) });
  const offEnv = Object.assign({ FORGE_LANE_BUDGET_ROTATOR: 'off' }, ON('oac'));
  assert.doesNotMatch(line(off, { env: offEnv }), /rotator/);
  assert.match(line(off, { env: offEnv }), /week 10 %/);
  assert.doesNotMatch(line(off, { env: ON('bad name;x') }), /rotator|bad name/, 'an unsafe marker is no marker');
  assert.match(line(off, { env: ON('bad name;x') }), /week 10 %/);
});

test('a damaged rotator state: a marked session is still named but its usage is unknown (no number)', () => {
  const dmg = home({ state: FRESH });
  fs.writeFileSync(path.join(dmg.dir, 'forge-accounts', 'state.json'), '{oops');
  const l = line(dmg, { env: ON('oac') });
  assert.match(l, /account oac via rotator/);
  assert.match(l, /usage onbekend/);
  assert.doesNotMatch(l, /10 %/, 'the default-login reading is another account, never shown for oac');
  assert.match(line(dmg), /week 10 %/, 'unmarked session: default login');
});

test('a window whose reset time has passed is unknown (that number is no longer true)', () => {
  const h = home({ rotator: rotator({ oac: tokenReading({ lastUsedAt: iso(NOW - 5 * MIN), windows: [win('session', 90, NOW - 1 * MIN), win('weekly_all', 60, NOW + 1440 * MIN)] }) }) });
  const r = src.rotatorAccount({ file: path.join(h.dir, 'forge-accounts', 'state.json'), now: NOW, env: ON('oac') });
  assert.equal(r.usage.session.pct, null);
  assert.equal(r.usage.week.pct, 60);
  assert.ok(r.usage.notes.some((n) => /reset/.test(n)));
});

test('weekly: weekly_all is preferred; without it the highest weekly window counts', () => {
  const h = home({ rotator: rotator({ oac: tokenReading({ lastUsedAt: iso(NOW - 5 * MIN), windows: [win('weekly_scoped', 70), win('weekly_scoped', 20)] }) }) });
  const r = src.rotatorAccount({ file: path.join(h.dir, 'forge-accounts', 'state.json'), now: NOW, env: ON('oac') });
  assert.equal(r.usage.week.pct, 70);
});

test('no rotator state at all -> unchanged default behaviour', () => {
  const h = home({ state: { mode: 'ok', percents: { session: 5, week: 10 }, lastCheckAt: iso(NOW - 1 * MIN) } });
  fs.rmSync(path.join(h.dir, 'forge-accounts'), { recursive: true, force: true });
  const l = line(h);
  assert.match(l, /^Lane-budget nu: 10 lanes \(week 10 %, 5 uur 5 %/);
});

// ---- rework: attribution comes from the session env, not from launch timestamps -----------------------------------
const rotFile = (h) => path.join(h.dir, 'forge-accounts', 'state.json');

test('RED rework: no marker + no setup token + a launch 5 min ago + a fresh default state -> default numbers, no rotator', () => {
  const h = home({ state: FRESH, rotator: rotator({ oac: tokenReading({ lastUsedAt: iso(NOW - 5 * MIN) }) }) });
  const l = line(h);
  assert.doesNotMatch(l, /rotator|oac/);
  assert.match(l, /week 10 %, 5 uur 5 %/);
  assert.equal(src.rotatorAccount({ file: rotFile(h), now: NOW, env: {} }), null);
});

test('RED rework: marker=oac while bussins was launched later -> oac (the marker wins over timestamps)', () => {
  const h = home({ state: FRESH, rotator: rotator({ oac: tokenReading({ lastUsedAt: iso(NOW - 3 * 60 * MIN) }), bussins: tokenReading({ lastUsedAt: iso(NOW - 2 * MIN), windows: [win('weekly_all', 1)] }) }) });
  const l = line(h, { env: ON('oac') });
  assert.match(l, /\(account oac via rotator\)/);
  assert.doesNotMatch(l, /vermoedelijk|bussins/);
  assert.match(l, /week 60 %/);
  const r = src.rotatorAccount({ file: rotFile(h), now: NOW, env: ON('oac') });
  assert.equal(r.via, 'marker');
  assert.equal(r.guess, false);
});

test('marker names an account the rotator state has no reading for -> named, usage unknown', () => {
  const h = home({ state: FRESH, rotator: rotator({ oac: tokenReading({ lastUsedAt: iso(NOW - 5 * MIN) }) }) });
  const l = line(h, { env: ON('zz9') });
  assert.match(l, /account zz9 via rotator/);
  assert.match(l, /usage onbekend \(geen meting gevonden\)/);
});

test('a marker is trusted even for an org-blocked or 8-day-old launch (the session itself says which account)', () => {
  const h = home({ rotator: rotator({ oac: tokenReading({ lastUsedAt: iso(NOW - 8 * 1440 * MIN) }) }, { oac: { orgBlocked: { at: iso(NOW - 10 * MIN), reason: 'x' } } }) });
  assert.match(line(h, { env: ON('oac') }), /account oac via rotator.*week 60 %/);
});

test('setup token without a marker and without any recent launch -> unknown account, unknown usage, never the default numbers', () => {
  const h = home({ state: FRESH, rotator: rotator({}) });
  const l = line(h, { env: TOKEN_ONLY });
  assert.match(l, /account onbekend\/unknown via rotator/);
  assert.match(l, /usage onbekend/);
  assert.doesNotMatch(l, /10 %/);
});

test('the setup token is checked for PRESENCE only: its value is never read', () => {
  const h = home({ rotator: rotator({ oac: tokenReading({ lastUsedAt: iso(NOW - 5 * MIN) }) }) });
  let reads = 0;
  const env = {};
  Object.defineProperty(env, 'CLAUDE_CODE_OAUTH_TOKEN', { enumerable: true, get() { reads++; return 'x'; } });
  const r = src.rotatorAccount({ file: rotFile(h), now: NOW, env });
  assert.equal(r.name, 'oac');
  assert.equal(reads, 0);
});
