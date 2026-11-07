// write boundary for /api/providers/custom[/:id] (ANY-MODEL-PLAN 2.2 D and 2.3):
//   - loopback peer only (the socket address, never a header), checked before the body is read;
//   - every write needs the dashboard credential (an agent token or no token gets 403);
//   - only GET, POST (collection), PATCH and DELETE (item) pass the method guard; PUT and the rest are 405;
//   - a key is never accepted over HTTP and a refused value is never echoed back;
//   - the routes sit in the server's route table and their item pattern equals the dashboard's CUSTOM_ID_RE.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer, describeRoutes, _configureRateLimitForTests } from '../src/server.mjs';
import { EXEC_TOKEN_HEADER, issueAgentToken } from '../src/security.mjs';
import { _setCustomProvidersDirForTests, customProvidersFile } from '../src/providers/custom-store.mjs';
import { _resetMergedRegistryCacheForTests } from '../src/providers/custom-registry.mjs';
import * as custom from '../src/routes/providers-custom.mjs';
import { request, requestWithBody } from '../test-support/helpers.mjs';

const COLLECTION = '/api/providers/custom';
const SECRET = 'sk' + '-' + 'C1bPlanted0123456789abcdefXyZ';

let tmp;
let server;
let port;

function listen(s) {
  return new Promise((resolve, reject) => {
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => resolve(s.address().port));
  });
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-providers-custom-boundary-'));
  server = createServer();
  port = await listen(server);
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  _setCustomProvidersDirForTests(null);
  _resetMergedRegistryCacheForTests();
  _configureRateLimitForTests();
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
});

beforeEach(() => {
  _setCustomProvidersDirForTests(fs.mkdtempSync(path.join(tmp, 's-')));
  _resetMergedRegistryCacheForTests();
  _configureRateLimitForTests();
});

function def(over = {}) {
  return {
    label: 'Mijn box', format: 'openai-chat', baseURL: 'http://127.0.0.1:8000/v1', auth: { type: 'bearer' },
    models: { mode: 'endpoint' }, extraHeaders: {}, contextLength: null, enabled: true, ...over,
  };
}
const fileExists = () => fs.existsSync(customProvidersFile());

/** A request object as node:http would hand it to a handler, from a peer that is NOT this PC. */
function remoteReq(remoteAddress, { method = 'POST', headers = {} } = {}) {
  let bodyRead = false;
  return {
    method, headers, url: COLLECTION, socket: { remoteAddress },
    on() { bodyRead = true; return this; }, removeAllListeners() { return this; }, resume() { return this; },
    get bodyRead() { return bodyRead; },
  };
}
function fakeRes() {
  const out = { status: null, body: '', headers: {} };
  return {
    out,
    setHeader(k, v) { out.headers[k.toLowerCase()] = v; },
    writeHead(s, h) { out.status = s; Object.assign(out.headers, h || {}); },
    end(b) { out.body = b ? String(b) : ''; },
  };
}

// ---- loopback only --------------------------------------------------------------------------------------

for (const addr of ['10.0.0.5', '192.168.1.20', '::ffff:192.168.1.20', 'fe80::1', '8.8.8.8', undefined]) {
  test('every handler refuses a non-loopback peer (' + String(addr) + ') with 403 before reading the body', async () => {
    for (const [name, ctx] of [['list', {}], ['create', {}], ['update', { match: [null, 'custom-mijn-box'] }], ['remove', { match: [null, 'custom-mijn-box'] }]]) {
      const req = remoteReq(addr, { headers: { 'x-forwarded-for': '127.0.0.1' } });
      const res = fakeRes();
      await custom[name](req, res, { searchParams: new URLSearchParams(), ...ctx });
      assert.equal(res.out.status, 403, name + ' answered ' + res.out.status);
      const json = JSON.parse(res.out.body);
      assert.equal(json.code, 'loopback_only');
      assert.match(json.nl, /deze computer/);
      assert.match(json.en, /this PC/);
      assert.equal(req.bodyRead, false, name + ' read the body of a refused peer');
    }
    assert.equal(fileExists(), false);
  });
}

test('the loopback peers (127.0.0.1, ::1, ::ffff:127.0.0.1) pass the peer check', () => {
  for (const addr of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) assert.equal(custom.isLoopbackPeer({ socket: { remoteAddress: addr } }), true, addr);
  for (const addr of ['127.0.0.2.evil', '0.0.0.0', '', null]) assert.equal(custom.isLoopbackPeer({ socket: { remoteAddress: addr } }), false, String(addr));
  assert.equal(custom.isLoopbackPeer({}), false);
});

// ---- token boundary -------------------------------------------------------------------------------------

test('POST, PATCH and DELETE without the dashboard credential: 403 ui_session_required; an agent token: 403; nothing stored', async () => {
  const agentToken = issueAgentToken('c1b-agent-token-test');
  assert.ok(agentToken);
  const calls = [
    [COLLECTION, 'POST', { revision: 0, provider: def() }],
    [COLLECTION + '/custom-mijn-box', 'PATCH', { revision: 0, provider: def() }],
    [COLLECTION + '/custom-mijn-box', 'DELETE', undefined],
  ];
  for (const [p, method, jsonBody] of calls) {
    const none = await requestWithBody(port, p, { method, jsonBody, omitExecToken: true });
    assert.equal(none.statusCode, 403, method + ' ' + none.body);
    assert.equal(none.json.code, 'ui_session_required');
    const agent = await requestWithBody(port, p, { method, jsonBody, omitExecToken: true, headers: { [EXEC_TOKEN_HEADER]: agentToken } });
    assert.equal(agent.statusCode, 403, method + ' ' + agent.body);
    assert.equal(agent.json.code, 'agent_token_refused');
  }
  assert.equal(fileExists(), false);
});

test('GET needs no token (reads never did)', async () => {
  const r = await request(port, COLLECTION);
  assert.equal(r.statusCode, 200);
});

// ---- method guard ---------------------------------------------------------------------------------------

// Probes carry no body: a body sent to a route the method guard refuses before reading can reset the socket on Windows.
test('only GET/POST on the collection and PATCH/DELETE on an item pass; PUT and the rest are 405', async () => {
  const put = await requestWithBody(port, COLLECTION + '/custom-mijn-box', { method: 'PUT' });
  assert.equal(put.statusCode, 405);
  const putColl = await requestWithBody(port, COLLECTION, { method: 'PUT' });
  assert.equal(putColl.statusCode, 405);
  const delColl = await requestWithBody(port, COLLECTION, { method: 'DELETE' });
  assert.equal(delColl.statusCode, 405, 'DELETE on the collection is never allowed');
  const patchColl = await requestWithBody(port, COLLECTION, { method: 'PATCH' });
  assert.equal(patchColl.statusCode, 405);
  const postItem = await requestWithBody(port, COLLECTION + '/custom-mijn-box', {});
  assert.equal(postItem.statusCode, 405, 'POST on an item is not a write route');
  const badId = await requestWithBody(port, COLLECTION + '/openai', { method: 'DELETE' });
  assert.equal(badId.statusCode, 405, 'an item path outside the custom- namespace is not a DELETE route');
  const traversal = await requestWithBody(port, COLLECTION + '/custom-..%2Fx', { method: 'DELETE' });
  assert.equal(traversal.statusCode, 405);
  assert.equal(fileExists(), false);
});

test('the item pattern is the dashboard CUSTOM_ID_RE (^custom-[a-z0-9][a-z0-9-]{0,40}$) on the path, anchored', () => {
  assert.equal(custom.CUSTOM_ITEM_RE.source, '^\\/api\\/providers\\/custom\\/(custom-[a-z0-9][a-z0-9-]{0,40})$');
  assert.ok(custom.CUSTOM_ITEM_RE.test(COLLECTION + '/custom-a'));
  assert.ok(!custom.CUSTOM_ITEM_RE.test(COLLECTION + '/custom-A'));
  assert.ok(!custom.CUSTOM_ITEM_RE.test(COLLECTION + '/custom-a/test'));
  assert.ok(!custom.CUSTOM_ITEM_RE.test(COLLECTION + '/custom-' + 'a'.repeat(42)));
  assert.equal(custom.isCustomWriteRoute(COLLECTION), true);
  assert.equal(custom.isCustomWriteRoute(COLLECTION + '/custom-a'), false, 'POST is collection-only');
  assert.equal(custom.isCustomItemRoute(COLLECTION + '/custom-a'), true);
});

test('the route table holds exactly the four custom rows, after the provider rows', () => {
  const rows = describeRoutes().filter((r) => r.module === 'providers-custom').map((r) => [r.method, r.path, r.handler]);
  assert.deepEqual(rows, [
    ['GET', COLLECTION, 'list'],
    ['POST', COLLECTION, 'create'],
    ['PATCH', custom.CUSTOM_ITEM_RE.source, 'update'],
    ['DELETE', custom.CUSTOM_ITEM_RE.source, 'remove'],
  ]);
});

test('the provider Test route still wins for /api/providers/custom-<slug>/test (no overlap with the item pattern)', async () => {
  const r = await requestWithBody(port, '/api/providers/custom-not-saved/test', { jsonBody: {} });
  assert.equal(r.statusCode, 404);
  assert.equal(r.json.error, 'unknown provider');
});

// ---- keys never over HTTP, refused values never echoed ---------------------------------------------------

test('a key field in the body (top level, provider or auth) is refused with key_not_allowed; the key is never echoed or stored', async () => {
  const bodies = [
    { revision: 0, provider: def(), apiKey: SECRET },
    { revision: 0, provider: { ...def(), key: SECRET } },
    { revision: 0, provider: { ...def(), api_key: SECRET } },
    { revision: 0, provider: def({ auth: { type: 'bearer', token: SECRET } }) },
    { revision: 0, provider: def({ auth: { type: 'bearer', value: SECRET } }) },
  ];
  for (const body of bodies) {
    const r = await requestWithBody(port, COLLECTION, { jsonBody: body });
    assert.equal(r.statusCode, 400, r.body);
    assert.ok(r.json.errors.some((e) => e.code === 'key_not_allowed'), r.body);
    assert.match(r.json.errors.find((e) => e.code === 'key_not_allowed').nl, /sleutelveld/);
    assert.ok(!r.body.includes(SECRET), 'the key came back in the answer');
  }
  assert.equal(fileExists(), false);
});

test('a key-shaped value anywhere (label, header, model id, field NAME) is refused and never echoed', async () => {
  const bodies = [
    { revision: 0, provider: def({ label: SECRET.slice(0, 39) }) },
    { revision: 0, provider: def({ extraHeaders: { 'X-Team': SECRET } }) },
    { revision: 0, provider: def({ models: { mode: 'manual', ids: [SECRET] } }) },
    { revision: 0, provider: { ...def(), [SECRET]: 1 } },
    { revision: 0, provider: def(), [SECRET]: 1 },
  ];
  for (const body of bodies) {
    const r = await requestWithBody(port, COLLECTION, { jsonBody: body });
    assert.equal(r.statusCode, 400, r.body);
    assert.ok(!r.body.includes(SECRET), 'echoed: ' + r.body);
    assert.ok(!r.body.includes(SECRET.slice(0, 20)), 'echoed a prefix: ' + r.body);
    for (const e of r.json.errors) assert.ok(!/REDACTED/.test(e.path), 'a key-shaped field name is dropped from the path, not shown masked: ' + e.path);
  }
  assert.equal(fileExists(), false);
});

test('a body that is not JSON is refused without quoting it; an oversized body is 413', async () => {
  const r = await requestWithBody(port, COLLECTION, { rawBody: '{"revision":0,"provider":"' + SECRET });
  assert.equal(r.statusCode, 400);
  assert.ok(!r.body.includes(SECRET));
  const big = await requestWithBody(port, COLLECTION, { rawBody: JSON.stringify({ revision: 0, provider: def({ label: 'x'.repeat(40 * 1024) }) }) });
  assert.equal(big.statusCode, 413);
  assert.equal(fileExists(), false);
});

test('the answers to a successful write carry no key and no key value from the environment', async () => {
  const r = await requestWithBody(port, COLLECTION, { jsonBody: { revision: 0, provider: def() } });
  assert.equal(r.statusCode, 201, r.body);
  assert.equal(r.json.provider.key_env_name, 'CUSTOM_MIJN_BOX_API_KEY');
  assert.ok(!('key' in r.json.provider) && !('apiKey' in r.json.provider) && !('last4' in r.json.provider));
});

// ---- anti-runaway brake ---------------------------------------------------------------------------------

test('writes share the anti-runaway bucket: past capacity the answer is 429', async () => {
  _configureRateLimitForTests({ capacity: 2, refillMs: 60_000 });
  const a = await requestWithBody(port, COLLECTION, { jsonBody: { revision: 0, provider: def({ label: 'Een' }) } });
  const b = await requestWithBody(port, COLLECTION, { jsonBody: { revision: 1, provider: def({ label: 'Twee' }) } });
  const c = await requestWithBody(port, COLLECTION, { jsonBody: { revision: 2, provider: def({ label: 'Drie' }) } });
  assert.equal(a.statusCode, 201);
  assert.equal(b.statusCode, 201);
  assert.equal(c.statusCode, 429, c.body);
  assert.equal(JSON.parse(fs.readFileSync(customProvidersFile(), 'utf8')).providers.length, 2);
});

// ---- ship-clean ----------------------------------------------------------------------------------------

test('the route module and server.mjs carry none of the desktop never-ship patterns (the matcher sees a planted needle)', async () => {
  const { scanBuffer } = await import('../../desktop/scripts/distribution-check.mjs');
  assert.equal(scanBuffer(Buffer.from('x forge-' + 'accounts y')).length, 1);
  const src = new URL('../src/', import.meta.url);
  assert.deepEqual(scanBuffer(fs.readFileSync(new URL('routes/providers-custom.mjs', src))).map((h) => h.pattern_id), []);
  // server.mjs keeps exactly its two allowlisted P8 hits (the /api/account-rotation branch and its comment,
  // distribution-check.mjs ALLOWLIST count 2); the new route lines add none.
  assert.deepEqual(scanBuffer(fs.readFileSync(new URL('server.mjs', src))).map((h) => h.pattern_id), ['P8', 'P8']);
});
