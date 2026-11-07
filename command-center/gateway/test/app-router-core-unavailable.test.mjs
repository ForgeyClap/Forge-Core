// Q5-EIGEN-API (Review Boss FAIL, seq 75): deleting or turning off an
// "Eigen API" (custom-*) that the router chain still names must NOT make router.json unreadable. Before this
// fix the whole file read as UNREADABLE with the defaults (router off), so the next turn silently ran on the
// main Claude account.
//
//   - read: a well-formed custom-* id the merged registry no longer holds (deleted, turned off, refused) is a
//     WARNING {path, code 'provider_unavailable', nl, en, entry_id, provider}; router.json stays STORED with
//     the user's real chain; `warnings` is always present ([] when none);
//   - every other bad provider (unknown bundled id, a cli-* adapter, a malformed custom id) stays a hard error;
//   - write: keeping an already-stored reference (same entry id + same provider) is allowed, so the user can
//     still change other settings; a NEW reference to a missing or turned-off custom id stays unknown_provider;
//   - validateRouterConfig() without options keeps its strict {ok, errors} answer (existing callers).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRouterConfig, writeRouterConfig, routerConfigFile, _setRouterDirForTests } from '../src/app-router/chain-store.mjs';
import { defaultRouterConfig, validateRouterConfig } from '../src/app-router/chain-schema.mjs';
import {
  createCustomProvider, updateCustomProvider, deleteCustomProvider, readCustomProviders, customProvidersFile,
  _setCustomProvidersDirForTests,
} from '../src/providers/custom-store.mjs';
import { _resetMergedRegistryCacheForTests } from '../src/providers/custom-registry.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures', 'providers-custom');
const ID = 'custom-mijn-vllm';

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-router-unavail-'));
  _setCustomProvidersDirForTests(path.join(dir, 'custom'));
  _setRouterDirForTests(path.join(dir, 'router'));
  _resetMergedRegistryCacheForTests();
});
afterEach(() => {
  _setCustomProvidersDirForTests(null);
  _setRouterDirForTests(null);
  _resetMergedRegistryCacheForTests();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

const def = (over = {}) => ({
  label: 'Mijn vLLM', format: 'openai-chat', baseURL: 'http://127.0.0.1:8000/v1', auth: { type: 'none' },
  models: { mode: 'manual', ids: ['qwen2.5-7b'] }, extraHeaders: {}, contextLength: null, enabled: true, ...over,
});
const rev = () => readCustomProviders().doc.revision;
function addCustom(over = {}) {
  const r = createCustomProvider(def(over), { expectRevision: rev() });
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.provider.id;
}
function turnOff(id) {
  const r = updateCustomProvider(id, def({ enabled: false }), { expectRevision: rev() });
  assert.equal(r.ok, true, JSON.stringify(r));
}
function remove(id) {
  const r = deleteCustomProvider(id, { expectRevision: rev() });
  assert.equal(r.ok, true, JSON.stringify(r));
}

const main = (over = {}) => ({ id: 'main', kind: 'claude-account', label: 'Hoofdaccount', profile: null, enabled: true, threshold_pct: null, ...over });
const eigen = (over = {}) => ({ id: 'eigen', kind: 'provider-model', label: 'Eigen API', provider: ID, model: 'qwen2.5-7b', enabled: true, paid_ack: false, notice_ack: false, ...over });
const chain = (entries, mode = 'model-first', revision = 0) => ({ ...defaultRouterConfig(), mode, entries, revision });

function storeChain(entries, mode = 'model-first') {
  const w = writeRouterConfig(chain(entries, mode, readRouterConfig().config.revision));
  assert.equal(w.ok, true, JSON.stringify(w.errors || w));
  return w.config;
}
function writeRaw(obj) {
  fs.mkdirSync(path.dirname(routerConfigFile()), { recursive: true });
  fs.writeFileSync(routerConfigFile(), JSON.stringify(obj), 'utf8');
}

function assertUnavailableWarning(r, { index = 0, entryId = 'eigen', provider = ID } = {}) {
  assert.ok(Array.isArray(r.warnings), 'warnings is always an array');
  assert.equal(r.warnings.length, 1, JSON.stringify(r.warnings));
  const w = r.warnings[0];
  assert.deepEqual(Object.keys(w).sort(), ['code', 'en', 'entry_id', 'nl', 'path', 'provider']);
  assert.equal(w.path, 'entries[' + index + '].provider');
  assert.equal(w.code, 'provider_unavailable');
  assert.equal(w.entry_id, entryId);
  assert.equal(w.provider, provider);
  assert.match(w.nl, /eigen API/i);
  assert.match(w.en, /own API/i);
  assert.doesNotMatch(w.nl, /\b(sessie|token|CLI|gateway|hook|run|MCP|reset|mode|only|default)\b/i, 'no app jargon in the Dutch text');
}

// ---- read ------------------------------------------------------------------------------------------------

test('delete-then-read: router.json stays STORED with the real chain and one provider_unavailable warning', () => {
  addCustom();
  const stored = storeChain([eigen(), main()]);
  remove(ID);
  const r = readRouterConfig();
  assert.equal(r.provenance, 'STORED', JSON.stringify(r.errors));
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.config, stored, 'the user\'s real chain, never the defaults');
  assert.equal(r.config.mode, 'model-first', 'the router is not turned off');
  assertUnavailableWarning(r);
});

test('disable-then-read: the same (STORED, real chain, provider_unavailable warning)', () => {
  addCustom();
  const stored = storeChain([eigen(), main()]);
  turnOff(ID);
  const r = readRouterConfig();
  assert.equal(r.provenance, 'STORED', JSON.stringify(r.errors));
  assert.deepEqual(r.config, stored);
  assertUnavailableWarning(r);
});

test('a router entry that is itself turned off still reports its unavailable provider (index follows the entry)', () => {
  addCustom();
  storeChain([main(), eigen({ enabled: false })], 'off');
  remove(ID);
  const r = readRouterConfig();
  assert.equal(r.provenance, 'STORED');
  assertUnavailableWarning(r, { index: 1 });
});

test('warnings is [] for a missing file, a clean chain and a damaged file', () => {
  assert.deepEqual(readRouterConfig().warnings, [], 'missing file (DEFAULT)');
  addCustom();
  storeChain([eigen(), main()]);
  const clean = readRouterConfig();
  assert.equal(clean.provenance, 'STORED');
  assert.deepEqual(clean.warnings, [], 'available custom provider');
  fs.writeFileSync(routerConfigFile(), '{"version":1,', 'utf8');
  const broken = readRouterConfig();
  assert.equal(broken.provenance, 'UNREADABLE');
  assert.deepEqual(broken.warnings, []);
});

test('an Eigen API the saved file now refuses (public http) also reads as unavailable, not as a broken router', () => {
  fs.mkdirSync(path.dirname(customProvidersFile()), { recursive: true });
  fs.copyFileSync(path.join(FIXTURES, 'public-http.json'), customProvidersFile());
  _resetMergedRegistryCacheForTests();
  const refused = JSON.parse(fs.readFileSync(customProvidersFile(), 'utf8')).providers[0].id;
  writeRaw(chain([eigen({ provider: refused }), main()], 'model-first', 3));
  const r = readRouterConfig();
  assert.equal(r.provenance, 'STORED', JSON.stringify(r.errors));
  assertUnavailableWarning(r, { provider: refused });
});

test('a bundled provider id that does not exist stays a hard error (UNREADABLE, defaults, router off)', () => {
  writeRaw(chain([eigen({ provider: 'nope-provider' }), main()], 'model-first', 4));
  const r = readRouterConfig();
  assert.equal(r.provenance, 'UNREADABLE');
  assert.equal(r.config.mode, 'off');
  assert.equal(r.config.revision, 4);
  assert.ok(r.errors.some((e) => e.path === 'entries[0].provider' && e.code === 'unknown_provider'));
  assert.deepEqual(r.warnings, []);
});

test('a cli-* adapter stays a hard error', () => {
  writeRaw(chain([eigen({ provider: 'claude-code-cli' }), main()], 'model-first', 2));
  const r = readRouterConfig();
  assert.equal(r.provenance, 'UNREADABLE');
  assert.ok(r.errors.some((e) => e.path === 'entries[0].provider' && e.code === 'unknown_provider'));
  assert.deepEqual(r.warnings, []);
});

test('a malformed custom id stays a hard error (not a warning)', () => {
  for (const bad of ['custom-', 'custom-Mijn_VLLM', 'custom-' + 'a'.repeat(60), 'custom--x!']) {
    writeRaw(chain([eigen({ provider: bad }), main()], 'model-first', 1));
    const r = readRouterConfig();
    assert.equal(r.provenance, 'UNREADABLE', bad);
    assert.ok(r.errors.some((e) => e.path === 'entries[0].provider' && e.code === 'unknown_provider'), bad);
    assert.deepEqual(r.warnings, [], bad);
  }
});

test('other errors in the same file still make it unreadable, even with an unavailable custom entry', () => {
  writeRaw({ ...chain([eigen(), main()], 'model-first', 6), mode: 'turbo' });
  const r = readRouterConfig();
  assert.equal(r.provenance, 'UNREADABLE');
  assert.ok(r.errors.some((e) => e.code === 'bad_mode'));
});

test('validateRouterConfig() without options stays strict: an unavailable custom id is unknown_provider, shape {ok, errors}', () => {
  const r = validateRouterConfig(chain([eigen(), main()]));
  assert.deepEqual(Object.keys(r).sort(), ['errors', 'ok']);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.path === 'entries[0].provider' && e.code === 'unknown_provider'));
});

// ---- write -----------------------------------------------------------------------------------------------

test('a save that keeps the stored unavailable entry unchanged and changes other settings succeeds', () => {
  addCustom();
  storeChain([eigen(), main()]);
  remove(ID);
  const current = readRouterConfig().config;
  const next = { ...current, defaults: { ...current.defaults, threshold_pct: 80, cooldown_min: 15 } };
  const w = writeRouterConfig(next);
  assert.equal(w.ok, true, JSON.stringify(w.errors || w));
  const r = readRouterConfig();
  assert.equal(r.provenance, 'STORED');
  assert.equal(r.config.defaults.threshold_pct, 80);
  assertUnavailableWarning(r);
});

test('a save may reorder, rename or turn off the kept entry (same entry id, same provider)', () => {
  addCustom();
  storeChain([eigen(), main()]);
  turnOff(ID);
  const w = writeRouterConfig(chain([main(), eigen({ enabled: false, label: 'Eigen API (oud)' })], 'off', readRouterConfig().config.revision));
  assert.equal(w.ok, true, JSON.stringify(w.errors || w));
  assert.equal(readRouterConfig().provenance, 'STORED');
});

test('a save that adds a reference to a deleted custom id is refused with unknown_provider', () => {
  addCustom();
  remove(ID);
  const w = writeRouterConfig(chain([eigen(), main()]));
  assert.equal(w.ok, false);
  assert.equal(w.error, 'invalid');
  assert.ok(w.errors.some((e) => e.path === 'entries[0].provider' && e.code === 'unknown_provider'));
  assert.equal(fs.existsSync(routerConfigFile()), false, 'nothing written');
});

test('a save that adds a reference to a turned-off custom id is refused with unknown_provider', () => {
  addCustom();
  turnOff(ID);
  const w = writeRouterConfig(chain([eigen(), main()]));
  assert.equal(w.ok, false);
  assert.ok(w.errors.some((e) => e.path === 'entries[0].provider' && e.code === 'unknown_provider'));
});

test('the same unavailable provider under a NEW entry id is a new reference: refused, while the kept entry passes', () => {
  addCustom();
  storeChain([eigen(), main()]);
  remove(ID);
  const current = readRouterConfig().config;
  const w = writeRouterConfig({ ...current, entries: [...current.entries, eigen({ id: 'eigen-twee', label: 'Eigen API 2' })] });
  assert.equal(w.ok, false);
  const paths = w.errors.filter((e) => e.code === 'unknown_provider').map((e) => e.path);
  assert.deepEqual(paths, ['entries[2].provider'], 'only the new reference is refused');
});

test('a kept entry id that now names ANOTHER unavailable provider is a new reference: refused', () => {
  addCustom();
  storeChain([eigen(), main()]);
  remove(ID);
  const current = readRouterConfig().config;
  const w = writeRouterConfig({ ...current, entries: [eigen({ provider: 'custom-iets-anders' }), main()] });
  assert.equal(w.ok, false);
  assert.ok(w.errors.some((e) => e.path === 'entries[0].provider' && e.code === 'unknown_provider'));
});

test('over a damaged router.json nothing counts as stored: the unavailable reference is refused', () => {
  writeRaw({ ...chain([eigen(), main()], 'model-first', 5), mode: 'bogus' });
  assert.equal(readRouterConfig().provenance, 'UNREADABLE');
  const w = writeRouterConfig(chain([eigen(), main()], 'model-first', 5));
  assert.equal(w.ok, false);
  assert.ok(w.errors.some((e) => e.path === 'entries[0].provider' && e.code === 'unknown_provider'));
});
