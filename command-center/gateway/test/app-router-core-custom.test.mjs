// ANY-MODEL-PLAN: the router config validator looks providers up in the MERGED registry (bundled
// catalogue + the user's own "Eigen API" entries), so a router entry may point at an enabled custom-*
// provider. Disabled, deleted or refused custom entries stay unknown; bundled providers keep working when
// the overlay file is damaged; an explicit registry seam still wins.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultRouterConfig, validateRouterConfig } from '../src/app-router/chain-schema.mjs';
import { customProvidersFile, _setCustomProvidersDirForTests } from '../src/providers/custom-store.mjs';
import { _resetMergedRegistryCacheForTests } from '../src/providers/custom-registry.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures', 'providers-custom');

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-router-custom-'));
  _setCustomProvidersDirForTests(dir);
  _resetMergedRegistryCacheForTests();
});
afterEach(() => {
  _setCustomProvidersDirForTests(null);
  _resetMergedRegistryCacheForTests();
  fs.rmSync(dir, { recursive: true, force: true });
});

function useFixture(name) {
  fs.mkdirSync(path.dirname(customProvidersFile()), { recursive: true });
  fs.copyFileSync(path.join(FIXTURES, name), customProvidersFile());
  _resetMergedRegistryCacheForTests();
}

const main = () => ({ id: 'main', kind: 'claude-account', label: 'Hoofdaccount', profile: null, enabled: true, threshold_pct: null });
const custom = (more = {}) => ({ id: 'eigen', kind: 'provider-model', label: 'Eigen API', provider: 'custom-mijn-vllm', model: 'qwen2.5-7b', enabled: true, paid_ack: true, notice_ack: false, ...more });
const ollama = () => ({ id: 'ollama', kind: 'provider-model', label: 'Ollama', provider: 'ollama-local', model: 'llama3.1:8b', enabled: true, num_ctx: 8192, vars: { port: '11434' }, paid_ack: false, notice_ack: false });
const cfg = (entries) => ({ ...defaultRouterConfig(), mode: 'claude-then-model', entries: [main(), ...entries] });
const codesAt = (r, p) => r.errors.filter((e) => e.path.startsWith(p)).map((e) => e.code);

test('an enabled custom provider from the store is accepted without passing a registry', () => {
  useFixture('valid.json');
  const r = validateRouterConfig(cfg([custom()]));
  assert.deepEqual(r, { ok: true, errors: [] });
});

test('a custom provider with a manual model list is accepted too', () => {
  useFixture('valid.json');
  const r = validateRouterConfig(cfg([custom({ provider: 'custom-team-gateway', model: 'team-large' })]));
  assert.deepEqual(r, { ok: true, errors: [] });
});

test('a custom provider that needs a key still requires paid_ack (same rule as bundled paid providers)', () => {
  useFixture('valid.json');
  const r = validateRouterConfig(cfg([custom({ paid_ack: false })]));
  assert.equal(r.ok, false);
  assert.deepEqual(codesAt(r, 'entries[1]'), ['paid_ack_required']);
});

test('a disabled custom provider is unknown to the router', () => {
  useFixture('valid.json');
  const r = validateRouterConfig(cfg([custom({ provider: 'custom-claude-proxy', model: 'proxy-model-1' })]));
  assert.equal(r.ok, false);
  assert.ok(codesAt(r, 'entries[1].provider').includes('unknown_provider'));
});

test('a custom id that is not in the store is unknown (no file at all)', () => {
  const r = validateRouterConfig(cfg([custom()]));
  assert.equal(r.ok, false);
  assert.ok(codesAt(r, 'entries[1].provider').includes('unknown_provider'));
});

test('a refused overlay entry (public http) never joins the router', () => {
  useFixture('public-http.json');
  const doc = JSON.parse(fs.readFileSync(customProvidersFile(), 'utf8'));
  const ids = doc.providers.map((p) => p.id);
  assert.ok(ids.length > 0, 'fixture has entries');
  for (const id of ids) {
    const r = validateRouterConfig(cfg([custom({ provider: id })]));
    assert.ok(codesAt(r, 'entries[1].provider').includes('unknown_provider'), id + ' must stay unknown');
  }
});

test('a damaged overlay file leaves the bundled providers valid', () => {
  useFixture('damaged.json');
  assert.deepEqual(validateRouterConfig(cfg([ollama()])), { ok: true, errors: [] });
  const r = validateRouterConfig(cfg([custom()]));
  assert.ok(codesAt(r, 'entries[1].provider').includes('unknown_provider'));
});

test('a store change after the first lookup is seen on the next validation', () => {
  assert.equal(validateRouterConfig(cfg([custom()])).ok, false);
  fs.copyFileSync(path.join(FIXTURES, 'valid.json'), customProvidersFile());
  // No cache reset here on purpose: the merged registry follows the store stamp by itself.
  assert.deepEqual(validateRouterConfig(cfg([custom()])), { ok: true, errors: [] });
});

test('an explicit registry seam still wins over the merged registry', () => {
  useFixture('valid.json');
  const empty = { get: () => null };
  const r = validateRouterConfig(cfg([custom()]), { registry: empty });
  assert.ok(codesAt(r, 'entries[1].provider').includes('unknown_provider'));
});
