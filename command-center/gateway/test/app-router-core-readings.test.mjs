// App router P1 (design section 4.4 + the state table in 4.2): usage readings from the stream-json
// rate_limit_event lines (both observed shapes), the token-free usage store, and targetState().
// Everything is written into a temp folder.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readingFromStreamLine,
  recordReading,
  recordLimitHit,
  markNeedsLogin,
  markDown,
  markUsed,
  readReadings,
  targetState,
} from '../src/app-router/usage-readings.mjs';
import { _setRouterDirForTests } from '../src/app-router/chain-store.mjs';
import { scanBuffer } from '../../desktop/scripts/distribution-check.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const lines = (rel) => fs.readFileSync(path.join(HERE, 'fixtures', rel), 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
const [ALLOWED_WARNING, ALLOWED_PLAIN] = lines('stream-json/rate-limit-allowed.jsonl');
const [REJECTED] = lines('stream-json/rate-limit-rejected.jsonl');
const [UNIFIED] = lines('app-router/rate-limit-unified.jsonl');

const NOW = Date.parse('2026-11-02T14:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const MIN = 60_000;

let tempDir;
let dir;
before(() => { tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-approuter-readings-')); });
after(() => {
  _setRouterDirForTests(null);
  fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
});
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(tempDir, 'case-'));
  _setRouterDirForTests(dir);
});

// ---- readingFromStreamLine ----------------------------------------------------------------------

test('shape (a), recorded allowed_warning: utilization 0.9 becomes 90 %, epoch becomes ISO', () => {
  const r = readingFromStreamLine(ALLOWED_WARNING);
  assert.deepEqual(r, {
    status: 'allowed_warning',
    windows: [{ type: 'seven_day', pct: 90, resets_at: new Date(1785355200 * 1000).toISOString(), status: 'allowed_warning' }],
  });
});

test('shape (a) without utilization: pct is null, never 0', () => {
  const r = readingFromStreamLine(ALLOWED_PLAIN);
  assert.equal(r.status, 'allowed');
  assert.equal(r.windows.length, 1);
  assert.equal(r.windows[0].type, 'five_hour');
  assert.equal(r.windows[0].pct, null);
  assert.equal(r.windows[0].resets_at, new Date(1785286800 * 1000).toISOString());
});

test('shape (a) rejected keeps the rejected status', () => {
  const r = readingFromStreamLine(REJECTED);
  assert.equal(r.status, 'rejected');
  assert.equal(r.windows[0].status, 'rejected');
  assert.equal(r.windows[0].pct, null);
});

test('shape (b) unifiedWindows: one window per entry, rounded to one decimal', () => {
  const r = readingFromStreamLine(UNIFIED);
  assert.equal(r.status, 'allowed');
  assert.deepEqual(r.windows.map((w) => [w.type, w.pct]), [['five_hour', 42], ['seven_day', 13.7]]);
  assert.equal(r.windows[0].resets_at, new Date(1785286800 * 1000).toISOString());
});

test('non-rate-limit lines and broken shapes give null, never a throw', () => {
  for (const bad of [null, undefined, 'x', {}, { type: 'result' }, { type: 'rate_limit_event' }, { type: 'rate_limit_event', rate_limit_info: 'x' }]) {
    assert.equal(readingFromStreamLine(bad), null);
  }
});

test('odd values are cleaned: bad utilization -> null, bad type -> other, ms epoch accepted', () => {
  const r = readingFromStreamLine({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'Weird Type!', utilization: 'lots', resetsAt: 1785286800000 } });
  assert.equal(r.windows[0].pct, null);
  assert.equal(r.windows[0].type, 'other');
  assert.equal(r.windows[0].resets_at, new Date(1785286800000).toISOString());
  const r2 = readingFromStreamLine({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour', utilization: 7, resetsAt: 'not a date' } });
  assert.equal(r2.windows[0].pct, null, 'utilization above 1 is not a fraction: unknown, not 700 %');
  assert.equal(r2.windows[0].resets_at, null);
});

// ---- store ----------------------------------------------------------------------------------------

test('recordReading stores numbers and timestamps only; readReadings returns them', () => {
  recordReading('werk', readingFromStreamLine(ALLOWED_WARNING), { source: 'turn', now: NOW });
  const all = readReadings();
  assert.deepEqual(Object.keys(all), ['werk']);
  assert.equal(all.werk.measured_at, iso(NOW));
  assert.equal(all.werk.source, 'turn');
  assert.equal(all.werk.windows[0].pct, 90);
  assert.equal(all.werk.limit_hit, null);
});

test('a rejected reading records a limit hit with the window and reset time', () => {
  recordReading('werk', readingFromStreamLine(REJECTED), { now: NOW });
  const rec = readReadings().werk;
  assert.deepEqual(rec.limit_hit, { at: iso(NOW), resets_at: new Date(1785286800 * 1000).toISOString(), window: 'five_hour' });
});

test('a later allowed reading clears an earlier limit hit and a needs-login mark', () => {
  recordLimitHit('werk', { resets_at: null, window: 'five_hour', now: NOW });
  markNeedsLogin('werk', { now: NOW });
  recordReading('werk', readingFromStreamLine(ALLOWED_PLAIN), { now: NOW + MIN });
  const rec = readReadings().werk;
  assert.equal(rec.limit_hit, null);
  assert.equal(rec.needs_login_at, null);
});

test('markers: limit hit, needs login, down, last used', () => {
  recordLimitHit('a', { resets_at: iso(NOW + 30 * MIN), window: 'seven_day', now: NOW });
  markNeedsLogin('b', { now: NOW });
  markDown('c', { now: NOW });
  markUsed('a', { now: NOW + 1 });
  const all = readReadings();
  assert.deepEqual(all.a.limit_hit, { at: iso(NOW), resets_at: iso(NOW + 30 * MIN), window: 'seven_day' });
  assert.equal(all.a.last_used_at, iso(NOW + 1));
  assert.equal(all.b.needs_login_at, iso(NOW));
  assert.equal(all.c.down_at, iso(NOW));
});

test('bad target ids are refused and never written', () => {
  assert.equal(recordReading('../x', readingFromStreamLine(ALLOWED_PLAIN), { now: NOW }), null);
  assert.equal(markUsed('Bad Id', { now: NOW }), null);
  assert.deepEqual(readReadings(), {});
});

test('a corrupt usage file reads as empty, and the next write repairs it', () => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'usage.json'), '{not json', 'utf8');
  assert.deepEqual(readReadings(), {});
  markUsed('main', { now: NOW });
  assert.equal(readReadings().main.last_used_at, iso(NOW));
});

test('the usage file is token-free: no never-ship needle and no free text from the line', () => {
  const planted = { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour', utilization: 0.5, resetsAt: 1785286800, note: 'sk' + '-ant-oat01-' + 'Z'.repeat(30), overageDisabledReason: 'org_level_disabled' } };
  recordReading('main', readingFromStreamLine(planted), { now: NOW });
  recordReading('werk', readingFromStreamLine(UNIFIED), { now: NOW });
  const bytes = fs.readFileSync(path.join(dir, 'usage.json'));
  assert.deepEqual(scanBuffer(bytes), []);
  const text = bytes.toString('utf8');
  assert.doesNotMatch(text, /org_level_disabled|oat01|session_id|uuid/);
});

// ---- targetState ----------------------------------------------------------------------------------

const MAIN = { id: 'main', kind: 'claude-account', label: 'Hoofd', profile: null, enabled: true, threshold_pct: null };
const WERK = { id: 'werk', kind: 'claude-account', label: 'Werk', profile: 'werk', enabled: true, threshold_pct: 80 };
const OLLAMA = { id: 'ollama', kind: 'provider-model', label: 'Ollama', provider: 'ollama-local', model: 'llama3.1:8b', enabled: true };
const CODEX = { id: 'codex', kind: 'codex-account', label: 'Codex', profile: null, enabled: true };
const reading = (windows, at = NOW) => ({ measured_at: iso(at), source: 'turn', windows, limit_hit: null, needs_login_at: null, down_at: null, last_used_at: null });
const win = (type, pct, resetsInMin = 120) => ({ type, pct, resets_at: iso(NOW + resetsInMin * MIN), status: 'allowed' });

test('no reading: a Claude account is unknown but eligible', () => {
  const s = targetState(MAIN, null, { now: NOW });
  assert.equal(s.state, 'unknown');
  assert.equal(s.eligible, true);
  assert.equal(s.max_pct, null);
});

test('below the threshold is ready; at or above is near-limit (entry threshold wins)', () => {
  assert.equal(targetState(MAIN, reading([win('five_hour', 91.9)]), { now: NOW }).state, 'ready');
  const near = targetState(MAIN, reading([win('five_hour', 92)]), { now: NOW });
  assert.equal(near.state, 'near-limit');
  assert.equal(near.eligible, false);
  assert.equal(near.max_pct, 92);
  assert.equal(near.max_window, 'five_hour');
  assert.equal(targetState(WERK, reading([win('five_hour', 80)]), { now: NOW }).state, 'near-limit');
  assert.equal(targetState(MAIN, reading([win('five_hour', 85)]), { now: NOW, defaultThresholdPct: 85 }).state, 'near-limit');
});

test('a fresh reading that says allowed without a number is ready (room ok, no percentage)', () => {
  const s = targetState(MAIN, reading([{ type: 'five_hour', pct: null, resets_at: iso(NOW + MIN), status: 'allowed' }]), { now: NOW });
  assert.equal(s.state, 'ready');
  assert.equal(s.max_pct, null);
});

test('a stale reading (> 15 min) is unknown', () => {
  const s = targetState(MAIN, reading([win('five_hour', 95)], NOW - 16 * MIN), { now: NOW });
  assert.equal(s.state, 'unknown');
  assert.equal(s.stale, true);
  assert.equal(s.eligible, true);
});

test('a window whose reset time has passed no longer counts', () => {
  const s = targetState(MAIN, reading([win('five_hour', 99, -1)]), { now: NOW });
  assert.equal(s.state, 'unknown');
});

test('exhausted while the reset time is in the future; free again after it', () => {
  const rec = { ...reading([]), limit_hit: { at: iso(NOW - 5 * MIN), resets_at: iso(NOW + 20 * MIN), window: 'five_hour' } };
  const s = targetState(MAIN, rec, { now: NOW });
  assert.equal(s.state, 'exhausted');
  assert.equal(s.eligible, false);
  assert.equal(s.resume_at, iso(NOW + 20 * MIN));
  assert.notEqual(targetState(MAIN, rec, { now: NOW + 21 * MIN }).state, 'exhausted');
});

test('unknown reset time: exhausted for 60 minutes after the hit, then not', () => {
  const rec = { ...reading([]), limit_hit: { at: iso(NOW), resets_at: null, window: null } };
  assert.equal(targetState(MAIN, rec, { now: NOW + 59 * MIN }).state, 'exhausted');
  assert.equal(targetState(MAIN, rec, { now: NOW + 59 * MIN }).resume_at, null);
  assert.notEqual(targetState(MAIN, rec, { now: NOW + 61 * MIN }).state, 'exhausted');
});

test('needs-login applies to extra profiles only, never to main', () => {
  const rec = { ...reading([]), needs_login_at: iso(NOW) };
  assert.equal(targetState(WERK, rec, { now: NOW }).state, 'needs-login');
  assert.equal(targetState(WERK, rec, { now: NOW }).eligible, false);
  assert.notEqual(targetState(MAIN, rec, { now: NOW }).state, 'needs-login');
});

test('down holds for 2 minutes', () => {
  const rec = { ...reading([]), down_at: iso(NOW) };
  assert.equal(targetState(OLLAMA, rec, { now: NOW + 119_000 }).state, 'down');
  assert.equal(targetState(OLLAMA, rec, { now: NOW + 121_000 }).state, 'ready');
});

test('a provider model without readings is ready; codex without readings is unknown', () => {
  assert.equal(targetState(OLLAMA, null, { now: NOW }).state, 'ready');
  assert.equal(targetState(CODEX, null, { now: NOW }).state, 'unknown');
});

test('per-model windows count only for that model family or when no model is asked', () => {
  const rec = reading([win('five_hour', 10), win('seven_day_opus', 97)]);
  assert.equal(targetState(MAIN, rec, { now: NOW }).state, 'near-limit');
  assert.equal(targetState(MAIN, rec, { now: NOW, requestedModel: 'opus' }).state, 'near-limit');
  assert.equal(targetState(MAIN, rec, { now: NOW, requestedModel: 'claude-sonnet-5-5' }).state, 'ready');
  const hit = { ...reading([]), limit_hit: { at: iso(NOW), resets_at: iso(NOW + 60 * MIN), window: 'seven_day_opus' } };
  assert.equal(targetState(MAIN, hit, { now: NOW, requestedModel: 'sonnet' }).state, 'unknown');
  assert.equal(targetState(MAIN, hit, { now: NOW, requestedModel: 'opus' }).state, 'exhausted');
});

test('precedence: exhausted beats needs-login beats down beats near-limit', () => {
  const rec = { ...reading([win('five_hour', 99)]), limit_hit: { at: iso(NOW), resets_at: iso(NOW + MIN), window: 'five_hour' }, needs_login_at: iso(NOW), down_at: iso(NOW) };
  assert.equal(targetState(WERK, rec, { now: NOW }).state, 'exhausted');
  assert.equal(targetState(WERK, { ...rec, limit_hit: null }, { now: NOW }).state, 'needs-login');
  assert.equal(targetState(WERK, { ...rec, limit_hit: null, needs_login_at: null }, { now: NOW }).state, 'down');
});
