// Q5-EIGEN-API rework (Review Boss finding): the SAME bug class through another
// trigger. The dashboard stores paid_ack:false for an "Eigen API" (custom-*) that needs no key. Later that API
// (1) is edited from auth 'none' to a keyed auth, or (2) is deleted and re-created under the same label with a
// key (uniqueCustomId gives it the same id, so the stored chain entry binds to the new API). Before this fix
// validateProvider reported paid_ack_required as a hard error, router.json read as UNREADABLE (defaults, router
// off) and every turn silently ran on the main Claude account.
//
//   - read: a stored entry naming an Eigen API that now needs a key, without paid_ack:true, is a WARNING
//     {path 'entries[<i>].paid_ack', code 'paid_ack_required', nl, en, entry_id, provider}; router.json stays STORED
//     with the real chain; the turn router skips that entry (exec test);
//   - write: keeping that already-stored, unconfirmed entry is allowed (other settings stay editable); a save that
//     ADDS such an entry, or flips a stored paid_ack:true back to false, stays a hard error paid_ack_required;
//   - a bundled provider that needs a key is unchanged: a hard error without paid_ack;
//   - validateRouterConfig() without options stays strict.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readRouterConfig, writeRouterConfig, routerConfigFile, _setRouterDirForTests } from '../src/app-router/chain-store.mjs';
import { defaultRouterConfig, validateRouterConfig } from '../src/app-router/chain-schema.mjs';
import {
  createCustomProvider, updateCustomProvider, deleteCustomProvider, readCustomProviders, _setCustomProvidersDirForTests,
} from '../src/providers/custom-store.mjs';
import { _resetMergedRegistryCacheForTests } from '../src/providers/custom-registry.mjs';

const ID = 'custom-mijn-vllm';

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-router-ack-'));
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
const KEYED = { auth: { type: 'bearer' } };
const rev = () => readCustomProviders().doc.revision;
function addCustom(over = {}) {
  const r = createCustomProvider(def(over), { expectRevision: rev() });
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.provider.id;
}
function addKey() {
  const r = updateCustomProvider(ID, def(KEYED), { expectRevision: rev() });
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
const codesAt = (errors, p) => errors.filter((e) => e.path === p).map((e) => e.code);

function assertAckWarning(r, { index = 0, entryId = 'eigen', provider = ID } = {}) {
  assert.ok(Array.isArray(r.warnings), 'warnings is always an array');
  assert.equal(r.warnings.length, 1, JSON.stringify(r.warnings));
  const w = r.warnings[0];
  assert.deepEqual(Object.keys(w).sort(), ['code', 'en', 'entry_id', 'nl', 'path', 'provider']);
  assert.equal(w.path, 'entries[' + index + '].paid_ack');
  assert.equal(w.code, 'paid_ack_required');
  assert.equal(w.entry_id, entryId);
  assert.equal(w.provider, provider);
  assert.match(w.nl, /eigen API/i);
  assert.match(w.en, /own API/i);
  assert.match(w.nl, /sleutel/i, 'the Dutch text says the API now needs a key');
  assert.doesNotMatch(w.nl, /\b(sessie|token|CLI|gateway|hook|run|MCP|reset|mode|only|default)\b/i, 'no app jargon in the Dutch text');
}

// ---- read ------------------------------------------------------------------------------------------------

test('auth none -> keyed: router.json stays STORED with the real chain and one paid_ack_required warning', () => {
  addCustom();
  const stored = storeChain([eigen(), main()]);
  addKey();
  const r = readRouterConfig();
  assert.equal(r.provenance, 'STORED', JSON.stringify(r.errors));
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.config, stored, 'the user\'s real chain, never the defaults');
  assert.equal(r.config.mode, 'model-first', 'the router is not turned off');
  assertAckWarning(r);
});

test('delete, then re-create under the same label with a key: the stored entry binds to the new API; STORED + warning', () => {
  addCustom();
  const stored = storeChain([eigen(), main()]);
  remove(ID);
  assert.equal(addCustom(KEYED), ID, 'uniqueCustomId gives the re-created API the same id');
  const r = readRouterConfig();
  assert.equal(r.provenance, 'STORED', JSON.stringify(r.errors));
  assert.deepEqual(r.config, stored);
  assertAckWarning(r);
});

test('the warning follows the entry index and is also reported for an entry that is itself turned off', () => {
  addCustom();
  storeChain([main(), eigen({ enabled: false })], 'off');
  addKey();
  const r = readRouterConfig();
  assert.equal(r.provenance, 'STORED');
  assertAckWarning(r, { index: 1 });
});

test('a stored entry with paid_ack:true reads clean after the API gets a key (warnings [])', () => {
  addCustom();
  storeChain([eigen({ paid_ack: true }), main()]);
  addKey();
  const r = readRouterConfig();
  assert.equal(r.provenance, 'STORED');
  assert.deepEqual(r.warnings, []);
});

test('a bundled provider that needs a key stays a hard error without paid_ack (UNREADABLE, defaults, router off)', () => {
  writeRaw(chain([{ id: 'oa', kind: 'provider-model', label: 'OpenAI', provider: 'openai', model: 'gpt-4o-mini', enabled: true, paid_ack: false, notice_ack: false }, main()], 'model-first', 3));
  const r = readRouterConfig();
  assert.equal(r.provenance, 'UNREADABLE');
  assert.equal(r.config.mode, 'off');
  assert.deepEqual(codesAt(r.errors, 'entries[0].paid_ack'), ['paid_ack_required']);
  assert.deepEqual(r.warnings, []);
});

test('validateRouterConfig() without options stays strict: paid_ack_required is an error, shape {ok, errors}', () => {
  addCustom(KEYED);
  const r = validateRouterConfig(chain([eigen(), main()]));
  assert.deepEqual(Object.keys(r).sort(), ['errors', 'ok']);
  assert.equal(r.ok, false);
  assert.deepEqual(codesAt(r.errors, 'entries[0].paid_ack'), ['paid_ack_required']);
});

// ---- write -----------------------------------------------------------------------------------------------

test('a save that keeps the stored unconfirmed entry and changes other settings succeeds (warning stays)', () => {
  addCustom();
  const stored = storeChain([eigen(), main()]);
  addKey();
  const w = writeRouterConfig({ ...stored, defaults: { ...stored.defaults, threshold_pct: 85 } });
  assert.equal(w.ok, true, JSON.stringify(w.errors || w));
  assert.equal(w.config.defaults.threshold_pct, 85);
  const r = readRouterConfig();
  assert.equal(r.provenance, 'STORED');
  assertAckWarning(r);
});

test('a save that confirms the cost (paid_ack:true) clears the warning', () => {
  addCustom();
  const stored = storeChain([eigen(), main()]);
  addKey();
  const w = writeRouterConfig({ ...stored, entries: [eigen({ paid_ack: true }), main()] });
  assert.equal(w.ok, true, JSON.stringify(w.errors || w));
  const r = readRouterConfig();
  assert.equal(r.provenance, 'STORED');
  assert.deepEqual(r.warnings, []);
});

test('a save that ADDS a new entry naming the keyed Eigen API without paid_ack is refused with paid_ack_required', () => {
  addCustom(KEYED);
  const w = writeRouterConfig(chain([main(), eigen()]));
  assert.equal(w.ok, false);
  assert.equal(w.error, 'invalid');
  assert.deepEqual(codesAt(w.errors, 'entries[1].paid_ack'), ['paid_ack_required']);
});

test('a save that flips a stored paid_ack:true back to false on a keyed Eigen API is refused (a save never creates the unconfirmed state)', () => {
  addCustom(KEYED);
  const stored = storeChain([eigen({ paid_ack: true }), main()]);
  const w = writeRouterConfig({ ...stored, entries: [eigen({ paid_ack: false }), main()] });
  assert.equal(w.ok, false);
  assert.deepEqual(codesAt(w.errors, 'entries[0].paid_ack'), ['paid_ack_required']);
});

test('the same unconfirmed provider under a NEW entry id is a new reference: refused, while the kept entry passes', () => {
  addCustom();
  const stored = storeChain([eigen(), main()]);
  addKey();
  const w = writeRouterConfig({ ...stored, entries: [eigen(), main(), eigen({ id: 'eigen-twee', label: 'Eigen API 2' })] });
  assert.equal(w.ok, false);
  assert.deepEqual(codesAt(w.errors, 'entries[0].paid_ack'), []);
  assert.deepEqual(codesAt(w.errors, 'entries[2].paid_ack'), ['paid_ack_required']);
});
