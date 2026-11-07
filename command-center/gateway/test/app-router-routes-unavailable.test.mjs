// Q5-EIGEN-API: the HTTP side of an "Eigen API" (custom-*) chain entry that is no longer usable, against the REAL
// gateway listener (server.mjs createServer), so the method allowlist, the token check and the route table run as
// in production. The custom store, the router folder, the profiles root and the conversations folder point at
// fresh temp folders. No outbound call, no `claude` process.
//
//   - GET /api/app-router passes `warnings` through ([] when none; the provider_unavailable warning after a delete),
//     and keeps provenance STORED with the real chain (the router is not turned off);
//   - PATCH /api/providers/custom/:id answers router_entries (the chain entries that name it), like DELETE does;
//   - POST /api/app-router keeps an already-stored unavailable entry; a NEW reference is 400 unknown_provider;
//   - GET /api/app-router/status shows the entry as not eligible (provider_unavailable) and `next` skips it;
//   - POST /api/app-router/profiles still adds a Claude account while the chain holds such an entry.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer, _configureRateLimitForTests } from '../src/server.mjs';
import { _setCustomProvidersDirForTests } from '../src/providers/custom-store.mjs';
import { _resetMergedRegistryCacheForTests } from '../src/providers/custom-registry.mjs';
import { _setRouterDirForTests } from '../src/app-router/chain-store.mjs';
import { defaultRouterConfig } from '../src/app-router/chain-schema.mjs';
import { _setConversationsDirForTests, _resetConversationsForTests } from '../src/conversations.mjs';
import { request, requestWithBody } from '../test-support/helpers.mjs';

const CUSTOM = '/api/providers/custom';
const ROUTER = '/api/app-router';
const ID = 'custom-mijn-vllm';

let tmp;
let server;
let port;
let savedProfilesEnv;

function listen(s) {
  return new Promise((resolve, reject) => {
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => resolve(s.address().port));
  });
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-unavail-routes-'));
  fs.mkdirSync(path.join(tmp, 'conv'));
  savedProfilesEnv = process.env.FORGE_ROUTER_PROFILES_DIR;
  _setConversationsDirForTests(path.join(tmp, 'conv'));
  server = createServer();
  port = await listen(server);
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  _setCustomProvidersDirForTests(null);
  _setRouterDirForTests(null);
  _resetMergedRegistryCacheForTests();
  _setConversationsDirForTests(null);
  _resetConversationsForTests();
  _configureRateLimitForTests();
  if (savedProfilesEnv === undefined) delete process.env.FORGE_ROUTER_PROFILES_DIR;
  else process.env.FORGE_ROUTER_PROFILES_DIR = savedProfilesEnv;
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
});

beforeEach(() => {
  _setCustomProvidersDirForTests(fs.mkdtempSync(path.join(tmp, 's-')));
  _setRouterDirForTests(fs.mkdtempSync(path.join(tmp, 'r-')));
  process.env.FORGE_ROUTER_PROFILES_DIR = fs.mkdtempSync(path.join(tmp, 'p-'));
  _resetMergedRegistryCacheForTests();
  _configureRateLimitForTests();
});

const def = (over = {}) => ({
  label: 'Mijn vLLM', format: 'openai-chat', baseURL: 'http://127.0.0.1:8000/v1', auth: { type: 'none' },
  models: { mode: 'manual', ids: ['qwen2.5-7b'] }, extraHeaders: {}, contextLength: null, enabled: true, ...over,
});
const eigen = (over = {}) => ({ id: 'eigen', kind: 'provider-model', label: 'Eigen API', provider: ID, model: 'qwen2.5-7b', enabled: true, paid_ack: false, notice_ack: false, ...over });
const main = () => ({ id: 'main', kind: 'claude-account', label: 'Hoofdaccount', profile: null, enabled: true, threshold_pct: null });

const getRouter = () => request(port, ROUTER);
const saveRouter = (body) => requestWithBody(port, ROUTER, { jsonBody: body });
const customList = () => request(port, CUSTOM);

async function setUp() {
  const made = await requestWithBody(port, CUSTOM, { jsonBody: { revision: 0, provider: def() } });
  assert.equal(made.statusCode, 201, made.body);
  assert.equal(made.json.provider.id, ID);
  const saved = await saveRouter({ ...defaultRouterConfig(), mode: 'model-first', entries: [eigen(), main()], revision: 0 });
  assert.equal(saved.statusCode, 200, saved.body);
  return saved.json.config;
}
async function deleteCustom() {
  const r = await requestWithBody(port, CUSTOM + '/' + ID, { method: 'DELETE' });
  assert.equal(r.statusCode, 200, r.body);
  return r;
}

test('GET /api/app-router carries warnings: [] when nothing is wrong', async () => {
  const empty = await getRouter();
  assert.equal(empty.statusCode, 200);
  assert.deepEqual(empty.json.warnings, []);
  await setUp();
  const stored = await getRouter();
  assert.equal(stored.json.provenance, 'STORED');
  assert.deepEqual(stored.json.warnings, []);
});

test('DELETE then GET /api/app-router: STORED, the real chain (router stays on) and the provider_unavailable warning', async () => {
  const config = await setUp();
  const d = await deleteCustom();
  assert.deepEqual(d.json.router_entries, ['eigen']);
  const g = await getRouter();
  assert.equal(g.statusCode, 200);
  assert.equal(g.json.provenance, 'STORED');
  assert.deepEqual(g.json.config, config);
  assert.equal(g.json.config.mode, 'model-first');
  assert.equal(g.json.warnings.length, 1);
  const w = g.json.warnings[0];
  assert.deepEqual({ path: w.path, code: w.code, entry: w.entry_id, provider: w.provider }, { path: 'entries[0].provider', code: 'provider_unavailable', entry: 'eigen', provider: ID });
  assert.ok(typeof w.nl === 'string' && w.nl.length > 0 && typeof w.en === 'string' && w.en.length > 0);
});

test('PATCH that turns an Eigen API off answers router_entries (the chain entries that name it)', async () => {
  await setUp();
  const rev = (await customList()).json.revision;
  const r = await requestWithBody(port, CUSTOM + '/' + ID, { method: 'PATCH', jsonBody: { revision: rev, provider: def({ enabled: false }) } });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json.provider.enabled, false);
  assert.deepEqual(r.json.router_entries, ['eigen']);
  const g = await getRouter();
  assert.equal(g.json.provenance, 'STORED');
  assert.equal(g.json.warnings[0].code, 'provider_unavailable');
});

test('PATCH of an Eigen API no chain entry names answers router_entries: []', async () => {
  const made = await requestWithBody(port, CUSTOM, { jsonBody: { revision: 0, provider: def() } });
  assert.equal(made.statusCode, 201, made.body);
  const r = await requestWithBody(port, CUSTOM + '/' + ID, { method: 'PATCH', jsonBody: { revision: 1, provider: def({ label: 'Mijn vLLM (groot)' }) } });
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(r.json.router_entries, []);
});

test('POST /api/app-router keeps the stored unavailable entry (200); a NEW reference to it is 400 unknown_provider', async () => {
  await setUp();
  await deleteCustom();
  const current = (await getRouter()).json.config;
  const keep = await saveRouter({ ...current, defaults: { ...current.defaults, threshold_pct: 85 } });
  assert.equal(keep.statusCode, 200, keep.body);
  assert.equal(keep.json.config.defaults.threshold_pct, 85);
  const latest = keep.json.config;
  const add = await saveRouter({ ...latest, entries: [...latest.entries, eigen({ id: 'eigen-twee', label: 'Eigen API 2' })] });
  assert.equal(add.statusCode, 400, add.body);
  assert.ok(add.json.errors.some((e) => e.path === 'entries[2].provider' && e.code === 'unknown_provider'));
});

test('GET /api/app-router/status: the unavailable entry is not eligible (provider_unavailable) and next skips it', async () => {
  await setUp();
  await deleteCustom();
  const s = await request(port, ROUTER + '/status');
  assert.equal(s.statusCode, 200, s.body);
  assert.equal(s.json.mode, 'model-first', 'the router is still on');
  const row = s.json.entries.find((e) => e.id === 'eigen');
  assert.ok(row);
  assert.equal(row.eligible, false);
  assert.equal(row.ineligible_reason, 'provider_unavailable');
  assert.equal(s.json.next && s.json.next.entry && s.json.next.entry.id, 'main');
});

test('POST /api/app-router/profiles still adds a Claude account while the chain holds an unavailable entry', async () => {
  await setUp();
  await deleteCustom();
  const r = await requestWithBody(port, ROUTER + '/profiles', { jsonBody: { label: 'Werk' } });
  assert.equal(r.statusCode, 201, r.body);
  assert.deepEqual(r.json.config.entries.map((e) => e.id), ['eigen', 'main', 'werk']);
});
