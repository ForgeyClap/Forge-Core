// Q5-EIGEN-API rework: the HTTP side of a chain entry whose "Eigen API" (custom-*) now needs a key while the
// stored entry never confirmed the cost, against the REAL gateway listener (server.mjs createServer). Fresh temp
// folders for the custom store, the router folder, the profiles root and the conversations folder. No outbound
// call, no `claude` process.
//
//   - PATCH /api/providers/custom/:id (auth none -> keyed) answers router_entries (the chain entries that name it),
//     so the dashboard can say the router now skips them; before the fix it answered [] (it read the defaults);
//   - GET /api/app-router then stays STORED (router on) and carries the paid_ack_required warning;
//   - GET /api/app-router/status shows the entry as not eligible (paid_ack_required) and `next` skips it;
//   - POST /api/app-router with paid_ack:true on that entry clears the warning.
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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ack-routes-'));
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

async function setUp() {
  const made = await requestWithBody(port, CUSTOM, { jsonBody: { revision: 0, provider: def() } });
  assert.equal(made.statusCode, 201, made.body);
  assert.equal(made.json.provider.id, ID);
  const saved = await saveRouter({ ...defaultRouterConfig(), mode: 'model-first', entries: [eigen(), main()], revision: 0 });
  assert.equal(saved.statusCode, 200, saved.body);
  return saved.json.config;
}
async function addKey() {
  const rev = (await request(port, CUSTOM)).json.revision;
  const r = await requestWithBody(port, CUSTOM + '/' + ID, { method: 'PATCH', jsonBody: { revision: rev, provider: def({ auth: { type: 'bearer' } }) } });
  assert.equal(r.statusCode, 200, r.body);
  return r;
}

test('PATCH auth none -> keyed answers router_entries; GET /api/app-router stays STORED (router on) with the paid_ack_required warning', async () => {
  const config = await setUp();
  const p = await addKey();
  assert.deepEqual(p.json.router_entries, ['eigen']);
  const g = await getRouter();
  assert.equal(g.statusCode, 200);
  assert.equal(g.json.provenance, 'STORED');
  assert.deepEqual(g.json.config, config);
  assert.equal(g.json.config.mode, 'model-first');
  assert.equal(g.json.warnings.length, 1, JSON.stringify(g.json.warnings));
  const w = g.json.warnings[0];
  assert.deepEqual({ path: w.path, code: w.code, entry: w.entry_id, provider: w.provider }, { path: 'entries[0].paid_ack', code: 'paid_ack_required', entry: 'eigen', provider: ID });
  assert.ok(typeof w.nl === 'string' && w.nl.length > 0 && typeof w.en === 'string' && w.en.length > 0);
});

test('GET /api/app-router/status: the unconfirmed entry is not eligible (paid_ack_required) and next skips it', async () => {
  await setUp();
  await addKey();
  const s = await request(port, ROUTER + '/status');
  assert.equal(s.statusCode, 200, s.body);
  assert.equal(s.json.mode, 'model-first', 'the router is still on');
  const row = s.json.entries.find((e) => e.id === 'eigen');
  assert.ok(row);
  assert.equal(row.eligible, false);
  assert.equal(row.ineligible_reason, 'paid_ack_required');
  assert.equal(s.json.next && s.json.next.entry && s.json.next.entry.id, 'main');
});

test('POST /api/app-router that confirms the cost (paid_ack:true) clears the warning; the entry is eligible again', async () => {
  await setUp();
  await addKey();
  const current = (await getRouter()).json.config;
  const ok = await saveRouter({ ...current, entries: [eigen({ paid_ack: true }), main()] });
  assert.equal(ok.statusCode, 200, ok.body);
  const g = await getRouter();
  assert.equal(g.json.provenance, 'STORED');
  assert.deepEqual(g.json.warnings, []);
  const s = await request(port, ROUTER + '/status');
  assert.equal(s.json.entries.find((e) => e.id === 'eigen').ineligible_reason, null);
});
