// App router P1 (design docs/forge-systeem/APP-ROUTER-DESIGN.md sections 2.4 and 2.5): every
// validation rule, positive and negative, and the effective chain with the multi-account gate.
// Uses the real provider registry (read-only).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultRouterConfig, validateRouterConfig, effectiveChain, describeChain } from '../src/app-router/chain-schema.mjs';
import { MODES, ENTRY_KINDS, LIMITS } from '../src/app-router/contract.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLE = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'app-router', 'router-example.json'), 'utf8'));
const ACK = '2026-11-02T13:00:00.000Z';
// Built at runtime so this file never carries a credential-shaped literal.
const SECRET_LIKE = 'sk' + '-' + 'A'.repeat(24);

const main = (more = {}) => ({ id: 'main', kind: 'claude-account', label: 'Hoofdaccount', profile: null, enabled: true, threshold_pct: null, ...more });
const extra = (id, more = {}) => ({ id, kind: 'claude-account', label: id, profile: id, enabled: true, threshold_pct: null, ...more });
const ollama = (more = {}) => ({ id: 'ollama', kind: 'provider-model', label: 'Ollama', provider: 'ollama-local', model: 'llama3.1:8b', enabled: true, num_ctx: 8192, vars: { port: '11434' }, paid_ack: false, notice_ack: false, ...more });
const codex = (more = {}) => ({ id: 'codex', kind: 'codex-account', label: 'Codex', profile: null, enabled: true, ...more });
function cfg(over = {}) {
  return { ...defaultRouterConfig(), mode: 'claude-then-model', entries: [main(), ollama()], ...over };
}
function codes(config) {
  return validateRouterConfig(config).errors.map((e) => e.code);
}
function assertCode(config, code, pathPart) {
  const r = validateRouterConfig(config);
  assert.equal(r.ok, false, 'expected invalid for ' + code);
  const hit = r.errors.find((e) => e.code === code);
  assert.ok(hit, 'expected code ' + code + ', got ' + JSON.stringify(r.errors.map((e) => e.code)));
  if (pathPart) assert.ok(hit.path.includes(pathPart), 'path ' + hit.path + ' should name ' + pathPart);
  assert.equal(typeof hit.nl, 'string');
  assert.equal(typeof hit.en, 'string');
  assert.ok(hit.nl.length > 0 && hit.en.length > 0);
}

test('contract enums are the design values', () => {
  assert.deepEqual([...MODES], ['off', 'claude-accounts', 'claude-then-model', 'model-first']);
  assert.deepEqual([...ENTRY_KINDS], ['claude-account', 'codex-account', 'provider-model']);
  assert.equal(LIMITS.THRESHOLD_DEFAULT, 92);
  assert.equal(LIMITS.COOLDOWN_DEFAULT, 10);
  assert.equal(LIMITS.MAX_PROACTIVE_SWITCHES_24H, 6);
});

test('default config is valid, mode off, only the main entry', () => {
  const d = defaultRouterConfig();
  assert.equal(d.version, 1);
  assert.equal(d.revision, 0);
  assert.equal(d.mode, 'off');
  assert.deepEqual(d.multi_account, { enabled: false, acknowledged_at: null });
  assert.deepEqual(d.defaults, { threshold_pct: 92, cooldown_min: 10, strategy: 'in-order', return: 'new-conversation', handover_turns: 12 });
  assert.deepEqual(d.entries.map((e) => e.id), ['main']);
  assert.deepEqual(validateRouterConfig(d), { ok: true, errors: [] });
  d.entries.push(extra('x'));
  assert.equal(defaultRouterConfig().entries.length, 1, 'a fresh object each call');
});

test('the design example (section 2.2) is valid', () => {
  assert.deepEqual(validateRouterConfig(EXAMPLE), { ok: true, errors: [] });
});

test('every mode value is accepted when its requirements hold', () => {
  for (const mode of MODES) {
    const c = cfg({ mode });
    if (mode === 'claude-accounts') {
      c.multi_account = { enabled: true, acknowledged_at: ACK };
      c.entries = [main(), extra('werk')];
    }
    if (mode === 'model-first') c.entries = [ollama(), main()];
    assert.deepEqual(validateRouterConfig(c).errors, [], mode);
  }
});

test('non-object input is refused without throwing', () => {
  for (const bad of [null, undefined, 3, 'x', []]) {
    const r = validateRouterConfig(bad);
    assert.equal(r.ok, false);
    assert.ok(r.errors.length >= 1);
  }
});

test('version and revision', () => {
  assertCode(cfg({ version: 2 }), 'bad_version', 'version');
  assertCode(cfg({ revision: -1 }), 'bad_revision', 'revision');
  assertCode(cfg({ revision: 1.5 }), 'bad_revision');
  assertCode(cfg({ revision: '3' }), 'bad_revision');
});

test('mode must be one of the four values', () => {
  assertCode(cfg({ mode: 'turbo' }), 'bad_mode', 'mode');
});

test('unknown keys are refused at the top level, in sub-objects and per entry kind', () => {
  assertCode({ ...cfg(), extra: 1 }, 'unknown_key', 'extra');
  assertCode(cfg({ defaults: { ...defaultRouterConfig().defaults, colour: 'red' } }), 'unknown_key', 'defaults.colour');
  assertCode(cfg({ multi_account: { enabled: false, acknowledged_at: null, who: 'me' } }), 'unknown_key', 'multi_account.who');
  assertCode(cfg({ entries: [main({ secret: 'x' }), ollama()] }), 'unknown_key', 'entries[0].secret');
  assertCode(cfg({ entries: [main({ model: 'opus' }), ollama()] }), 'unknown_key', 'entries[0].model');
  assertCode(cfg({ entries: [main(), ollama({ profile: 'x' })] }), 'unknown_key', 'entries[1].profile');
});

test('entry kind must be known', () => {
  assertCode(cfg({ entries: [main(), { ...ollama(), kind: 'robot' }] }), 'bad_kind', 'entries[1].kind');
});

test('ids: pattern, uniqueness, reserved names', () => {
  assertCode(cfg({ entries: [main(), ollama({ id: 'Bad Id' })] }), 'bad_id', 'entries[1].id');
  assertCode(cfg({ entries: [main(), ollama({ id: '-x' })] }), 'bad_id');
  assertCode(cfg({ entries: [main(), ollama({ id: 'a'.repeat(33) })] }), 'bad_id');
  assert.deepEqual(codes(cfg({ entries: [main(), ollama({ id: 'a'.repeat(32) })] })), []);
  assertCode(cfg({ entries: [main(), ollama(), ollama()] }), 'duplicate_id', 'entries[2].id');
  for (const reserved of ['con', 'prn', 'aux', 'nul', 'com0', 'com1', 'com9', 'lpt0', 'lpt1', 'lpt9']) {
    assertCode(cfg({ entries: [main(), ollama({ id: reserved })] }), 'reserved_id', 'entries[1].id');
  }
  assertCode(cfg({ entries: [main(), ollama({ id: 'main' })] }), 'reserved_id');
});

test('label: 1-40 chars, no control characters, nothing secret-shaped', () => {
  assertCode(cfg({ entries: [main({ label: '' }), ollama()] }), 'bad_label', 'entries[0].label');
  assertCode(cfg({ entries: [main({ label: 'x'.repeat(41) }), ollama()] }), 'bad_label');
  assert.deepEqual(codes(cfg({ entries: [main({ label: 'x'.repeat(40) }), ollama()] })), []);
  assertCode(cfg({ entries: [main({ label: 'a\u0007b' }), ollama()] }), 'bad_label');
  assertCode(cfg({ entries: [main({ label: 'a\nb' }), ollama()] }), 'bad_label');
  assertCode(cfg({ entries: [main({ label: 7 }), ollama()] }), 'bad_label');
  assertCode(cfg({ entries: [main({ label: SECRET_LIKE }), ollama()] }), 'secret_like_value', 'entries[0].label');
});

test('a secret-shaped value is refused in any string field, not only labels', () => {
  assertCode(cfg({ entries: [main(), ollama({ model: SECRET_LIKE })] }), 'secret_like_value', 'entries[1].model');
});

test('exactly one main entry (claude-account, profile null, id main)', () => {
  assertCode(cfg({ entries: [ollama()], mode: 'model-first' }), 'main_missing');
  assertCode(cfg({ entries: [main(), { ...main(), id: 'twee' }, ollama()] }), 'main_duplicate', 'entries[1]');
  assertCode(cfg({ entries: [extra('main'), ollama()] }), 'main_missing');
});

test('profile slugs: same rule as ids, unique, not reserved', () => {
  assertCode(cfg({ entries: [main(), extra('werk', { profile: 'Werk!' }), ollama()] }), 'bad_profile', 'entries[1].profile');
  assertCode(cfg({ entries: [main(), extra('werk', { profile: 'con' }), ollama()] }), 'bad_profile');
  assertCode(cfg({ entries: [main(), extra('werk', { profile: 'main' }), ollama()] }), 'bad_profile');
  assertCode(cfg({ entries: [main(), extra('a', { profile: 'same' }), extra('b', { profile: 'same' }), ollama()] }), 'duplicate_profile', 'entries[2].profile');
  assertCode(cfg({ entries: [main(), codex({ profile: 'werk' })] }), 'bad_profile', 'entries[1].profile');
  assert.deepEqual(codes(cfg({ entries: [main(), codex()] })), []);
});

test('entry count caps: 12 total, 8 Claude, 1 Codex', () => {
  const claudes = [main(), ...Array.from({ length: 7 }, (_, i) => extra('p' + i))];
  assert.deepEqual(codes(cfg({ entries: [...claudes, ollama()] })), []);
  assertCode(cfg({ entries: [...claudes, extra('p9'), ollama()] }), 'too_many_claude');
  assertCode(cfg({ entries: [main(), codex(), codex({ id: 'codex2' }), ollama()] }), 'too_many_codex');
  const many = [main(), ...Array.from({ length: 12 }, (_, i) => ollama({ id: 'o' + i }))];
  assertCode(cfg({ entries: many }), 'too_many_entries');
});

test('threshold_pct: null or an integer 50-99', () => {
  for (const ok of [null, 50, 99, 90]) assert.deepEqual(codes(cfg({ entries: [main({ threshold_pct: ok }), ollama()] })), [], String(ok));
  for (const bad of [49, 100, 92.5, '90']) assertCode(cfg({ entries: [main({ threshold_pct: bad }), ollama()] }), 'out_of_range', 'entries[0].threshold_pct');
});

test('defaults: ranges and enums', () => {
  const d = defaultRouterConfig().defaults;
  assertCode(cfg({ defaults: { ...d, cooldown_min: 0 } }), 'out_of_range', 'defaults.cooldown_min');
  assertCode(cfg({ defaults: { ...d, cooldown_min: 241 } }), 'out_of_range');
  assert.deepEqual(codes(cfg({ defaults: { ...d, cooldown_min: 240 } })), []);
  assertCode(cfg({ defaults: { ...d, handover_turns: 1 } }), 'out_of_range', 'defaults.handover_turns');
  assertCode(cfg({ defaults: { ...d, handover_turns: 41 } }), 'out_of_range');
  assertCode(cfg({ defaults: { ...d, threshold_pct: 100 } }), 'out_of_range', 'defaults.threshold_pct');
  assertCode(cfg({ defaults: { ...d, strategy: 'random' } }), 'bad_enum', 'defaults.strategy');
  assertCode(cfg({ defaults: { ...d, return: 'never' } }), 'bad_enum', 'defaults.return');
  assert.deepEqual(codes(cfg({ defaults: { ...d, strategy: 'spread', return: 'asap' } })), []);
});

test('provider must exist in the registry and must not be a cli-* adapter', () => {
  assertCode(cfg({ entries: [main(), ollama({ provider: 'nope' })] }), 'unknown_provider', 'entries[1].provider');
  assertCode(cfg({ entries: [main(), ollama({ provider: 'claude-code-cli', vars: {} })] }), 'unknown_provider');
});

test('model id pattern', () => {
  for (const ok of ['llama3.1:8b', 'qwen2.5:0.5b', 'meta/llama-3_1', 'A'.repeat(200)]) {
    assert.deepEqual(codes(cfg({ entries: [main(), ollama({ model: ok })] })), [], ok);
  }
  for (const bad of ['', ':x', 'has space', 'A'.repeat(201), 'x;rm']) {
    assertCode(cfg({ entries: [main(), ollama({ model: bad })] }), 'bad_model', 'entries[1].model');
  }
});

test('num_ctx: null or 2048-131072', () => {
  assert.deepEqual(codes(cfg({ entries: [main(), ollama({ num_ctx: null })] })), []);
  assert.deepEqual(codes(cfg({ entries: [main(), ollama({ num_ctx: 131072 })] })), []);
  assertCode(cfg({ entries: [main(), ollama({ num_ctx: 2047 })] }), 'out_of_range', 'entries[1].num_ctx');
  assertCode(cfg({ entries: [main(), ollama({ num_ctx: 131073 })] }), 'out_of_range');
});

test('vars follow the registry templateVars patterns', () => {
  assert.deepEqual(codes(cfg({ entries: [main(), ollama({ vars: {} })] })), []);
  assertCode(cfg({ entries: [main(), ollama({ vars: { port: 'abc' } })] }), 'bad_vars', 'entries[1].vars');
  assertCode(cfg({ entries: [main(), ollama({ vars: { host: 'evil.example' } })] }), 'bad_vars');
  assertCode(cfg({ entries: [main(), ollama({ vars: { port: 11434 } })] }), 'bad_vars');
  assertCode(cfg({ entries: [main(), ollama({ vars: 'port=1' })] }), 'bad_vars');
});

test('a provider that needs an API key requires paid_ack', () => {
  const openai = ollama({ id: 'gpt', provider: 'openai', model: 'gpt-5', vars: {} });
  assertCode(cfg({ entries: [main(), openai] }), 'paid_ack_required', 'entries[1].paid_ack');
  assert.deepEqual(codes(cfg({ entries: [main(), { ...openai, paid_ack: true }] })), []);
  assert.deepEqual(codes(cfg({ entries: [main(), ollama({ provider: 'lmstudio', vars: { port: '1234' } })] })), [], 'a local server needs no key');
});

test('a remote provider with noticeRequired requires notice_ack', () => {
  const cloud = ollama({ id: 'cloud', provider: 'ollama-cloud', vars: {}, paid_ack: true });
  assertCode(cfg({ entries: [main(), cloud] }), 'notice_ack_required', 'entries[1].notice_ack');
  assert.deepEqual(codes(cfg({ entries: [main(), { ...cloud, notice_ack: true }] })), []);
});

test('mode claude-accounts needs the acknowledgement and two enabled Claude accounts', () => {
  const base = { mode: 'claude-accounts', entries: [main(), extra('werk')] };
  assertCode(cfg(base), 'multi_account_required', 'mode');
  const acked = { ...base, multi_account: { enabled: true, acknowledged_at: ACK } };
  assert.deepEqual(codes(cfg(acked)), []);
  assertCode(cfg({ ...acked, entries: [main(), extra('werk', { enabled: false })] }), 'needs_two_accounts');
});

test('mode claude-then-model needs a Claude account and an enabled fallback', () => {
  assertCode(cfg({ entries: [main()] }), 'fallback_missing', 'mode');
  assertCode(cfg({ entries: [main(), ollama({ enabled: false })] }), 'fallback_missing');
  assertCode(cfg({ entries: [main({ enabled: false }), ollama()] }), 'fallback_missing');
  assert.deepEqual(codes(cfg({ entries: [main(), codex()] })), []);
});

test('mode model-first: the first enabled entry must be a model or codex', () => {
  assertCode(cfg({ mode: 'model-first', entries: [main(), ollama()] }), 'model_first_order', 'mode');
  assert.deepEqual(codes(cfg({ mode: 'model-first', entries: [main({ enabled: false }), ollama()] })), []);
  assert.deepEqual(codes(cfg({ mode: 'model-first', entries: [codex(), main()] })), []);
});

test('multi_account.enabled needs a valid ISO acknowledged_at', () => {
  assertCode(cfg({ multi_account: { enabled: true, acknowledged_at: null } }), 'ack_missing', 'multi_account.acknowledged_at');
  assertCode(cfg({ multi_account: { enabled: true, acknowledged_at: 'yesterday' } }), 'ack_missing');
  assert.deepEqual(codes(cfg({ multi_account: { enabled: true, acknowledged_at: ACK } })), []);
  assertCode(cfg({ multi_account: { enabled: 'yes', acknowledged_at: ACK } }), 'bad_type', 'multi_account.enabled');
});

test('enabled and the acks must be booleans', () => {
  assertCode(cfg({ entries: [main({ enabled: 'true' }), ollama()] }), 'bad_type', 'entries[0].enabled');
  assertCode(cfg({ entries: [main(), ollama({ paid_ack: 1 })] }), 'bad_type', 'entries[1].paid_ack');
});

test('Dutch messages avoid the jargon words the app bans', () => {
  const r = validateRouterConfig({
    version: 9, revision: -1, mode: 'x', extra: 1,
    multi_account: { enabled: true, acknowledged_at: null },
    defaults: { threshold_pct: 1, cooldown_min: 0, strategy: 'q', return: 'q', handover_turns: 0 },
    entries: [ollama({ provider: 'nope', model: '', num_ctx: 1, vars: { a: 'b' }, enabled: 'x' }), { id: 'BAD', kind: 'robot' }, { id: 'con', kind: 'claude-account', label: SECRET_LIKE, profile: 'Q', enabled: true }],
  });
  assert.ok(r.errors.length > 10);
  for (const e of r.errors) {
    assert.doesNotMatch(e.nl, /\b(sessie|token|CLI|gateway|hook|run|MCP|reset|mode|only|default)\b/i, e.code + ': ' + e.nl);
  }
});

// ---- effective chain ----------------------------------------------------------------------------

test('effectiveChain: off is empty; enabled entries in stored order', () => {
  assert.deepEqual(effectiveChain({ ...cfg(), mode: 'off' }), []);
  const c = cfg({ entries: [main(), codex({ enabled: false }), ollama()] });
  assert.deepEqual(effectiveChain(c).map((e) => e.id), ['main', 'ollama']);
});

test('effectiveChain: claude-accounts drops every non-Claude entry', () => {
  const c = cfg({ mode: 'claude-accounts', multi_account: { enabled: true, acknowledged_at: ACK }, entries: [main(), ollama(), extra('werk'), codex()] });
  assert.deepEqual(effectiveChain(c).map((e) => e.id), ['main', 'werk']);
});

test('effectiveChain: with multi-account off only the first enabled Claude entry stays', () => {
  const c = cfg({ entries: [main({ enabled: false }), extra('werk'), extra('prive'), ollama()] });
  assert.deepEqual(effectiveChain(c).map((e) => e.id), ['werk', 'ollama']);
  const on = { ...c, multi_account: { enabled: true, acknowledged_at: ACK } };
  assert.deepEqual(effectiveChain(on).map((e) => e.id), ['werk', 'prive', 'ollama']);
});

test('effectiveChain never throws on garbage and returns copies', () => {
  assert.deepEqual(effectiveChain(null), []);
  assert.deepEqual(effectiveChain({ mode: 'claude-then-model', entries: 'x' }), []);
  const c = cfg();
  const chain = effectiveChain(c);
  chain[0].label = 'changed';
  assert.equal(c.entries[0].label, 'Hoofdaccount');
});

test('describeChain marks every entry with why it is in or out', () => {
  const c = cfg({ entries: [main(), extra('werk'), codex({ enabled: false }), ollama()] });
  assert.deepEqual(describeChain(c).map((x) => [x.entry.id, x.in_chain, x.excluded_reason]), [
    ['main', true, null],
    ['werk', false, 'multi_account_off'],
    ['codex', false, 'disabled'],
    ['ollama', true, null],
  ]);
  const ca = cfg({ mode: 'claude-accounts', multi_account: { enabled: true, acknowledged_at: ACK }, entries: [main(), extra('werk'), ollama()] });
  assert.deepEqual(describeChain(ca).map((x) => x.excluded_reason), [null, null, 'mode']);
  assert.deepEqual(describeChain({ ...ca, mode: 'off' }).map((x) => x.excluded_reason), ['mode', 'mode', 'mode']);
});
