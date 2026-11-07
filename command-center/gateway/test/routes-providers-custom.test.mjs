// (ANY-MODEL-PLAN 2.2 D): GET/POST/PATCH/DELETE /api/providers/custom[/:id] against the REAL gateway
// listener (server.mjs createServer), so the method allowlist, the token check and the route table run exactly
// as in production. The overlay store points at a fresh temp folder per test. The answer shapes are the ones the
// dashboard adapter (dashboard/src/prototype/state/adapter/providers-custom.ts) parses. The one outbound call
// in this file goes to the in-process mock server on 127.0.0.1 (providers/testing/mock-http-server.mjs).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer, _configureRateLimitForTests } from '../src/server.mjs';
import { _setCustomProvidersDirForTests, customProvidersFile } from '../src/providers/custom-store.mjs';
import { _resetMergedRegistryCacheForTests } from '../src/providers/custom-registry.mjs';
import { startMockServer } from '../src/providers/testing/mock-http-server.mjs';
import { _setRouterDirForTests, routerConfigFile } from '../src/app-router/chain-store.mjs';
import { defaultRouterConfig } from '../src/app-router/chain-schema.mjs';
import { request, requestWithBody } from '../test-support/helpers.mjs';

const COLLECTION = '/api/providers/custom';

let tmp;
let server;
let port;
let mock;

function listen(s) {
  return new Promise((resolve, reject) => {
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => resolve(s.address().port));
  });
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-providers-custom-routes-'));
  mock = await startMockServer((req, h) => {
    if (req.method === 'GET' && req.path === '/v1/models') return h.json(200, { object: 'list', data: [{ id: 'mock-small', object: 'model' }] });
    return h.json(404, { error: 'not found' });
  });
  server = createServer();
  port = await listen(server);
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await mock.close();
  _setCustomProvidersDirForTests(null);
  _setRouterDirForTests(null);
  _resetMergedRegistryCacheForTests();
  _configureRateLimitForTests();
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
});

let storeDir;
beforeEach(() => {
  storeDir = fs.mkdtempSync(path.join(tmp, 's-'));
  _setCustomProvidersDirForTests(storeDir);
  _setRouterDirForTests(fs.mkdtempSync(path.join(tmp, 'r-')));
  _resetMergedRegistryCacheForTests();
  _configureRateLimitForTests();
});

function def(over = {}) {
  return {
    label: 'Mijn vLLM', format: 'openai-chat', baseURL: 'http://127.0.0.1:8000/v1', auth: { type: 'none' },
    models: { mode: 'endpoint' }, extraHeaders: {}, contextLength: null, enabled: true, ...over,
  };
}
const list = () => request(port, COLLECTION);
const create = (body, opts = {}) => requestWithBody(port, COLLECTION, { jsonBody: body, ...opts });
const patch = (id, body, opts = {}) => requestWithBody(port, COLLECTION + '/' + id, { method: 'PATCH', jsonBody: body, ...opts });
const del = (id, query = '', opts = {}) => requestWithBody(port, COLLECTION + '/' + id + query, { method: 'DELETE', ...opts });
const fileText = () => (fs.existsSync(customProvidersFile()) ? fs.readFileSync(customProvidersFile(), 'utf8') : null);

// ---- GET ----------------------------------------------------------------------------------------------

test('GET with no file: 200 {ok, revision 0, provenance DEFAULT, providers []} (the dashboard reads this as "available")', async () => {
  const r = await list();
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.revision, 0);
  assert.equal(r.json.provenance, 'DEFAULT');
  assert.deepEqual(r.json.providers, []);
  assert.ok(Number.isFinite(Date.parse(r.json.captured_at)));
  assert.equal(fileText(), null, 'a read never creates the file');
});

test('GET with stored entries: every entry keeps its stored fields plus key_env_name, warnings and usable', async () => {
  const fixture = fs.readFileSync(new URL('./fixtures/providers-custom/valid.json', import.meta.url), 'utf8');
  fs.writeFileSync(customProvidersFile(), fixture, 'utf8');
  const r = await list();
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json.provenance, 'STORED');
  assert.equal(r.json.revision, 3);
  const byId = Object.fromEntries(r.json.providers.map((p) => [p.id, p]));
  assert.deepEqual(Object.keys(byId).sort(), ['custom-claude-proxy', 'custom-mijn-vllm', 'custom-team-gateway']);
  const vllm = byId['custom-mijn-vllm'];
  assert.equal(vllm.baseURL, 'http://192.168.1.20:8000/v1');
  assert.equal(vllm.key_env_name, 'CUSTOM_MIJN_VLLM_API_KEY');
  assert.deepEqual(vllm.warnings.map((w) => [w.path, w.code]), [['baseURL', 'http_lan']]);
  assert.match(vllm.warnings[0].nl, /niet versleuteld/);
  assert.equal(vllm.usable, true);
  assert.equal(byId['custom-claude-proxy'].usable, false, 'a disabled entry is not usable');
  assert.equal(byId['custom-team-gateway'].warnings.length, 0);
});

test('GET with a damaged file: 200, provenance UNREADABLE, no entries, the errors in {path, code, nl, en}; never a 500', async () => {
  fs.writeFileSync(customProvidersFile(), '{"version":1,"revision":7,"providers":[', 'utf8');
  const r = await list();
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json.provenance, 'UNREADABLE');
  assert.deepEqual(r.json.providers, []);
  assert.ok(r.json.errors.length > 0);
  for (const e of r.json.errors) assert.deepEqual(Object.keys(e).sort(), ['code', 'en', 'nl', 'path']);
});

// ---- POST -----------------------------------------------------------------------------------------------

test('POST creates an entry: 201 {ok, revision, provider}; the id comes from the label; the file holds no key', async () => {
  const r = await create({ revision: 0, provider: def({ auth: { type: 'bearer' } }) });
  assert.equal(r.statusCode, 201, r.body);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.revision, 1);
  assert.equal(r.json.provider.id, 'custom-mijn-vllm');
  assert.equal(r.json.provider.label, 'Mijn vLLM');
  assert.equal(r.json.provider.key_env_name, 'CUSTOM_MIJN_VLLM_API_KEY');
  assert.ok(Number.isFinite(Date.parse(r.json.provider.created_at)));
  const stored = JSON.parse(fileText());
  assert.equal(stored.revision, 1);
  assert.equal(stored.providers.length, 1);
  assert.ok(!/key"\s*:\s*"/i.test(fileText().replace(/"keyEnvName"/g, '')), 'no key value in the file');
  const again = await list();
  assert.equal(again.json.revision, 1);
  assert.equal(again.json.providers[0].id, 'custom-mijn-vllm');
});

test('POST with a LAN http address saves with the http_lan warning (D1); a public http address is refused with https_required', async () => {
  const lan = await create({ revision: 0, provider: def({ label: 'NAS', baseURL: 'http://192.168.1.50:8000/v1' }) });
  assert.equal(lan.statusCode, 201, lan.body);
  assert.deepEqual(lan.json.warnings.map((w) => w.code), ['http_lan']);
  const pub = await create({ revision: 1, provider: def({ label: 'Pub', baseURL: 'http://example.com/v1' }) });
  assert.equal(pub.statusCode, 400, pub.body);
  assert.equal(pub.json.ok, false);
  assert.deepEqual(pub.json.errors.map((e) => [e.path, e.code]), [['baseURL', 'https_required']]);
  assert.match(pub.json.errors[0].nl, /https:\/\//);
  assert.equal(JSON.parse(fileText()).revision, 1, 'a refused write changes nothing');
});

test('POST refuses cloud metadata hosts and blocked ports with their own code', async () => {
  const meta = await create({ revision: 0, provider: def({ baseURL: 'http://169.254.169.254/latest' }) });
  assert.equal(meta.statusCode, 400);
  assert.equal(meta.json.errors[0].code, 'blocked_host');
  const smtp = await create({ revision: 0, provider: def({ baseURL: 'https://mail.example.com:25/v1' }) });
  assert.equal(smtp.statusCode, 400);
  assert.equal(smtp.json.errors[0].code, 'blocked_port');
  assert.equal(fileText(), null);
});

test('POST with a stale revision: 409 {error: stale_revision, revision: <current>}', async () => {
  assert.equal((await create({ revision: 0, provider: def() })).statusCode, 201);
  const r = await create({ revision: 0, provider: def({ label: 'Tweede' }) });
  assert.equal(r.statusCode, 409, r.body);
  assert.equal(r.json.error, 'stale_revision');
  assert.equal(r.json.revision, 1);
});

test('POST with an id that exists: 409 {error: duplicate_id, revision}', async () => {
  assert.equal((await create({ revision: 0, provider: def({ id: 'custom-box' }) })).statusCode, 201);
  const r = await create({ revision: 1, provider: def({ id: 'custom-box', label: 'Andere' }) });
  assert.equal(r.statusCode, 409, r.body);
  assert.equal(r.json.error, 'duplicate_id');
  assert.equal(r.json.revision, 1);
});

test('POST without a revision, with a bad body or with unknown top-level fields: 400 in the {path, code, nl, en} shape', async () => {
  const noRev = await create({ provider: def() });
  assert.equal(noRev.statusCode, 400);
  assert.equal(noRev.json.errors[0].code, 'bad_revision');
  const notObj = await create([1, 2]);
  assert.equal(notObj.statusCode, 400);
  assert.equal(notObj.json.errors[0].code, 'bad_shape');
  const noProvider = await create({ revision: 0 });
  assert.equal(noProvider.statusCode, 400);
  assert.equal(noProvider.json.errors[0].path, 'provider');
  const extra = await create({ revision: 0, provider: def(), hello: 1 });
  assert.equal(extra.statusCode, 400);
  assert.equal(extra.json.errors[0].code, 'unknown_key');
  const badJson = await requestWithBody(port, COLLECTION, { rawBody: '{"revision": 0,' });
  assert.equal(badJson.statusCode, 400);
  assert.equal(fileText(), null);
});

test('POST over a damaged file replaces it (the damaged file is kept beside it), like the app router does', async () => {
  // Parses but is no longer valid: the store keeps revision 7, so the save does not 409-loop.
  fs.writeFileSync(customProvidersFile(), '{"version":1,"revision":7,"providers":"nope"}', 'utf8');
  const r = await create({ revision: 7, provider: def() });
  assert.equal(r.statusCode, 201, r.body);
  assert.equal(r.json.revision, 9, 'one revision for the reset, one for the new entry');
  assert.equal((await list()).json.provenance, 'STORED');
  const aside = fs.readdirSync(storeDir).filter((n) => n.startsWith('custom.json.unreadable-'));
  assert.equal(aside.length, 1);
});

test('POST over a damaged file with a stale revision does not touch the file', async () => {
  const broken = '{"version":1,"revision":7,"providers":"nope"}';
  fs.writeFileSync(customProvidersFile(), broken, 'utf8');
  const r = await create({ revision: 2, provider: def() });
  assert.equal(r.statusCode, 409, r.body);
  assert.equal(r.json.error, 'stale_revision');
  assert.equal(r.json.revision, 7);
  assert.equal(fileText(), broken);
});

test('POST over a file that does not even parse: it reads as revision 0, so revision 0 replaces it', async () => {
  fs.writeFileSync(customProvidersFile(), '{"version":1,"revision":7,"providers":[', 'utf8');
  assert.equal((await list()).json.revision, 0);
  const r = await create({ revision: 0, provider: def() });
  assert.equal(r.statusCode, 201, r.body);
  assert.equal(r.json.revision, 2);
});

// ---- PATCH ----------------------------------------------------------------------------------------------

test('PATCH /:id replaces the editable fields: 200 {ok, revision, provider}; id and created_at stay', async () => {
  const made = await create({ revision: 0, provider: def() });
  const r = await patch('custom-mijn-vllm', { revision: 1, provider: def({ label: 'Mijn vLLM (groot)', models: { mode: 'manual', ids: ['qwen2.5-72b'] } }) });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json.revision, 2);
  assert.equal(r.json.provider.id, 'custom-mijn-vllm');
  assert.equal(r.json.provider.label, 'Mijn vLLM (groot)');
  assert.deepEqual(r.json.provider.models, { mode: 'manual', ids: ['qwen2.5-72b'] });
  assert.equal(r.json.provider.created_at, made.json.provider.created_at);
});

test('PATCH of an unknown id: 404; a stale revision: 409; an invalid field: 400 with the field path', async () => {
  await create({ revision: 0, provider: def() });
  const missing = await patch('custom-nope', { revision: 1, provider: def() });
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json.error, 'not_found');
  const stale = await patch('custom-mijn-vllm', { revision: 0, provider: def() });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json.error, 'stale_revision');
  assert.equal(stale.json.revision, 1);
  const bad = await patch('custom-mijn-vllm', { revision: 1, provider: def({ format: 'gemini' }) });
  assert.equal(bad.statusCode, 400);
  assert.deepEqual(bad.json.errors.map((e) => e.path), ['format']);
});

test('PATCH with a different id in the body is refused (an entry cannot be renamed into another one)', async () => {
  await create({ revision: 0, provider: def() });
  const r = await patch('custom-mijn-vllm', { revision: 1, provider: def({ id: 'custom-other' }) });
  assert.equal(r.statusCode, 400);
  assert.equal(r.json.errors[0].code, 'bad_id');
});

// ---- DELETE ---------------------------------------------------------------------------------------------

test('DELETE /:id: 200 {ok, revision, removed: {id, key_env_name}}; the entry is gone', async () => {
  await create({ revision: 0, provider: def({ auth: { type: 'bearer' } }) });
  const r = await del('custom-mijn-vllm');
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.revision, 2);
  assert.deepEqual(r.json.removed, { id: 'custom-mijn-vllm', key_env_name: 'CUSTOM_MIJN_VLLM_API_KEY' });
  assert.deepEqual(r.json.router_entries, []);
  assert.deepEqual((await list()).json.providers, []);
});

test('DELETE with ?revision=: a stale one is 409, a bad one is 400; an unknown id is 404', async () => {
  await create({ revision: 0, provider: def() });
  const stale = await del('custom-mijn-vllm', '?revision=0');
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json.error, 'stale_revision');
  for (const q of ['?revision=abc', '?revision=1e0', '?revision=0x1', '?revision=-1', '?revision=']) {
    const bad = await del('custom-mijn-vllm', q);
    assert.equal(bad.statusCode, 400, q + ' ' + bad.body);
    assert.equal(bad.json.errors[0].code, 'bad_revision');
  }
  assert.equal((await list()).json.providers.length, 1, 'no refused DELETE removed anything');
  const ok = await del('custom-mijn-vllm', '?revision=1');
  assert.equal(ok.statusCode, 200, ok.body);
  const gone = await del('custom-mijn-vllm');
  assert.equal(gone.statusCode, 404);
});

test('DELETE on a damaged file: 409 store_unreadable with a {nl, en} message; the file is not touched', async () => {
  const broken = '{"version":1,"revision":7,"providers":[';
  fs.writeFileSync(customProvidersFile(), broken, 'utf8');
  const r = await del('custom-mijn-vllm');
  assert.equal(r.statusCode, 409, r.body);
  assert.equal(r.json.error, 'store_unreadable');
  assert.ok(r.json.errors[0].nl && r.json.errors[0].en);
  assert.equal(fileText(), broken);
});

test('DELETE names the router chain entries that still use the provider (router_entries), read before the delete', async () => {
  await create({ revision: 0, provider: def() });
  const chain = defaultRouterConfig();
  const entry = { id: 'eigen-box', kind: 'provider-model', label: 'Eigen box', provider: 'custom-mijn-vllm', model: 'qwen2.5-7b', enabled: true, paid_ack: false, notice_ack: false };
  fs.writeFileSync(routerConfigFile(), JSON.stringify({ ...chain, revision: 2, mode: 'model-first', entries: [entry, ...chain.entries] }), 'utf8');
  const r = await del('custom-mijn-vllm');
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(r.json.router_entries, ['eigen-box']);
});

// ---- the existing Test route sees a saved entry at once ------------------------------------------------------

test('a saved entry is testable at once through POST /api/providers/:id/test (mock server, no key)', async () => {
  const made = await create({ revision: 0, provider: def({ label: 'Mock box', baseURL: mock.url + '/v1' }) });
  assert.equal(made.statusCode, 201, made.body);
  const before = mock.requests.length;
  const t = await requestWithBody(port, '/api/providers/custom-mock-box/test', { jsonBody: {} });
  assert.equal(t.statusCode, 200, t.body);
  assert.equal(t.json.ok, true);
  const calls = mock.requests.slice(before);
  assert.equal(calls.length, 1, 'exactly one outbound call');
  assert.equal(calls[0].path, '/v1/models');
  assert.equal(calls[0].headers.authorization, undefined, 'auth none sends no Authorization header');
  const del1 = await del('custom-mock-box');
  assert.equal(del1.statusCode, 200);
  const after = await requestWithBody(port, '/api/providers/custom-mock-box/test', { jsonBody: {} });
  assert.equal(after.statusCode, 404, 'a deleted entry is no longer a provider');
});
