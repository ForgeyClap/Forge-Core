// App router P1 (design sections 4.2 and 4.3): selectTarget() is pure; these cases are the table
// from section 7.1 (in-order, spread, exhausted until resets_at, unknown-reset 60-min rule,
// unknown = eligible, threshold, per-model window, cooldown, 6/24 h cap, stickiness, capability
// upgrade back, return asap vs new-conversation, exhausted -> earliest resume_at + first_free,
// provider down -> next).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectTarget } from '../src/app-router/select.mjs';
import { defaultRouterConfig } from '../src/app-router/chain-schema.mjs';

const NOW = Date.parse('2026-11-02T14:00:00.000Z');
const MIN = 60_000;
const iso = (ms) => new Date(ms).toISOString();
const ACK = '2026-11-02T13:00:00.000Z';

const main = { id: 'main', kind: 'claude-account', label: 'Hoofdaccount', profile: null, enabled: true, threshold_pct: null };
const werk = { id: 'werk', kind: 'claude-account', label: 'Werk', profile: 'werk', enabled: true, threshold_pct: null };
const prive = { id: 'prive', kind: 'claude-account', label: 'Prive', profile: 'prive', enabled: true, threshold_pct: null };
const ollama = { id: 'ollama', kind: 'provider-model', label: 'Ollama', provider: 'ollama-local', model: 'llama3.1:8b', enabled: true, num_ctx: 8192, vars: {}, paid_ack: false, notice_ack: false };
const codex = { id: 'codex', kind: 'codex-account', label: 'Codex', profile: null, enabled: true };

function config({ mode = 'claude-accounts', entries = [main, werk, prive], multi = true, defaults = {} } = {}) {
  const d = defaultRouterConfig();
  return {
    ...d,
    mode,
    multi_account: multi ? { enabled: true, acknowledged_at: ACK } : { enabled: false, acknowledged_at: null },
    defaults: { ...d.defaults, ...defaults },
    entries,
  };
}
const fresh = (pct, type = 'five_hour') => ({ measured_at: iso(NOW - MIN), source: 'turn', windows: [{ type, pct, resets_at: iso(NOW + 120 * MIN), status: 'allowed' }], limit_hit: null, needs_login_at: null, down_at: null, last_used_at: null });
const hit = (resetsInMin, atMinAgo = 1) => ({ measured_at: null, source: null, windows: [], limit_hit: { at: iso(NOW - atMinAgo * MIN), resets_at: resetsInMin == null ? null : iso(NOW + resetsInMin * MIN), window: 'five_hour' }, needs_login_at: null, down_at: null, last_used_at: null });
const used = (minAgo) => ({ measured_at: null, source: null, windows: [], limit_hit: null, needs_login_at: null, down_at: null, last_used_at: iso(NOW - minAgo * MIN) });
const conv = (target_id, switchedMinAgo = null, proactive = 0) => ({ target_id, switched_at: switchedMinAgo == null ? null : iso(NOW - switchedMinAgo * MIN), proactive_switches_24h: proactive });
const pick = (args) => selectTarget({ now: NOW, readings: {}, conv: null, ...args });

test('mode off -> off', () => {
  assert.deepEqual(pick({ config: config({ mode: 'off' }) }), { kind: 'off' });
});

test('in-order: a new conversation starts on the first eligible entry', () => {
  const r = pick({ config: config() });
  assert.equal(r.kind, 'target');
  assert.equal(r.entry.id, 'main');
  assert.equal(r.reason, 'first');
  assert.equal(r.switched, false);
  assert.equal(r.from, null);
  assert.equal(r.capability, 'full');
});

test('unknown usage is eligible (no reading at all)', () => {
  const r = pick({ config: config(), readings: {} });
  assert.equal(r.entry.id, 'main');
  assert.equal(r.state, 'unknown');
});

test('a near-limit entry is skipped for a new choice', () => {
  const r = pick({ config: config(), readings: { main: fresh(95) } });
  assert.equal(r.entry.id, 'werk');
  assert.equal(r.reason, 'first');
});

test('when every entry is near its limit, a new choice still uses the first one (it has room)', () => {
  const r = pick({ config: config(), readings: { main: fresh(95), werk: fresh(96), prive: fresh(97) } });
  assert.equal(r.kind, 'target');
  assert.equal(r.entry.id, 'main');
});

test('spread: a new conversation starts on the Claude account used least recently', () => {
  const c = config({ defaults: { strategy: 'spread' } });
  const r = pick({ config: c, readings: { main: used(5), werk: used(60), prive: used(30) } });
  assert.equal(r.entry.id, 'werk');
  const never = pick({ config: c, readings: { main: used(5), werk: used(60) } });
  assert.equal(never.entry.id, 'prive', 'never used counts as least recent');
});

test('exhausted until resets_at, eligible again after it', () => {
  const readings = { main: hit(30) };
  assert.equal(pick({ config: config(), readings }).entry.id, 'werk');
  const later = selectTarget({ config: config(), readings, conv: null, now: NOW + 31 * MIN });
  assert.equal(later.entry.id, 'main');
});

test('unknown reset time: 60-minute rule', () => {
  assert.equal(pick({ config: config(), readings: { main: hit(null, 59) } }).entry.id, 'werk');
  assert.equal(pick({ config: config(), readings: { main: hit(null, 61) } }).entry.id, 'main');
});

test('threshold per entry overrides the default', () => {
  const low = { ...main, threshold_pct: 60 };
  const r = pick({ config: config({ entries: [low, werk] }), readings: { main: fresh(65) } });
  assert.equal(r.entry.id, 'werk');
  const r2 = pick({ config: config({ entries: [main, werk] }), readings: { main: fresh(65) } });
  assert.equal(r2.entry.id, 'main');
});

test('per-model window only counts for that model', () => {
  const readings = { main: fresh(97, 'seven_day_opus') };
  assert.equal(pick({ config: config(), readings, requestedModel: 'opus' }).entry.id, 'werk');
  assert.equal(pick({ config: config(), readings, requestedModel: 'sonnet' }).entry.id, 'main');
});

test('sticky: a conversation stays on its eligible target', () => {
  const r = pick({ config: config(), conv: conv('werk', 30), readings: { werk: fresh(40) } });
  assert.equal(r.entry.id, 'werk');
  assert.equal(r.reason, 'sticky');
  assert.equal(r.switched, false);
});

test('proactive switch at the threshold when cooldown has passed', () => {
  const r = pick({ config: config(), conv: conv('main', 11), readings: { main: fresh(93) } });
  assert.equal(r.entry.id, 'werk');
  assert.equal(r.reason, 'switch-threshold');
  assert.equal(r.switched, true);
  assert.equal(r.proactive, true);
  assert.deepEqual(r.from, { target_id: 'main', label: 'Hoofdaccount', kind: 'claude-account', window: 'five_hour', pct: 93, resume_at: null });
});

test('cooldown blocks a proactive switch: the turn stays on the current target', () => {
  const r = pick({ config: config(), conv: conv('main', 5), readings: { main: fresh(93) } });
  assert.equal(r.entry.id, 'main');
  assert.equal(r.reason, 'sticky');
  assert.equal(r.switched, false);
});

test('the 6-per-24-hours cap blocks a seventh proactive switch', () => {
  const r = pick({ config: config(), conv: conv('main', 60, 6), readings: { main: fresh(93) } });
  assert.equal(r.entry.id, 'main');
  assert.equal(r.reason, 'sticky');
  const r5 = pick({ config: config(), conv: conv('main', 60, 5), readings: { main: fresh(93) } });
  assert.equal(r5.entry.id, 'werk');
});

test('a real limit always switches, cooldown or not', () => {
  const r = pick({ config: config(), conv: conv('main', 1, 6), readings: { main: hit(40) } });
  assert.equal(r.entry.id, 'werk');
  assert.equal(r.reason, 'switch-limit');
  assert.equal(r.proactive, false);
  assert.equal(r.from.resume_at, iso(NOW + 40 * MIN));
  assert.equal(r.from.window, 'five_hour');
});

test('failover with exclude: attempt 2 never picks the excluded target, reason from the failover', () => {
  const r = pick({ config: config(), conv: conv('main', 1), exclude: ['main'], failover: 'rate_limited' });
  assert.equal(r.entry.id, 'werk');
  assert.equal(r.reason, 'switch-limit');
  const login = pick({ config: config(), conv: conv('werk', 1), exclude: ['werk'], failover: 'logged_out' });
  assert.equal(login.entry.id, 'main');
  assert.equal(login.reason, 'switch-login');
  const down = pick({ config: config({ mode: 'model-first', multi: false, entries: [ollama, main] }), conv: conv('ollama', 1), exclude: ['ollama'], failover: 'down' });
  assert.equal(down.entry.id, 'main');
  assert.equal(down.reason, 'switch-down');
});

test('needs-login on the current extra profile switches with switch-login', () => {
  const readings = { werk: { ...used(1), needs_login_at: iso(NOW - MIN) } };
  const r = pick({ config: config(), conv: conv('werk', 1), readings });
  assert.equal(r.reason, 'switch-login');
  assert.notEqual(r.entry.id, 'werk');
});

test('provider down -> next entry (switch-down)', () => {
  const c = config({ mode: 'model-first', multi: false, entries: [ollama, main] });
  const r = pick({ config: c, conv: conv('ollama', 1), readings: { ollama: { ...used(1), down_at: iso(NOW - MIN) } } });
  assert.equal(r.entry.id, 'main');
  assert.equal(r.reason, 'switch-down');
  const fresh2 = pick({ config: c, readings: { ollama: { ...used(1), down_at: iso(NOW - MIN) } } });
  assert.equal(fresh2.entry.id, 'main', 'a new conversation also skips a down provider');
});

test('claude-then-model: all Claude accounts exhausted -> the model, with capability answers-only', () => {
  const c = config({ mode: 'claude-then-model', multi: false, entries: [main, ollama] });
  const r = pick({ config: c, conv: conv('main', 1), readings: { main: hit(50) } });
  assert.equal(r.entry.id, 'ollama');
  assert.equal(r.capability, 'answers-only');
  assert.equal(r.reason, 'switch-limit');
  assert.equal(r.from.target_id, 'main');
});

test('capability upgrade: back from a model to an eligible Claude account (cooldown passed)', () => {
  const c = config({ mode: 'claude-then-model', multi: false, entries: [main, ollama] });
  const r = pick({ config: c, conv: conv('ollama', 20), readings: { main: fresh(10) } });
  assert.equal(r.entry.id, 'main');
  assert.equal(r.reason, 'return');
  assert.equal(r.switched, true);
  assert.equal(r.proactive, true);
  const blocked = pick({ config: c, conv: conv('ollama', 2), readings: { main: fresh(10) } });
  assert.equal(blocked.entry.id, 'ollama', 'cooldown also holds the way back');
  assert.equal(blocked.reason, 'sticky');
});

test('codex is a capability downgrade too: read-answer, and the way back works', () => {
  const c = config({ mode: 'claude-then-model', multi: false, entries: [main, codex] });
  const down = pick({ config: c, conv: conv('main', 1), readings: { main: hit(50) } });
  assert.equal(down.entry.id, 'codex');
  assert.equal(down.capability, 'read-answer');
  const back = pick({ config: c, conv: conv('codex', 20), readings: {} });
  assert.equal(back.entry.id, 'main');
  assert.equal(back.reason, 'return');
});

test('model-first: no upgrade back to Claude (the model is the first choice)', () => {
  const c = config({ mode: 'model-first', multi: false, entries: [ollama, main] });
  const r = pick({ config: c, conv: conv('ollama', 60), readings: { main: fresh(1) } });
  assert.equal(r.entry.id, 'ollama');
  assert.equal(r.reason, 'sticky');
});

test('model-first: back to the own model after it was down, once the cooldown allows; no flip-flop inside the cooldown', () => {
  const c = config({ mode: 'model-first', multi: false, entries: [ollama, main] });
  const downNow = { ollama: { ...used(1), down_at: iso(NOW - MIN) } };
  const away = pick({ config: c, conv: conv('ollama', 30), readings: downNow });
  assert.deepEqual([away.entry.id, away.reason, away.switched], ['main', 'switch-down', true], 'Ollama down: the conversation moves to main');
  // Ollama answers again (the 2-minute down hold is over), but the move to main was only 5 minutes ago.
  const upAgain = { ollama: { ...used(1), down_at: iso(NOW - 5 * MIN) } };
  const cool = pick({ config: c, conv: conv('main', 5), readings: upAgain });
  assert.deepEqual([cool.entry.id, cool.reason, cool.switched], ['main', 'sticky', false], 'no flip-flop within the cooldown');
  const back = pick({ config: c, conv: conv('main', 11), readings: upAgain });
  assert.deepEqual([back.entry.id, back.reason, back.switched, back.proactive], ['ollama', 'return', true, true], 'the next choice after the cooldown returns to the own model');
  assert.equal(back.capability, 'answers-only');
  assert.equal(back.from.target_id, 'main');
  const capped = pick({ config: c, conv: conv('main', 60, 6), readings: upAgain });
  assert.deepEqual([capped.entry.id, capped.reason], ['main', 'sticky'], 'the 6-per-24-hours cap holds the way back too');
  const stillDown = pick({ config: c, conv: conv('main', 11), readings: downNow });
  assert.deepEqual([stillDown.entry.id, stillDown.reason], ['main', 'sticky'], 'a model that is still down is no way back');
});

test('model-first with Codex first: back to Codex once its limit is free again (cooldown permitting)', () => {
  const c = config({ mode: 'model-first', multi: false, entries: [codex, main] });
  const limited = pick({ config: c, conv: conv('main', 20), readings: { codex: hit(30) } });
  assert.deepEqual([limited.entry.id, limited.reason], ['main', 'sticky']);
  const free = pick({ config: c, conv: conv('main', 20), readings: { codex: hit(-1, 70) } });
  assert.deepEqual([free.entry.id, free.reason, free.capability], ['codex', 'return', 'read-answer']);
});

test('claude-then-model never returns to a model: only model-first prefers the own model', () => {
  const c = config({ mode: 'claude-then-model', multi: false, entries: [main, ollama] });
  const r = pick({ config: c, conv: conv('main', 60), readings: { main: fresh(10) } });
  assert.deepEqual([r.entry.id, r.reason], ['main', 'sticky']);
});

test('return new-conversation (default): a conversation on werk stays there when main is free again', () => {
  const r = pick({ config: config(), conv: conv('werk', 60), readings: { main: fresh(5), werk: fresh(10) } });
  assert.equal(r.entry.id, 'werk');
  assert.equal(r.reason, 'sticky');
  assert.equal(pick({ config: config(), readings: { main: fresh(5) } }).entry.id, 'main', 'a new conversation starts at the top');
});

test('return asap: switches back to the earlier Claude account (cooldown permitting)', () => {
  const c = config({ defaults: { return: 'asap' } });
  const r = pick({ config: c, conv: conv('werk', 60), readings: { main: fresh(5) } });
  assert.equal(r.entry.id, 'main');
  assert.equal(r.reason, 'return');
  const cool = pick({ config: c, conv: conv('werk', 3), readings: { main: fresh(5) } });
  assert.equal(cool.entry.id, 'werk');
});

test('a target that left the chain (disabled) is replaced', () => {
  const c = config({ entries: [main, { ...werk, enabled: false }, prive] });
  const r = pick({ config: c, conv: conv('werk', 1) });
  assert.equal(r.entry.id, 'main');
  assert.equal(r.switched, true);
  assert.equal(r.from.target_id, 'werk');
});

test('everything exhausted -> exhausted with the earliest known resume_at and first_free', () => {
  const r = pick({ config: config(), readings: { main: hit(90), werk: hit(20), prive: hit(null, 5) } });
  assert.equal(r.kind, 'exhausted');
  assert.equal(r.resume_at, iso(NOW + 20 * MIN));
  assert.deepEqual(r.first_free, { target_id: 'werk', label: 'Werk' });
});

test('earliest resume_at wins regardless of chain order', () => {
  const r = pick({ config: config(), readings: { main: hit(20), werk: hit(90), prive: hit(45) } });
  assert.equal(r.resume_at, iso(NOW + 20 * MIN));
  assert.deepEqual(r.first_free, { target_id: 'main', label: 'Hoofdaccount' });
});

test('everything exhausted with unknown times -> resume_at null, never an invented time', () => {
  const r = pick({ config: config(), readings: { main: hit(null, 1), werk: hit(null, 2), prive: hit(null, 3) } });
  assert.deepEqual(r, { kind: 'exhausted', resume_at: null, first_free: null });
});

test('exclude alone can exhaust the chain (attempt 2 with nothing left)', () => {
  const c = config({ mode: 'claude-then-model', multi: false, entries: [main, ollama] });
  const r = pick({ config: c, conv: conv('main', 1), exclude: ['main', 'ollama'], failover: 'rate_limited' });
  assert.equal(r.kind, 'exhausted');
});

test('the multi-account gate: with it off only the first Claude account is used', () => {
  const c = config({ mode: 'claude-then-model', multi: false, entries: [main, werk, ollama] });
  const r = pick({ config: c, readings: { main: hit(30) } });
  assert.equal(r.entry.id, 'ollama', 'werk is greyed out by the gate, so the model is next');
});

test('selectTarget is pure: inputs are not changed', () => {
  const c = config();
  const readings = { main: fresh(95) };
  const before = JSON.stringify({ c, readings });
  pick({ config: c, readings, conv: conv('main', 30) });
  assert.equal(JSON.stringify({ c, readings }), before);
});
