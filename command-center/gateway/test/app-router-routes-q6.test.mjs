// Q6-GW C2 + C3: the HTTP side of an "Eigen API" (custom-*) chain entry the turn router skips, against the REAL
// gateway listener (server.mjs createServer). Fresh temp folders for the custom store, the router folder, the
// profiles root and the conversations folder. No `claude` process; the only outbound target is an in-process stub.
//
//   C2  POST /api/app-router/targets/:id/test on an entry that unusableEntryReasons() flags answers
//       409 {ok:false, error:'entry_unusable', reason, nl, en} and makes NO provider call (probe seam counter and,
//       for the keyed case, the real probe against a stub that must see no request);
//   C3  POST /api/app-router (save) answers {ok:true, config, warnings}, warnings computed from the just-stored
//       config in the same shape as GET /api/app-router ([] for a clean chain).
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
import { readRouterEvents } from '../src/app-router/router-log.mjs';
import { _setProbeForTests } from '../src/routes/app-router.mjs';
import { startMockServer } from '../src/providers/testing/mock-http-server.mjs';
import { _setConversationsDirForTests, _resetConversationsForTests } from '../src/conversations.mjs';
import { request, requestWithBody } from '../test-support/helpers.mjs';

const CUSTOM = '/api/providers/custom';
const ROUTER = '/api/app-router';
const ID = 'custom-mijn-vllm';

let tmp;
let server;
let port;
let savedProfilesEnv;
let probeCalls;

function listen(s) {
  return new Promise((resolve, reject) => {
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => resolve(s.address().port));
  });
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-q6-routes-'));
  fs.mkdirSync(path.join(tmp, 'conv'));
  savedProfilesEnv = process.env.FORGE_ROUTER_PROFILES_DIR;
  _setConversationsDirForTests(path.join(tmp, 'conv'));
  server = createServer();
  port = await listen(server);
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  _setProbeForTests(null);
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
  probeCalls = 0;
  _setProbeForTests(async () => { probeCalls += 1; return { outcome: 'ok', reading: null, detail: null }; });
});

const def = (over = {}) => ({
  label: 'Mijn vLLM', format: 'openai-chat', baseURL: 'http://127.0.0.1:8000/v1', auth: { type: 'none' },
  models: { mode: 'manual', ids: ['qwen2.5-7b'] }, extraHeaders: {}, contextLength: null, enabled: true, ...over,
});
const eigen = (over = {}) => ({ id: 'eigen', kind: 'provider-model', label: 'Eigen API', provider: ID, model: 'qwen2.5-7b', enabled: true, paid_ack: false, notice_ack: false, ...over });
const main = () => ({ id: 'main', kind: 'claude-account', label: 'Hoofdaccount', profile: null, enabled: true, threshold_pct: null });

const getRouter = () => request(port, ROUTER);
const saveRouter = (body) => requestWithBody(port, ROUTER, { jsonBody: body });
const runTest = (id) => requestWithBody(port, ROUTER + '/targets/' + id + '/test', { jsonBody: {} });

async function setUp(over = {}) {
  const made = await requestWithBody(port, CUSTOM, { jsonBody: { revision: 0, provider: def(over) } });
  assert.equal(made.statusCode, 201, made.body);
  assert.equal(made.json.provider.id, ID);
  const saved = await saveRouter({ ...defaultRouterConfig(), mode: 'model-first', entries: [eigen(), main()], revision: 0 });
  assert.equal(saved.statusCode, 200, saved.body);
  return saved;
}
async function deleteCustom() {
  const r = await requestWithBody(port, CUSTOM + '/' + ID, { method: 'DELETE' });
  assert.equal(r.statusCode, 200, r.body);
}
async function addKey(over = {}) {
  const rev = (await request(port, CUSTOM)).json.revision;
  const r = await requestWithBody(port, CUSTOM + '/' + ID, { method: 'PATCH', jsonBody: { revision: rev, provider: def({ auth: { type: 'bearer' }, ...over }) } });
  assert.equal(r.statusCode, 200, r.body);
}
function assertRefused(r, reason) {
  assert.equal(r.statusCode, 409, r.body);
  assert.deepEqual(Object.keys(r.json).sort(), ['en', 'error', 'nl', 'ok', 'reason']);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.error, 'entry_unusable');
  assert.equal(r.json.reason, reason);
  assert.ok(typeof r.json.nl === 'string' && r.json.nl.length > 0);
  assert.ok(typeof r.json.en === 'string' && r.json.en.length > 0);
}

// ---- C2 ------------------------------------------------------------------------------------------

test('C2 Test on an entry whose Eigen API was deleted: 409 entry_unusable provider_unavailable, no probe', async () => {
  await setUp();
  await deleteCustom();
  const r = await runTest('eigen');
  assertRefused(r, 'provider_unavailable');
  assert.equal(probeCalls, 0, 'no provider call');
  assert.equal(readRouterEvents().filter((e) => e.kind === 'router_test').length, 0, 'no test ran, so no router_test line');
});

test('C2 Test on an entry whose Eigen API now needs a key without cost confirmation: 409 paid_ack_required, no probe', async () => {
  await setUp();
  await addKey();
  const r = await runTest('eigen');
  assertRefused(r, 'paid_ack_required');
  assert.equal(probeCalls, 0, 'no provider call');
});

test('C2 with the REAL probe: the keyed, unconfirmed Eigen API gets no request at all', async () => {
  const stub = await startMockServer(async (req, h) => h.json(200, { data: [{ id: 'qwen2.5-7b' }] }));
  try {
    await setUp({ baseURL: stub.url + '/v1' });
    await addKey({ baseURL: stub.url + '/v1' });
    _setProbeForTests(null);
    const r = await runTest('eigen');
    assertRefused(r, 'paid_ack_required');
    assert.equal(stub.requests.length, 0, 'nothing was sent to the Eigen API');
  } finally {
    await stub.close();
  }
});

test('C2 a usable entry still probes as before (200, one probe call)', async () => {
  await setUp();
  const r = await runTest('eigen');
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json.state, 'ready');
  assert.equal(probeCalls, 1);
});

// ---- C3 ------------------------------------------------------------------------------------------

test('C3 POST /api/app-router answers warnings: [] for a clean chain', async () => {
  const saved = await setUp();
  assert.deepEqual(Object.keys(saved.json).sort(), ['config', 'ok', 'warnings']);
  assert.deepEqual(saved.json.warnings, []);
});

test('C3 POST /api/app-router answers the fresh warnings of the just-stored config, equal to GET', async () => {
  await setUp();
  await deleteCustom();
  const current = (await getRouter()).json.config;
  const keep = await saveRouter({ ...current, defaults: { ...current.defaults, threshold_pct: 85 } });
  assert.equal(keep.statusCode, 200, keep.body);
  assert.equal(keep.json.warnings.length, 1, JSON.stringify(keep.json.warnings));
  const w = keep.json.warnings[0];
  assert.deepEqual({ path: w.path, code: w.code, entry: w.entry_id, provider: w.provider }, { path: 'entries[0].provider', code: 'provider_unavailable', entry: 'eigen', provider: ID });
  assert.deepEqual(keep.json.warnings, (await getRouter()).json.warnings, 'the same shape and content as GET');
});

test('C3 a save that confirms the cost answers warnings: [] (the warning is gone right away)', async () => {
  await setUp();
  await addKey();
  const before = await getRouter();
  assert.equal(before.json.warnings[0].code, 'paid_ack_required');
  const ok = await saveRouter({ ...before.json.config, entries: [eigen({ paid_ack: true }), main()] });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.deepEqual(ok.json.warnings, []);
});

test('C3 an invalid save keeps its error answer unchanged (no warnings key)', async () => {
  const saved = await setUp();
  const bad = await saveRouter({ ...saved.json.config, entries: [...saved.json.config.entries, eigen({ id: 'eigen-twee', provider: 'custom-bestaat-niet' })] });
  assert.equal(bad.statusCode, 400, bad.body);
  assert.deepEqual(Object.keys(bad.json).sort(), ['errors', 'ok']);
});
