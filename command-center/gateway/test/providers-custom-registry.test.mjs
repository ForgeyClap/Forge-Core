// "Eigen API" (ANY-MODEL-PLAN 2.2 A): an overlay entry compiles into a normal registry entry that
// passes the bundled semantic rules, and loadMergedRegistry() = bundled registry + compiled overlay.
// custom-* ids are reserved for the overlay; a broken overlay never takes the bundled providers down.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRegistry, semanticProblems, RegistryError } from '../src/providers/registry.mjs';
import {
  compileCustomEntry, loadMergedRegistry, verifyCustomTarget, isCustomEntry, _resetMergedRegistryCacheForTests,
} from '../src/providers/custom-registry.mjs';
import {
  createCustomProvider, updateCustomProvider, customProvidersFile, _setCustomProvidersDirForTests,
} from '../src/providers/custom-store.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'providers-custom');
const NOW = Date.parse('2026-11-02T12:00:00.000Z');
const bundled = loadRegistry();
let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-custom-reg-'));
  _setCustomProvidersDirForTests(dir);
  _resetMergedRegistryCacheForTests();
});
afterEach(() => {
  _setCustomProvidersDirForTests(null);
  _resetMergedRegistryCacheForTests();
  fs.rmSync(dir, { recursive: true, force: true });
});

function def(over = {}) {
  return {
    id: 'custom-mijn-vllm', label: 'Mijn vLLM-server', format: 'openai-chat', baseURL: 'http://192.168.1.20:8000/v1',
    auth: { type: 'bearer' }, models: { mode: 'endpoint' }, extraHeaders: {}, contextLength: null, enabled: true, ...over,
  };
}

test('compile: openai-chat over LAN http -> openai-compatible/chat-completions, derived key, http_lan warning, no semantic problems', () => {
  const { entry, problems } = compileCustomEntry(def(), { bundled });
  assert.deepEqual(problems, []);
  assert.equal(entry.adapter, 'openai-compatible');
  assert.equal(entry.apiStyle, 'chat-completions');
  assert.equal(entry.authType, 'bearer');
  assert.equal(entry.keyEnvName, 'CUSTOM_MIJN_VLLM_API_KEY');
  assert.equal(entry.modelsMode, 'endpoint');
  assert.equal(entry.modelsEndpoint, '/models');
  assert.equal(entry.testCall, 'models');
  assert.equal(entry.local, false);
  assert.equal(entry.source, 'custom');
  assert.equal(entry.verification, 'user');
  assert.equal(entry.urlClass, 'lan');
  assert.deepEqual(entry.warnings, ['http_lan']);
  assert.equal(entry.subscription, false);
  assert.equal(entry.noticeRequired, false);
  assert.ok(Object.isFrozen(entry) && Object.isFrozen(entry.extraHeaders));
  // Every bundled rule except the shipped catalogue's own address policy, which D1 replaces for custom entries.
  const remaining = semanticProblems(entry).filter((m) => m !== 'remote providers must use https://');
  assert.deepEqual(remaining, []);
});

test('compile: the three formats and five auth types map to adapters the existing code knows', () => {
  const cases = [
    [{ format: 'openai-responses', auth: { type: 'none' } }, { adapter: 'openai-compatible', apiStyle: 'responses', authType: 'none', keyEnvName: null }],
    [{ format: 'openai-chat', auth: { type: 'x-api-key' } }, { authType: 'custom-header', customAuth: { header: 'x-api-key', prefix: '' } }],
    [{ format: 'openai-chat', auth: { type: 'api-key-header' } }, { authType: 'api-key-header' }],
    [{ format: 'openai-chat', auth: { type: 'custom', header: 'X-Auth-Token', prefix: 'Token ' } }, { authType: 'custom-header', customAuth: { header: 'X-Auth-Token', prefix: 'Token ' } }],
    [{ format: 'anthropic', auth: { type: 'bearer' } }, { adapter: 'anthropic', apiStyle: null, authType: 'bearer-or-x-api-key', authHeaderMode: 'bearer', modelsEndpoint: '/v1/models' }],
    [{ format: 'anthropic', auth: { type: 'x-api-key' } }, { adapter: 'anthropic', authType: 'bearer-or-x-api-key', authHeaderMode: 'x-api-key' }],
  ];
  for (const [over, want] of cases) {
    const { entry, problems } = compileCustomEntry(def({ baseURL: 'https://llm.example.com', ...over }), { bundled });
    assert.deepEqual(problems, [], JSON.stringify(over));
    for (const [k, v] of Object.entries(want)) assert.deepEqual(entry[k], v, JSON.stringify(over) + ' ' + k);
    assert.deepEqual(semanticProblems(entry), [], JSON.stringify(over));
  }
});

test('compile: anthropic gets the bundled anthropic-version unless the user set one; manual models become a static list', () => {
  const a = compileCustomEntry(def({ format: 'anthropic', baseURL: 'https://p.example.com', models: { mode: 'manual', ids: ['m-1', 'm-2'] } }), { bundled }).entry;
  assert.equal(a.extraHeaders['anthropic-version'], bundled.get('anthropic').extraHeaders['anthropic-version']);
  assert.equal(a.modelsMode, 'static');
  assert.deepEqual(a.staticModels, ['m-1', 'm-2']);
  assert.equal(a.modelsEndpoint, null);
  assert.equal(a.testCall, 'chat-1-token');
  const own = compileCustomEntry(def({ format: 'anthropic', baseURL: 'https://p.example.com', extraHeaders: { 'anthropic-version': '2023-06-01' } }), { bundled }).entry;
  assert.equal(own.extraHeaders['anthropic-version'], '2023-06-01');
});

test('compile: loopback http is local; a refused definition compiles to problems, never to an entry', () => {
  const l = compileCustomEntry(def({ baseURL: 'http://127.0.0.1:11434/v1', auth: { type: 'none' } }), { bundled });
  assert.deepEqual(l.problems, []);
  assert.equal(l.entry.local, true);
  assert.deepEqual(semanticProblems(l.entry), []);
  const bad = compileCustomEntry(def({ baseURL: 'http://169.254.169.254/latest' }), { bundled });
  assert.equal(bad.entry, null);
  assert.ok(bad.problems.some((p) => p.code === 'blocked_host'));
});

test('merge: no overlay file -> exactly the bundled providers (same objects), custom state DEFAULT', () => {
  const m = loadMergedRegistry();
  assert.deepEqual(m.ids(), bundled.ids());
  for (const id of bundled.ids()) assert.equal(m.get(id), bundled.get(id), id);
  assert.equal(m.custom.provenance, 'DEFAULT');
  assert.deepEqual(m.custom.ids, []);
});

test('merge: enabled custom entries are appended, disabled ones listed apart, get/ids/providers agree', () => {
  fs.copyFileSync(path.join(FIXTURES, 'valid.json'), customProvidersFile());
  const m = loadMergedRegistry();
  assert.deepEqual(m.custom.ids, ['custom-mijn-vllm', 'custom-team-gateway']);
  assert.deepEqual(m.custom.disabled, ['custom-claude-proxy']);
  assert.equal(m.get('custom-claude-proxy'), null);
  assert.equal(m.ids().length, bundled.ids().length + 2);
  assert.equal(m.providers.length, m.ids().length);
  assert.equal(m.get('custom-team-gateway').authType, 'custom-header');
  assert.equal(isCustomEntry(m.get('custom-mijn-vllm')), true);
  assert.equal(isCustomEntry(m.get('openai')), false);
  assert.deepEqual(m.custom.warnings['custom-mijn-vllm'], ['http_lan']);
  assert.ok(Object.isFrozen(m));
});

test('merge: a damaged overlay keeps every bundled provider and reports the problem (never throws)', () => {
  fs.copyFileSync(path.join(FIXTURES, 'damaged.json'), customProvidersFile());
  const m = loadMergedRegistry();
  assert.deepEqual(m.ids(), bundled.ids());
  assert.equal(m.custom.provenance, 'UNREADABLE');
  assert.ok(m.custom.problems.length > 0);
  for (const p of m.custom.problems) assert.deepEqual(Object.keys(p).sort(), ['code', 'en', 'id', 'nl', 'path']);
});

test('merge: a bundled id or key name in the reserved custom namespace fails loud (RegistryError)', () => {
  const fakeBundled = (extra) => {
    const providers = [...bundled.providers, extra];
    const byId = new Map(providers.map((p) => [p.id, p]));
    return { schema: 1, providers, get: (id) => byId.get(id) || null, ids: () => [...byId.keys()] };
  };
  const idClash = { ...bundled.get('groq'), id: 'custom-groq' };
  assert.throws(() => loadMergedRegistry({ loadBundled: () => fakeBundled(idClash), useCache: false }), RegistryError);
  const nameClash = { ...bundled.get('groq'), id: 'groq-two', keyEnvName: 'CUSTOM_GROQ_API_KEY' };
  assert.throws(() => loadMergedRegistry({ loadBundled: () => fakeBundled(nameClash), useCache: false }), (err) => err instanceof RegistryError && /reserved/.test(err.message));
});

test('cache: the same merged object until the store changes; a write gives a new object with the new entry', () => {
  const m1 = loadMergedRegistry();
  assert.equal(loadMergedRegistry(), m1);
  const c = createCustomProvider({ label: 'Thuis', format: 'openai-chat', baseURL: 'http://127.0.0.1:1234/v1', auth: { type: 'none' }, models: { mode: 'endpoint' } }, { expectRevision: 0, now: NOW });
  assert.equal(c.ok, true);
  const m2 = loadMergedRegistry();
  assert.notEqual(m2, m1);
  assert.equal(m2.get('custom-thuis').baseURL, 'http://127.0.0.1:1234/v1');
  for (const id of bundled.ids()) assert.equal(m2.get(id), m1.get(id), 'bundled entries keep their identity: ' + id);
});

test('verifyCustomTarget: ok for the saved address; refused when the entry is gone, disabled, or its address differs', () => {
  const c = createCustomProvider({ label: 'Thuis', format: 'openai-chat', baseURL: 'http://127.0.0.1:1234/v1', auth: { type: 'none' }, models: { mode: 'endpoint' } }, { expectRevision: 0, now: NOW });
  const entry = loadMergedRegistry().get('custom-thuis');
  assert.deepEqual(verifyCustomTarget(entry), { ok: true });
  assert.deepEqual(verifyCustomTarget(bundled.get('openai')), { ok: true }, 'bundled entries are not overlay entries');
  const forged = { ...entry, baseURL: 'http://127.0.0.1:9999/v1' };
  const r = verifyCustomTarget(forged);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'target_changed');
  assert.ok(r.nl && r.en);
  updateCustomProvider('custom-thuis', { ...c.provider, id: undefined, created_at: undefined, updated_at: undefined, enabled: false }, { expectRevision: 1, now: NOW });
  assert.equal(verifyCustomTarget(entry).code, 'target_disabled');
  fs.unlinkSync(customProvidersFile());
  assert.equal(verifyCustomTarget(entry).code, 'target_missing');
});
